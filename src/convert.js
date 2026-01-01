/**
 * 协议转换模块 - 新架构版本
 * 使用重构后的转换器架构
 *
 * 这个文件展示了如何使用新的转换器架构
 * 可以逐步替换原有的 convert.js
 */

import { ConverterFactory } from './converters/ConverterFactory.js';

// =============================================================================
// 初始化：注册所有转换器
// =============================================================================

// =============================================================================
// 主转换函数
// =============================================================================

/**
 * 通用数据转换函数（新架构版本）
 * @param {object} data - 要转换的数据（请求体或响应）
 * @param {string} type - 转换类型：'request', 'response', 'streamChunk', 'modelList'
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称（用于响应转换）
 * @returns {object} 转换后的数据
 * @throws {Error} 如果找不到合适的转换函数
 */
export function convertData(data, type, fromProvider, toProvider, model) {
    try {
        // 获取协议前缀
        const fromProtocol = getProtocolPrefix(fromProvider);
        const toProtocol = getProtocolPrefix(toProvider);

        // 从工厂获取转换器
        const converter = ConverterFactory.getConverter(fromProtocol);

        if (!converter) {
            throw new Error(`No converter found for protocol: ${fromProtocol}`);
        }

        // 根据类型调用相应的转换方法
        switch (type) {
            case 'request':
                return converter.convertRequest(data, toProtocol);
                
            case 'response':
                return converter.convertResponse(data, toProtocol, model);
                
            case 'streamChunk':
                return converter.convertStreamChunk(data, toProtocol, model);
                
            case 'modelList':
                return converter.convertModelList(data, toProtocol);
                
            default:
                throw new Error(`Unsupported conversion type: ${type}`);
        }
    } catch (error) {
        console.error(`Conversion error: ${error.message}`);
        throw error;
    }
}

// =============================================================================
// 向后兼容的导出函数
// =============================================================================

/**
 * 以下函数保持与原有API的兼容性
 * 内部使用新的转换器架构
 */

// 辅助函数导出
export async function extractAndProcessSystemMessages(messages) {
    const { Utils } = await import('./converters/utils.js');
    return Utils.extractSystemMessages(messages);
}

export async function extractTextFromMessageContent(content) {
    const { Utils } = await import('./converters/utils.js');
    return Utils.extractText(content);
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 获取所有已注册的协议
 * @returns {Array<string>} 协议前缀数组
 */
export function getRegisteredProtocols() {
    return ConverterFactory.getRegisteredProtocols();
}

/**
 * 检查协议是否已注册
 * @param {string} protocol - 协议前缀
 * @returns {boolean} 是否已注册
 */
export function isProtocolRegistered(protocol) {
    return ConverterFactory.isProtocolRegistered(protocol);
}

/**
 * 清除所有转换器缓存
 */
export function clearConverterCache() {
    ConverterFactory.clearCache();
}

/**
 * 获取转换器实例（用于高级用法）
 * @param {string} protocol - 协议前缀
 * @returns {BaseConverter} 转换器实例
 */
export function getConverter(protocol) {
    return ConverterFactory.getConverter(protocol);
}

// =============================================================================
// 默认导出
// =============================================================================

export default {
    convertData,
    getRegisteredProtocols,
    isProtocolRegistered,
    clearConverterCache,
    getConverter,
};
