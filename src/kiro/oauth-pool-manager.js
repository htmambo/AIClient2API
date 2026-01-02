import * as fs from 'fs'; // Import fs module
import { getServiceAdapter } from './adapter.js';

/**
 * Manages a pool of API service providers, handling their health and selection.
 */
export class ProviderPoolManager {
    // 默认健康检查模型配置
    // 键名必须与 MODEL_PROVIDER 常量值一致
    static DEFAULT_HEALTH_CHECK_MODELS = {
        'claude-kiro-oauth': 'claude-haiku-4-5'
    };

    constructor(providerPools, options = {}) {
        // 单一提供商模式：支持兼容旧格式
        this.providerType = options.providerType || 'claude-kiro-oauth';
        this.providerPools = Array.isArray(providerPools)
            ? providerPools
            : (providerPools && typeof providerPools === 'object' ? (providerPools[this.providerType] || []) : []);

        this.globalConfig = options.globalConfig || {}; // 存储全局配置
        this.providerStatus = []; // Tracks health and usage for each provider instance (single-provider)
        // 使用 ?? 运算符确保 0 也能被正确设置，而不是被 || 替换为默认值
        this.maxErrorCount = options.maxErrorCount ?? 3; // Default to 3 errors before marking unhealthy
        this.healthCheckInterval = options.healthCheckInterval ?? 10 * 60 * 1000; // Default to 10 minutes

        // 日志级别控制
        this.logLevel = options.logLevel || 'info'; // 'debug', 'info', 'warn', 'error'

        // 添加防抖机制，避免频繁的文件 I/O 操作
        this.saveDebounceTime = options.saveDebounceTime || 1000; // 默认1秒防抖
        this.saveTimer = null;
        this.pendingSave = false; // 单一提供商模式：简化为布尔值

        this.initializeProviderStatus();
    }

    /**
     * 日志输出方法，支持日志级别控制
     * @private
     */
    _log(level, message) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        if (levels[level] >= levels[this.logLevel]) {
            const logMethod = level === 'debug' ? 'log' : level;
            console[logMethod](`[ProviderPoolManager] ${message}`);
        }
    }

    /**
     * 查找指定的 provider（单一提供商版本）
     * @private
     */
    _findProvider(uuid) {
        if (!uuid) {
            this._log('error', `Invalid parameters: uuid=${uuid}`);
            return null;
        }
        return this.providerStatus.find(p => p.uuid === uuid) || null;
    }

    /**
     * Initializes the status for each provider in the pools (single-provider version).
     * Initially, all providers are considered healthy and have zero usage.
     */
    initializeProviderStatus() {
        this.providerStatus = [];
        for (const providerConfig of this.providerPools) {
            // Ensure initial health and usage stats are present in the config
            providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
            providerConfig.isDisabled = providerConfig.isDisabled !== undefined ? providerConfig.isDisabled : false;
            providerConfig.lastUsed = providerConfig.lastUsed !== undefined ? providerConfig.lastUsed : null;
            providerConfig.usageCount = providerConfig.usageCount !== undefined ? providerConfig.usageCount : 0;
            providerConfig.errorCount = providerConfig.errorCount !== undefined ? providerConfig.errorCount : 0;

            // 优化2: 简化 lastErrorTime 处理逻辑
            providerConfig.lastErrorTime = providerConfig.lastErrorTime instanceof Date
                ? providerConfig.lastErrorTime.toISOString()
                : (providerConfig.lastErrorTime || null);

            // 健康检测相关字段
            providerConfig.lastHealthCheckTime = providerConfig.lastHealthCheckTime || null;
            providerConfig.lastHealthCheckModel = providerConfig.lastHealthCheckModel || null;
            providerConfig.lastErrorMessage = providerConfig.lastErrorMessage || null;

            this.providerStatus.push({
                config: providerConfig,
                uuid: providerConfig.uuid, // Still keep uuid at the top level for easy access
            });
        }
        this._log('info', `Initialized provider statuses: ${this.providerStatus.length} accounts (maxErrorCount: ${this.maxErrorCount})`);
    }

    /**
     * Selects a provider from the pool (single-provider version).
     * Uses LRU (Least Recently Used) strategy for load balancing.
     * If requestedModel is provided, providers that don't support the model will be excluded.
     * @param {string} [requestedModel] - Optional. The model name to filter providers by.
     * @param {Object} [options] - Optional. Additional options.
     * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
     * @returns {object|null} The selected provider's configuration, or null if no healthy provider is found.
     */
    selectProvider(requestedModel = null, options = {}) {
        const availableProviders = this.providerStatus || [];
        let availableAndHealthyProviders = availableProviders.filter(p =>
            p.config.isHealthy && !p.config.isDisabled
        );

        // 如果指定了模型，则排除不支持该模型的提供商
        if (requestedModel) {
            const modelFilteredProviders = availableAndHealthyProviders.filter(p => {
                // 如果提供商没有配置 notSupportedModels，则认为它支持所有模型
                if (!p.config.notSupportedModels || !Array.isArray(p.config.notSupportedModels)) {
                    return true;
                }
                // 检查 notSupportedModels 数组中是否包含请求的模型，如果包含则排除
                return !p.config.notSupportedModels.includes(requestedModel);
            });

            if (modelFilteredProviders.length === 0) {
                this._log('warn', `No available providers that support model: ${requestedModel}`);
                return null;
            }

            availableAndHealthyProviders = modelFilteredProviders;
            this._log('debug', `Filtered ${modelFilteredProviders.length} providers supporting model: ${requestedModel}`);
        }

        if (availableAndHealthyProviders.length === 0) {
            this._log('warn', `No available and healthy providers`);
            return null;
        }

        // 使用"最久未被使用"策略（LRU）进行负载均衡
        // 这样即使可用列表长度动态变化，也能确保每个账号被平均轮到
        const selected = availableAndHealthyProviders.sort((a, b) => {
            const timeA = a.config.lastUsed ? new Date(a.config.lastUsed).getTime() : 0;
            const timeB = b.config.lastUsed ? new Date(b.config.lastUsed).getTime() : 0;
            // 优先选择从未用过的，或者最久没用的
            if (timeA !== timeB) return timeA - timeB;
            // 如果时间相同，使用使用次数辅助判断
            return (a.config.usageCount || 0) - (b.config.usageCount || 0);
        })[0];

        // 更新使用信息（除非明确跳过）
        if (!options.skipUsageCount) {
            selected.config.lastUsed = new Date().toISOString();
            selected.config.usageCount++;
            // 使用防抖保存
            this._debouncedSave();
        }

        this._log('debug', `Selected provider (LRU): ${selected.config.uuid}${requestedModel ? ` for model: ${requestedModel}` : ''}${options.skipUsageCount ? ' (skip usage count)' : ''}`);

        return selected.config;
    }

    /**
     * Checks if all providers are unhealthy or disabled (single-provider).
     * @returns {boolean} True if all providers are unhealthy or disabled.
     */
    isAllProvidersUnhealthy() {
        const providers = this.providerStatus || [];
        if (providers.length === 0) {
            return true;
        }
        return providers.every(p => !p.config.isHealthy || p.config.isDisabled);
    }

    /**
     * Gets statistics about provider health (single-provider).
     * @returns {Object} Statistics object with total, healthy, unhealthy, and disabled counts.
     */
    getProviderStats() {
        const providers = this.providerStatus || [];
        const stats = {
            total: providers.length,
            healthy: 0,
            unhealthy: 0,
            disabled: 0
        };
        
        for (const p of providers) {
            if (p.config.isDisabled) {
                stats.disabled++;
            } else if (p.config.isHealthy) {
                stats.healthy++;
            } else {
                stats.unhealthy++;
            }
        }
        
        return stats;
    }

    getProviderPools() {
        return this.providerPools;
    }

    /**
     * Marks a provider as unhealthy (e.g., after an API error).
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {string} [errorMessage] - Optional error message to store.
     */
    markProviderUnhealthy(providerConfig, errorMessage = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthy');
            return;
        }

        const provider = this._findProvider(providerConfig.uuid);
        if (provider) {
            provider.config.errorCount++;
            provider.config.lastErrorTime = new Date().toISOString();
            // 更新 lastUsed 时间，避免因 LRU 策略导致失败节点被重复选中
            provider.config.lastUsed = new Date().toISOString();
            
            // 保存错误信息
            if (errorMessage) {
                provider.config.lastErrorMessage = errorMessage;
            }

            if (provider.config.errorCount >= this.maxErrorCount) {
                provider.config.isHealthy = false;
                this._log('warn', `Marked provider as unhealthy: ${providerConfig.uuid} for type ${this.providerType}. Total errors: ${provider.config.errorCount}`);
            } else {
                this._log('warn', `Provider ${providerConfig.uuid} for type ${this.providerType} error count: ${provider.config.errorCount}/${this.maxErrorCount}. Still healthy.`);
            }
            
            this._debouncedSave();
        }
    }

    /**
     * Marks a provider as healthy.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {boolean} resetUsageCount - Whether to reset usage count (optional, default: false).
     * @param {string} [healthCheckModel] - Optional model name used for health check.
     */
    markProviderHealthy(providerConfig, resetUsageCount = false, healthCheckModel = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderHealthy');
            return;
        }

        const provider = this._findProvider(providerConfig.uuid);
        if (provider) {
            provider.config.isHealthy = true;
            provider.config.errorCount = 0;
            provider.config.lastErrorTime = null;
            provider.config.lastErrorMessage = null;
            
            // 更新健康检测信息
            provider.config.lastHealthCheckTime = new Date().toISOString();
            if (healthCheckModel) {
                provider.config.lastHealthCheckModel = healthCheckModel;
            }
            
            // 只有在明确要求重置使用计数时才重置
            if (resetUsageCount) {
                provider.config.usageCount = 0;
            }else{
                provider.config.usageCount++;
                provider.config.lastUsed = new Date().toISOString();
            }
            this._log('info', `Marked provider as healthy: ${provider.config.uuid} for type ${this.providerType}${resetUsageCount ? ' (usage count reset)' : ''}`);
            
            this._debouncedSave();
        }
    }

    /**
     * 重置提供商的计数器（错误计数和使用计数）
     * @param {object} providerConfig - The configuration of the provider to mark.
     */
    resetProviderCounters(providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in resetProviderCounters');
            return;
        }

        const provider = this._findProvider(providerConfig.uuid);
        if (provider) {
            provider.config.errorCount = 0;
            provider.config.usageCount = 0;
            this._log('info', `Reset provider counters: ${provider.config.uuid} for type ${this.providerType}`);
            
            this._debouncedSave();
        }
    }

    /**
     * 禁用指定提供商
     * @param {object} providerConfig - 提供商配置
     */
    disableProvider(providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in disableProvider');
            return;
        }

        const provider = this._findProvider(providerConfig.uuid);
        if (provider) {
            provider.config.isDisabled = true;
            this._log('info', `Disabled provider: ${providerConfig.uuid} for type ${this.providerType}`);
            this._debouncedSave();
        }
    }

    /**
     * 启用指定提供商
     * @param {object} providerConfig - 提供商配置
     */
    enableProvider(providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in enableProvider');
            return;
        }

        const provider = this._findProvider(providerConfig.uuid);
        if (provider) {
            provider.config.isDisabled = false;
            this._log('info', `Enabled provider: ${providerConfig.uuid} for type ${this.providerType}`);
            this._debouncedSave();
        }
    }

    /**
     * Performs health checks on all providers in the pool.
     * This method would typically be called periodically (e.g., via cron job).
     */
    async performHealthChecks(isInit = false) {
        this._log('info', 'Performing health checks on all providers...');
        const now = new Date();
        const providerType = this.providerType;

        for (const providerStatus of this.providerStatus) {
            const providerConfig = providerStatus.config;

            // Only attempt to health check unhealthy providers after a certain interval
            if (!providerStatus.config.isHealthy && providerStatus.config.lastErrorTime &&
                (now.getTime() - new Date(providerStatus.config.lastErrorTime).getTime() < this.healthCheckInterval)) {
                this._log('debug', `Skipping health check for ${providerConfig.uuid} (${providerType}). Last error too recent.`);
                continue;
            }

            try {
                // Perform actual health check based on provider type
                const healthResult = await this._checkProviderHealth(providerType, providerConfig);
                
                if (healthResult === null) {
                    this._log('debug', `Health check for ${providerConfig.uuid} (${providerType}) skipped: Check not implemented.`);
                    this.resetProviderCounters(providerConfig);
                    continue;
                }
                
                if (healthResult.success) {
                    if (!providerStatus.config.isHealthy) {
                        // Provider was unhealthy but is now healthy
                        // 恢复健康时不重置使用计数，保持原有值
                        this.markProviderHealthy(providerConfig, true, healthResult.modelName);
                        this._log('info', `Health check for ${providerConfig.uuid} (${providerType}): Marked Healthy (actual check)`);
                    } else {
                        // Provider was already healthy and still is
                        // 只在初始化时重置使用计数
                        this.markProviderHealthy(providerConfig, true, healthResult.modelName);
                        this._log('debug', `Health check for ${providerConfig.uuid} (${providerType}): Still Healthy`);
                    }
                } else {
                    // Provider is not healthy
                    this._log('warn', `Health check for ${providerConfig.uuid} (${providerType}) failed: ${healthResult.errorMessage || 'Provider is not responding correctly.'}`);
                    this.markProviderUnhealthy(providerConfig, healthResult.errorMessage);
                    
                    // 更新健康检测时间和模型（即使失败也记录）
                    providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                    if (healthResult.modelName) {
                        providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                    }
                }

            } catch (error) {
                this._log('error', `Health check for ${providerConfig.uuid} (${providerType}) failed: ${error.message}`);
                // If a health check fails, mark it unhealthy, which will update error count and lastErrorTime
                this.markProviderUnhealthy(providerConfig, error.message);
            }
        }
    }

    /**
     * 构建健康检查请求（返回多种格式用于重试）
     * @private
     * @returns {Array} 请求格式数组，按优先级排序
     */
    _buildHealthCheckRequests(providerType, modelName) {
        const baseMessage = { role: 'user', content: 'Hi' };
        const requests = [];
        
        // Kiro OAuth 同时支持 messages 和 contents 格式
        if (providerType.startsWith('claude-kiro')) {
            // 优先使用 messages 格式
            requests.push({
                messages: [baseMessage],
                model: modelName,
                max_tokens: 1
            });
            // 备用 contents 格式
            requests.push({
                contents: [{
                    role: 'user',
                    parts: [{ text: baseMessage.content }]
                }],
                max_tokens: 1
            });
            return requests;
        }
        
        // 其他提供商使用标准 messages 格式
        requests.push({
            messages: [baseMessage],
            model: modelName
        });
        
        return requests;
    }

    /**
     * Performs an actual health check for a specific provider.
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to check.
     * @param {boolean} forceCheck - If true, ignore checkHealth config and force the check.
     * @returns {Promise<{success: boolean, modelName: string, errorMessage: string}|null>} - Health check result object or null if check not implemented.
     */
    async _checkProviderHealth(providerType, providerConfig, forceCheck = false) {
        // 确定健康检查使用的模型名称
        const modelName = providerConfig.checkModelName ||
                        ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType];
        
        // 如果未启用健康检查且不是强制检查，返回 null
        if (!providerConfig.checkHealth && !forceCheck) {
            return null;
        }

        if (!modelName) {
            this._log('warn', `Unknown provider type for health check: ${providerType}`);
            return { success: false, modelName: null, errorMessage: 'Unknown provider type for health check' };
        }

        // 使用内部服务适配器方式进行健康检查
        const proxyKeys = ['CLAUDE', 'KIRO'];
        const tempConfig = {
            ...providerConfig,
            MODEL_PROVIDER: providerType
        };
        
        proxyKeys.forEach(key => {
            const proxyKey = `USE_SYSTEM_PROXY_${key}`;
            if (this.globalConfig[proxyKey] !== undefined) {
                tempConfig[proxyKey] = this.globalConfig[proxyKey];
            }
        });

        const serviceAdapter = getServiceAdapter(tempConfig);
        
        // 获取所有可能的请求格式
        const healthCheckRequests = this._buildHealthCheckRequests(providerType, modelName);
        
        // 重试机制：尝试不同的请求格式
        const maxRetries = healthCheckRequests.length;
        let lastError = null;
        
        for (let i = 0; i < maxRetries; i++) {
            const healthCheckRequest = healthCheckRequests[i];
            try {
                this._log('debug', `Health check attempt ${i + 1}/${maxRetries} for ${modelName}: ${JSON.stringify(healthCheckRequest)}`);
                await serviceAdapter.generateContent(modelName, healthCheckRequest);
                return { success: true, modelName, errorMessage: null };
            } catch (error) {
                lastError = error;
                this._log('debug', `Health check attempt ${i + 1} failed for ${providerType}: ${error.message}`);
                // 继续尝试下一个格式
            }
        }
        
        // 所有尝试都失败
        this._log('error', `Health check failed for ${providerType} after ${maxRetries} attempts: ${lastError?.message}`);
        return { success: false, modelName, errorMessage: lastError?.message || 'All health check attempts failed' };
    }

    /**
     * 优化1: 添加防抖保存方法
     * 延迟保存操作，避免频繁的文件 I/O
     * @private
     */
    _debouncedSave() {
        this.pendingSave = true;
        
        // 清除之前的定时器
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        
        // 设置新的定时器
        this.saveTimer = setTimeout(() => {
            void this._flushPendingSaves();
        }, this.saveDebounceTime);
    }
    
    /**
     * 单一提供商：批量保存（防抖后单次写入）
     * @private
     */
    async _flushPendingSaves() {
        if (!this.pendingSave) return;

        this.pendingSave = false;
        this.saveTimer = null;
        
        try {
            const filePath = this.globalConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            let currentPools = null;
            
            // 一次性读取文件
            try {
                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                currentPools = JSON.parse(fileContent);
            } catch (readError) {
                if (readError.code === 'ENOENT') {
                    this._log('info', 'configs/provider_pools.json does not exist, creating new file.');
                } else {
                    throw readError;
                }
            }

            const nextProviders = (this.providerStatus || []).map(p => {
                // Convert Date objects to ISOString if they exist
                const config = { ...p.config };
                if (config.lastUsed instanceof Date) {
                    config.lastUsed = config.lastUsed.toISOString();
                }
                if (config.lastErrorTime instanceof Date) {
                    config.lastErrorTime = config.lastErrorTime.toISOString();
                }
                if (config.lastHealthCheckTime instanceof Date) {
                    config.lastHealthCheckTime = config.lastHealthCheckTime.toISOString();
                }
                return config;
            });

            // 兼容旧结构：如果文件是对象，则只更新当前 providerType；否则写数组
            let nextPools;
            if (Array.isArray(currentPools)) {
                nextPools = nextProviders;
            } else if (currentPools && typeof currentPools === 'object') {
                nextPools = { ...currentPools, [this.providerType]: nextProviders };
            } else {
                nextPools = nextProviders;
            }
            
            // 一次性写入文件
            await fs.promises.writeFile(filePath, JSON.stringify(nextPools, null, 2), 'utf8');
            this._log('info', `configs/provider_pools.json updated successfully for type: ${this.providerType}`);
        } catch (error) {
            this._log('error', `Failed to write provider_pools.json: ${error.message}`);
        }
    }

}
