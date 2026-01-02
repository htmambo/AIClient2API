/**
 * 配置验证模块
 * 提供配置项的验证和默认值管理
 */

/**
 * 配置验证错误类
 */
export class ConfigValidationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'ConfigValidationError';
        this.field = field;
    }
}

/**
 * 验证器类型枚举
 */
export const ValidatorType = {
    STRING: 'string',
    NUMBER: 'number',
    BOOLEAN: 'boolean',
    ARRAY: 'array',
    OBJECT: 'object',
    ENUM: 'enum',
    URL: 'url',
    PORT: 'port',
    PATH: 'path',
};

/**
 * 配置项定义
 */
export const CONFIG_SCHEMA = {
    // 服务器配置
    HOST: {
        type: ValidatorType.STRING,
        default: '0.0.0.0',
        description: 'Server host address',
    },
    SERVER_PORT: {
        type: ValidatorType.PORT,
        default: 3000,
        description: 'Server port number',
        min: 1,
        max: 65535,
    },
    REQUIRED_API_KEY: {
        type: ValidatorType.STRING,
        required: false,
        description: 'API key for authentication',
    },

    // 日志配置
    PROMPT_LOG_MODE: {
        type: ValidatorType.ENUM,
        default: 'none',
        enum: ['none', 'console', 'file'],
        description: 'Prompt logging mode',
    },
    PROMPT_LOG_FILENAME: {
        type: ValidatorType.PATH,
        required: false,
        description: 'Prompt log file path',
    },

    // 模型提供商配置
    MODEL_PROVIDER: {
        type: ValidatorType.STRING,
        default: 'claude-kiro-oauth',
        description: 'Default model provider',
    },
    DEFAULT_MODEL_PROVIDERS: {
        type: ValidatorType.ARRAY,
        default: [],
        description: 'List of default model providers',
    },

    // Kiro 配置
    KIRO_OAUTH_CREDS_DIR_PATH: {
        type: ValidatorType.PATH,
        required: false,
        description: 'Kiro OAuth credentials directory path',
    },
    KIRO_OAUTH_CREDS_FILE_PATH: {
        type: ValidatorType.PATH,
        required: false,
        description: 'Kiro OAuth credentials file path',
    },
    KIRO_OAUTH_CREDS_BASE64: {
        type: ValidatorType.STRING,
        required: false,
        description: 'Kiro OAuth credentials in Base64 format',
    },
    KIRO_BASE_URL: {
        type: ValidatorType.URL,
        required: false,
        description: 'Kiro API base URL',
    },
    KIRO_REFRESH_URL: {
        type: ValidatorType.URL,
        required: false,
        description: 'Kiro token refresh URL',
    },
    KIRO_REFRESH_IDC_URL: {
        type: ValidatorType.URL,
        required: false,
        description: 'Kiro IDC token refresh URL',
    },
    USE_SYSTEM_PROXY_KIRO: {
        type: ValidatorType.BOOLEAN,
        default: false,
        description: 'Use system proxy for Kiro API',
    },

    // 定时任务配置
    CRON_REFRESH_TOKEN: {
        type: ValidatorType.BOOLEAN,
        default: false,
        description: 'Enable token refresh cron job',
    },
    CRON_NEAR_MINUTES: {
        type: ValidatorType.NUMBER,
        default: 10,
        min: 1,
        max: 60,
        description: 'Minutes before token expiry to trigger refresh',
    },

    // 请求配置
    REQUEST_MAX_RETRIES: {
        type: ValidatorType.NUMBER,
        default: 3,
        min: 0,
        max: 10,
        description: 'Maximum number of request retries',
    },
    REQUEST_BASE_DELAY: {
        type: ValidatorType.NUMBER,
        default: 1000,
        min: 100,
        max: 10000,
        description: 'Base delay for exponential backoff (ms)',
    },

    // 提供商池配置
    PROVIDER_POOLS_FILE_PATH: {
        type: ValidatorType.PATH,
        default: 'configs/provider_pools.json',
        description: 'Provider pools configuration file path',
    },
    MAX_ERROR_COUNT: {
        type: ValidatorType.NUMBER,
        default: 3,
        min: 1,
        max: 10,
        description: 'Maximum error count before marking provider unhealthy',
    },
};

/**
 * 验证单个配置项
 * @param {string} key - 配置项键名
 * @param {any} value -* @param {Object} schema - 配置项定义
 * @returns {any} 验证后的值
 * @throws {ConfigValidationError}
 */
function validateConfigItem(key, value, schema) {
    // 检查必填项
    if (schema.required && (value === undefined || value === null || value === '')) {
        throw new ConfigValidationError(`Required config "${key}" is missing`, key);
    }

    // 如果值为空且有默认值，使用默认值
    if ((value === undefined || value === null || value === '') && schema.default !== undefined) {
        return schema.default;
    }

    // 如果值为空且不是必填项，返回 undefined
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    // 类型验证
    switch (schema.type) {
        case ValidatorType.STRING:
            if (typeof value !== 'string') {
                throw new ConfigValidationError(`Config "${key}" must be a string`, key);
            }
            break;

        case ValidatorType.NUMBER:
            const num = Number(value);
            if (isNaN(num)) {
                throw new ConfigValidationError(`Config "${key}" must be a number`, key);
            }
            if (schema.min !== undefined && num < schema.min) {
                throw new ConfigValidationError(`Config "${key}" must be >= ${schema.min}`, key);
            }
            if (schema.max !== undefined && num > schema.max) {
                throw new ConfigValidationError(`Config "${key}" must be <= ${schema.max}`, key);
            }
            return num;

        case ValidatorType.BOOLEAN:
            if (typeof value === 'boolean') {
                return value;
            }
            if (typeof value === 'string') {
                const lower = value.toLowerCase();
                if (lower === 'true' || lower === '1' || lower === 'yes') return true;
                if (lower === 'false' || lower === '0' || lower === 'no') return false;
            }
            throw new ConfigValidationError(`Config "${key}" must be a boolean`, key);

        case ValidatorType.ARRAY:
            if (!Array.isArray(value)) {
                throw new ConfigValidationError(`Config "${key}" must be an array`, key);
            }
            break;

        case ValidatorType.OBJECT:
            if (typeof value !== 'object' || Array.isArray(value)) {
                throw new ConfigValidationError(`Config "${key}" must be an object`, key);
            }
            break;

        case ValidatorType.ENUM:
            if (!schema.enum.includes(value)) {
                throw new ConfigValidationError(
                    `Config "${key}" must be one of: ${schema.enum.join(', ')}`,
                    key
                );
            }
            break;

        case ValidatorType.URL:
            try {
                new URL(value);
            } catch (e) {
                throw new ConfigValidationError(`Config "${key}" must be a valid URL`, key);
            }
            break;

        case ValidatorType.PORT:
            const port = Number(value);
            if (isNaN(port) || port < 1 || port > 65535) {
                throw new ConfigValidationError(`Config "${key}" must be a valid port (1-65535)`, key);
            }
            return port;

        case ValidatorType.PATH:
            if (typeof value !== 'string') {
                throw new ConfigValidationError(`Config "${key}" must be a valid path string`, key);
            }
            break;
    }

    return value;
}

/**
 * 验证配置对象
 * @param {Object} config - 配置对象
 * @param {Object} schema - 配置定义（默认使用 CONFIG_SCHEMA）
 * @returns {Object} 验证后的配置对象
 * @throws {ConfigValidationError}
 */
export function validateConfig(config, schema = CONFIG_SCHEMA) {
    const validatedConfig = {};
    const errors = [];

    // 验证所有定义的配置项
    for (const [key, itemSchema] of Object.entries(schema)) {
        try {
            const value = config[key];
            const validatedValue = validateConfigItem(key, value, itemSchema);

            // 只添加非 undefined 的值
            if (validatedValue !== undefined) {
                validatedConfig[key] = validatedValue;
            }
        } catch (error) {
            if (error instanceof ConfigValidationError) {
                errors.push(error);
            } else {
                throw error;
            }
        }
    }

    // 如果有验证错误，抛出汇总错误
    if (errors.length > 0) {
        const errorMessages = errors.map(e => `  - ${e.message}`).join('\n');
        throw new ConfigValidationError(
            `Configuration validation failed:\n${errorMessages}`,
            'multiple'
        );
    }

    // 保留未在 schema 中定义的配置项
    for (const [key, value] of Object.entries(config)) {
        if (!(key in schema) && value !== undefined) {
            validatedConfig[key] = value;
        }
    }

    return validatedConfig;
}

/**
 * 获取配置项的默认值
 * @param {string} key - 配置项键名
 * @returns {any} 默认值
 */
export function getConfigDefault(key) {
    const schema = CONFIG_SCHEMA[key];
    return schema ? schema.default : undefined;
}

/**
 * 获取所有配置项的默认值
 * @returns {Object} 默认配置对象
 */
export function getDefaultConfig() {
    const defaultConfig = {};

    for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
        if (schema.default !== undefined) {
            defaultConfig[key] = schema.default;
        }
    }

    return defaultConfig;
}

/**
 * 打印配置验证帮助信息
 */
export function printConfigHelp() {
    console.log('\n=== Configuration Options ===\n');

    for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
        console.log(`${key}:`);
        console.log(`  Type: ${schema.type}`);
        console.log(`  Description: ${schema.description}`);

        if (schema.default !== undefined) {
            console.log(`  Default: ${JSON.stringify(schema.default)}`);
        }

        if (schema.required) {
            console.log(`  Required: Yes`);
        }

        if (schema.enum) {
            console.log(`  Allowed values: ${schema.enum.join(', ')}`);
        }

        if (schema.min !== undefined || schema.max !== undefined) {
            const range = [];
            if (schema.min !== undefined) range.push(`min: ${schema.min}`);
            if (schema.max !== undefined) range.push(`max: ${schema.max}`);
            console.log(`  Range: ${range.join(', ')}`);
        }

        console.log('');
    }
}
