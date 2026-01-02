/**
 * UI 事件广播模块
 * 负责向所有连接的 SSE 客户端广播事件
 */

import { createLogger } from '../logger.js';

const logger = createLogger('EventBroadcaster');

/**
 * 广播事件到所有连接的客户端
 * @param {string} eventType - 事件类型
 * @param {Object|string} data - 事件数据
 */
export function broadcastEvent(eventType, data) {
    if (global.eventClients && global.eventClients.length > 0) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        logger.debug('Broadcasting event', { eventType, clientCount: global.eventClients.length });

        global.eventClients.forEach(client => {
            try {
                client.write(`event: ${eventType}\n`);
                client.write(`data: ${payload}\n\n`);
            } catch (error) {
                logger.error('Failed to broadcast event to client', { eventType, error: error.message });
            }
        });
    }
}

/**
 * 初始化事件客户端列表
 */
export function initializeEventClients() {
    if (!global.eventClients) {
        global.eventClients = [];
        logger.info('Event clients list initialized');
    }
}

/**
 * 添加事件客户端
 * @param {Object} client - 客户端响应对象
 */
export function addEventClient(client) {
    if (!global.eventClients) {
        initializeEventClients();
    }
    global.eventClients.push(client);
    logger.info('Event client added', { totalClients: global.eventClients.length });
}

/**
 * 移除事件客户端
 * @param {Object} client - 客户端响应对象
 */
export function removeEventClient(client) {
    if (global.eventClients) {
        const index = global.eventClients.indexOf(client);
        if (index !== -1) {
            global.eventClients.splice(index, 1);
            logger.info('Event client removed', { totalClients: global.eventClients.length });
        }
    }
}

/**
 * 获取当前连接的客户端数量
 * @returns {number}
 */
export function getEventClientCount() {
    return global.eventClients ? global.eventClients.length : 0;
}
