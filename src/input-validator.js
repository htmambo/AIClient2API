/**
 * 输入验证模块
 * 提供请求体和输入数据的验证功能
 */

/**
 * 验证错误类
 */
export class ValidationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
        this.statusCode = 400;
    }
}

/**
 * 请求体大小限制（10MB）
 */
const MAX_REQUEST_SIZE = 10 * 1024 * 1024;

/**
 * 验证请求体大小
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {number} maxSize - 最大大小（字节）
 * @returns {Promise<string>} 请求体字符串
 * @throws {ValidationError}
 */
export function validateRequestSize(req, maxSize = MAX_REQUEST_SIZE) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                reject(new ValidationError(
                    `Request body too large. Maximum size is ${maxSize} bytes`,
                    'body'
                ));
                return;
            }
            body += chunk.toString();
        });

        req.on('end', () => {
            resolve(body);
        });

        req.on('error', err => {
            reject(new ValidationError(`Request error: ${err.message}`, 'request'));
        });
    });
}

/**
 * 验证 JSON 格式
 * @param {string} jsonString - JSON 字符串
 * @returns {Object} 解析后的对象
 * @throws {ValidationError}
 */
export function validateJSON(jsonString) {
    if (!jsonString || jsonString.trim() === '') {
        return {};
    }

    try {
        const parsed = JSON.parse(jsonString);
        if (typeof parsed !== 'object' || parsed === null) {
            throw new ValidationError('Request body must be a JSON object', 'body');
        }
        return parsed;
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }
        throw new ValidationError(`Invalid JSON: ${error.message}`, 'body');
    }
}

/**
 * 验证 Claude Messages API 请求体
 * @param {Object} body - 请求体对象
 * @throws {ValidationError}
 */
export function validateClaudeMessagesRequest(body) {
    // 验证必填字段
    if (!body.model) {
        throw new ValidationError('Missing required field: model', 'model');
    }

    if (!body.messages || !Array.isArray(body.messages)) {
        throw new ValidationError('Missing or invalid field: messages (must be an array)', 'messages');
    }

    if (body.messages.length === 0) {
        throw new ValidationError('messages array cannot be empty', 'messages');
    }

    // 验证 max_tokens
    if (body.max_tokens !== undefined) {
        const maxTokens = Number(body.max_tokens);
        if (isNaN(maxTokens) || maxTokens < 1 || maxTokens > 200000) {
            throw new ValidationError('max_tokens must be between 1 and 200000', 'max_tokens');
        }
    }

    // 验证 temperature
    if (body.temperature !== undefined) {
        const temp = Number(body.temperature);
        if (isNaN(temp) || temp < 0 || temp > 1) {
            throw new ValidationError('temperature must be between 0 and 1', 'temperature');
        }
    }

    // 验证 top_p
    if (body.top_p !== undefined) {
        const topP = Number(body.top_p);
        if (isNaN(topP) || topP < 0 || topP > 1) {
            throw new ValidationError('top_p must be between 0 and 1', 'top_p');
        }
    }

    // 验证 top_k
    if (body.top_k !== undefined) {
        const topK = Number(body.top_k);
        if (isNaN(topK) || topK < 0) {
            throw new ValidationError('top_k must be a non-negative number', 'top_k');
        }
    }

    // 验证 messages 数组
    for (let i = 0; i < body.messages.length; i++) {
        const message = body.messages[i];

        if (!message.role) {
            throw new ValidationError(`messages[${i}]: Missing required field: role`, `messages[${i}].role`);
        }

        if (!['user', 'assistant'].includes(message.role)) {
            throw new ValidationError(
                `messages[${i}]: role must be 'user' or 'assistant'`,
                `messages[${i}].role`
            );
        }

        if (!message.content) {
            throw new ValidationError(`messages[${i}]: Missing required field: content`, `messages[${i}].content`);
        }

        // 验证 content 类型
        if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
            throw new ValidationError(
                `messages[${i}]: content must be a string or array`,
                `messages[${i}].content`
            );
        }

        // 如果是数组，验证每个 content block
        if (Array.isArray(message.content)) {
            for (let j = 0; j < message.content.length; j++) {
                const block = message.content[j];

                if (!block.type) {
                    throw new ValidationError(
                        `messages[${i}].content[${j}]: Missing required field: type`,
                        `messages[${i}].content[${j}].type`
                    );
                }

                const validTypes = ['text', 'image', 'tool_use', 'tool_result'];
                if (!validTypes.includes(block.type)) {
                    throw new ValidationError(
                        `messages[${i}].content[${j}]: type must be one of: ${validTypes.join(', ')}`,
                        `messages[${i}].content[${j}].type`
                    );
                }

                // 验证 text block
                if (block.type === 'text' && !block.text) {
                    throw new ValidationError(
                        `messages[${i}].content[${j}]: text block must have 'text' field`,
                        `messages[${i}].content[${j}].text`
                    );
                }

                // 验证 image block
                if (block.type === 'image') {
                    if (!block.source || !block.source.type || !block.source.data) {
                        throw new ValidationError(
                            `messages[${i}].content[${j}]: image block must have source.type and source.data`,
                            `messages[${i}].content[${j}].source`
                        );
                    }
                }

                // 验证 tool_use block
                if (block.type === 'tool_use') {
                    if (!block.id || !block.name) {
                        throw new ValidationError(
                            `messages[${i}].content[${j}]: tool_use block must have 'id' and 'name'`,
                            `messages[${i}].content[${j}]`
                        );
                    }
                }

                // 验证 tool_result block
                if (block.type === 'tool_result') {
                    if (!block.tool_use_id) {
                        throw new ValidationError(
                            `messages[${i}].content[${j}]: tool_result block must have 'tool_use_id'`,
                            `messages[${i}].content[${j}].tool_use_id`
                        );
                    }
                }
            }
        }
    }

    // 验证 tools 数组
    if (body.tools !== undefined) {
        if (!Array.isArray(body.tools)) {
            throw new ValidationError('tools must be an array', 'tools');
        }

        for (let i = 0; i < body.tools.length; i++) {
            const tool = body.tools[i];

            if (!tool.name) {
                throw new ValidationError(`tools[${i}]: Missing required field: name`, `tools[${i}].name`);
            }

            if (!tool.input_schema) {
                throw new ValidationError(
                    `tools[${i}]: Missing required field: input_schema`,
                    `tools[${i}].input_schema`
                );
            }

            if (typeof tool.input_schema !== 'object') {
                throw new ValidationError(
                    `tools[${i}]: input_schema must be an object`,
                    `tools[${i}].input_schema`
                );
            }
        }
    }
}

/**
 * 验证模型名称
 * @param {string} model - 模型名称
 * @param {Array<string>} allowedModels - 允许的模型列表
 * @throws {ValidationError}
 */
export function validateModel(model, allowedModels = []) {
    if (!model || typeof model !== 'string') {
        throw new ValidationError('model must be a non-empty string', 'model');
    }

    if (allowedModels.length > 0 && !allowedModels.includes(model)) {
        throw new ValidationError(
            `Invalid model: ${model}. Allowed models: ${allowedModels.join(', ')}`,
            'model'
        );
    }
}

/**
 * 清理和验证字符串输入（防止注入攻击）
 * @param {string} input - 输入字符串
 * @param {Object} options - 选项
 * @returns {string} 清理后的字符串
 */
export function sanitizeString(input, options = {}) {
    const {
        maxLength = 10000,
        allowHTML = false,
        allowNewlines = true,
    } = options;

    if (typeof input !== 'string') {
        return '';
    }

    let sanitized = input;

    // 限制长度
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength);
    }

    // 移除 HTML 标签（如果不允许）
    if (!allowHTML) {
        sanitized = sanitized.replace(/<[^>]*>/g, '');
    }

    // 移除换行符（如果不允许）
    if (!allowNewlines) {
        sanitized = sanitized.replace(/[\r\n]/g, ' ');
    }

    return sanitized;
}

/**
 * 验证 API Key
 * @param {string} apiKey - API Key
 * @throws {ValidationError}
 */
export function validateApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
        throw new ValidationError('API key must be a non-empty string', 'api_key');
    }

    if (apiKey.length < 8) {
        throw new ValidationError('API key is too short', 'api_key');
    }

    // 检查是否包含非法字符
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(apiKey)) {
        throw new ValidationError('API key contains invalid characters', 'api_key');
    }
}

/**
 * 验证 URL
 * @param {string} url - URL 字符串
 * @param {Object} options - 选项
 * @throws {ValidationError}
 */
export function validateUrl(url, options = {}) {
    const { allowedProtocols = ['http:', 'https:'] } = options;

    if (!url || typeof url !== 'string') {
        throw new ValidationError('URL must be a non-empty string', 'url');
    }

    try {
        const parsed = new URL(url);

        if (!allowedProtocols.includes(parsed.protocol)) {
            throw new ValidationError(
                `URL protocol must be one of: ${allowedProtocols.join(', ')}`,
                'url'
            );
        }
    } catch (error) {
        throw new ValidationError(`Invalid URL: ${error.message}`, 'url');
    }
}

/**
 * 批量验证对象字段
 * @param {Object} obj - 要验证的对象
 * @param {Object} rules - 验证规则
 * @throws {ValidationError}
 */
export function validateFields(obj, rules) {
    const errors = [];

    for (const [field, rule] of Object.entries(rules)) {
        try {
            const value = obj[field];

            // 必填验证
            if (rule.required && (value === undefined || value === null || value === '')) {
                throw new ValidationError(`Missing required field: ${field}`, field);
            }

            // 跳过空值的其他验证
            if (value === undefined || value === null || value === '') {
                continue;
            }

            // 类型验证
            if (rule.type) {
                const actualType = Array.isArray(value) ? 'array' : typeof value;
                if (actualType !== rule.type) {
                    throw new ValidationError(
                        `Field ${field} must be of type ${rule.type}`,
                        field
                    );
                }
            }

            // 自定义验证函数
            if (rule.validator && typeof rule.validator === 'function') {
                rule.validator(value, field);
            }
        } catch (error) {
            if (error instanceof ValidationError) {
                errors.push(error);
            } else {
                throw error;
            }
        }
    }

    if (errors.length > 0) {
        const errorMessages = errors.map(e => `  - ${e.message}`).join('\n');
        throw new ValidationError(
            `Validation failed:\n${errorMessages}`,
            'multiple'
        );
    }
}
