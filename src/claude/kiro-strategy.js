import { promises as fs } from 'fs';
import { extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX, FETCH_SYSTEM_PROMPT_FILE } from '../common.js';

/**
 * Kiro 提供者策略实现。
 * 负责处理所有 Kiro 特定的请求与响应处理逻辑。
 */
export class KiroStrategy {
    /**
     * 提取模型与流式信息。
     * 
     * @param {object} req - HTTP request object. （HTTP 请求对象）
     * @param {object} requestBody - Parsed request body. （解析后的请求体）
     * @returns {{model: string, isStream: boolean}} Object containing model name and stream status. （返回模型名称和是否为流的标志）
     */
    extractModelAndStreamInfo(req, requestBody) {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    /**
     * 从响应对象中提取文本内容（支持不同的 content 类型，如 text、content_block_delta 等）。
     * 
     * @param {object} response - API response object. （API 响应对象）
     * @returns {string} Extracted text content. （提取出的文本内容，如果不存在则返回空字符串）
     */
    extractResponseText(response) {
        if (response.type === 'content_block_delta' && response.delta) {
            if (response.delta.type === 'text_delta') {
                return response.delta.text;
            }
            if (response.delta.type === 'input_json_delta') {
                return response.delta.partial_json;
            }
        }
        if (response.content && Array.isArray(response.content)) {
            return response.content
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text)
                .join('');
        } else if (response.content && response.content.type === 'text') {
            return response.content.text;
        }
        return '';
    }

    /**
     * 从请求体中提取用于模型的 prompt 文本（主要从 messages 的最后一条消息提取）。
     * 
     * @param {object} requestBody - Request body object. （请求体对象）
     * @returns {string} Extracted prompt text. （提取出的 prompt 文本，若不存在则返回空字符串）
     */
    extractPromptText(requestBody) {
        if (requestBody.messages && requestBody.messages.length > 0) {
            const lastMessage = requestBody.messages[requestBody.messages.length - 1];
            if (lastMessage.content && Array.isArray(lastMessage.content)) {
                return lastMessage.content.map(block => block.text).join('');
            }
            return lastMessage.content;
        }
        return '';
    }

    /**
     * 将配置中的系统提示（SYSTEM_PROMPT_FILE）应用到请求体中，支持 append 模式或覆盖模式。
     * 
     * @param {object} config - Configuration object. （配置对象，包含 SYSTEM_PROMPT_FILE_PATH/SYSTEM_PROMPT_CONTENT/SYSTEM_PROMPT_MODE 等）
     * @param {object} requestBody - Request body object. （请求体对象）
     * @returns {Promise<object>} Modified request body. （返回修改后的请求体）
     */
    async applySystemPromptFromFile(config, requestBody) {
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.CLAUDE);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        requestBody.system = newSystemText;
        console.log(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'claude'.`);

        return requestBody;
    }

    /**
     * 管理系统提示文件：根据请求体中的 system prompt 更新持久化的系统提示文件。
     * 
     * @param {object} requestBody - Request body object. （请求体对象）
     * @returns {Promise<void>} （无返回值，执行文件写入/清理操作）
     */
    async manageSystemPrompt(requestBody) {
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.CLAUDE);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.CLAUDE);
    }

    /**
     * 更新系统提示文件的底层实现：如果 incomingSystemText 与当前文件内容不同则写入新内容；如果 incomingSystemText 为空且文件存在内容则清空文件。
     * 
     * @param {string} incomingSystemText - Incoming system prompt text. （新到达的系统提示文本）
     * @param {string} providerName - Provider name (for logging). （提供者名称，用于日志）
     * @returns {Promise<void>} （无返回值）
     * @private
     */
    async _updateSystemPromptFile(incomingSystemText, providerName) {
        let currentSystemText = '';
        try {
            currentSystemText = await fs.readFile(FETCH_SYSTEM_PROMPT_FILE, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`[System Prompt Manager] Error reading system prompt file: ${error.message}`);
            }
        }

        try {
            if (incomingSystemText && incomingSystemText !== currentSystemText) {
                await fs.writeFile(FETCH_SYSTEM_PROMPT_FILE, incomingSystemText);
                console.log(`[System Prompt Manager] System prompt updated in file for provider '${providerName}'.`);
            } else if (!incomingSystemText && currentSystemText) {
                await fs.writeFile(FETCH_SYSTEM_PROMPT_FILE, '');
                console.log('[System Prompt Manager] System prompt cleared from file.');
            }
        } catch (error) {
            console.error(`[System Prompt Manager] Failed to manage system prompt file: ${error.message}`);
        }
    }
}
