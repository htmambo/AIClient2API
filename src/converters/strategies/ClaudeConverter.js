/**
 * Claude转换器
 * 处理Claude（Anthropic）协议与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseConverter } from '../BaseConverter.js';
import {
    checkAndAssignOrDefault,
    cleanJsonSchemaProperties as cleanJsonSchema,
    determineReasoningEffortFromBudget,
    OPENAI_DEFAULT_MAX_TOKENS,
    OPENAI_DEFAULT_TEMPERATURE,
    OPENAI_DEFAULT_TOP_P
} from '../utils.js';
import { MODEL_PROTOCOL_PREFIX } from '../../common.js';
import {
    generateResponseCreated,
    generateResponseInProgress,
    generateOutputItemAdded,
    generateContentPartAdded,
    generateOutputTextDone,
    generateContentPartDone,
    generateOutputItemDone,
    generateResponseCompleted
} from '../../openai/openai-responses-core.mjs';

/**
 * Claude转换器类
 * 实现Claude协议到其他协议的转换
 */
export class ClaudeConverter extends BaseConverter {
    constructor() {
        super('claude');
    }

    /**
     * 转换请求
     */
    convertRequest(data, targetProtocol) {
        switch (targetProtocol) {
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换响应
     */
    convertResponse(data, targetProtocol, model) {
        switch (targetProtocol) {
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换流式响应块
     */
    convertStreamChunk(chunk, targetProtocol, model) {
        switch (targetProtocol) {
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换模型列表
     */
    convertModelList(data, targetProtocol) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIModelList(data);
            default:
                return data;
        }
    }

    // =========================================================================
    // Claude -> OpenAI 转换
    // =========================================================================

    /**
     * Claude请求 -> OpenAI请求
     */
    toOpenAIRequest(claudeRequest) {
        const openaiMessages = [];
        let systemMessageContent = '';

        // 添加系统消息
        if (claudeRequest.system) {
            systemMessageContent = claudeRequest.system;
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            const tempOpenAIMessages = [];
            for (const msg of claudeRequest.messages) {
                const role = msg.role;

                // 处理用户的工具结果消息
                if (role === "user" && Array.isArray(msg.content)) {
                    const hasToolResult = msg.content.some(
                        item => item && typeof item === 'object' && item.type === "tool_result"
                    );

                    if (hasToolResult) {
                        for (const item of msg.content) {
                            if (item && typeof item === 'object' && item.type === "tool_result") {
                                const toolUseId = item.tool_use_id || item.id || "";
                                const contentStr = String(item.content || "");
                                tempOpenAIMessages.push({
                                    role: "tool",
                                    tool_call_id: toolUseId,
                                    content: contentStr,
                                });
                            }
                        }
                        continue;
                    }
                }

                // 处理assistant消息中的工具调用
                if (role === "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
                    const firstPart = msg.content[0];
                    if (firstPart.type === "tool_use") {
                        const funcName = firstPart.name || "";
                        const funcArgs = firstPart.input || {};
                        tempOpenAIMessages.push({
                            role: "assistant",
                            content: '',
                            tool_calls: [
                                {
                                    id: firstPart.id || `call_${funcName}_1`,
                                    type: "function",
                                    function: {
                                        name: funcName,
                                        arguments: JSON.stringify(funcArgs)
                                    },
                                    index: firstPart.index || 0
                                }
                            ]
                        });
                        continue;
                    }
                }

                // 普通文本消息
                const contentConverted = this.processClaudeContentToOpenAIContent(msg.content || "");
                if (contentConverted && (Array.isArray(contentConverted) ? contentConverted.length > 0 : contentConverted.trim().length > 0)) {
                    tempOpenAIMessages.push({
                        role: role,
                        content: contentConverted
                    });
                }
            }

            // OpenAI兼容性校验
            const validatedMessages = [];
            for (let idx = 0; idx < tempOpenAIMessages.length; idx++) {
                const m = tempOpenAIMessages[idx];
                if (m.role === "assistant" && m.tool_calls) {
                    const callIds = m.tool_calls.map(tc => tc.id).filter(id => id);
                    let unmatched = new Set(callIds);
                    for (let laterIdx = idx + 1; laterIdx < tempOpenAIMessages.length; laterIdx++) {
                        const later = tempOpenAIMessages[laterIdx];
                        if (later.role === "tool" && unmatched.has(later.tool_call_id)) {
                            unmatched.delete(later.tool_call_id);
                        }
                        if (unmatched.size === 0) break;
                    }
                    if (unmatched.size > 0) {
                        m.tool_calls = m.tool_calls.filter(tc => !unmatched.has(tc.id));
                        if (m.tool_calls.length === 0) {
                            delete m.tool_calls;
                            if (m.content === null) m.content = "";
                        }
                    }
                }
                validatedMessages.push(m);
            }
            openaiMessages.push(...validatedMessages);
        }

        const openaiRequest = {
            model: claudeRequest.model,
            messages: openaiMessages,
            max_tokens: checkAndAssignOrDefault(claudeRequest.max_tokens, OPENAI_DEFAULT_MAX_TOKENS),
            temperature: checkAndAssignOrDefault(claudeRequest.temperature, OPENAI_DEFAULT_TEMPERATURE),
            top_p: checkAndAssignOrDefault(claudeRequest.top_p, OPENAI_DEFAULT_TOP_P),
            stream: claudeRequest.stream,
        };

        // 处理工具
        if (claudeRequest.tools) {
            const openaiTools = [];
            for (const tool of claudeRequest.tools) {
                openaiTools.push({
                    type: "function",
                    function: {
                        name: tool.name || "",
                        description: tool.description || "",
                        parameters: cleanJsonSchema(tool.input_schema || {})
                    }
                });
            }
            openaiRequest.tools = openaiTools;
            openaiRequest.tool_choice = "auto";
        }

        // 处理thinking转换
        if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
            const budgetTokens = claudeRequest.thinking.budget_tokens;
            const reasoningEffort = determineReasoningEffortFromBudget(budgetTokens);
            openaiRequest.reasoning_effort = reasoningEffort;

            let maxCompletionTokens = null;
            if (claudeRequest.max_tokens !== undefined) {
                maxCompletionTokens = claudeRequest.max_tokens;
                delete openaiRequest.max_tokens;
            } else {
                const envMaxTokens = process.env.OPENAI_REASONING_MAX_TOKENS;
                if (envMaxTokens) {
                    try {
                        maxCompletionTokens = parseInt(envMaxTokens, 10);
                    } catch (e) {
                        console.warn(`Invalid OPENAI_REASONING_MAX_TOKENS value '${envMaxTokens}'`);
                    }
                }
                if (!envMaxTokens) {
                    throw new Error("For OpenAI reasoning models, max_completion_tokens is required.");
                }
            }
            openaiRequest.max_completion_tokens = maxCompletionTokens;
        }

        // 添加系统消息
        if (systemMessageContent) {
            let stringifiedSystemMessageContent = systemMessageContent;
            if (Array.isArray(systemMessageContent)) {
                stringifiedSystemMessageContent = systemMessageContent.map(item =>
                    typeof item === 'string' ? item : item.text).join('\n');
            }
            openaiRequest.messages.unshift({ role: 'system', content: stringifiedSystemMessageContent });
        }

        return openaiRequest;
    }

    /**
     * Claude响应 -> OpenAI响应
     */
    toOpenAIResponse(claudeResponse, model) {
        if (!claudeResponse || !claudeResponse.content || claudeResponse.content.length === 0) {
            return {
                id: `chatcmpl-${uuidv4()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "",
                    },
                    finish_reason: "stop",
                }],
                usage: {
                    prompt_tokens: claudeResponse.usage?.input_tokens || 0,
                    completion_tokens: claudeResponse.usage?.output_tokens || 0,
                    total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
                },
            };
        }

        // 检查是否包含 tool_use
        const hasToolUse = claudeResponse.content.some(block => block && block.type === 'tool_use');
        
        let message = {
            role: "assistant",
            content: null
        };

        if (hasToolUse) {
            // 处理包含工具调用的响应
            const toolCalls = [];
            let textContent = '';

            for (const block of claudeResponse.content) {
                if (!block) continue;

                if (block.type === 'text') {
                    textContent += block.text || '';
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id || `call_${block.name}_${Date.now()}`,
                        type: "function",
                        function: {
                            name: block.name || '',
                            arguments: JSON.stringify(block.input || {})
                        }
                    });
                }
            }

            message.content = textContent || null;
            if (toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }
        } else {
            // 处理普通文本响应
            message.content = this.processClaudeResponseContent(claudeResponse.content);
        }

        // 处理 finish_reason
        let finishReason = 'stop';
        if (claudeResponse.stop_reason === 'end_turn') {
            finishReason = 'stop';
        } else if (claudeResponse.stop_reason === 'max_tokens') {
            finishReason = 'length';
        } else if (claudeResponse.stop_reason === 'tool_use') {
            finishReason = 'tool_calls';
        } else if (claudeResponse.stop_reason) {
            finishReason = claudeResponse.stop_reason;
        }

        return {
            id: `chatcmpl-${uuidv4()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: message,
                finish_reason: finishReason,
            }],
            usage: {
                prompt_tokens: claudeResponse.usage?.input_tokens || 0,
                completion_tokens: claudeResponse.usage?.output_tokens || 0,
                total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
                cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                }
            },
        };
    }

    /**
     * Claude流式响应 -> OpenAI流式响应
     */
    toOpenAIStreamChunk(claudeChunk, model) {
        if (!claudeChunk) return null;

        // 处理 Claude 流式事件
        const chunkId = `chatcmpl-${uuidv4()}`;
        const timestamp = Math.floor(Date.now() / 1000);

        // message_start 事件
        if (claudeChunk.type === 'message_start') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        role: "assistant",
                        content: ""
                    },
                    finish_reason: null
                }],
                usage: {
                    prompt_tokens: claudeChunk.message?.usage?.input_tokens || 0,
                    completion_tokens: 0,
                    total_tokens: claudeChunk.message?.usage?.input_tokens || 0,
                    cached_tokens: claudeChunk.message?.usage?.cache_read_input_tokens || 0
                }
            };
        }

        // content_block_start 事件
        if (claudeChunk.type === 'content_block_start') {
            const contentBlock = claudeChunk.content_block;
            
            // 处理 tool_use 类型
            if (contentBlock && contentBlock.type === 'tool_use') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: claudeChunk.index || 0,
                                id: contentBlock.id,
                                type: "function",
                                function: {
                                    name: contentBlock.name,
                                    arguments: ""
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 text 类型
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        content: ""
                    },
                    finish_reason: null
                }]
            };
        }

        // content_block_delta 事件
        if (claudeChunk.type === 'content_block_delta') {
            const delta = claudeChunk.delta;
            
            // 处理 text_delta
            if (delta && delta.type === 'text_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            content: delta.text || ""
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 thinking_delta (推理内容)
            if (delta && delta.type === 'thinking_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            reasoning_content: delta.thinking || ""
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 input_json_delta (tool arguments)
            if (delta && delta.type === 'input_json_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: claudeChunk.index || 0,
                                function: {
                                    arguments: delta.partial_json || ""
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }
        }

        // content_block_stop 事件
        if (claudeChunk.type === 'content_block_stop') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: null
                }]
            };
        }

        // message_delta 事件
        if (claudeChunk.type === 'message_delta') {
            const stopReason = claudeChunk.delta?.stop_reason;
            const finishReason = stopReason === 'end_turn' ? 'stop' :
                                stopReason === 'max_tokens' ? 'length' :
                                stopReason === 'tool_use' ? 'tool_calls' :
                                stopReason || 'stop';

            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: finishReason
                }],
                usage: claudeChunk.usage ? {
                    prompt_tokens: claudeChunk.usage.input_tokens || 0,
                    completion_tokens: claudeChunk.usage.output_tokens || 0,
                    total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0),
                    cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0,
                    prompt_tokens_details: {
                        cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0
                    }
                } : undefined
            };
        }

        // message_stop 事件
        if (claudeChunk.type === 'message_stop') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                }]
            };
        }

        // 兼容旧格式：如果是字符串，直接作为文本内容
        if (typeof claudeChunk === 'string') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        content: claudeChunk
                    },
                    finish_reason: null
                }]
            };
        }

        return null;
    }

    /**
     * Claude模型列表 -> OpenAI模型列表
     */
    toOpenAIModelList(claudeModels) {
        return {
            object: "list",
            data: claudeModels.models.map(m => ({
                id: m.id || m.name,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "anthropic",
            })),
        };
    }

    /**
     * 处理Claude内容到OpenAI格式
     */
    processClaudeContentToOpenAIContent(content) {
        if (!content || !Array.isArray(content)) return [];
        
        const contentArray = [];
        
        content.forEach(block => {
            if (!block) return;
            
            switch (block.type) {
                case 'text':
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
                    break;
                    
                case 'image':
                    if (block.source && block.source.type === 'base64') {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`
                            }
                        });
                    }
                    break;
                    
                case 'tool_use':
                    contentArray.push({
                        type: 'text',
                        text: `[Tool use: ${block.name}]`
                    });
                    break;
                    
                case 'tool_result':
                    contentArray.push({
                        type: 'text',
                        text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                    });
                    break;
                    
                default:
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
            }
        });
        
        return contentArray;
    }

    /**
     * 处理Claude响应内容
     */
    processClaudeResponseContent(content) {
        if (!content || !Array.isArray(content)) return '';
        
        const contentArray = [];
        
        content.forEach(block => {
            if (!block) return;
            
            switch (block.type) {
                case 'text':
                    contentArray.push({
                        type: 'text',
                        text: block.text || ''
                    });
                    break;
                    
                case 'image':
                    if (block.source && block.source.type === 'base64') {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`
                            }
                        });
                    }
                    break;
                    
                default:
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
            }
        });
        
        return contentArray.length === 1 && contentArray[0].type === 'text'
            ? contentArray[0].text
            : contentArray;
    }

    // =========================================================================
    // Claude -> OpenAI Responses 转换
    // =========================================================================

    /**
     * Claude请求 -> OpenAI Responses请求
     */
    toOpenAIResponsesRequest(claudeRequest) {
        // 转换为OpenAI Responses格式
        const responsesRequest = {
            model: claudeRequest.model,
            max_tokens: checkAndAssignOrDefault(claudeRequest.max_tokens, OPENAI_DEFAULT_MAX_TOKENS),
            temperature: checkAndAssignOrDefault(claudeRequest.temperature, OPENAI_DEFAULT_TEMPERATURE),
            top_p: checkAndAssignOrDefault(claudeRequest.top_p, OPENAI_DEFAULT_TOP_P),
        };

        // 处理系统指令
        if (claudeRequest.system) {
            responsesRequest.instructions = claudeRequest.system;
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            responsesRequest.input = claudeRequest.messages;
        }

        return responsesRequest;
    }

    /**
     * Claude响应 -> OpenAI Responses响应
     */
    toOpenAIResponsesResponse(claudeResponse, model) {
        const content = this.processClaudeResponseContent(claudeResponse.content);
        const textContent = typeof content === 'string' ? content : JSON.stringify(content);

        let output = [];
        output.push({
            type: "message",
            id: `msg_${uuidv4().replace(/-/g, '')}`,
            summary: [],
            role: "assistant",
            status: "completed",
            content: [{
                annotations: [],
                logprobs: [],
                text: textContent,
                type: "output_text"
            }]
        });

        return {
            background: false,
            created_at: Math.floor(Date.now() / 1000),
            error: null,
            id: `resp_${uuidv4().replace(/-/g, '')}`,
            incomplete_details: null,
            max_output_tokens: null,
            max_tool_calls: null,
            metadata: {},
            model: model || claudeResponse.model,
            object: "response",
            output: output,
            parallel_tool_calls: true,
            previous_response_id: null,
            prompt_cache_key: null,
            reasoning: {},
            safety_identifier: "user-" + uuidv4().replace(/-/g, ''),
            service_tier: "default",
            status: "completed",
            store: false,
            temperature: 1,
            text: {
                format: { type: "text" },
            },
            tool_choice: "auto",
            tools: [],
            top_logprobs: 0,
            top_p: 1,
            truncation: "disabled",
            usage: {
                input_tokens: claudeResponse.usage?.input_tokens || 0,
                input_tokens_details: {
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                },
                output_tokens: claudeResponse.usage?.output_tokens || 0,
                output_tokens_details: {
                    reasoning_tokens: 0
                },
                total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
            },
            user: null
        };
    }

    /**
     * Claude流式响应 -> OpenAI Responses流式响应
     */
    toOpenAIResponsesStreamChunk(claudeChunk, model, requestId = null) {
        if (!claudeChunk) return [];

        const responseId = requestId || `resp_${uuidv4().replace(/-/g, '')}`;
        const events = [];

        // message_start 事件 - 流开始
        if (claudeChunk.type === 'message_start') {
            events.push(
                generateResponseCreated(responseId, model || 'unknown'),
                generateResponseInProgress(responseId),
                generateOutputItemAdded(responseId),
                generateContentPartAdded(responseId)
            );
        }

        // content_block_start 事件
        if (claudeChunk.type === 'content_block_start') {
            const contentBlock = claudeChunk.content_block;
            
            // 对于 tool_use 类型，添加工具调用项
            if (contentBlock && contentBlock.type === 'tool_use') {
                events.push({
                    item: {
                        id: contentBlock.id,
                        type: "function_call",
                        name: contentBlock.name,
                        arguments: "",
                        status: "in_progress"
                    },
                    output_index: claudeChunk.index || 0,
                    sequence_number: 2,
                    type: "response.output_item.added"
                });
            }
        }

        // content_block_delta 事件
        if (claudeChunk.type === 'content_block_delta') {
            const delta = claudeChunk.delta;
            
            // 处理文本增量
            if (delta && delta.type === 'text_delta') {
                events.push({
                    delta: delta.text || "",
                    item_id: `msg_${uuidv4().replace(/-/g, '')}`,
                    output_index: claudeChunk.index || 0,
                    sequence_number: 3,
                    type: "response.output_text.delta"
                });
            }
            // 处理推理内容增量
            else if (delta && delta.type === 'thinking_delta') {
                events.push({
                    delta: delta.thinking || "",
                    item_id: `thinking_${uuidv4().replace(/-/g, '')}`,
                    output_index: claudeChunk.index || 0,
                    sequence_number: 3,
                    type: "response.reasoning_summary_text.delta"
                });
            }
            // 处理工具调用参数增量
            else if (delta && delta.type === 'input_json_delta') {
                events.push({
                    delta: delta.partial_json || "",
                    item_id: `call_${uuidv4().replace(/-/g, '')}`,
                    output_index: claudeChunk.index || 0,
                    sequence_number: 3,
                    type: "response.custom_tool_call_input.delta"
                });
            }
        }

        // content_block_stop 事件
        if (claudeChunk.type === 'content_block_stop') {
            events.push({
                item_id: `msg_${uuidv4().replace(/-/g, '')}`,
                output_index: claudeChunk.index || 0,
                sequence_number: 4,
                type: "response.output_item.done"
            });
        }

        // message_delta 事件 - 流结束
        if (claudeChunk.type === 'message_delta') {
            // events.push(
            //     generateOutputTextDone(responseId),
            //     generateContentPartDone(responseId),
            //     generateOutputItemDone(responseId),
            //     generateResponseCompleted(responseId)
            // );
            
            // 如果有 usage 信息，更新最后一个事件
            if (claudeChunk.usage && events.length > 0) {
                const lastEvent = events[events.length - 1];
                if (lastEvent.response) {
                    lastEvent.response.usage = {
                        input_tokens: claudeChunk.usage.input_tokens || 0,
                        input_tokens_details: {
                            cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0
                        },
                        output_tokens: claudeChunk.usage.output_tokens || 0,
                        output_tokens_details: {
                            reasoning_tokens: 0
                        },
                        total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0)
                    };
                }
            }
        }

        // message_stop 事件
        if (claudeChunk.type === 'message_stop') {
            events.push(
                generateOutputTextDone(responseId),
                generateContentPartDone(responseId),
                generateOutputItemDone(responseId),
                generateResponseCompleted(responseId)
            );
        }

        return events;
    }
}

export default ClaudeConverter;
