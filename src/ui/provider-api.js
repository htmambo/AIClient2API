/**
 * UI 提供商API管理模块
 * 负责提供商池的增删改查操作
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { KIRO_MODELS } from '../kiro/constants.js';
import { SINGLE_PROVIDER_CRED_PATH_KEY, SINGLE_PROVIDER_TYPE } from '../provider-utils.js';
import { broadcastEvent } from './event-broadcaster.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ProviderAPI');

function normalizeProviderPools(providerPools) {
    if (Array.isArray(providerPools)) {
        return providerPools;
    }
    if (providerPools && typeof providerPools === 'object') {
        const legacyPools = providerPools[SINGLE_PROVIDER_TYPE];
        if (Array.isArray(legacyPools)) {
            return legacyPools;
        }
    }
    return [];
}

/**
 * 获取提供商池摘要
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Array} 提供商池数据（单一提供商数组）
 */
export function getProviderPools(currentConfig, providerPoolManager) {
    let providerPools = [];
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';

    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            providerPools = providerPoolManager.providerPools;
        } else if (filePath && existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            providerPools = poolsData;
        }
    } catch (error) {
        logger.warn('Failed to load provider pools', { error: error.message });
    }

    return normalizeProviderPools(providerPools);
}

/**
 * 获取提供商的详细信息（单一提供商）
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 提供商详情
 */
export function getProviderDetails(currentConfig, providerPoolManager) {
    const providers = getProviderPools(currentConfig, providerPoolManager);

    return {
        providerType: SINGLE_PROVIDER_TYPE,
        providers,
        totalCount: providers.length,
        healthyCount: providers.filter(p => p.isHealthy).length
    };
}

/**
 * 获取提供商类型的可用模型
 * @returns {Object} 模型信息
 */
export function getProviderModels() {
    return {
        providerType: SINGLE_PROVIDER_TYPE,
        models: KIRO_MODELS
    };
}

/**
 * 添加新的提供商配置
 * @param {Object} providerConfig - 提供商配置
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 添加结果
 */
export function addProvider(providerConfig, currentConfig, providerPoolManager) {
    if (!providerConfig) {
        throw new Error('providerConfig is required');
    }

    // Generate UUID if not provided
    if (!providerConfig.uuid) {
        providerConfig.uuid = uuidv4();
    }

    // Set default values
    providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
    providerConfig.lastUsed = providerConfig.lastUsed || null;
    providerConfig.usageCount = providerConfig.usageCount || 0;
    providerConfig.errorCount = providerConfig.errorCount || 0;
    providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;

    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    let providerPools = [];

    // Load existing pools
    if (existsSync(filePath)) {
        try {
            const fileContent = readFileSync(filePath, 'utf8');
            providerPools = normalizeProviderPools(JSON.parse(fileContent));
        } catch (readError) {
            logger.warn('Failed to read existing provider pools', { error: readError.message });
        }
    }

    providerPools.push(providerConfig);

    // Save to file
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
    logger.info('Added new provider', { providerType: SINGLE_PROVIDER_TYPE, uuid: providerConfig.uuid });

    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
    }

    // 广播更新事件
    broadcastEvent('config_update', {
        action: 'add',
        filePath: filePath,
        providerType: SINGLE_PROVIDER_TYPE,
        providerConfig,
        timestamp: new Date().toISOString()
    });

    // 广播提供商更新事件
    broadcastEvent('provider_update', {
        action: 'add',
        providerType: SINGLE_PROVIDER_TYPE,
        providerConfig,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        message: 'Provider added successfully',
        provider: providerConfig,
        providerType: SINGLE_PROVIDER_TYPE
    };
}

/**
 * 更新提供商配置
 * @param {string} providerUuid - 提供商UUID
 * @param {Object} providerConfig - 新的提供商配置
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 更新结果
 */
export function updateProvider(providerUuid, providerConfig, currentConfig, providerPoolManager) {
    if (!providerConfig) {
        throw new Error('providerConfig is required');
    }

    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    let providerPools = [];

    // Load existing pools
    if (existsSync(filePath)) {
        try {
            const fileContent = readFileSync(filePath, 'utf8');
            providerPools = normalizeProviderPools(JSON.parse(fileContent));
        } catch (readError) {
            throw new Error('Provider pools file not found');
        }
    }

    // Find and update the provider
    const providerIndex = providerPools.findIndex(p => p.uuid === providerUuid);

    if (providerIndex === -1) {
        throw new Error('Provider not found');
    }

    // Update provider while preserving certain fields
    const existingProvider = providerPools[providerIndex];
    const updatedProvider = {
        ...existingProvider,
        ...providerConfig,
        uuid: providerUuid, // Ensure UUID doesn't change
        lastUsed: existingProvider.lastUsed, // Preserve usage stats
        usageCount: existingProvider.usageCount,
        errorCount: existingProvider.errorCount,
        lastErrorTime: existingProvider.lastErrorTime
    };

    providerPools[providerIndex] = updatedProvider;

    // Save to file
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
    logger.info('Updated provider', { providerType: SINGLE_PROVIDER_TYPE, uuid: providerUuid });

    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
    }

    // 广播更新事件
    broadcastEvent('config_update', {
        action: 'update',
        filePath: filePath,
        providerType: SINGLE_PROVIDER_TYPE,
        providerConfig: updatedProvider,
        timestamp: new Date().toISOString()
    });

    // 广播提供商更新事件
    broadcastEvent('provider_update', {
        action: 'update',
        providerType: SINGLE_PROVIDER_TYPE,
        providerConfig: updatedProvider,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        message: 'Provider updated successfully',
        provider: updatedProvider,
        providerType: SINGLE_PROVIDER_TYPE
    };
}

/**
 * 删除提供商配置
 * @param {string} providerUuid - 提供商UUID
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 删除结果
 */
export function deleteProvider(providerUuid, currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    let providerPools = [];

    // Load existing pools
    if (existsSync(filePath)) {
        try {
            const fileContent = readFileSync(filePath, 'utf8');
            providerPools = normalizeProviderPools(JSON.parse(fileContent));
        } catch (readError) {
            throw new Error('Provider pools file not found');
        }
    }

    // Find and remove the provider
    const providerIndex = providerPools.findIndex(p => p.uuid === providerUuid);

    if (providerIndex === -1) {
        throw new Error('Provider not found');
    }

    const deletedProvider = providerPools[providerIndex];
    providerPools.splice(providerIndex, 1);

    // Save to file
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
    logger.info('Deleted provider', { providerType: SINGLE_PROVIDER_TYPE, uuid: providerUuid });

    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
    }

    // 广播更新事件
    broadcastEvent('config_update', {
        action: 'delete',
        filePath: filePath,
        providerType: SINGLE_PROVIDER_TYPE,
        providerUuid,
        timestamp: new Date().toISOString()
    });

    // 广播提供商更新事件
    broadcastEvent('provider_update', {
        action: 'delete',
        providerType: SINGLE_PROVIDER_TYPE,
        providerUuid,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        message: 'Provider deleted successfully',
        provider: deletedProvider,
        providerType: SINGLE_PROVIDER_TYPE
    };
}
