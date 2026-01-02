/**
 * Kiro 请求构建模块
 * 负责构建 CodeWhisperer API 请求
 */

import { v4 as uuidv4 } from 'uuid';
import { KIRO_CONSTANTS } from './kiro-constants.js';

/**
 * 提取文本内容
 * @param {any} message - 消息对象
 * @returns {string} 文本内容
 */
function getContentText(message) {
    if (message == null) {
        return "";
    }
    if (Array.isArray(message)) {
        return message
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('');
    } else if (typeof message.content === 'string') {
        return message.content;
    } else if (Array.isArray(message.content)) {
        return message.content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('');
    }
    return String(message.content || message);
}

/**
 * 构建 CodeWhisperer 请求
 * @param {Array} messages - 消息数组
 * @param {string} model - 模型名称
 * @param {Object} modelMapping - 模型映射
 * @param {Array} tools - 工具数组
 * @param {string} inSystemPrompt - 系统提示词
 * @param {string} authMethod - 认证方法
 * @param {string} profileArn - Profile ARN
 * @returns {Object} CodeWhisperer 请求对象
 */
export function buildCodewhispererRequest(messages, model, modelMapping, tools = null, inSystemPrompt = null, authMethod = null, profileArn = null) {
    const conversationId = uuidv4();

    let systemPrompt = getContentText(inSystemPrompt);
    const processedMessages = messages;

    if (processedMessages.length === 0) {
        throw new Error('No user messages found');
    }

    // 判断最后一条消息是否为 assistant，如果是则移除
    const lastMessage = processedMessages[processedMessages.length - 1];
    if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
        if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
            console.log('[Kiro] Removing last assistant with "{" message from processedMessages');
            processedMessages.pop();
        }
    }

    // 合并相邻相同 role 的消息
    const mergedMessages = [];
    for (let i = 0; i < processedMessages.length; i++) {
        const currentMsg = processedMessages[i];

        if (mergedMessages.length === 0) {
            mergedMessages.push(currentMsg);
        } else {
            const lastMsg = mergedMessages[mergedMessages.length - 1];

            // 判断当前消息和上一条消息是否为相同 role
            if (currentMsg.role === lastMsg.role) {
                // 合并消息内容
                if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
                    lastMsg.content.push(...currentMsg.content);
                } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
                    lastMsg.content += '\n' + currentMsg.content;
                } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
                    lastMsg.content.push({ type: 'text', text: currentMsg.content });
                } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
                    lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content];
                }
                console.log(`[Kiro] Merged adjacent ${currentMsg.role} messages`);
            } else {
                mergedMessages.push(currentMsg);
            }
        }
    }

    // 用合并后的消息替换原消息数组
    processedMessages.length = 0;
    processedMessages.push(...mergedMessages);

    const codewhispererModel = modelMapping[model] || modelMapping[KIRO_CONSTANTS.DEFAULT_MODEL_NAME];

    let toolsContext = {};
    if (tools && Array.isArray(tools) && tools.length > 0) {
        toolsContext = {
            tools: tools.map(tool => ({
                toolSpecification: {
                    name: tool.name,
                    description: tool.description || "",
                    inputSchema: { json: tool.input_schema || {} }
                }
            }))
        };
    }

    const history = [];
    let startIndex = 0;

    // 处理系统提示词
    if (systemPrompt) {
        if (processedMessages[0].role === 'user') {
            let firstUserContent = getContentText(processedMessages[0]);
            history.push({
                userInputMessage: {
                    content: `${systemPrompt}\n\n${firstUserContent}`,
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                }
            });
            startIndex = 1;
        } else {
            history.push({
                userInputMessage: {
                    content: systemPrompt,
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                }
            });
        }
    }

    // 添加剩余的 user/assistant 消���到 history
    for (let i = startIndex; i < processedMessages.length - 1; i++) {
        const message = processedMessages[i];
        if (message.role === 'user') {
            let userInputMessage = {
                content: '',
                modelId: codewhispererModel,
                origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
            };
            let images = [];
            let toolResults = [];

            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'text') {
                        userInputMessage.content += part.text;
                    } else if (part.type === 'tool_result') {
                        toolResults.push({
                            content: [{ text: getContentText(part.content) }],
                            status: 'success',
                            toolUseId: part.tool_use_id
                        });
                    } else if (part.type === 'image') {
                        images.push({
                            format: part.source.media_type.split('/')[1],
                            source: {
                                bytes: part.source.data
                            }
                        });
                    }
                }
            } else {
                userInputMessage.content = getContentText(message);
            }

            // 只添加非空字段
            if (images.length > 0) {
                userInputMessage.images = images;
            }
            if (toolResults.length > 0) {
                // 去重 toolResults
                const uniqueToolResults = [];
                const seenIds = new Set();
                for (const tr of toolResults) {
                    if (!seenIds.has(tr.toolUseId)) {
                        seenIds.add(tr.toolUseId);
                        uniqueToolResults.push(tr);
                    }
                }
                userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
            }

            history.push({ userInputMessage });
        } else if (message.role === 'assistant') {
            let assistantResponseMessage = {
                content: ''
            };
            let toolUses = [];

            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'text') {
                        assistantResponseMessage.content += part.text;
                    } else if (part.type === 'tool_use') {
                        toolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    }
                }
            } else {
                assistantResponseMessage.content = getContentText(message);
            }

            // 只添加非空字段
            if (toolUses.length > 0) {
                assistantResponseMessage.toolUses = toolUses;
            }

            history.push({ assistantResponseMessage });
        }
    }

    // 构建当前消息
    let currentMessage = processedMessages[processedMessages.length - 1];
    let currentContent = '';
    let currentToolResults = [];
    let currentToolUses = [];
    let currentImages = [];

    // 如果最后一条消息是 assistant，需要将其加入 history，然后创建一个 user 类型的 currentMessage
    if (currentMessage.role === 'assistant') {
        console.log('[Kiro] Last message is assistant, moving it to history and creating user currentMessage');

        // 构建 assistant 消息并加入 history
        let assistantResponseMessage = {
            content: '',
            toolUses: []
        };
        if (Array.isArray(currentMessage.content)) {
            for (const part of currentMessage.content) {
                if (part.type === 'text') {
                    assistantResponseMessage.content += part.text;
                } else if (part.type === 'tool_use') {
                    assistantResponseMessage.toolUses.push({
                        input: part.input,
                        name: part.name,
                        toolUseId: part.id
                    });
                }
            }
        } else {
            assistantResponseMessage.content = getContentText(currentMessage);
        }
        if (assistantResponseMessage.toolUses.length === 0) {
            delete assistantResponseMessage.toolUses;
        }
        history.push({ assistantResponseMessage });

        // 设置 currentCont 为 "Continue"
        currentContent = 'Continue';
    } else {
        // 最后一条消息是 user，需要确保 history 最后一个元素是 assistantResponseMessage
        if (history.length > 0) {
            const lastHistoryItem = history[history.length - 1];
            if (!lastHistoryItem.assistantResponseMessage) {
                console.log('[Kiro] History does not end with assistantResponseMessage, adding empty one');
                history.push({
                    assistantResponseMessage: {
                        content: 'Continue'
                    }
                });
            }
        }

        // 处理 user 消息
        if (Array.isArray(currentMessage.content)) {
            for (const part of currentMessage.content) {
                if (part.type === 'text') {
                    currentContent += part.text;
                } else if (part.type === 'tool_result') {
                    currentToolResults.push({
                        content: [{ text: getContentText(part.content) }],
                        status: 'success',
                        toolUseId: part.tool_use_id
                    });
                } else if (part.type === 'tool_use') {
                    currentToolUses.push({
                        input: part.input,
                        name: part.name,
                        toolUseId: part.id
                    });
                } else if (part.type === 'image') {
                    currentImages.push({
                        format: part.source.media_type.split('/')[1],
                        source: {
                            bytes: part.source.data
                        }
                    });
                }
            }
        } else {
            currentContent = getContentText(currentMessage);
        }

        // Kiro API 要求 content 不能为空
        if (!currentContent) {
            currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
        }
    }

    const request = {
        conversationState: {
            chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
            conversationId: conversationId,
            currentMessage: {}
        }
    };

    // 只有当 history 非空时才添加
    if (history.length > 0) {
        request.conversationState.history = history;
    }

    // currentMessage 始终是 userInputMessage 类型
    const userInputMessage = {
        content: currentContent,
        modelId: codewhispererModel,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
    };

    // 只有当 images 非空时才添加
    if (currentImages && currentImages.length > 0) {
        userInputMessage.images = currentImages;
    }

    // 构建 userInputMessageContext
    const userInputMessageContext = {};
    if (currentToolResults.length > 0) {
        // 去重 toolResults
        const uniqueToolResults = [];
        const seenToolUseIds = new Set();
        for (const tr of currentToolResults) {
            if (!seenToolUseIds.has(tr.toolUseId)) {
                seenToolUseIds.add(tr.toolUseId);
                uniqueToolResults.push(tr);
            }
        }
        userInputMessageContext.toolResults = uniqueToolResults;
    }
    if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
        userInputMessageContext.tools = toolsContext.tools;
    }

    // 只有当 userInputMessageContext 有内容时才添加
    if (Object.keys(userInputMessageContext).length > 0) {
        userInputMessage.userInputMessageContext = userInputMessageContext;
    }

    request.conversationState.currentMessage.userInputMessage = userInputMessage;

    if (authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && profileArn) {
        request.profileArn = profileArn;
    }

    return request;
}
