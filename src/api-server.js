import * as http from 'http';
import { initializeConfig, CONFIG, logProviderSpecificDetails } from './config-manager.js';
import { initApiService, autoLinkProviderConfigs } from './service-manager.js';
import { initializeUIManagement } from './ui-manager.js';
import { initializeAPIManagement } from './common.js';
import { createRequestHandler } from './request-handler.js';

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * 描述 / Description:
 * (最终生产就绪版本 / Final Production Ready Version)
 * 此脚本创建一个独立的 Node.js HTTP 服务器，作为 AI 模型 API 的本地代理。
 * 此版本包含所有功能和错误修复，设计为健壮、灵活且易于通过全面可控的日志系统进行监控。
 * 
 * This script creates a standalone Node.js HTTP server that acts as a local proxy for AI model APIs.
 * This version includes all features and bug fixes, designed to be robust, flexible, and easy to monitor through a comprehensive and controllable logging system.
 *
 * 使用示例 / Usage Examples:
 * 
 * 基本用法 / Basic Usage:
 * node src/api-server.js
 * 
 * 服务器配置 / Server Configuration:
 * node src/api-server.js --host 0.0.0.0 --port 8080 --api-key your-secret-key
 *
 * Kiro 提供商（OAuth）/ Kiro Provider (OAuth):
 * node src/api-server.js --model-provider claude-kiro-oauth --kiro-oauth-creds-file /path/to/credentials.json
 *
 * 系统提示管理 / System Prompt Management:
 * node src/api-server.js --system-prompt-file custom-prompt.txt --system-prompt-mode append
 *
 * 日志配置 / Logging Configuration:
 * node src/api-server.js --log-prompts console
 * node src/api-server.js --log-prompts file --prompt-log-base-name my-logs
 *
 * 完整示例 / Complete Example:
 * node src/api-server.js \
 *   --host 0.0.0.0 \
 *   --port 3000 \
 *   --api-key my-secret-key \
 *   --model-provider claude-kiro-oauth \
 *   --kiro-oauth-creds-file ./credentials.json \
 *   --system-prompt-file ./custom-system-prompt.txt \
 *   --system-prompt-mode overwrite \
 *   --log-prompts file \
 *   --prompt-log-base-name api-logs
 *
 * 命令行参数 / Command Line Parameters:
 * --host <address>                    服务器监听地址 / Server listening address (default: 0.0.0.0)
 * --port <number>                     服务器监听端口 / Server listening port (default: 3000)
 * --api-key <key>                     身份验证所需的 API 密钥 / Required API key for authentication (default: 123456)
 * --model-provider <provider[,provider...]> AI 模型提供商 / AI model provider: claude-kiro-oauth
 * --kiro-oauth-creds-base64 <b64>    Kiro OAuth 凭据的 Base64 字符串 / Kiro OAuth credentials as Base64 string
 * --kiro-oauth-creds-file <path>     Kiro OAuth 凭据 JSON 文件路径 / Path to Kiro OAuth credentials JSON file
 * --project-id <id>                  项目 ID（按需）/ Project ID (optional)
 * --system-prompt-file <path>        系统提示文件路径 / Path to system prompt file (default: configs/input_system_prompt.txt)
 * --system-prompt-mode <mode>        系统提示模式 / System prompt mode: overwrite or append (default: overwrite)
 * --log-prompts <mode>               提示日志模式 / Prompt logging mode: console, file, or none (default: none)
 * --prompt-log-base-name <name>      提示日志文件基础名称 / Base name for prompt log files (default: prompt_log)
 * --request-max-retries <number>     API 请求失败时，自动重试的最大次数。 / Max retries for API requests on failure (default: 3)
 * --request-base-delay <number>      自动重试之间的基础延迟时间（毫秒）。每次重试后延迟会增加。 / Base delay in milliseconds between retries, increases with each retry (default: 1000)
 * --cron-near-minutes <number>       OAuth 令牌刷新任务计划的间隔时间（分钟）。 / Interval for OAuth token refresh task in minutes (default: 15)
 * --cron-refresh-token <boolean>     是否开启 OAuth 令牌自动刷新任务 / Whether to enable automatic OAuth token refresh task (default: true)
 * --provider-pools-file <path>       提供商号池配置文件路径 / Path to provider pools configuration file (default: null)
 *
 */

import 'dotenv/config'; // Import dotenv and configure it
import { getProviderPoolManager } from './service-manager.js';

// 检测是否作为子进程运行
const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';

// 存储服务器实例，用于优雅关闭
let serverInstance = null;

/**
 * 发送消息给主进程
 * @param {Object} message - 消息对象
 */
function sendToMaster(message) {
    if (IS_WORKER_PROCESS && process.send) {
        process.send(message);
    }
}

/**
 * 设置子进程通信处理
 */
function setupWorkerCommunication() {
    if (!IS_WORKER_PROCESS) return;

    // 监听来自主进程的消息
    process.on('message', (message) => {
        if (!message || !message.type) return;

        console.log('[Worker] Received message from master:', message.type);

        switch (message.type) {
            case 'shutdown':
                console.log('[Worker] Shutdown requested by master');
                gracefulShutdown();
                break;
            case 'status':
                sendToMaster({
                    type: 'status',
                    data: {
                        pid: process.pid,
                        uptime: process.uptime(),
                        memoryUsage: process.memoryUsage()
                    }
                });
                break;
            default:
                console.log('[Worker] Unknown message type:', message.type);
        }
    });

    // 监听断开连接
    process.on('disconnect', () => {
        console.log('[Worker] Disconnected from master, shutting down...');
        gracefulShutdown();
    });
}

/**
 * 优雅关闭服务器
 */
async function gracefulShutdown() {
    console.log('[Server] Initiating graceful shutdown...');

    if (serverInstance) {
        serverInstance.close(() => {
            console.log('[Server] HTTP server closed');
            process.exit(0);
        });

        // 设置超时，防止无限等待
        setTimeout(() => {
            console.log('[Server] Shutdown timeout, forcing exit...');
            process.exit(1);
        }, 10000);
    } else {
        process.exit(0);
    }
}

/**
 * 设置进程信号处理
 */
function setupSignalHandlers() {
    process.on('SIGTERM', () => {
        console.log('[Server] Received SIGTERM');
        gracefulShutdown();
    });

    process.on('SIGINT', () => {
        console.log('[Server] Received SIGINT');
        gracefulShutdown();
    });

    process.on('uncaughtException', (error) => {
        console.error('[Server] Uncaught exception:', error);
        gracefulShutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
    });
}

// --- Server Initialization ---
async function startServer() {
    // Initialize configuration
    await initializeConfig(process.argv.slice(2), 'configs/config.json');
    
    // 自动关联 configs 目录中的配置文件到对应的提供商
    console.log('[Initialization] Checking for unlinked provider configs...');
    await autoLinkProviderConfigs(CONFIG);

    // Initialize API services
    const services = await initApiService(CONFIG);
    
    // Initialize UI management features
    initializeUIManagement(CONFIG);
    
    // Initialize API management and get heartbeat function
    const heartbeatAndRefreshToken = initializeAPIManagement(services);
    
    // Create request handler
    const requestHandlerInstance = createRequestHandler(CONFIG, getProviderPoolManager());

    serverInstance = http.createServer(requestHandlerInstance);
    serverInstance.listen(CONFIG.SERVER_PORT, CONFIG.HOST, async () => {
        console.log(`--- Unified API Server Configuration ---`);
        const configuredProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 0
            ? CONFIG.DEFAULT_MODEL_PROVIDERS
            : [CONFIG.MODEL_PROVIDER];
        const uniqueProviders = [...new Set(configuredProviders)];
        console.log(`  Primary Model Provider: ${CONFIG.MODEL_PROVIDER}`);
        if (uniqueProviders.length > 1) {
            console.log(`  Additional Model Providers: ${uniqueProviders.slice(1).join(', ')}`);
        }
        uniqueProviders.forEach((provider) => logProviderSpecificDetails(provider, CONFIG));
        console.log(`  System Prompt File: ${CONFIG.SYSTEM_PROMPT_FILE_PATH || 'Default'}`);
        console.log(`  System Prompt Mode: ${CONFIG.SYSTEM_PROMPT_MODE}`);
        console.log(`  Host: ${CONFIG.HOST}`);
        console.log(`  Port: ${CONFIG.SERVER_PORT}`);
        console.log(`  Required API Key: ${CONFIG.REQUIRED_API_KEY}`);
        console.log(`  Prompt Logging: ${CONFIG.PROMPT_LOG_MODE}${CONFIG.PROMPT_LOG_FILENAME ? ` (to ${CONFIG.PROMPT_LOG_FILENAME})` : ''}`);
        console.log(`------------------------------------------`);
        console.log(`\nUnified API Server running on http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}`);
        console.log(`Supports multiple API formats:`);
        console.log(`  • Claude-compatible: /v1/messages`);
        console.log(`  • Health check: /health`);
        console.log(`  • UI Management Console: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/`);

        // Auto-open browser to UI
        try {
            const open = (await import('open')).default;
            setTimeout(() => {
                let openUrl = `http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`;
                if(CONFIG.HOST === '0.0.0.0'){
                    openUrl = `http://localhost:${CONFIG.SERVER_PORT}/login.html`;
                }
                open(openUrl)
                    .then(() => {
                        console.log('[UI] Opened login page in default browser');
                    })
                    .catch(err => {
                        console.log('[UI] Please open manually: http://' + CONFIG.HOST + ':' + CONFIG.SERVER_PORT + '/login.html');
                    });
            }, 1000);
        } catch (err) {
            console.log(`[UI] Login page available at: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`);
        }

        if (CONFIG.CRON_REFRESH_TOKEN) {
            console.log(`  • Cron Near Minutes: ${CONFIG.CRON_NEAR_MINUTES}`);
            console.log(`  • Cron Refresh Token: ${CONFIG.CRON_REFRESH_TOKEN}`);
            // 每 CRON_NEAR_MINUTES 分钟执行一次心跳日志和令牌刷新
            setInterval(heartbeatAndRefreshToken, CONFIG.CRON_NEAR_MINUTES * 60 * 1000);
        }
        // 服务器完全启动后,执行初始健康检查
        const poolManager = getProviderPoolManager();
        if (poolManager) {
            console.log('[Initialization] Performing initial health checks for provider pools...');
            poolManager.performHealthChecks(true);
        }

        // 如果是子进程，通知主进程已就绪
        if (IS_WORKER_PROCESS) {
            sendToMaster({ type: 'ready', pid: process.pid });
        }
    });
    return serverInstance; // Return the server instance for testing purposes
}

// 设置信号处理
setupSignalHandlers();

// 设置子进程通信
setupWorkerCommunication();

startServer().catch(err => {
    console.error("[Server] Failed to start server:", err.message);
    process.exit(1);
});

// 导出用于外部调用
export { gracefulShutdown, sendToMaster };
