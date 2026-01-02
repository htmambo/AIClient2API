/**
 * Kiro 认证管理模块
 * 负责处理 OAuth 认证、Token 刷新等功能
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { KIRO_CONSTANTS, KIRO_AUTH_TOKEN_FILE } from './constants.js';

/**
 * 加载凭据文件
 * @param {string} filePath - 文件路径
 * @returns {Promise<Object|null>} 凭据对象或 null
 */
async function loadCredentialsFromFile(filePath) {
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.debug(`[Kiro Auth] Credential file not found: ${filePath}`);
        } else if (error instanceof SyntaxError) {
            console.warn(`[Kiro Auth] Failed to parse JSON from ${filePath}: ${error.message}`);
        } else {
            console.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`);
        }
        return null;
    }
}

/**
 * 保存凭据到文件
 * @param {string} filePath - 文件路径
 * @param {Object} newData - 新数据
 */
async function saveCredentialsToFile(filePath, newData) {
    try {
        let existingData = {};
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            existingData = JSON.parse(fileContent);
        } catch (readError) {
            if (readError.code === 'ENOENT') {
                console.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`);
            } else {
                console.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`);
            }
        }
        const mergedData = { ...existingData, ...newData };
        await fs.writeFile(filePath, JSON.stringify(mergedData, null, 2), 'utf8');
        console.info(`[Kiro Auth] Updated token file: ${filePath}`);
    } catch (error) {
        console.error(`[Kiro Auth] Failed to write token to file ${filePath}: ${error.message}`);
    }
}

/**
 * Kiro 认证管理器类
 */
export class KiroAuthManager {
    constructor(config = {}) {
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(process.env.HOME || process.env.USERPROFILE, ".aws", "sso", "cache");
        this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH;
        this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;

        // 认证信息
        this.accessToken = null;
        this.refreshToken = null;
        this.clientId = null;
        this.clientSecret = null;
        this.authMethod = null;
        this.expiresAt = null;
        this.profileArn = null;
        this.region = null;

        // URL 配置
        this.refreshUrl = null;
        this.refreshIDCUrl = null;
        this.baseUrl = null;
        this.amazonQUrl = null;

        // Base64 凭据缓存
        this.base64Creds = null;

        // 解析 Base64 凭据
        if (this.credsBase64) {
            try {
                const decodedCreds = Buffer.from(this.credsBase64, 'base64').toString('utf8');
                this.base64Creds = JSON.parse(decodedCreds);
                console.info('[Kiro Auth] Successfully decoded Base64 credentials');
            } catch (error) {
                console.error(`[Kiro Auth] Failed to parse Base64 credentials: ${error.message}`);
            }
        }
    }

    /**
     * 初始化认证
     * @param {boolean} forceRefresh - 是否强制刷新
     * @param {Object} axiosInstance - Axios 实例
     */
    async initializeAuth(forceRefresh = false, axiosInstance = null) {
        if (this.accessToken && !forceRefresh) {
            console.debug('[Kiro Auth] Access token already available and not forced refresh.');
            return;
        }

        try {
            let mergedCredentials = {};

            // Priority 1: 从 Base64 凭据加载
            if (this.base64Creds) {
                Object.assign(mergedCredentials, this.base64Creds);
                console.info('[Kiro Auth] Successfully loaded credentials from Base64');
                this.base64Creds = null;
            }

            // Priority 2 & 3: 从文件加载凭据
            const targetFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
            const dirPath = path.dirname(targetFilePath);
            const targetFileName = path.basename(targetFilePath);

            console.debug(`[Kiro Auth] Attempting to load credentials from directory: ${dirPath}`);

            try {
                // 读取目标文件
                const targetCredentials = await loadCredentialsFromFile(targetFilePath);
                if (targetCredentials) {
                    Object.assign(mergedCredentials, targetCredentials);
                    console.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`);
                }

                // 读取目录下的其他 JSON 文件
                const files = await fs.readdir(dirPath);
                for (const file of files) {
                    if (file.endsWith('.json') && file !== targetFileName) {
                        const filePath = path.join(dirPath, file);
                        const credentials = await loadCredentialsFromFile(filePath);
                        if (credentials) {
                            credentials.expiresAt = mergedCredentials.expiresAt;
                            Object.assign(mergedCredentials, credentials);
                            console.debug(`[Kiro Auth] Loaded Client credentials from ${file}`);
                        }
                    }
                }
            } catch (error) {
                console.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`);
            }

            // 应用加载的凭据
            this.accessToken = this.accessToken || mergedCredentials.accessToken;
            this.refreshToken = this.refreshToken || mergedCredentials.refreshToken;
            this.clientId = this.clientId || mergedCredentials.clientId;
            this.clientSecret = this.clientSecret || mergedCredentials.clientSecret;
            this.authMethod = this.authMethod || mergedCredentials.authMethod;
            this.expiresAt = this.expiresAt || mergedCredentials.expiresAt;
            this.profileArn = this.profileArn || mergedCredentials.profileArn;
            this.region = this.region || mergedCredentials.region;

            // 确保 region 已设置
            if (!this.region) {
                console.warn('[Kiro Auth] Region not found in credentials. Using default region us-east-1');
                this.region = 'us-east-1';
            }

            // 设置 URL
            this.refreshUrl = (this.config.KIRO_REFRESH_URL || KIRO_CONSTANTS.REFRESH_URL).replace("{{region}}", this.region);
            this.refreshIDCUrl = (this.config.KIRO_REFRESH_IDC_URL || KIRO_CONSTANTS.REFRESH_IDC_URL).replace("{{region}}", this.region);
            this.baseUrl = (this.config.KIRO_BASE_URL || KIRO_CONSTANTS.BASE_URL).replace("{{region}}", this.region);
            this.amazonQUrl = KIRO_CONSTANTS.AMAZON_Q_URL.replace("{{region}}", this.region);
        } catch (error) {
            console.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
        }

        // 刷新 Token
        if (forceRefresh || (!this.accessToken && this.refreshToken)) {
            if (!this.refreshToken) {
                throw new Error('No refresh token available to refresh access token.');
            }

            if (!axiosInstance) {
                throw new Error('Axios instance is required for token refresh.');
            }

            try {
                const requestBody = {
                    refreshToken: this.refreshToken,
                };

                let refreshUrl = this.refreshUrl;
                if (this.authMethod !== KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
                    refreshUrl = this.refreshIDCUrl;
                    requestBody.clientId = this.clientId;
                    requestBody.clientSecret = this.clientSecret;
                    requestBody.grantType = 'refresh_token';
                }

                const response = await axiosInstance.post(refreshUrl, requestBody);
                console.log('[Kiro Auth] Token refresh response: ok');

                if (response.data && response.data.accessToken) {
                    this.accessToken = response.data.accessToken;
                    this.refreshToken = response.data.refreshToken;
                    this.profileArn = response.data.profileArn;
                    const expiresIn = response.data.expiresIn;
                    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                    this.expiresAt = expiresAt;
                    console.info('[Kiro Auth] Access token refreshed successfully');

                    // 更新 Token 文件
                    const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
                    const updatedTokenData = {
                        accessToken: this.accessToken,
                        refreshToken: this.refreshToken,
                        expiresAt: expiresAt,
                    };
                    if (this.profileArn) {
                        updatedTokenData.profileArn = this.profileArn;
                    }
                    await saveCredentialsToFile(tokenFilePath, updatedTokenData);
                } else {
                    throw new Error('Invalid refresh response: Missing accessToken');
                }
            } catch (error) {
                console.error('[Kiro Auth] Token refresh failed:', error.message);
                throw new Error(`Token refresh failed: ${error.message}`);
            }
        }

        if (!this.accessToken) {
            throw new Error('No access token available after initialization and refresh attempts.');
        }
    }

    /**
     * 检查 Token 是否即将过期
     * @param {number} nearMinutes - 提前多少分钟判断为即将过期（默认10分钟）
     * @returns {boolean}
     */
    isExpiryDateNear(nearMinutes = 10) {
        try {
            const expirationTime = new Date(this.expiresAt);
            const currentTime = new Date();
            const cronNearMinutesInMillis = nearMinutes * 60 * 1000;
            const thresholdTime = new Date(currentTime.getTime() + cronNearMinutesInMillis);
            console.log(`[Kiro Auth] Expiry date: ${expirationTime.getTime()}, Current time: ${currentTime.getTime()}, ${nearMinutes} minutes from now: ${thresholdTime.getTime()}`);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch (error) {
            console.error(`[Kiro Auth] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取访问令牌
     * @returns {string}
     */
    getAccessToken() {
        return this.accessToken;
    }

    /**
     * 获取认证方法
     * @returns {string}
     */
    getAuthMethod() {
        return this.authMethod;
    }

    /**
     * 获取 Profile ARN
     * @returns {string}
     */
    getProfileArn() {
        return this.profileArn;
    }

    /**
     * 获取 Region
     * @returns {string}
     */
    getRegion() {
        return this.region;
    }

    /**
     * 获取 Base URL
     * @returns {string}
     */
    getBaseUrl() {
        return this.baseUrl;
    }

    /**
     * 获取 Amazon Q URL
     * @returns {string}
     */
    getAmazonQUrl() {
        return this.amazonQUrl;
    }
}
