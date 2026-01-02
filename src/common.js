import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http'; // Add http for IncomingMessage and ServerResponse types
import * as crypto from 'crypto'; // Import crypto for MD5 hashing

import {
    handleError as handleErrorWithConfig,
    createErrorResponse,
    createStreamErrorResponse
} from './error-handler.js';
import { createLogger } from './logger.js';
import { KiroStrategy } from './claude/kiro-strategy.js';

const logger = createLogger('Common');

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};

export const MODEL_PROTOCOL_PREFIX = {
    // Model provider constants
    CLAUDE: 'claude',
}

export const MODEL_PROVIDER = {
    // Model provider constants
    KIRO_API: 'claude-kiro-oauth',
}

/**
 * Handle API authentication and routing
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} apiService - The API service instance
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @param {string} promptLogFilename - The prompt log filename
 * @returns {Promise<boolean>} - True if the request was handled by API
 */
export async function handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, promptLogFilename) {

    // Route content generation requests
    if (method === 'POST') {
        if (path === '/v1/messages') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.CLAUDE_MESSAGE, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
    }

    return false;
}

/**
 * Initialize API management features
 * @param {Object} services - The initialized services
 * @returns {Function} - The heartbeat and token refresh function
 */
export function initializeAPIManagement(services) {
    return async function heartbeatAndRefreshToken() {
        console.log(`[Heartbeat] Server is running. Current time: ${new Date().toLocaleString()}`, Object.keys(services));
        // 循环遍历所有已初始化的服务适配器，并尝试刷新令牌
        for (const providerKey in services) {
            const serviceAdapter = services[providerKey];
            try {
                // For pooled providers, refreshToken should be handled by individual instances
                // For single instances, this remains relevant
                await serviceAdapter.checkToken();
                // console.log(`[Token Refresh] Refreshed token for ${providerKey}`);
            } catch (error) {
                console.error(`[Token Refresh Error] Failed to refresh token for ${providerKey}: ${error.message}`);
                // 如果是号池中的某个实例刷新失败，这里需要捕获并更新其状态
                // 现有的 serviceInstances 存储的是每个配置对应的单例，而非池中的成员
                // 这意味着如果一个池成员的 token 刷新失败，需要找到它并更新其在 poolManager 中的状态
                // 暂时通过捕获错误日志来发现问题，更精细的控制需要在 refreshToken 中抛出更多信息
            }
        }
    };
}

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., claude).
 * @param {string} provider - The model provider string (e.g., 'claude-kiro-oauth').
 * @returns {string} The protocol prefix (e.g., 'claude').
 */
export function getProtocolPrefix(provider) {
    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider; // Return original if no hyphen is found
}

export const ENDPOINT_TYPE = {
    CLAUDE_MESSAGE: 'claude_message',
};

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        });
        req.on('error', err => {
            reject(err);
        });
    });
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        logger.info(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            logger.error('Failed to write conversation log', { filename: logFilename, error: err });
        }
    }
}

/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === REQUIRED_API_KEY) {
            return true;
        }
    }

    // Check for API key in URL query parameter (legacy support)
    if (queryKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-goog-api-key header (legacy support)
    if (googApiKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (claudeApiKey === REQUIRED_API_KEY) {
        return true;
    }

    logger.warn('Unauthorized request denied', {
        hasBearer: !!authHeader,
        hasQueryKey: !!queryKey,
        hasGoogApiKey: !!googApiKey,
        hasClaudeApiKey: !!claudeApiKey
    });
    return false;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * This includes writing response headers, logging conversation, and logging auth token expiry.
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 */
export async function handleUnifiedResponse(res, responsePayload, isStream) {
    if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Transfer-Encoding": "chunked" });
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    let fullResponseText = '';
    let responseClosed = false;

    await handleUnifiedResponse(res, '', true);

    // The service returns a stream in its native format (toProvider).
    requestBody.model = model;
    const nativeStream = await service.generateContentStream(model, requestBody);
    const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE;

    try {
        for await (const nativeChunk of nativeStream) {
            // Extract text for logging purposes
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseText += chunkText;
            }

            // Use the chunk directly (no conversion needed with single provider)
            const chunkToSend = nativeChunk;

            if (!chunkToSend) {
                continue;
            }

            // 处理 chunkToSend 可能是数组或对象的情况
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                if (addEvent) {
                    res.write(`event: ${chunk.type}\n`);
                }

                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
        }

        // 流式请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            logger.debug('Marking provider healthy after successful stream', { provider: toProvider, uuid: pooluuid });
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }

    } catch (error) {
        logger.error('Error during stream processing', error);
        if (providerPoolManager && pooluuid) {
            logger.warn('Marking provider unhealthy due to stream error', { provider: toProvider, uuid: pooluuid });
            // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            });
        }

        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        res.write(errorPayload);
        res.end();
        responseClosed = true;
    } finally {
        if (!responseClosed) {
            res.end();
        }
        await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    }
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    try{
        // The service returns the response in its native format (toProvider).
        requestBody.model = model;
        const nativeResponse = await service.generateContent(model, requestBody);
        const responseText = extractResponseText(nativeResponse, toProvider);

        // Use the response directly (no conversion needed with single provider)
        const clientResponse = nativeResponse;

        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

        // 一元请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            logger.debug('Marking provider healthy after successful unary request', { provider: toProvider, uuid: pooluuid });
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }
    } catch (error) {
        logger.error('Error during unary processing', error);
        if (providerPoolManager && pooluuid) {
            logger.warn('Marking provider unhealthy due to unary error', { provider: toProvider, uuid: pooluuid });
            // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            });
        }

        // 使用新方法创建符合 fromProvider 格式的错误响应
        const errorResponse = createErrorResponse(error, fromProvider);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false);
    }
}

/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the backend protocol format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., CLAUDE_MESSAGE).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    const originalRequestBody = await getRequestBody(req);
    if (!originalRequestBody) {
        throw new Error("Request body is missing for content generation.");
    }

    const clientProviderMap = {
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
    };

    const fromProvider = clientProviderMap[endpointType];
    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;
    
    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    const { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    logger.info('Content generation request received', { model, isStream });

    // 2.5. 如果使用了提供商池，根据模型重新选择提供商（支持 Fallback）
    // 注意：这里使用 skipUsageCount: true，因为初次选择时已经增加了 usageCount
    if (providerPoolManager && CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]) {
        const { getApiServiceWithFallback } = await import('./service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model);
        
        service = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        
        if (result.isFallback) {
            logger.warn('Fallback activated', {
                from: CONFIG.MODEL_PROVIDER,
                to: toProvider,
                uuid: actualUuid
            });
        } else {
            logger.debug('Re-selected service adapter based on model', { model });
        }
    }

    // 1. Use request body directly (no conversion needed with single provider)
    let processedRequestBody = originalRequestBody;
    logger.debug('Request format matches backend provider, no conversion needed');

    // 3. Apply system prompt from file if configured.
    processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
    await _manageSystemPrompt(processedRequestBody, toProvider);

    // 4. Log the incoming prompt (after potential conversion to the backend's format).
    const promptText = extractPromptText(processedRequestBody, toProvider);
    await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    
    // 5. Call the appropriate stream or unary handler, passing the provider info.
    if (isStream) {
        await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid);
    } else {
        await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid);
    }
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = new KiroStrategy();
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
    const strategy = new KiroStrategy();
    return strategy.applySystemPromptFromFile(config, requestBody);
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = new KiroStrategy();
    await strategy.manageSystemPrompt(requestBody);
}

// Helper functions for content extraction
export function extractResponseText(response, provider) {
    const strategy = new KiroStrategy();
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = new KiroStrategy();
    return strategy.extractPromptText(requestBody);
}

// 导出新的错误处理函数
export const handleError = handleErrorWithConfig;

/**
 * 从请求体中提取系统提示词。
 * @param {Object} requestBody - 请求体对象。
 * @param {string} provider - 提供商类型（'claude'）。
 * @returns {string} 提取到的系统提示词字符串。
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        default:
            logger.warn('Unknown provider for system prompt extraction', { provider });
            break;
    }
    return incomingSystemText;
}

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 * @param {object} obj - The object to hash.
 * @returns {string} The MD5 hash of the object's JSON string representation.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}
