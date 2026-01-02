/**
 * UI 用量API管理模块
 * 负责获取和管理提供商用量信息
 */

import path from 'path';
import { CONFIG } from '../config-manager.js';
import { getServiceAdapter, serviceInstances } from '../kiro/adapter.js';
import { formatKiroUsage } from '../usage-service.js';
import { SINGLE_PROVIDER_CRED_PATH_KEY, SINGLE_PROVIDER_TYPE } from '../provider-utils.js';
import { createLogger } from '../logger.js';

const logger = createLogger('UsageAPI');

/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
export async function getAllProvidersUsage(currentConfig, providerPoolManager) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    try {
        const providerUsage = await getProviderTypeUsage(SINGLE_PROVIDER_TYPE, currentConfig, providerPoolManager);
        results.providers[SINGLE_PROVIDER_TYPE] = providerUsage;
    } catch (error) {
        logger.error('Failed to get provider usage', { providerType: SINGLE_PROVIDER_TYPE, error: error.message });
        results.providers[SINGLE_PROVIDER_TYPE] = {
            error: error.message,
            instances: []
        };
    }

    logger.info('Retrieved usage for all providers', {
        providerCount: Object.keys(results.providers).length
    });

    return results;
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 提供商用量信息
 */
export async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager) {
    // 单一提供商模式：仅支持固定 providerType
    if (providerType !== SINGLE_PROVIDER_TYPE) {
        throw new Error(`Unsupported provider type: ${providerType}`);
    }

    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例
    let providers = [];
    if (providerPoolManager && Array.isArray(providerPoolManager.providerPools)) {
        providers = providerPoolManager.providerPools;
    } else if (Array.isArray(currentConfig.providerPools)) {
        providers = currentConfig.providerPools;
    } else if (currentConfig.providerPools && typeof currentConfig.providerPools === 'object') {
        providers = currentConfig.providerPools[SINGLE_PROVIDER_TYPE] || [];
    }

    result.totalCount = providers.length;

    // 遍历所有提供商实例获取用量
    for (const provider of providers) {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];

        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            success: false,
            usage: null,
            error: null
        };

        // 首先检查是否已禁用，已禁用的提供商跳过初始化
        if (provider.isDisabled) {
            instanceResult.error = 'Provider is disabled';
            result.errorCount++;
        } else if (!adapter) {
            // 服务实例未初始化，尝试自动初始化
            try {
                logger.debug('Auto-initializing service adapter', {
                    providerType,
                    uuid: provider.uuid
                });
                // 构建配置对象
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                logger.error('Failed to initialize adapter', {
                    providerType,
                    uuid: provider.uuid,
                    error: initError.message
                });
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                result.errorCount++;
            }
        }

        // 如果适配器存在（包括刚初始化的），且没有错误，尝试获取用量
        if (adapter && !instanceResult.error) {
            try {
                const usage = await getAdapterUsage(adapter, providerType);
                instanceResult.success = true;
                instanceResult.usage = usage;
                result.successCount++;
            } catch (error) {
                logger.warn('Failed to get adapter usage', {
                    providerType,
                    uuid: provider.uuid,
                    error: error.message
                });
                instanceResult.error = error.message;
                result.errorCount++;
            }
        }

        result.instances.push(instanceResult);
    }

    logger.info('Retrieved provider type usage', {
        providerType,
        totalCount: result.totalCount,
        successCount: result.successCount,
        errorCount: result.errorCount
    });

    return result;
}

/**
 * 从适配器获取用量信息
 * @param {Object} adapter - 服务适配器
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object>} 用量信息
 */
async function getAdapterUsage(adapter, providerType) {
    if (typeof adapter.getUsageLimits === 'function') {
        const rawUsage = await adapter.getUsageLimits();
        return formatKiroUsage(rawUsage);
    }

    throw new Error(`Unsupported provider type: ${providerType}`);
}

/**
 * 获取提供商显示名称
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    if (providerType === SINGLE_PROVIDER_TYPE && SINGLE_PROVIDER_CRED_PATH_KEY && provider[SINGLE_PROVIDER_CRED_PATH_KEY]) {
        const filePath = provider[SINGLE_PROVIDER_CRED_PATH_KEY];
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        return `${dirName}/${fileName}`;
    }

    return provider.uuid || 'Unnamed';
}
