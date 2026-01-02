import { existsSync, readFileSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getRequestBody } from './common.js';
import { broadcastEvent, initializeEventClients } from './ui/event-broadcaster.js';
import { checkAuth, handleLoginRequest, cleanupExpiredTokens } from './ui/auth-manager.js';
import { upload, handleFileUpload } from './ui/file-upload.js';
import { scanConfigFiles } from './ui/config-scanner.js';
import { getAllProvidersUsage, getProviderTypeUsage } from './ui/usage-api.js';
import { getCpuUsagePercent, checkForUpdates, performUpdate, getSystemInfo } from './ui/system-api.js';
import { reloadConfig, updateAdminPassword, getSanitizedConfig } from './ui/config-api.js';
import { getProviderPools, getProviderDetails, getProviderModels, addProvider, updateProvider, deleteProvider } from './ui/provider-api.js';
import { SINGLE_PROVIDER_TYPE } from './provider-utils.js';
import { createLogger } from './logger.js';
import { handleKiroOAuth } from './kiro/oauth-handlers.js';

const logger = createLogger('UIManager');

const execAsync = promisify(exec);

// 用量缓存文件路径
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');

function normalizeProviderPoolsForResponse(providers) {
    return { [SINGLE_PROVIDER_TYPE]: Array.isArray(providers) ? providers : [] };
}

async function writeProviderPoolsFile(currentConfig, providers) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    const nextProviders = Array.isArray(providers) ? providers : [];
    try {
        let currentPools = null;
        try {
            if (existsSync(filePath)) {
                currentPools = JSON.parse(readFileSync(filePath, 'utf-8'));
            }
        } catch (readError) {
            // ignore and treat as empty
        }

        let nextPools;
        if (Array.isArray(currentPools)) {
            nextPools = nextProviders;
        } else if (currentPools && typeof currentPools === 'object') {
            nextPools = { ...currentPools, [SINGLE_PROVIDER_TYPE]: nextProviders };
        } else {
            nextPools = nextProviders;
        }

        writeFileSync(filePath, JSON.stringify(nextPools, null, 2), 'utf8');
    } catch (error) {
        console.warn('[UI API] Failed to write provider pools file:', error.message);
    }
    return filePath;
}

export async function handleUIApiRequests(method, pathParam, req, res, currentConfig, providerPoolManager) {
    // 处理登录接口
    if (method === 'POST' && pathParam === '/api/login') {
        const handled = await handleLoginRequest(req, res);
        if (handled) return true;
    }

    // 健康检查接口（用于前端token验证）
    if (method === 'GET' && pathParam === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
        return true;
    }
    
    // Handle UI management API requests (需要token验证，除了登录接口、健康检查和Events接口)
    if (pathParam.startsWith('/api/') && pathParam !== '/api/login' && pathParam !== '/api/health' && pathParam !== '/api/events') {
        // 检查token验证
        const isAuth = await checkAuth(req);
        if (!isAuth) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify({
                error: {
                    message: 'Unauthorized access, please login first',
                    code: 'UNAUTHORIZED'
                }
            }));
            return true;
        }
    }

    // 文件上传API
    if (method === 'POST' && pathParam === '/api/upload-oauth-credentials') {
        const uploadMiddleware = upload.single('file');
        
        uploadMiddleware(req, res, async (err) => {
            if (err) {
                console.error('[UI API] File upload error:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: err.message || 'File upload failed'
                    }
                }));
                return;
            }

            try {
                if (!req.file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: 'No file was uploaded'
                        }
                    }));
                    return;
                }

                // multer执行完成后，表单字段已解析到req.body中
                const provider = req.body.provider || 'common';
                const tempFilePath = req.file.path;
                
                // 根据实际的provider移动文件到正确的目录
                let targetDir = path.join(process.cwd(), 'configs', provider);
                
                // 如果是kiro类型的凭证，需要再包裹一层文件夹
                if (provider === 'kiro') {
                    // 使用时间戳作为子文件夹名称，确保每个上传的文件都有独立的目录
                    const timestamp = Date.now();
                    const originalNameWithoutExt = path.parse(req.file.originalname).name;
                    const subFolder = `${timestamp}_${originalNameWithoutExt}`;
                    targetDir = path.join(targetDir, subFolder);
                }
                
                await fs.mkdir(targetDir, { recursive: true });
                
                const targetFilePath = path.join(targetDir, req.file.filename);
                await fs.rename(tempFilePath, targetFilePath);
                
                const relativePath = path.relative(process.cwd(), targetFilePath);

                // 广播更新事件
                broadcastEvent('config_update', {
                    action: 'add',
                    filePath: relativePath,
                    provider: provider,
                    timestamp: new Date().toISOString()
                });

                console.log(`[UI API] OAuth credentials file uploaded: ${targetFilePath} (provider: ${provider})`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'File uploaded successfully',
                    filePath: relativePath,
                    originalName: req.file.originalname,
                    provider: provider
                }));

            } catch (error) {
                console.error('[UI API] File upload processing error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File upload processing failed: ' + error.message
                    }
                }));
            }
        });
        return true;
    }

    // Update admin password
    if (method === 'POST' && pathParam === '/api/admin-password') {
        try {
            const body = await getRequestBody(req);
            const { password } = body;

            if (!password || password.trim() === '') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Password cannot be empty'
                    }
                }));
                return true;
            }

            // 写入密码到 pwd 文件
            const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
            await fs.writeFile(pwdFilePath, password.trim(), 'utf8');
            
            console.log('[UI API] Admin password updated successfully');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Admin password updated successfully'
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to update admin password:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to update password: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get configuration
    if (method === 'GET' && pathParam === '/api/config') {
        let systemPrompt = '';

        if (currentConfig.SYSTEM_PROMPT_FILE_PATH && existsSync(currentConfig.SYSTEM_PROMPT_FILE_PATH)) {
            try {
                systemPrompt = readFileSync(currentConfig.SYSTEM_PROMPT_FILE_PATH, 'utf-8');
            } catch (e) {
                console.warn('[UI API] Failed to read system prompt file:', e.message);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...currentConfig,
            systemPrompt
        }));
        return true;
    }

    // Update configuration
    if (method === 'POST' && pathParam === '/api/config') {
        try {
            const body = await getRequestBody(req);
            const newConfig = body;

            // Update config values in memory
            if (newConfig.REQUIRED_API_KEY !== undefined) currentConfig.REQUIRED_API_KEY = newConfig.REQUIRED_API_KEY;
            if (newConfig.HOST !== undefined) currentConfig.HOST = newConfig.HOST;
            if (newConfig.SERVER_PORT !== undefined) currentConfig.SERVER_PORT = newConfig.SERVER_PORT;
            if (newConfig.MODEL_PROVIDER !== undefined) currentConfig.MODEL_PROVIDER = newConfig.MODEL_PROVIDER;
            if (newConfig.PROJECT_ID !== undefined) currentConfig.PROJECT_ID = newConfig.PROJECT_ID;
            if (newConfig.KIRO_OAUTH_CREDS_BASE64 !== undefined) currentConfig.KIRO_OAUTH_CREDS_BASE64 = newConfig.KIRO_OAUTH_CREDS_BASE64;
            if (newConfig.KIRO_OAUTH_CREDS_FILE_PATH !== undefined) currentConfig.KIRO_OAUTH_CREDS_FILE_PATH = newConfig.KIRO_OAUTH_CREDS_FILE_PATH;
            
            // New Provider URLs
            if (newConfig.KIRO_REFRESH_URL !== undefined) currentConfig.KIRO_REFRESH_URL = newConfig.KIRO_REFRESH_URL;
            if (newConfig.KIRO_REFRESH_IDC_URL !== undefined) currentConfig.KIRO_REFRESH_IDC_URL = newConfig.KIRO_REFRESH_IDC_URL;
            if (newConfig.KIRO_BASE_URL !== undefined) currentConfig.KIRO_BASE_URL = newConfig.KIRO_BASE_URL;
            if (newConfig.SYSTEM_PROMPT_FILE_PATH !== undefined) currentConfig.SYSTEM_PROMPT_FILE_PATH = newConfig.SYSTEM_PROMPT_FILE_PATH;
            if (newConfig.SYSTEM_PROMPT_MODE !== undefined) currentConfig.SYSTEM_PROMPT_MODE = newConfig.SYSTEM_PROMPT_MODE;
            if (newConfig.PROMPT_LOG_BASE_NAME !== undefined) currentConfig.PROMPT_LOG_BASE_NAME = newConfig.PROMPT_LOG_BASE_NAME;
            if (newConfig.PROMPT_LOG_MODE !== undefined) currentConfig.PROMPT_LOG_MODE = newConfig.PROMPT_LOG_MODE;
            if (newConfig.REQUEST_MAX_RETRIES !== undefined) currentConfig.REQUEST_MAX_RETRIES = newConfig.REQUEST_MAX_RETRIES;
            if (newConfig.REQUEST_BASE_DELAY !== undefined) currentConfig.REQUEST_BASE_DELAY = newConfig.REQUEST_BASE_DELAY;
            if (newConfig.CRON_NEAR_MINUTES !== undefined) currentConfig.CRON_NEAR_MINUTES = newConfig.CRON_NEAR_MINUTES;
            if (newConfig.CRON_REFRESH_TOKEN !== undefined) currentConfig.CRON_REFRESH_TOKEN = newConfig.CRON_REFRESH_TOKEN;
            if (newConfig.PROVIDER_POOLS_FILE_PATH !== undefined) currentConfig.PROVIDER_POOLS_FILE_PATH = newConfig.PROVIDER_POOLS_FILE_PATH;
            if (newConfig.MAX_ERROR_COUNT !== undefined) currentConfig.MAX_ERROR_COUNT = newConfig.MAX_ERROR_COUNT;
            if (newConfig.providerFallbackChain !== undefined) currentConfig.providerFallbackChain = newConfig.providerFallbackChain;

            // Handle system prompt update
            if (newConfig.systemPrompt !== undefined) {
                const promptPath = currentConfig.SYSTEM_PROMPT_FILE_PATH || 'configs/input_system_prompt.txt';
                try {
                    const relativePath = path.relative(process.cwd(), promptPath);
                    writeFileSync(promptPath, newConfig.systemPrompt, 'utf-8');

                    // 广播更新事件
                    broadcastEvent('config_update', {
                        action: 'update',
                        filePath: relativePath,
                        type: 'system_prompt',
                        timestamp: new Date().toISOString()
                    });
                    
                    console.log('[UI API] System prompt updated');
                } catch (e) {
                    console.warn('[UI API] Failed to write system prompt:', e.message);
                }
            }

            // Update config.json file
            try {
                const configPath = 'configs/config.json';
                
                // Create a clean config object for saving (exclude runtime-only properties)
                const configToSave = {
                    REQUIRED_API_KEY: currentConfig.REQUIRED_API_KEY,
                    SERVER_PORT: currentConfig.SERVER_PORT,
                    HOST: currentConfig.HOST,
                    MODEL_PROVIDER: currentConfig.MODEL_PROVIDER,
                    PROJECT_ID: currentConfig.PROJECT_ID,
                    KIRO_OAUTH_CREDS_BASE64: currentConfig.KIRO_OAUTH_CREDS_BASE64,
                    KIRO_OAUTH_CREDS_FILE_PATH: currentConfig.KIRO_OAUTH_CREDS_FILE_PATH,
                    // Provider URLs
                    KIRO_REFRESH_URL: currentConfig.KIRO_REFRESH_URL,
                    KIRO_REFRESH_IDC_URL: currentConfig.KIRO_REFRESH_IDC_URL,
                    KIRO_BASE_URL: currentConfig.KIRO_BASE_URL,
                    KIRO_AMAZON_Q_URL: currentConfig.KIRO_AMAZON_Q_URL,
                    KIRO_USAGE_LIMITS_URL: currentConfig.KIRO_USAGE_LIMITS_URL,
                    SYSTEM_PROMPT_FILE_PATH: currentConfig.SYSTEM_PROMPT_FILE_PATH,
                    SYSTEM_PROMPT_MODE: currentConfig.SYSTEM_PROMPT_MODE,
                    PROMPT_LOG_BASE_NAME: currentConfig.PROMPT_LOG_BASE_NAME,
                    PROMPT_LOG_MODE: currentConfig.PROMPT_LOG_MODE,
                    REQUEST_MAX_RETRIES: currentConfig.REQUEST_MAX_RETRIES,
                    REQUEST_BASE_DELAY: currentConfig.REQUEST_BASE_DELAY,
                    CRON_NEAR_MINUTES: currentConfig.CRON_NEAR_MINUTES,
                    CRON_REFRESH_TOKEN: currentConfig.CRON_REFRESH_TOKEN,
                    PROVIDER_POOLS_FILE_PATH: currentConfig.PROVIDER_POOLS_FILE_PATH,
                    MAX_ERROR_COUNT: currentConfig.MAX_ERROR_COUNT,
                    providerFallbackChain: currentConfig.providerFallbackChain
                };

                writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
                console.log('[UI API] Configuration saved to configs/config.json');
                
                // 广播更新事件
                broadcastEvent('config_update', {
                    action: 'update',
                    filePath: 'configs/config.json',
                    type: 'main_config',
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('[UI API] Failed to save configuration to file:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Failed to save configuration to file: ' + error.message,
                        partial: true  // Indicate that memory config was updated but not saved
                    }
                }));
                return true;
            }

            // Update the global CONFIG object to reflect changes immediately
            Object.assign(CONFIG, currentConfig);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Configuration updated successfully',
                details: 'Configuration has been updated in both memory and config.json file'
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get system information
    if (method === 'GET' && pathParam === '/api/system') {
        const memUsage = process.memoryUsage();
        
        // 读取版本号
        let appVersion = 'unknown';
        try {
            const versionFilePath = path.join(process.cwd(), 'VERSION');
            if (existsSync(versionFilePath)) {
                appVersion = readFileSync(versionFilePath, 'utf8').trim();
            }
        } catch (error) {
            console.warn('[UI API] Failed to read VERSION file:', error.message);
        }
        
        // 计算 CPU 使用率
        const cpuUsage = getCpuUsagePercent();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            appVersion: appVersion,
            nodeVersion: process.version,
            serverTime: new Date().toLocaleString(),
            memoryUsage: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
            cpuUsage: cpuUsage,
            uptime: process.uptime()
        }));
        return true;
    }

    // Get provider pools summary
    if (method === 'GET' && pathParam === '/api/providers') {
        const providers = getProviderPools(currentConfig, providerPoolManager);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(normalizeProviderPoolsForResponse(providers)));
        return true;
    }

    // Get specific provider type details
    const providerTypeMatch = pathParam.match(/^\/api\/providers\/([^\/]+)$/);
    if (method === 'GET' && providerTypeMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType，统一返回固定 providerType 的详情
        const details = getProviderDetails(currentConfig, providerPoolManager);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(details));
        return true;
    }

    // Get available models for a specific provider type
    const providerModelsMatch = pathParam.match(/^\/api\/provider-models\/([^\/]+)$/);
    if (method === 'GET' && providerModelsMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType
        const modelInfo = getProviderModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(modelInfo));
        return true;
    }

	    // Add new provider configuration
	    if (method === 'POST' && pathParam === '/api/providers') {
	        try {
	            const body = await getRequestBody(req);
	            const providerConfig = body?.providerConfig;
	            if (!providerConfig) {
	                res.writeHead(400, { 'Content-Type': 'application/json' });
	                res.end(JSON.stringify({ error: { message: 'providerConfig is required' } }));
	                return true;
	            }

	            res.writeHead(200, { 'Content-Type': 'application/json' });
	            res.end(JSON.stringify(addProvider(providerConfig, currentConfig, providerPoolManager)));
	            return true;
	        } catch (error) {
	            res.writeHead(500, { 'Content-Type': 'application/json' });
	            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Update specific provider configuration
    const updateProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)$/);
    if (method === 'PUT' && updateProviderMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType
        const providerUuid = updateProviderMatch[2];

        try {
            const body = await getRequestBody(req);
            const providerConfig = body?.providerConfig;

            if (!providerConfig) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'providerConfig is required' } }));
                return true;
            }
            const result = updateProvider(providerUuid, providerConfig, currentConfig, providerPoolManager);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Delete specific provider configuration
    if (method === 'DELETE' && updateProviderMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType
        const providerUuid = updateProviderMatch[2];

        try {
            const result = deleteProvider(providerUuid, currentConfig, providerPoolManager);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Disable/Enable specific provider configuration
    const disableEnableProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/);
    if (disableEnableProviderMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType
        const providerUuid = disableEnableProviderMatch[2];
        const action = disableEnableProviderMatch[3];

        try {
            const providers = getProviderPools(currentConfig, providerPoolManager);
            const provider = providers.find(p => p.uuid === providerUuid);
            if (!provider) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            provider.isDisabled = action === 'disable';
            const filePath = await writeProviderPoolsFile(currentConfig, providers);

            console.log(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} (${SINGLE_PROVIDER_TYPE})`);

            if (providerPoolManager) {
                providerPoolManager.providerPools = providers;
                providerPoolManager.initializeProviderStatus();
                if (action === 'disable') {
                    providerPoolManager.disableProvider(provider);
                } else {
                    providerPoolManager.enableProvider(provider);
                }
            }

            // 广播更新事件
            broadcastEvent('config_update', {
                action: action,
                filePath: filePath,
                providerType: SINGLE_PROVIDER_TYPE,
                providerConfig: provider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Provider ${action}d successfully`,
                provider: provider
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Reset all providers health status for a specific provider type
    const resetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && resetHealthMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType

        try {
            const providers = getProviderPools(currentConfig, providerPoolManager);
            
            if (providers.length === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No providers found' } }));
                return true;
            }

            let resetCount = 0;
            providers.forEach(provider => {
                if (!provider.isHealthy) {
                    provider.isHealthy = true;
                    provider.errorCount = 0;
                    provider.lastErrorTime = null;
                    resetCount++;
                }
            });

            // Save to file
            const filePath = await writeProviderPoolsFile(currentConfig, providers);
            console.log(`[UI API] Reset health status for ${resetCount} providers (${SINGLE_PROVIDER_TYPE})`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providers;
                providerPoolManager.initializeProviderStatus();
            }

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'reset_health',
                filePath: filePath,
                providerType: SINGLE_PROVIDER_TYPE,
                resetCount,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Successfully reset health status for ${resetCount} providers`,
                resetCount,
                totalCount: providers.length
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Perform health check for a single provider by UUID (must be before batch health check route)
    const singleHealthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/health-check$/);
    if (method === 'POST' && singleHealthCheckMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType
        const providerUuid = singleHealthCheckMatch[2];

        try {
            if (!providerPoolManager) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
                return true;
            }

            const providerType = providerPoolManager.providerType || SINGLE_PROVIDER_TYPE;
            const providerStatus = (providerPoolManager.providerStatus || []).find(p => p.config.uuid === providerUuid);

            if (!providerStatus) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            console.log(`[UI API] Starting health check for single provider ${providerUuid} in ${providerType}`);

            const providerConfig = providerStatus.config;
            let result;

            try {
                const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);

                if (healthResult === null) {
                    result = {
                        uuid: providerConfig.uuid,
                        success: null,
                        message: '健康检测不支持此提供商类型'
                    };
                } else if (healthResult.success) {
                    providerPoolManager.markProviderHealthy(providerConfig, false, healthResult.modelName);
                    result = {
                        uuid: providerConfig.uuid,
                        success: true,
                        modelName: healthResult.modelName,
                        message: '健康'
                    };
                } else {
                    providerPoolManager.markProviderUnhealthy(providerConfig, healthResult.errorMessage);
                    providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                    if (healthResult.modelName) {
                        providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                    }
                    result = {
                        uuid: providerConfig.uuid,
                        success: false,
                        modelName: healthResult.modelName,
                        message: healthResult.errorMessage || '检测失败'
                    };
                }
            } catch (error) {
                providerPoolManager.markProviderUnhealthy(providerConfig, error.message);
                result = {
                    uuid: providerConfig.uuid,
                    success: false,
                    message: error.message
                };
            }

            // 保存更新后的状态到文件
            const filePath = await writeProviderPoolsFile(
                currentConfig,
                (providerPoolManager.providerStatus || []).map(ps => ps.config)
            );

            console.log(`[UI API] Single health check completed for ${providerUuid}: ${result.success ? 'healthy' : 'unhealthy'}`);

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'health_check',
                filePath: filePath,
                providerType: SINGLE_PROVIDER_TYPE,
                results: [result],
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                result
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Single health check error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Perform health check for all providers of a specific type
    const healthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/health-check$/);
    if (method === 'POST' && healthCheckMatch) {
        // 单一提供商模式：忽略 URL 中的 providerType

        try {
            if (!providerPoolManager) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
                return true;
            }

            const providerType = providerPoolManager.providerType || SINGLE_PROVIDER_TYPE;
            const providers = providerPoolManager.providerStatus || [];
            
            if (providers.length === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No providers found' } }));
                return true;
            }

            console.log(`[UI API] Starting health check for ${providers.length} providers (${providerType})`);

            // 执行健康检测（强制检查，忽略 checkHealth 配置）
            const results = [];
            for (const providerStatus of providers) {
                const providerConfig = providerStatus.config;
                try {
                    // 传递 forceCheck = true 强制执行健康检查，忽略 checkHealth 配置
                    const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);
                    
                    if (healthResult === null) {
                        results.push({
                            uuid: providerConfig.uuid,
                            success: null,
                            message: 'Health check not supported for this provider type'
                        });
                        continue;
                    }
                    
                    if (healthResult.success) {
                        providerPoolManager.markProviderHealthy(providerConfig, false, healthResult.modelName);
                        results.push({
                            uuid: providerConfig.uuid,
                            success: true,
                            modelName: healthResult.modelName,
                            message: 'Healthy'
                        });
                    } else {
                        providerPoolManager.markProviderUnhealthy(providerConfig, healthResult.errorMessage);
                        providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                        if (healthResult.modelName) {
                            providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                        }
                        results.push({
                            uuid: providerConfig.uuid,
                            success: false,
                            modelName: healthResult.modelName,
                            message: healthResult.errorMessage || 'Check failed'
                        });
                    }
                } catch (error) {
                    providerPoolManager.markProviderUnhealthy(providerConfig, error.message);
                    results.push({
                        uuid: providerConfig.uuid,
                        success: false,
                        message: error.message
                    });
                }
            }

            // 保存更新后的状态到文件
            const filePath = await writeProviderPoolsFile(
                currentConfig,
                (providerPoolManager.providerStatus || []).map(ps => ps.config)
            );

            const successCount = results.filter(r => r.success === true).length;
            const failCount = results.filter(r => r.success === false).length;

            console.log(`[UI API] Health check completed for ${providerType}: ${successCount} healthy, ${failCount} unhealthy`);

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'health_check',
                filePath: filePath,
                providerType: SINGLE_PROVIDER_TYPE,
                results,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
                successCount,
                failCount,
                totalCount: providers.length,
                results
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Health check error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Generate OAuth authorization URL for providers
    const generateAuthUrlMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/generate-auth-url$/);
    if (method === 'POST' && generateAuthUrlMatch) {
        const providerType = decodeURIComponent(generateAuthUrlMatch[1]);
        
        try {
            let authUrl = '';
            let authInfo = {};
            
            // 解析 options
            let options = {};
            try {
                options = await getRequestBody(req);
            } catch (e) {
                // 如果没有请求体，使用默认空对象
            }

            // 根据提供商类型生成授权链接并启动回调服务器
            if (providerType === 'claude-kiro-oauth') {
                // Kiro OAuth 支持多种认证方式
                // options.method 可以是: 'google' | 'github' | 'builder-id'
                const result = await handleKiroOAuth(currentConfig, options);
                authUrl = result.authUrl;
                authInfo = result.authInfo;
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: `Unsupported provider type: ${providerType}`
                    }
                }));
                return true;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                authUrl: authUrl,
                authInfo: authInfo
            }));
            return true;
            
        } catch (error) {
            console.error(`[UI API] Failed to generate auth URL for ${providerType}:`, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `Failed to generate auth URL: ${error.message}`
                }
            }));
            return true;
        }
    }

    // Server-Sent Events for real-time updates
    if (method === 'GET' && pathParam === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        res.write('\n');

        // Store the response object for broadcasting
        if (!global.eventClients) {
            global.eventClients = [];
        }
        global.eventClients.push(res);

        // Keep connection alive
        const keepAlive = setInterval(() => {
            res.write(':\n\n');
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
            global.eventClients = global.eventClients.filter(r => r !== res);
        });

        return true;
    }

    // Get upload configuration files list
    if (method === 'GET' && pathParam === '/api/upload-configs') {
        try {
            const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(configFiles));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to scan config files:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to scan config files: ' + error.message
                }
            }));
            return true;
        }
    }

    // View specific configuration file
    const viewConfigMatch = pathParam.match(/^\/api\/upload-configs\/view\/(.+)$/);
    if (method === 'GET' && viewConfigMatch) {
        try {
            const filePath = decodeURIComponent(viewConfigMatch[1]);
            const fullPath = path.join(process.cwd(), filePath);
            
            // 安全检查：确保文件路径在允许的目录内
            const allowedDirs = ['configs'];
            const relativePath = path.relative(process.cwd(), fullPath);
            const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
            
            if (!isAllowed) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Access denied: can only view files in configs directory'
                    }
                }));
                return true;
            }
            
            if (!existsSync(fullPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File does not exist'
                    }
                }));
                return true;
            }
            
            const content = await fs.readFile(fullPath, 'utf8');
            const stats = await fs.stat(fullPath);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                path: relativePath,
                content: content,
                size: stats.size,
                modified: stats.mtime.toISOString(),
                name: path.basename(fullPath)
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to view config file:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to view config file: ' + error.message
                }
            }));
            return true;
        }
    }

    // Delete specific configuration file
    const deleteConfigMatch = pathParam.match(/^\/api\/upload-configs\/delete\/(.+)$/);
    if (method === 'DELETE' && deleteConfigMatch) {
        try {
            const filePath = decodeURIComponent(deleteConfigMatch[1]);
            const fullPath = path.join(process.cwd(), filePath);
            
            // 安全检查：确保文件路径在允许的目录内
            const allowedDirs = ['configs'];
            const relativePath = path.relative(process.cwd(), fullPath);
            const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
            
            if (!isAllowed) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Access denied: can only delete files in configs directory'
                    }
                }));
                return true;
            }
            
            if (!existsSync(fullPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File does not exist'
                    }
                }));
                return true;
            }
            
            
            await fs.unlink(fullPath);
            
            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'delete',
                filePath: relativePath,
                timestamp: new Date().toISOString()
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'File deleted successfully',
                filePath: relativePath
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to delete config file:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to delete config file: ' + error.message
                }
            }));
            return true;
        }
    }

    // Download all configs as zip
    if (method === 'GET' && pathParam === '/api/upload-configs/download-all') {
        try {
            const configsPath = path.join(process.cwd(), 'configs');
            if (!existsSync(configsPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'configs directory does not exist' } }));
                return true;
            }

            const zip = new AdmZip();
            
            // 递归添加目录函数
            const addDirectoryToZip = async (dirPath, zipPath = '') => {
                const items = await fs.readdir(dirPath, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(dirPath, item.name);
                    const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;
                    
                    if (item.isFile()) {
                        const content = await fs.readFile(fullPath);
                        zip.addFile(itemZipPath.replace(/\\/g, '/'), content);
                    } else if (item.isDirectory()) {
                        await addDirectoryToZip(fullPath, itemZipPath);
                    }
                }
            };

            await addDirectoryToZip(configsPath);
            
            const zipBuffer = zip.toBuffer();
            const filename = `configs_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': zipBuffer.length
            });
            res.end(zipBuffer);
            
            console.log(`[UI API] All configs downloaded as zip: ${filename}`);
            return true;
        } catch (error) {
            console.error('[UI API] Failed to download all configs:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to download zip: ' + error.message
                }
            }));
            return true;
        }
    }

    // Quick link config to corresponding provider based on directory
    if (method === 'POST' && pathParam === '/api/quick-link-provider') {
        try {
            const body = await getRequestBody(req);
            const { filePath } = body;

            if (!filePath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'filePath is required' } }));
                return true;
            }

            const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
            
            // 根据文件路径自动识别提供商类型
            const providerMapping = detectProviderFromPath(normalizedPath);
            
            if (!providerMapping) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Unable to identify provider type for config file, please ensure file is in configs/kiro/ directory'
                    }
                }));
                return true;
            }

            const { providerType, credPathKey, defaultCheckModel, displayName } = providerMapping;
            const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            const providers = getProviderPools(currentConfig, providerPoolManager);

            // Check if already linked - 使用标准化路径进行比较
            const normalizedForComparison = filePath.replace(/\\/g, '/');
            const isAlreadyLinked = providers.some(p => {
                const existingPath = p[credPathKey];
                if (!existingPath) return false;
                const normalizedExistingPath = existingPath.replace(/\\/g, '/');
                return normalizedExistingPath === normalizedForComparison ||
                       normalizedExistingPath === './' + normalizedForComparison ||
                       './' + normalizedExistingPath === normalizedForComparison;
            });

            if (isAlreadyLinked) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'This config file is already linked' } }));
                return true;
            }

            // Create new provider config based on provider type
            const newProvider = createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(filePath),
                defaultCheckModel,
                needsProjectId: providerMapping.needsProjectId
                });

            const addResult = addProvider(newProvider, currentConfig, providerPoolManager);
            console.log(`[UI API] Quick linked config: ${filePath} -> ${addResult.providerType}`);

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'quick_link',
                filePath: poolsFilePath,
                providerType: SINGLE_PROVIDER_TYPE,
                newProvider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Config successfully linked to ${displayName}`,
                provider: newProvider,
                providerType: SINGLE_PROVIDER_TYPE
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Quick link failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Link failed: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get usage limits for all providers
    if (method === 'GET' && pathParam === '/api/usage') {
        try {
            // 解析查询参数，检查是否需要强制刷新
            const url = new URL(req.url, `http://${req.headers.host}`);
            const refresh = url.searchParams.get('refresh') === 'true';
            
            let usageResults;
            
            if (!refresh) {
                // 优先读取缓存
                const cachedData = await readUsageCache();
                if (cachedData) {
                    console.log('[Usage API] Returning cached usage data');
                    usageResults = { ...cachedData, fromCache: true };
                }
            }
            
            if (!usageResults) {
                // 缓存不存在或需要刷新，重新查询
                console.log('[Usage API] Fetching fresh usage data');
                usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
                // 写入缓存
                await writeUsageCache(usageResults);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(usageResults));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to get usage:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to get usage info: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get usage limits for a specific provider type
    const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);
    if (method === 'GET' && usageProviderMatch) {
        const providerType = decodeURIComponent(usageProviderMatch[1]);
        try {
            // 解析查询参数，检查是否需要强制刷新
            const url = new URL(req.url, `http://${req.headers.host}`);
            const refresh = url.searchParams.get('refresh') === 'true';
            
            let usageResults;
            
            if (!refresh) {
                // 优先读取缓存
                const cachedData = await readProviderUsageCache(providerType);
                if (cachedData) {
                    console.log(`[Usage API] Returning cached usage data for ${providerType}`);
                    usageResults = cachedData;
                }
            }
            
            if (!usageResults) {
                // 缓存不存在或需要刷新，重新查询
                console.log(`[Usage API] Fetching fresh usage data for ${providerType}`);
                usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
                // 更新缓存
                await updateProviderUsageCache(providerType, usageResults);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(usageResults));
            return true;
        } catch (error) {
            console.error(`[UI API] Failed to get usage for ${providerType}:`, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `Failed to get usage info for ${providerType}: ` + error.message
                }
            }));
            return true;
        }
    }

    // Check for updates - compare local VERSION with latest git tag
    if (method === 'GET' && pathParam === '/api/check-update') {
        try {
            const updateInfo = await checkForUpdates();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updateInfo));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to check for updates:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to check for updates: ' + error.message
                }
            }));
            return true;
        }
    }

    // Perform update - git fetch and checkout to latest tag
    if (method === 'POST' && pathParam === '/api/update') {
        try {
            const updateResult = await performUpdate();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updateResult));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to perform update:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Update failed: ' + error.message
                }
            }));
            return true;
        }
    }

    // Reload configuration files
    if (method === 'POST' && pathParam === '/api/reload-config') {
        try {
            // 调用重载配置函数
            const newConfig = await reloadConfig(providerPoolManager);
            
            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'reload',
                filePath: 'configs/config.json',
                providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null,
                timestamp: new Date().toISOString()
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Configuration files reloaded successfully',
                details: {
                    configReloaded: true,
                    configPath: 'configs/config.json',
                    providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null
                }
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to reload config files:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to reload configuration files: ' + error.message
                }
            }));
            return true;
        }
    }

    // Restart service (worker process)
    // 重启服务端点 - 支持主进程-子进程架构
    if (method === 'POST' && pathParam === '/api/restart-service') {
        try {
            const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
            
            if (IS_WORKER_PROCESS && process.send) {
                // 作为子进程运行，通知主进程重启
                console.log('[UI API] Requesting restart from master process...');
                process.send({ type: 'restart_request' });
                
                // 广播重启事件
                broadcastEvent('service_restart', {
                    action: 'restart_requested',
                    timestamp: new Date().toISOString(),
                    message: 'Service restart requested, worker will be restarted by master process'
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'Restart request sent to master process',
                    mode: 'worker',
                    details: {
                        workerPid: process.pid,
                        restartMethod: 'master_controlled'
                    }
                }));
            } else {
                // 独立运行模式，无法自动重启
                console.log('[UI API] Service is running in standalone mode, cannot auto-restart');
                
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: 'Service is running in standalone mode. Please use master.js to enable auto-restart feature.',
                    mode: 'standalone',
                    hint: 'Start the service with: node src/master.js [args]'
                }));
            }
            return true;
        } catch (error) {
            console.error('[UI API] Failed to restart service:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to restart service: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get service mode information
    // 获取服务运行模式信息
    if (method === 'GET' && pathParam === '/api/service-mode') {
        const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
        const masterPort = process.env.MASTER_PORT || 3100;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            mode: IS_WORKER_PROCESS ? 'worker' : 'standalone',
            pid: process.pid,
            ppid: process.ppid,
            uptime: process.uptime(),
            canAutoRestart: IS_WORKER_PROCESS && !!process.send,
            masterPort: IS_WORKER_PROCESS ? masterPort : null,
            nodeVersion: process.version,
            platform: process.platform
        }));
        return true;
    }

    return false;
}

/**
 * Initialize UI management features
 */
export function initializeUIManagement() {
    // Initialize log broadcasting for UI
    if (!global.eventClients) {
        global.eventClients = [];
    }
    if (!global.logBuffer) {
        global.logBuffer = [];
    }

    // Override console.log to broadcast logs
    const originalLog = console.log;
    console.log = function(...args) {
        originalLog.apply(console, args);
        const message = args.map(arg => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch (e) {
                if (arg instanceof Error) {
                    return `[Error: ${arg.message}] ${arg.stack || ''}`;
                }
                return `[Object: ${Object.prototype.toString.call(arg)}] (Circular or too complex to stringify)`;
            }
        }).join(' ');
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: message
        };
        global.logBuffer.push(logEntry);
        if (global.logBuffer.length > 100) {
            global.logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };

    // Override console.error to broadcast errors
    const originalError = console.error;
    console.error = function(...args) {
        originalError.apply(console, args);
        const message = args.map(arg => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch (e) {
                if (arg instanceof Error) {
                    return `[Error: ${arg.message}] ${arg.stack || ''}`;
                }
                return `[Object: ${Object.prototype.toString.call(arg)}] (Circular or too complex to stringify)`;
            }
        }).join(' ');
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'error',
            message: message
        };
        global.logBuffer.push(logEntry);
        if (global.logBuffer.length > 100) {
            global.logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };
}

/**
 * 读取用量缓存文件
 * @returns {Promise<Object|null>} 缓存的用量数据，如果不存在或读取失败则返回 null
 */
async function readUsageCache() {
    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            return JSON.parse(content);
        }
        return null;
    } catch (error) {
        console.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * 写入用量缓存文件
 * @param {Object} usageData - 用量数据
 */
async function writeUsageCache(usageData) {
    try {
        await fs.writeFile(USAGE_CACHE_FILE, JSON.stringify(usageData, null, 2), 'utf8');
        console.log('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
    } catch (error) {
        console.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * 读取特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
async function readProviderUsageCache(providerType) {
    const cache = await readUsageCache();
    if (cache && cache.providers && cache.providers[providerType]) {
        return {
            ...cache.providers[providerType],
            cachedAt: cache.timestamp,
            fromCache: true
        };
    }
    return null;
}

/**
 * 更新特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
async function updateProviderUsageCache(providerType, usageData) {
    let cache = await readUsageCache();
    if (!cache) {
        cache = {
            timestamp: new Date().toISOString(),
            providers: {}
        };
    }
    cache.providers[providerType] = usageData;
    cache.timestamp = new Date().toISOString();
    await writeUsageCache(cache);
}
