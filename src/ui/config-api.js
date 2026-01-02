/**
 * UI 配置API管理模块
 * 负责配置重载和管理
 */

import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG } from '../config-manager.js';
import { serviceInstances } from '../kiro/adapter.js';
import { initApiService } from '../service-manager.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ConfigAPI');

/**
 * 重载配置文件
 * 动态导入config-manager并重新初始化配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 返回重载后的配置对象
 */
export async function reloadConfig(providerPoolManager) {
    try {
        logger.info('Reloading configuration');

        // Import config manager dynamically
        const { initializeConfig } = await import('../config-manager.js');

        // Reload main config
        const newConfig = await initializeConfig(process.argv.slice(2), 'configs/config.json');

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = newConfig.providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // Update global CONFIG
        Object.assign(CONFIG, newConfig);

        // Update initApiService - 清空并重新初始化服务实例
        Object.keys(serviceInstances).forEach(key => delete serviceInstances[key]);
        initApiService(CONFIG);

        logger.info('Configuration reloaded successfully');

        return newConfig;
    } catch (error) {
        logger.error('Failed to reload configuration', { error: error.message });
        throw error;
    }
}

/**
 * 更新管理员密码
 * @param {string} password - 新密码
 * @returns {Promise<void>}
 */
export async function updateAdminPassword(password) {
    if (!password || password.trim() === '') {
        throw new Error('Password cannot be empty');
    }

    const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');

    try {
        await fs.writeFile(pwdFilePath, password.trim(), 'utf8');
        logger.info('Admin password updated successfully');
    } catch (error) {
        logger.error('Failed to update admin password', { error: error.message });
        throw new Error('Failed to update password: ' + error.message);
    }
}

/**
 * 获取配置信息（敏感信息已脱敏）
 * @param {Object} currentConfig - 当前配置
 * @returns {Object} 脱敏后的配置信息
 */
export function getSanitizedConfig(currentConfig) {
    const sanitized = { ...currentConfig };

    // 移除敏感信息
    const sensitiveKeys = [
        'KIRO_OAUTH_CREDS_BASE64',
        'KIRO_OAUTH_CREDS_FILE_PATH',
        'API_KEY',
        'SECRET_KEY'
    ];

    sensitiveKeys.forEach(key => {
        if (sanitized[key]) {
            sanitized[key] = '***REDACTED***';
        }
    });

    // 处理提供商池中的敏感信息
    if (sanitized.providerPools) {
        if (Array.isArray(sanitized.providerPools)) {
            sanitized.providerPools = sanitized.providerPools.map(provider => {
                const sanitizedProvider = { ...provider };
                sensitiveKeys.forEach(key => {
                    if (sanitizedProvider[key]) {
                        sanitizedProvider[key] = '***REDACTED***';
                    }
                });
                return sanitizedProvider;
            });
        } else if (typeof sanitized.providerPools === 'object') {
            for (const providerType in sanitized.providerPools) {
                sanitized.providerPools[providerType] = sanitized.providerPools[providerType].map(provider => {
                    const sanitizedProvider = { ...provider };
                    sensitiveKeys.forEach(key => {
                        if (sanitizedProvider[key]) {
                            sanitizedProvider[key] = '***REDACTED***';
                        }
                    });
                    return sanitizedProvider;
                });
            }
        }
    }

    return sanitized;
}
