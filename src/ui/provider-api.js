/**
 * UI 提供商API管理模块
 * 负责提供商池的增删改查操作
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { KIRO_MODELS } from '../claude/kiro-constants.js';
import { broadcastEvent } from './event-broadcaster.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ProviderAPI');

/**
 * 获取提供商池摘要
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 提供商池数据
 */
export function getProviderPools(currentConfig, providerPoolManager) {
    let providerPools = {};
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

    return providerPools;
}

/**
 * 获取特定提供商类型的详细信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 提供商类型详情
 */
export function getProviderTypeDetails(providerType, currentConfig, providerPoolManager) {
    const providerPools = getProviderPools(currentConfig, providerPoolManager);
    const providers = providerPools[providerType] || [];

    return {
        providerType,
        providers,
        totalCount: providers.length,
        healthyCount: providers.filter(p => p.isHealthy).length
    };
}

/**
 * 获取提供商类型的可用模型
 * @param {string} providerType - 提供商类型
 * @returns {Object} 模型信息
 */
export function getProviderModels(providerType) {
    return {
        providerType,
        models: KIRO_MODELS
    };
}

/**
 * 添加新的提供商配置
 * @param {string} providerType - 提供商类型
 * @param {Object} providerConfig - 提供商配置
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 添加结果
 */
export function addProvider(providerType, providerConfig, currentConfig, providerPoolManager) {
    if (!providerType || !providerConfig) {
        throw new Error('providerType and providerConfig are required');
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
    let providerPools = {};

    // Load existing pools
    if (existsSync(filePath)) {
        try {
            const fileContent = readFileSync(filePath, 'utf8');
            providerPools = JSON.parse(fileContent);
        } catch (readError) {
            logger.warn('Failed to read existing provider pools', { error: readError.message });
        }
    }

    // Add new provider to the appropriate type
    if (!providerPools[providerType]) {
        providerPools[providerType] = [];
    }
    providerPools[providerType].push(providerConfig);

    // Save to file
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
    logger.info('Added new provider', { providerType, uuid: providerConfig.uuid });

    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
    }

    // 广播更新事件
    broadcastEvent('config_update', {
        action: 'add',
        filePath: filePath,
        providerType,
        providerConfig,
        timestamp: new Date().toISOString()
    });

    // 广播提供商更新事件
    broadcastEvent('provider_update', {
        action: 'add',
        providerType,
        providerConfig,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        message: 'Provider added successfully',
        provider: providerConfig,
        providerType
    };
}

/**
 * 更新提供商配置
 * @param {string} providerType - 提供商类型
 * @param {string} providerUuid - 提供商UUID
 * @param {Object} providerConfig - 新的提供商配置
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 更新结果
 */
export function updateProvider(providerType, providerUuid, providerConfig, currentConfig, providerPoolManager) {
    if (!providerConfig) {
        throw new Error('providerConfig is required');
    }

    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    let providerPools = {};

    // Load existing pools
    if (existsSync(filePath)) {
        try {
            const fileContent = readFileSync(filePath, 'utf8');
            providerPools = JSON.parse(fileContent);
        } catch (readError) {
            throw new Error('Provider pools file not found');
        }
    }

    // Find and update the provider
    const providers = providerPools[providerType] || [];
    const providerIndex = providers.findIndex(p => p.uuid === providerUuid);

    if (providerIndex === -1) {
        throw new Error('Provider not found');
    }

    // Update provider while preserving certain fields
    const existingProvider = providers[providerIndex];
    const updatedProvider = {
        ...existingProvider,
        ...providerConfig,
        uuid: providerUuid, // Ensure UUID doesn't change
        lastUsed: existingProvider.lastUsed, // Preserve usage stats
        usageCount: existingProvider.usageCount,
        errorCount: existingProvider.errorCount,
        lastErrorTime: existingProvider.lastErrorTime
    };

    providerPools[providerType][providerIndex] = updatedProvider;

    // Save to file
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
    logger.info('Updated provider', { providerType, uuid: providerUuid });

    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
    }

    // 广播更新事件
    broadcastEvent('config_update', {
        action: 'update',
        filePath: filePath,
        providerType,
        providerConfig: updatedProvider,
        timestamp: new Date().toISOString()
    });

    // 广播提供商更新事件
    broadcastEvent('provider_update', {
        action: 'update',
        providerType,
        providerConfig: updatedProvider,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        message: 'Provider updated successfully',
        provider: updatedProvider,
        providerType
    };
}

/**
 * 删除提供商配置
 * @param {string} providerType - 提供商类型
 * @param {string} providerUuid - 提供商UUID
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Object} 删除结果
 */
export function deleteProvider(providerType, providerUuid, currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    let providerPools = {};

    // Load existing pools
    if (existsSync(filePath)) {
        try {
            const fileContent = readFileSync(filePath, 'utf8');
            providerPools = JSON.parse(fileContent);
        } catch (readError) {
            throw new Error('Provider pools file not found');
        }
    }

    // Find and remove the provider
    const providers = providerPools[providerType] || [];
    const providerIndex = providers.findIndex(p => p.uuid === providerUuid);

    if (providerIndex === -1) {
        throw new Error('Provider not found');
    }

    const deletedProvider = providers[providerIndex];
    providerPools[providerType].splice(providerIndex, 1);

    // Save to file
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
    logger.info('Deleted provider', { providerType, uuid: providerUuid });

    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
    }

    // 广播更新事件
    broadcastEvent('config_update', {
        action: 'delete',
        filePath: filePath,
        providerType,
        providerUuid,
        timestamp: new Date().toISOString()
    });

    // 广播提供商更新事件
    broadcastEvent('provider_update', {
        action: 'delete',
        providerType,
        providerUuid,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        message: 'Provider deleted successfully',
        provider: deletedProvider,
        providerType
    };
}
