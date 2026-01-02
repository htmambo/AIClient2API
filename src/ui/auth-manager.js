/**
 * UI 认证管理模块
 * 负责 Token 管理、密码验证、登录处理
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { existsSync } from 'fs';
import { getRequestBody } from '../common.js';
import { createLogger } from '../logger.js';

const logger = createLogger('AuthManager');

// Token 存储文件路径
const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token_store.json');

// 默认密码（当pwd文件不存在时使用）
const DEFAULT_PASSWORD = 'admin123';

/**
 * 读取token存储文件
 */
async function readTokenStore() {
    try {
        if (existsSync(TOKEN_STORE_FILE)) {
            const content = await fs.readFile(TOKEN_STORE_FILE, 'utf8');
            return JSON.parse(content);
        } else {
            // 如果文件不存在，创建一个默认的token store
            await writeTokenStore({ tokens: {} });
            return { tokens: {} };
        }
    } catch (error) {
        logger.error('Failed to read token store file', error);
        return { tokens: {} };
    }
}

/**
 * 写入token存储文件
 */
async function writeTokenStore(tokenStore) {
    try {
        await fs.writeFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), 'utf8');
    } catch (error) {
        logger.error('Failed to write token store file', error);
    }
}

/**
 * 生成简单的token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 生成token过期时间
 */
function getExpiryTime() {
    const now = Date.now();
    const expiry = 60 * 60 * 1000; // 1小时
    return now + expiry;
}

/**
 * 验证简单token
 */
async function verifyToken(token) {
    const tokenStore = await readTokenStore();
    const tokenInfo = tokenStore.tokens[token];
    if (!tokenInfo) {
        return null;
    }

    // 检查是否过期
    if (Date.now() > tokenInfo.expiryTime) {
        await deleteToken(token);
        return null;
    }

    return tokenInfo;
}

/**
 * 保存token到本地文件
 */
async function saveToken(token, tokenInfo) {
    const tokenStore = await readTokenStore();
    tokenStore.tokens[token] = tokenInfo;
    await writeTokenStore(tokenStore);
}

/**
 * 删除token
 */
async function deleteToken(token) {
    const tokenStore = await readTokenStore();
    if (tokenStore.tokens[token]) {
        delete tokenStore.tokens[token];
        await writeTokenStore(tokenStore);
    }
}

/**
 * 清理过期的token
 */
export async function cleanupExpiredTokens() {
    const tokenStore = await readTokenStore();
    const now = Date.now();
    let hasChanges = false;

    for (const token in tokenStore.tokens) {
        if (now > tokenStore.tokens[token].expiryTime) {
            delete tokenStore.tokens[token];
            hasChanges = true;
        }
    }

    if (hasChanges) {
        await writeTokenStore(tokenStore);
        logger.debug('Cleaned up expired tokens');
    }
}

/**
 * 读取密码文件内容
 * 如果文件不存在或读取失败，返回默认密码
 */
async function readPasswordFile() {
    const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
    try {
        const password = await fs.readFile(pwdFilePath, 'utf8');
        const trimmedPassword = password.trim();
        // 如果密码文件为空，使用默认密码
        if (!trimmedPassword) {
            logger.info('Password file is empty, using default password');
            return DEFAULT_PASSWORD;
        }
        logger.debug('Successfully read password file');
        return trimmedPassword;
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('Password file does not exist, using default password');
        } else {
            logger.error('Failed to read password file', error);
        }
        return DEFAULT_PASSWORD;
    }
}

/**
 * 验证登录凭据
 */
async function validateCredentials(password) {
    const storedPassword = await readPasswordFile();
    logger.debug('Validating password', {
        storedLength: storedPassword ? storedPassword.length : 0,
        inputLength: password ? password.length : 0
    });
    const isValid = storedPassword && password === storedPassword;
    logger.debug('Password validation result', { isValid });
    return isValid;
}

/**
 * 检查token验证
 */
export async function checkAuth(req) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }

    const token = authHeader.substring(7);
    const tokenInfo = await verifyToken(token);

    return tokenInfo !== null;
}

/**
 * 处理登录请求
 */
export async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Only POST requests are supported' }));
        return true;
    }

    try {
        const requestData = await getRequestBody(req);
        const { password } = requestData;

        if (!password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Password cannot be empty' }));
            return true;
        }

        const isValid = await validateCredentials(password);

        if (isValid) {
            // 生成简单token
            const token = generateToken();
            const expiryTime = getExpiryTime();

            // 存储token信息到本地文件
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime
            });

            logger.info('User logged in successfully');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: '1 hour'
            }));
        } else {
            logger.warn('Failed login attempt');
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Incorrect password, please try again'
            }));
        }
    } catch (error) {
        logger.error('Login processing error', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: error.message || 'Server error'
        }));
    }
    return true;
}

// 定时清理过期token（每5分钟）
setInterval(cleanupExpiredTokens, 5 * 60 * 1000);
