import { KiroApiService } from './claude/claude-kiro.js'; // 导入KiroApiService
import { MODEL_PROVIDER } from './common.js'; // 导入 MODEL_PROVIDER

// 定义AI服务适配器接口
// 所有的服务适配器都应该实现这些方法
export class ApiServiceAdapter {
    constructor() {
        if (new.target === ApiServiceAdapter) {
            throw new TypeError("Cannot construct ApiServiceAdapter instances directly");
        }
    }

    /**
     * 生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - 请求体
     * @returns {Promise<object>} - API响应
     */
    async generateContent(model, requestBody) {
        throw new Error("Method 'generateContent()' must be implemented.");
    }

    /**
     * 流式生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - 请求体
     * @returns {AsyncIterable<object>} - API响应流
     */
    async *generateContentStream(model, requestBody) {
        throw new Error("Method 'generateContentStream()' must be implemented.");
    }

    /**
     * 列出可用模型
     * @returns {Promise<object>} - 模型列表
     */
    async listModels() {
        throw new Error("Method 'listModels()' must be implemented.");
    }

    /**
     * 刷新认证令牌
     * @returns {Promise<void>}
     */
    async refreshToken() {
        throw new Error("Method 'refreshToken()' must be implemented.");
    }
}

// Kiro API 服务适配器
export class KiroApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.kiroApiService = new KiroApiService(config);
        // this.kiroApiService.initialize().catch(error => {
        //     console.error("Failed to initialize kiroApiService:", error);
        // });
    }

    async generateContent(model, requestBody) {
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        const stream = this.kiroApiService.generateContentStream(model, requestBody);
        yield* stream;
    }

    async listModels() {
        // Returns the native model list from the Kiro service
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.listModels();
    }

    async refreshToken() {
        if(this.kiroApiService.isExpiryDateNear()===true){
            console.log(`[Kiro] Expiry date is near, refreshing token...`);
            return this.kiroApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.getUsageLimits();
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
     * @returns {Object} { input_tokens: number }
     */
    countTokens(requestBody) {
        return this.kiroApiService.countTokens(requestBody);
    }
}

// 用于存储服务适配器单例的映射
export const serviceInstances = {};

// 服务适配器工厂
export function getServiceAdapter(config) {
    console.log(`[Adapter] getServiceAdapter, provider: ${config.MODEL_PROVIDER}, uuid: ${config.uuid}`);
    const provider = config.MODEL_PROVIDER;
    const providerKey = config.uuid ? provider + config.uuid : provider;
    if (!serviceInstances[providerKey]) {
        switch (provider) {
            case MODEL_PROVIDER.KIRO_API:
                serviceInstances[providerKey] = new KiroApiServiceAdapter(config);
                break;
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }
    return serviceInstances[providerKey];
}
