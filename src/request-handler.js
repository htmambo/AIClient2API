import deepmerge from 'deepmerge';
import { handleError, isAuthorized, getRequestBody } from './common.js';
import { handleUIApiRequests } from './ui-manager.js';
import { serveStaticFiles } from './ui/static-server.js';
import { handleAPIRequests } from './common.js';
import { getApiService, getProviderStatus } from './service-manager.js';
import { getProviderPoolManager } from './service-manager.js';
import { MODEL_PROVIDER } from './common.js';
import { PROMPT_LOG_FILENAME } from './config-manager.js';
import { validateRequestSize, validateJSON, ValidationError } from './input-validator.js';
import { createLogger } from './logger.js';

const logger = createLogger('RequestHandler');

/**
 * 创建主请求处理器
 *
 * 这是整个服务器的核心请求处理函数，负责：
 * 1. 请求预处理（CORS、静态文件、UI API）
 * 2. 提供商动态切换（通过 Header 或 Path）
 * 3. 服务实例获取与健康检查
 * 4. 身份验证
 * 5. 请求路由分发
 *
 * @param {Object} config - 服务器全局配置对象，包含所有提供商配置、API密钥等
 * @param {Object} providerPoolManager - 提供商池管理器实例，用于多账号轮询和健康管理
 * @returns {Function} - 返回实际的请求处理函数 requestHandler(req, res)
 */
export function createRequestHandler(config, providerPoolManager) {
    return async function requestHandler(req, res) {
        // ==================== 第一步：请求初始化 ====================

        /**
         * 深拷贝配置对象，确保每个请求都有独立的配置副本
         * 这样可以在不影响全局配置的情况下动态修改当前请求的配置
         * 例如：通过 Header 或 Path 动态切换 MODEL_PROVIDER
         */
        const currentConfig = deepmerge({}, config);

        /**
         * 解析请求 URL，提取路径和查询参数
         * 使用 req.headers.host 构建完整 URL 以支持相对路径解析
         */
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        let path = requestUrl.pathname;  // 请求路径，可能会被后续逻辑修改（如移除提供商前缀）
        const method = req.method;       // HTTP 方法（GET, POST, OPTIONS 等）

        // ==================== 第二步：CORS 处理 ====================

        /**
         * 设置 CORS 响应头，允许跨域请求
         * - Access-Control-Allow-Origin: 允许所有域名访问
         * - Access-Control-Allow-Methods: 允许的 HTTP 方法
         * - Access-Control-Allow-Headers: 允许的自定义请求头
         */
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        // 单一提供商模式：不再支持 Model-Provider Header 动态切换
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

        /**
         * 处理 CORS 预检请求（OPTIONS）
         * 浏览器在发送跨域请求前会先发送 OPTIONS 请求确认服务器是否允许
         * 直接返回 204 No Content，表示允许后续的实际请求
         */
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // ==================== 第三步：静态文件服务 ====================

        /**
         * 处理静态文件请求（前端 UI 资源）
         * 匹配以下路径：
         * - /static/*: 静态资源目录（CSS, JS, 图片等）
         * - /: 根路径，返回 index.html
         * - /favicon.ico: 网站图标
         * - /index.html: 主页
         * - /app/*: 应用路由（SPA 路由）
         * - /login.html: 登录页面
         *
         * 注意：这些路径不需要 API 认证，但登录页面可能有额外的认证逻辑
         */
        if (path.startsWith('/static/') || path === '/' || path === '/favicon.ico' || path === '/index.html' || path.startsWith('/app/') || path === '/login.html') {
            const served = await serveStaticFiles(path, res);
            if (served) return;  // 如果文件成功提供，直接返回
        }

        // ==================== 第四步：UI 管理 API 处理 ====================

        /**
         * 处理 UI 管理相关的 API 请求
         * 包括：配置管理、提供商池管理、健康检查等后台管理接口
         * 这些接口通常需要管理员权限，由 handleUIApiRequests 内部处理认证
         */
        const uiHandled = await handleUIApiRequests(method, path, req, res, currentConfig, providerPoolManager);
        if (uiHandled) return;  // 如果请求已被处理，直接返回

        // ==================== 第五步：请求日志 ====================

        /**
         * 记录请求日志，便于调试和监控
         * 格式：时间戳 + HTTP方法 + 完整URL
         */
        console.log(`\n${new Date().toLocaleString()}`);
        console.log(`[Server] Received request: ${req.method} http://${req.headers.host}${req.url}`);

        // ==================== 第六步：健康检查端点 ====================

        /**
         * 处理服务健康检查请求 GET /health
         * 返回服务状态、时间戳和当前使用的提供商
         * 用于监控系统、负载均衡器等外部服务检查服务可用性
         */
        if (method === 'GET' && path === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                provider: currentConfig.MODEL_PROVIDER
            }));
            return true;
        }

        // ==================== 第七步：提供商健康状态端点 ====================

        /**
         * 处理提供商池健康状态查询 GET /provider_health
         *
         * 查询参数：
         * - provider: 过滤指定的提供商类型（如 'claude-kiro-oauth'）
         * - customName: 过滤指定的自定义名称（如 'Kiro OAuth节点1'）
         * - unhealthRatioThreshold: 不健康比例阈值（默认 0.0001）
         *   当实际不健康比例超过此阈值时，summaryHealth 返回 false
         *
         * 返回数据：
         * - items: 提供商池的精简信息列表
         * - count: 总提供商数量
         * - unhealthyCount: 不健康的提供商数量
         * - unhealthyRatio: 不健康比例（unhealthyCount / count）
         * - unhealthySummeryMessage: 不健康提供商的摘要信息
         * - summaryHealth: 整体健康状态（基于阈值判断）
         */
        if (method === 'GET' && path === '/provider_health') {
            try {
                // 提取查询参数
                const provider = requestUrl.searchParams.get('provider');
                const customName = requestUrl.searchParams.get('customName');
                let unhealthRatioThreshold = requestUrl.searchParams.get('unhealthRatioThreshold');

                // 设置默认阈值：如果未提供则使用 0.0001（即 0.01%）
                unhealthRatioThreshold = unhealthRatioThreshold === null ? 0.0001 : parseFloat(unhealthRatioThreshold);

                // 获取提供商状态信息（支持 provider 和 customName 过滤）
                let provideStatus = await getProviderStatus(currentConfig, { provider, customName });

                // 计算整体健康状态：不健康比例是否在阈值范围内
                let summaryHealth = true;
                if (!isNaN(unhealthRatioThreshold)) {
                    summaryHealth = provideStatus.unhealthyRatio <= unhealthRatioThreshold;
                }

                // 返回健康状态响应
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    items: provideStatus.providerPoolsSlim,
                    count: provideStatus.count,
                    unhealthyCount: provideStatus.unhealthyCount,
                    unhealthyRatio: provideStatus.unhealthyRatio,
                    unhealthySummeryMessage: provideStatus.unhealthySummeryMessage,
                    summaryHealth
                }));
                return true;
            } catch (error) {
                console.log(`[Server] req provider_health error: ${error.message}`);
                handleError(res, { statusCode: 500, message: `Failed to get providers health: ${error.message}` });
                return;
            }
        }


        // ==================== 第八步：提供商动态切换（已移除） ====================
        // 单一提供商模式：不再支持通过 Header 或 URL Path 动态切换 MODEL_PROVIDER。
        // 统一使用配置文件确定的 MODEL_PROVIDER（当前仅支持单一 providerType）。

        // ==================== 第九步：获取 API 服务实例 ====================

        /**
         * 根据当前配置获取对应的 API 服务适配器实例
         *
         * getApiService 会：
         * 1. 检查是否启用了提供商池（多账号模式）
         * 2. 如果启用池：
         *    - 使用 LRU 策略选择最久未使用的健康账号
         *    - 支持 Fallback 机制（当主提供商不可用时切换到备用提供商）
         *    - 返回选中账号的服务实例和 UUID
         * 3. 如果未启用池：
         *    - 使用配置文件中的默认提供商配置
         *    - 返回单例服务实例
         *
         * 错误处理：
         * - 如果获取失败（如所有账号都不健康），返回 500 错误
         * - 如果启用了池管理，将失败的提供商标记为不健康
         */
        let apiService;
        try {
            apiService = await getApiService(currentConfig);
        } catch (error) {
            // 服务获取失败，返回错误响应
            handleError(res, { statusCode: 500, message: `Failed to get API service: ${error.message}` });

            // 如果启用了池管理，标记提供商为不健康（单一提供商模式：不再需要 providerType 参数）
            const poolManager = getProviderPoolManager();
            if (poolManager) {
                poolManager.markProviderUnhealthy({ uuid: currentConfig.uuid });
            }
            return;
        }

        // ==================== 第十步：身份验证 ====================

        /**
         * 验证 API 请求的身份
         *
         * 支持多种认证方式（按优先级）：
         * 1. Authorization Header: Bearer <token>
         * 2. URL Query Parameter: ?key=<token>
         * 3. x-goog-api-key Header: <token> (Google 风格)
         * 4. x-api-key Header: <token> (Claude 风格)
         *
         * 如果认证失败，返回 401 Unauthorized
         */
        if (!isAuthorized(req, requestUrl, currentConfig.REQUIRED_API_KEY)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Unauthorized: API key is invalid or missing.' } }));
            return;
        }

        // ==================== 第十一步：Token 计数端点 ====================

        /**
         * 处理 Token 计数请求 POST /count_tokens
         *
         * 这是 Anthropic API 兼容的端点，用于估算请求的 Token 数量
         * 在发送实际请求前，客户端可以使用此端点预估成本
         *
         * 处理逻辑（按优先级）：
         * 1. 如果 apiService 实现了 countTokens 方法：
         *    - 使用精确的 Token 计数（基于模型的 Tokenizer）
         * 2. 如果只实现了 estimateInputTokens 方法：
         *    - 使用估算方法（通常基于字符数或简单规则）
         * 3. 如果都没实现：
         *    - 返回 0（表示不支持 Token 计数）
         *
         * 返回格式：
         * { input_tokens: <number> }
         */
        if (path.includes('/count_tokens') && method === 'POST') {
            try {
                const body = await getRequestBody(req);
                console.log(`[Server] Handling count_tokens request for model: ${body.model}`);

                // 优先使用精确的 countTokens 方法
                if (apiService && typeof apiService.countTokens === 'function') {
                    const result = apiService.countTokens(body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } else {
                    // 降级：使用估算方法
                    if (apiService && typeof apiService.estimateInputTokens === 'function') {
                        const inputTokens = apiService.estimateInputTokens(body);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ input_tokens: inputTokens }));
                    } else {
                        // 最后降级：返回 0
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ input_tokens: 0 }));
                    }
                }
                return true;
            } catch (error) {
                console.error(`[Server] count_tokens error: ${error.message}`);
                handleError(res, { statusCode: 500, message: `Failed to count tokens: ${error.message}` });
                return;
            }
        }

        // ==================== 第十二步：请求路由分发 ====================

        try {
            /**
             * 处理标准 API 请求
             *
             * 支持的端点：
             * - POST /v1/messages: Claude 消息 API
             * - 其他协议特定的端点
             *
             * 处理流程：
             * 1. 解析请求体
             * 2. 协议转换（如果需要）
             * 3. 调用底层 API
             * 4. 响应转换（如果需要）
             * 5. 返回结果
             */
            const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, PROMPT_LOG_FILENAME);
            if (apiHandled) return;  // 如果已处理完成，直接返回

            /**
             * 未匹配任何路由，返回 404
             *
             * 如果请求路径不匹配任何已知的端点，返回 404 Not Found
             */
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not Found' } }));
        } catch (error) {
            /**
             * 全局错误处理
             *
             * 捕获所有未处理的异常，统一返回错误响应
             * handleError 会根据错误类型返回适当的 HTTP 状态码和错误信息
             */
            handleError(res, error);
        }
    };
}
