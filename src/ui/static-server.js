/**
 * UI 静态文件服务模块
 * 负责提供静态文件服务
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';

const logger = createLogger('StaticServer');

/**
 * MIME 类型映射
 */
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject'
};

/**
 * 提供静态文件服务
 * @param {string} pathParam - 请求路径
 * @param {Object} res - HTTP 响应对象
 * @returns {Promise<boolean>} - 如果文件存在并成功提供则返回 true
 */
export async function serveStaticFiles(pathParam, res) {
    try {
        // 处理根路径和 index.html
        let requestPath = pathParam;
        if (pathParam === '/' || pathParam === '/index.html') {
            requestPath = 'index.html';
        } else if (pathParam.startsWith('/static/')) {
            requestPath = pathParam.replace('/static/', '');
        }

        const filePath = path.join(process.cwd(), 'static', requestPath);

        // 安全检查：确保文件路径在 static 目录内
        const staticDir = path.join(process.cwd(), 'static');
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(staticDir)) {
            logger.warn('Attempted path traversal attack', { requestPath, resolvedPath });
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return true;
        }

        if (existsSync(filePath)) {
            const ext = path.extname(filePath);
            const contentType = MIME_TYPES[ext] || 'text/plain';

            logger.debug('Serving static file', { filePath, contentType });

            res.writeHead(200, { 'Content-Type': contentType });
            res.end(readFileSync(filePath));
            return true;
        }

        logger.debug('Static file not found', { filePath });
        return false;
    } catch (error) {
        logger.error('Error serving static file', { pathParam, error: error.message });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return true;
    }
}
