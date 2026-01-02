/**
 * UI 配置扫描器模块
 * 负责扫描和分析 OAuth 配置文件
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import {
    pathsEqual,
    isPathUsed,
    addToUsedPaths,
    SINGLE_PROVIDER_TYPE
} from '../provider-utils.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ConfigScanner');

/**
 * 扫描和分析配置文件
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} providerPoolManager - 提供商池管理器实例
 * @returns {Promise<Array>} 配置文件对象数组
 */
export async function scanConfigFiles(currentConfig, providerPoolManager) {
    const configFiles = [];

    // 只扫描configs目录
    const configsPath = path.join(process.cwd(), 'configs');

    if (!existsSync(configsPath)) {
        logger.debug('configs directory not found');
        return configFiles;
    }

    const usedPaths = new Set(); // 存储已使用的路径，用于判断关联状态

    // 从配置中提取所有OAuth凭据文件路径 - 标准化路径格式
    addToUsedPaths(usedPaths, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH);

    // 使用最新的提供商池数据
    let providerPools = currentConfig.providerPools;
    if (providerPoolManager && providerPoolManager.providerPools) {
        providerPools = providerPoolManager.providerPools;
    }

    // 检查提供商池文件中的所有OAuth凭据路径 - 标准化路径格式
    if (providerPools) {
        const providers = Array.isArray(providerPools)
            ? providerPools
            : (providerPools && typeof providerPools === 'object' ? (providerPools[SINGLE_PROVIDER_TYPE] || []) : []);

        for (const provider of providers) {
            addToUsedPaths(usedPaths, provider.KIRO_OAUTH_CREDS_FILE_PATH);
        }
    }

    try {
        // 扫描configs目录下的所有子目录和文件
        const configsFiles = await scanOAuthDirectory(configsPath, usedPaths, currentConfig);
        configFiles.push(...configsFiles);
        logger.info('Config files scanned', { count: configFiles.length });
    } catch (error) {
        logger.warn('Failed to scan configs directory', { error: error.message });
    }

    return configFiles;
}

/**
 * 分析 OAuth 配置文件并返回元数据
 * @param {string} filePath - 文件完整路径
 * @param {Set} usedPaths - 当前使用的路径集合
 * @param {Object} currentConfig - 当前配置
 * @returns {Promise<Object|nuOAuth 文件信息对象
 */
async function analyzeOAuthFile(filePath, usedPaths, currentConfig) {
    try {
        const stats = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const filename = path.basename(filePath);
        const relativePath = path.relative(process.cwd(), filePath);

        // 读取文件内容进行分析
        let content = '';
        let type = 'oauth_credentials';
        let isValid = true;
        let errorMessage = '';
        let oauthProvider = 'unknown';
        let usageInfo = getFileUsageInfo(relativePath, filename, usedPaths, currentConfig);

        try {
            if (ext === '.json') {
                const rawContent = await fs.readFile(filePath, 'utf8');
                const jsonData = JSON.parse(rawContent);
                content = rawContent;

                // 识别OAuth提供商
                if (jsonData.apiKey || jsonData.api_key) {
                    type = 'api_key';
                } else if (jsonData.client_id || jsonData.client_secret) {
                    oauthProvider = 'oauth2';
                } else if (jsonData.access_token || jsonData.refresh_token) {
                    oauthProvider = 'token_based';
                } else if (jsonData.credentials) {
                    oauthProvider = 'service_account';
                }
            } else {
                content = await fs.readFile(filePath, 'utf8');

                if (ext === '.key' || ext === '.pem') {
                    if (content.includes('-----BEGIN') && content.includes('PRIVATE KEY-----')) {
                        oauthProvider = 'private_key';
                    }
                } else if (ext === '.txt') {
                    if (content.includes('api_key') || content.includes('apikey')) {
                        oauthProvider = 'api_key';
                    }
                } else if (ext === '.oauth' || ext === '.creds') {
                    oauthProvider = 'oauth_credentials';
                }
            }
        } catch (readError) {
            isValid = false;
            errorMessage = `Unable to read file: ${readError.message}`;
            logger.warn('Failed to read OAuth file', { filePath, error: readError.message });
        }

        return {
            name: filename,
            path: relativePath,
            size: stats.size,
            type: type,
            provider: oauthProvider,
            extension: ext,
            modified: stats.mtime.toISOString(),
            isValid: isValid,
            errorMessage: errorMessage,
            isUsed: isPathUsed(relativePath, filename, usedPaths),
            usageInfo: usageInfo,
            preview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
        };
    } catch (error) {
        logger.warn('Failed to analyze OAuth file', { filePath, error: error.message });
        return null;
    }
}

/**
 * 获取文件的详细使用信息
 * @param {string} relativePath - 相对文件路径
 * @param {string} fileName - 文件名
 * @param {Set} usedPaths - 已使用路径集合
 * @param {Object} currentConfig - 当前配置
 * @returns {Object} 使用信息对象
 */
function getFileUsageInfo(relativePath, fileName, usedPaths, currentConfig) {
    const usageInfo = {
        isUsed: false,
        usageType: null,
        usageDetails: []
    };

    // 检查是否被使用
    const isUsed = isPathUsed(relativePath, fileName, usedPaths);
    if (!isUsed) {
        return usageInfo;
    }

    usageInfo.isUsed = true;

    // 检查主要配置中的使用情况
    if (currentConfig.KIRO_OAUTH_CREDS_FILE_PATH &&
        (pathsEqual(relativePath, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH) ||
         pathsEqual(relativePath, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
        usageInfo.usageType = 'main_config';
        usageInfo.usageDetails.push({
            type: 'Main Config',
            location: 'Kiro OAuth credentials file path',
            configKey: 'KIRO_OAUTH_CREDS_FILE_PATH'
        });
    }

    // 检查提供商池中的使用情况
    if (currentConfig.providerPools) {
        const providers = Array.isArray(currentConfig.providerPools)
            ? currentConfig.providerPools
            : (currentConfig.providerPools && typeof currentConfig.providerPools === 'object'
                ? (currentConfig.providerPools[SINGLE_PROVIDER_TYPE] || [])
                : []);

        for (const [index, provider] of providers.entries()) {
            const providerUsages = [];

            if (provider.KIRO_OAUTH_CREDS_FILE_PATH &&
                (pathsEqual(relativePath, provider.KIRO_OAUTH_CREDS_FILE_PATH) ||
                 pathsEqual(relativePath, provider.KIRO_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
                providerUsages.push({
                    type: 'Provider Pool',
                    location: `Kiro OAuth credentials (node ${index + 1})`,
                    providerType: SINGLE_PROVIDER_TYPE,
                    providerIndex: index,
                    configKey: 'KIRO_OAUTH_CREDS_FILE_PATH'
                });
            }

            if (providerUsages.length > 0) {
                usageInfo.usageType = 'provider_pool';
                usageInfo.usageDetails.push(...providerUsages);
            }
        }
    }

    // 如果有多个使用位置，标记为多种用途
    if (usageInfo.usageDetails.length > 1) {
        usageInfo.usageType = 'multiple';
    }

    return usageInfo;
}

/**
 * 扫描 OAuth 目录查找凭据文件
 * @param {string} dirPath - 要扫描的目录路径
 * @param {Set} usedPaths - 已使用路径集合
 * @param {Object} currentConfig - 当前配置
 * @returns {Promise<Array>} OAuth 配置文件对象数组
 */
async function scanOAuthDirectory(dirPath, usedPaths, currentConfig) {
    const oauthFiles = [];

    try {
        const files = await fs.readdir(dirPath, { withFileTypes: true });

        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);

            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // 只关注OAuth相关的文件类型
                if (['.json', '.oauth', '.creds', '.key', '.pem', '.txt'].includes(ext)) {
                    const fileInfo = await analyzeOAuthFile(fullPath, usedPaths, currentConfig);
                    if (fileInfo) {
                        oauthFiles.push(fileInfo);
                    }
                }
            } else if (file.isDirectory()) {
                // 递归扫描子目录（限制深度）
                const relativePath = path.relative(process.cwd(), fullPath);
                // 最大深度4层，以支持 configs/kiro/{subfolder}/file.json 这样的结构
                if (relativePath.split(path.sep).length < 4) {
                    const subFiles = await scanOAuthDirectory(fullPath, usedPaths, currentConfig);
                    oauthFiles.push(...subFiles);
                }
            }
        }
    } catch (error) {
        logger.warn('Failed to scan OAuth directory', { dirPath, error: error.message });
    }

    return oauthFiles;
}
