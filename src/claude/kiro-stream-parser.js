/**
 * Kiro 流解析模块
 * 负责解析 AWS Event Stream 格式的数据流
 */

import { parseBracketToolCalls, deduplicateToolCalls } from './kiro-tool-parser.js';

/**
 * 解析 AWS Event Stream 格式，提取所有完整的 JSON 事件
 * @param {string} buffer - 缓冲区字符串
 * @returns {Object} { events: 解析出的事件数组, remaining: 未处理完的缓冲区 }
 */
export function parseAwsEventStreamBuffer(buffer) {
    const events = [];
    let remaining = buffer;
    let searchStart = 0;

    while (true) {
        // 查找真正的 JSON payload 起始位置
        const contentStart = remaining.indexOf('{"content":', searchStart);
        const nameStart = remaining.indexOf('{"name":', searchStart);
        const followupStart = remaining.indexOf('{"followupPrompt":', searchStart);
        const inputStart = remaining.indexOf('{"input":', searchStart);
        const stopStart = remaining.indexOf('{"stop":', searchStart);

        // 找到最早出现的有效 JSON 模式
        const candidates = [contentStart, nameStart, followupStart, inputStart, stopStart].filter(pos => pos >= 0);
        if (candidates.length === 0) break;

        const jsonStart = Math.min(...candidates);
        if (jsonStart < 0) break;

        // 正确处理嵌套的 {} - 使用括号计数法
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = jsonStart; i < remaining.length; i++) {
            const char = remaining[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i;
                        break;
                    }
                }
            }
        }

        if (jsonEnd < 0) {
            // 不完整的 JSON，保留在缓冲区等待更多数据
            remaining = remaining.substring(jsonStart);
            break;
        }

        const jsonStr = remaining.substring(jsonStart, jsonEnd + 1);
        try {
            const parsed = JSON.parse(jsonStr);
            // 处理 content 事件
            if (parsed.content !== undefined && !parsed.followupPrompt) {
                // 处理转义字符
                let decodedContent = parsed.content;
                events.push({ type: 'content', data: decodedContent });
            }
            // 处理结构化工具调用事件 - 开始事件（包含 name 和 toolUseId）
            else if (parsed.name && parsed.toolUseId) {
                events.push({
                    type: 'toolUse',
                    data: {
                        name: parsed.name,
                        toolUseId: parsed.toolUseId,
                        input: parsed.input || '',
                        stop: parsed.stop || false
                    }
                });
            }
            // 处理工具调用的 input 续传事件（只有 input 字段）
            else if (parsed.input !== undefined && !parsed.name) {
                events.push({
                    type: 'toolUseInput',
                    data: {
                        input: parsed.input
                    }
                });
            }
            // 处理工具调用的结束事件（只有 stop 字段）
            else if (parsed.stop !== undefined) {
                events.push({
                    type: 'toolUseStop',
                    data: {
                        stop: parsed.stop
                    }
                });
            }
        } catch (e) {
            // JSON 解析失败，跳过这个位置继续搜索
        }

        searchStart = jsonEnd + 1;
        if (searchStart >= remaining.length) {
            remaining = '';
            break;
        }
    }

    // 如果 searchStart 有进展，截取剩余部分
    if (searchStart > 0 && remaining.length > 0) {
        remaining = remaining.substring(searchStart);
    }

    return { events, remaining };
}

/**
 * 解析事件流数据块（用于非真实流式）
 * @param {Buffer|string} rawData - 原始数据
 * @returns {Object} { content: 文本内容, toolCalls: 工具调用数组 }
 */
export function parseEventStreamChunk(rawData) {
    const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    let fullContent = '';
    const toolCalls = [];
    let currentToolCallDict = null;

    // 改进的 SSE 事件解析：匹配 :message-typeevent 后面的 JSON 数据
    const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
    const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;

    // 首先尝试使用 SSE 格式解析
    let matches = [...rawStr.matchAll(sseEventRegex)];

    // 如果 SSE 格式没有匹配到，回退到旧的格式
    if (matches.length === 0) {
        matches = [...rawStr.matchAll(legacyEventRegex)];
    }

    for (const match of matches) {
        const potentialJsonBlock = match[1];
        if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
            continue;
        }

        // 尝试找到完整的 JSON 对象
        let searchPos = 0;
        while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
            const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
            try {
                const eventData = JSON.parse(jsonCandidate);

                // 优先处理结构化工具调用事件
                if (eventData.name && eventData.toolUseId) {
                    if (!currentToolCallDict) {
                        currentToolCallDict = {
                            id: eventData.toolUseId,
                            type: "function",
                            function: {
                                name: eventData.name,
                                arguments: ""
                            }
                        };
                    }
                    if (eventData.input) {
                        currentToolCallDict.function.arguments += eventData.input;
                    }
                    if (eventData.stop) {
                        try {
                            const args = JSON.parse(currentToolCallDict.function.arguments);
                            currentToolCallDict.function.arguments = JSON.stringify(args);
                        } catch (e) {
                            console.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                        }
                        toolCalls.push(currentToolCallDict);
                        currentToolCallDict = null;
                    }
                } else if (!eventData.followupPrompt && eventData.content) {
                    // 处理内容，移除转义字符
                    let decodedContent = eventData.content;
                    decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n');
                    fullContent += decodedContent;
                }
                break;
            } catch (e) {
                // JSON 解析失败，继续寻找下一个可能的结束位置
                continue;
            }
        }
    }

    // 如果还有未完成的工具调用，添加到列表中
    if (currentToolCallDict) {
        toolCalls.push(currentToolCallDict);
    }

    // 检查解析后文本中的 bracket 格式工具调用
    const bracketToolCalls = parseBracketToolCalls(fullContent);
    if (bracketToolCalls) {
        toolCalls.push(...bracketToolCalls);
        // 从响应文本中移除工具调用文本
        for (const tc of bracketToolCalls) {
            const funcName = tc.function.name;
            const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
            fullContent = fullContent.replace(pattern, '');
        }
        fullContent = fullContent.replace(/\s+/g, ' ').trim();
    }

    const uniqueToolCalls = deduplicateToolCalls(toolCalls);
    return { content: fullContent || '', toolCalls: uniqueToolCalls };
}
