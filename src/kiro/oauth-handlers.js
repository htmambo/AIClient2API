import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { broadcastEvent } from '../ui/event-broadcaster.js';
import { autoLinkProviderConfigs } from '../service-manager.js';
import { CONFIG } from '../config-manager.js';

/**
 * Kiro OAuth 配置（支持多种认证方式）
 */
const KIRO_OAUTH_CONFIG = {
    // Kiro Auth Service 端点 (用于 Social Auth)
    authServiceEndpoint: 'https://prod.us-east-1.auth.desktop.kiro.dev',
    
    // AWS SSO OIDC 端点 (用于 Builder ID)
    ssoOIDCEndpoint: 'https://oidc.us-east-1.amazonaws.com',
    
    // AWS Builder ID 起始 URL
    builderIDStartURL: 'https://view.awsapps.com/start',
    
    // 本地回调端口范围（用于 Social Auth HTTP 回调）
    callbackPortStart: 19876,
    callbackPortEnd: 19880,
    
    // 超时配置
    authTimeout: 10 * 60 * 1000,  // 10 分钟
    pollInterval: 5000,           // 5 秒
    
    // CodeWhisperer Scopes
    scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist'
    ],
    
    // 凭据存储（符合现有规范）
    credentialsDir: '.kiro',
    credentialsFile: 'oauth_creds.json',
    
    // 日志前缀
    logPrefix: '[Kiro Auth]'
};

/**
 * 活动的 Kiro 回调服务器管理
 */
const activeKiroServers = new Map();

/**
 * 活动的 Kiro 轮询任务管理（用于 Builder ID Device Code）
 */
const activeKiroPollingTasks = new Map();

/**
 * 生成 HTML 响应页面
 * @param {boolean} isSuccess - 是否成功
 * @param {string} message - 显示消息
 * @returns {string} HTML 内容
 */
function generateResponsePage(isSuccess, message) {
    const title = isSuccess ? '授权成功！' : '授权失败';
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
    </div>
</body>
</html>`;
}

/**
 * 关闭指定端口的活动服务器
 * @param {number} port - 端口号
 * @returns {Promise<void>}
 */
/**
 * 生成 PKCE 代码验证器
 * @returns {string} Base64URL 编码的随机字符串
 */
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * 生成 PKCE 代码挑战
 * @param {string} codeVerifier - 代码验证器
 * @returns {string} Base64URL 编码的 SHA256 哈希
 */
function generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256');
    hash.update(codeVerifier);
    return hash.digest('base64url');
}


/**
 * 处理 Kiro OAuth 授权（统一入口）
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 *   - method: 'builder-id'
 *   - saveToConfigs: boolean
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleKiroOAuth(currentConfig, options = {}) {
    const method = options.method || 'builder-id';  // 默认使用 builder-id
    
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Starting OAuth with method: ${method}`);
    
    switch (method) {
        case 'builder-id':
            return handleKiroBuilderIDDeviceCode(currentConfig, options);
        default:
            throw new Error(`不支持的认证方式: ${method}`);
    }
}

/**
 * Kiro Builder ID - Device Code Flow
 */
async function handleKiroBuilderIDDeviceCode(currentConfig, options = {}) {
    // 停止之前的轮询任务
    for (const [existingTaskId] of activeKiroPollingTasks.entries()) {
        if (existingTaskId.startsWith('kiro-')) {
            stopKiroPollingTask(existingTaskId);
        }
    }

    // 1. 注册 OIDC 客户端
    const regResponse = await fetch(`${KIRO_OAUTH_CONFIG.ssoOIDCEndpoint}/client/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'KiroIDE'
        },
        body: JSON.stringify({
            clientName: 'Kiro IDE',
            clientType: 'public',
            scopes: KIRO_OAUTH_CONFIG.scopes,
            grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
        })
    });
    
    if (!regResponse.ok) {
        throw new Error(`Kiro OAuth 客户端注册失败: ${regResponse.status}`);
    }
    
    const regData = await regResponse.json();
    
    // 2. 启动设备授权
    const authResponse = await fetch(`${KIRO_OAUTH_CONFIG.ssoOIDCEndpoint}/device_authorization`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'KiroIDE'
        },
        body: JSON.stringify({
            clientId: regData.clientId,
            clientSecret: regData.clientSecret,
            startUrl: KIRO_OAUTH_CONFIG.builderIDStartURL
        })
    });
    
    if (!authResponse.ok) {
        throw new Error(`Kiro OAuth 设备授权失败: ${authResponse.status}`);
    }
    
    const deviceAuth = await authResponse.json();
    
    // 3. 启动后台轮询
    const taskId = `kiro-${deviceAuth.deviceCode.substring(0, 8)}-${Date.now()}`;

    
    // 异步轮询
    pollKiroBuilderIDToken(
        regData.clientId,
        regData.clientSecret,
        deviceAuth.deviceCode,
        5, 
        300, 
        taskId,
        options
    ).catch(error => {
        console.error(`${KIRO_OAUTH_CONFIG.logPrefix} 轮询失败 [${taskId}]:`, error);
        broadcastEvent('oauth_error', {
            provider: 'claude-kiro-oauth',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    });
    
    return {
        authUrl: deviceAuth.verificationUriComplete,
        authInfo: {
            provider: 'claude-kiro-oauth',
            authMethod: 'builder-id',
            deviceCode: deviceAuth.deviceCode,
            userCode: deviceAuth.userCode,
            verificationUri: deviceAuth.verificationUri,
            verificationUriComplete: deviceAuth.verificationUriComplete,
            expiresIn: deviceAuth.expiresIn,
            interval: deviceAuth.interval,
            ...options
        }
    };
}

/**
 * 轮询获取 Kiro Builder ID Token
 */
async function pollKiroBuilderIDToken(clientId, clientSecret, deviceCode, interval, expiresIn, taskId, options = {}) {
    let credPath = path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir, KIRO_OAUTH_CONFIG.credentialsFile);
    const maxAttempts = Math.floor(expiresIn / interval);
    let attempts = 0;
    
    const taskControl = { shouldStop: false };
    activeKiroPollingTasks.set(taskId, taskControl);
    
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 开始轮询令牌 [${taskId}]`);
    
    const poll = async () => {
        if (taskControl.shouldStop) {
            throw new Error('轮询任务已被取消');
        }
        
        if (attempts >= maxAttempts) {
            activeKiroPollingTasks.delete(taskId);
            throw new Error('授权超时');
        }
        
        attempts++;
        
        try {
            const response = await fetch(`${KIRO_OAUTH_CONFIG.ssoOIDCEndpoint}/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'KiroIDE'
                },
                body: JSON.stringify({
                    clientId,
                    clientSecret,
                    deviceCode,
                    grantType: 'urn:ietf:params:oauth:grant-type:device_code'
                })
            });
            
            const data = await response.json();
            
            if (response.ok && data.accessToken) {
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 成功获取令牌 [${taskId}]`);
                
                // 保存令牌（符合现有规范）
                if (options.saveToConfigs) {
                    const timestamp = Date.now();
                    const fileName = `${timestamp}_kiro-auth-token.json`;
                    const targetDir = path.join(process.cwd(), 'configs', 'kiro');
                    await fs.promises.mkdir(targetDir, { recursive: true });
                    credPath = path.join(targetDir, fileName);
                }
                
                const tokenData = {
                    accessToken: data.accessToken,
                    refreshToken: data.refreshToken,
                    expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
                    authMethod: 'builder-id',
                    clientId,
                    clientSecret,
                    region: 'us-east-1'
                };
                
                await fs.promises.mkdir(path.dirname(credPath), { recursive: true });
                await fs.promises.writeFile(credPath, JSON.stringify(tokenData, null, 2));
                
                activeKiroPollingTasks.delete(taskId);
                
                // 广播成功事件（符合现有规范）
                broadcastEvent('oauth_success', {
                    provider: 'claude-kiro-oauth',
                    credPath,
                    relativePath: path.relative(process.cwd(), credPath),
                    timestamp: new Date().toISOString()
                });
                
                // 自动关联新生成的凭据到 Pools
                await autoLinkProviderConfigs(CONFIG);
                
                return tokenData;
            }
            
            // 检查错误类型
            if (data.error === 'authorization_pending') {
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 等待用户授权 [${taskId}]... (${attempts}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
                return poll();
            } else if (data.error === 'slow_down') {
                await new Promise(resolve => setTimeout(resolve, (interval + 5) * 1000));
                return poll();
            } else {
                activeKiroPollingTasks.delete(taskId);
                throw new Error(`授权失败: ${data.error || '未知错误'}`);
            }
        } catch (error) {
            if (error.message.includes('授权') || error.message.includes('取消')) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, interval * 1000));
            return poll();
        }
    };
    
    return poll();
}

/**
 * 停止 Kiro 轮询任务
 */
function stopKiroPollingTask(taskId) {
    const task = activeKiroPollingTasks.get(taskId);
    if (task) {
        task.shouldStop = true;
        activeKiroPollingTasks.delete(taskId);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 已停止轮询任务: ${taskId}`);
    }
}

/**
 * 启动 Kiro 回调服务器（用于 Social Auth HTTP 回调）
 */
async function startKiroCallbackServer(codeVerifier, expectedState, options = {}) {
    const portStart = KIRO_OAUTH_CONFIG.callbackPortStart;
    const portEnd = KIRO_OAUTH_CONFIG.callbackPortEnd;
    
    for (let port = portStart; port <= portEnd; port++) {
    // 关闭已存在的服务器
    await closeKiroServer(port);
    
    try {
        const server = await createKiroHttpCallbackServer(port, codeVerifier, expectedState, options);
        activeKiroServers.set('claude-kiro-oauth', { server, port });
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 回调服务器已启动于端口 ${port}`);
        return port;
    } catch (err) {
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 端口 ${port} 被占用，尝试下一个...`);
    }
    }
    
    throw new Error('所有端口都被占用');
}

/**
 * 关闭 Kiro 服务器
 */
async function closeKiroServer(provider, port = null) {
    const existing = activeKiroServers.get(provider);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeKiroServers.delete(provider);
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
                resolve();
            });
        });
    }

    if (port) {
        for (const [p, info] of activeKiroServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeKiroServers.delete(p);
                        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 已关闭端口 ${port} 上的旧服务器`);
                        resolve();
                    });
                });
            }
        }
    }
}

/**
 * 创建 Kiro HTTP 回调服务器
 */
function createKiroHttpCallbackServer(port, codeVerifier, expectedState, options = {}) {
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                
                if (url.pathname === '/oauth/callback') {
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const errorParam = url.searchParams.get('error');
                    
                    if (errorParam) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                        return;
                    }
                    
                    if (state !== expectedState) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, 'State 验证失败'));
                        return;
                    }
                    
                    // 交换 Code 获取 Token（使用动态的 redirect_uri）
                    const tokenResponse = await fetch(`${KIRO_OAUTH_CONFIG.authServiceEndpoint}/oauth/token`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'AIClient-2-API/1.0.0'
                        },
                        body: JSON.stringify({
                            code,
                            code_verifier: codeVerifier,
                            redirect_uri: redirectUri
                        })
                    });
                    
                    if (!tokenResponse.ok) {
                        const errorText = await tokenResponse.text();
                        console.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token exchange failed:`, errorText);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `获取令牌失败: ${tokenResponse.status}`));
                        return;
                    }
                    
                    const tokenData = await tokenResponse.json();
                    
                    // 保存令牌
                    let credPath = path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir, KIRO_OAUTH_CONFIG.credentialsFile);
                    
                    if (options.saveToConfigs) {
                        const timestamp = Date.now();
                        const fileName = `${timestamp}_kiro-auth-token.json`;
                        const targetDir = path.join(process.cwd(), 'configs', 'kiro');
                        await fs.promises.mkdir(targetDir, { recursive: true });
                        credPath = path.join(targetDir, fileName);
                    }
                    
                    const saveData = {
                        accessToken: tokenData.accessToken,
                        refreshToken: tokenData.refreshToken,
                        profileArn: tokenData.profileArn,
                        expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
                        authMethod: 'social',
                        region: 'us-east-1'
                    };
                    
                    await fs.promises.mkdir(path.dirname(credPath), { recursive: true });
                    await fs.promises.writeFile(credPath, JSON.stringify(saveData, null, 2));
                    
                    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 令牌已保存: ${credPath}`);
                    
                    // 广播成功事件
                    broadcastEvent('oauth_success', {
                        provider: 'claude-kiro-oauth',
                        credPath,
                        relativePath: path.relative(process.cwd(), credPath),
                        timestamp: new Date().toISOString()
                    });
                    
                    // 自动关联新生成的凭据到 Pools
                    await autoLinkProviderConfigs(CONFIG);
                    
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(true, '授权成功！您可以关闭此页面'));
                    
                    // 关闭服务器
                    server.close(() => {
                        activeKiroServers.delete('claude-kiro-oauth');
                    });
                    
                } else {
                    res.writeHead(204);
                    res.end();
                }
            } catch (error) {
                console.error(`${KIRO_OAUTH_CONFIG.logPrefix} 处理回调出错:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
            }
        });
        
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
        
        // 超时自动关闭
        setTimeout(() => {
            if (server.listening) {
                server.close(() => {
                    activeKiroServers.delete('claude-kiro-oauth');
                });
            }
        }, KIRO_OAUTH_CONFIG.authTimeout);
    });
}
