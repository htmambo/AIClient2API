/**
 * 各提供商支持的模型列表
 * 用于前端UI选择不支持的模型
 */

export const PROVIDER_MODELS = {
    'claude-custom': [],
    'claude-kiro-oauth': [
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-haiku-4-5',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-3-7-sonnet-20250219'
    ],
    'openai-custom': [],
    'openaiResponses-custom': [],
    'openai-qwen-oauth': [
        'qwen3-coder-plus',
        'qwen3-coder-flash'
    ]
};

/**
 * 获取指定提供商类型支持的模型列表
 * @param {string} providerType - 提供商类型
 * @returns {Array<string>} 模型列表
 */
export function getProviderModels(providerType) {
    return PROVIDER_MODELS[providerType] || [];
}

/**
 * 获取所有提供商的模型列表
 * @returns {Object} 所有提供商的模型映射
 */
export function getAllProviderModels() {
    return PROVIDER_MODELS;
}
