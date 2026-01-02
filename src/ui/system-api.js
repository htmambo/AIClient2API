/**
 * UI 系统API管理模块
 * 负责系统信息、更新检查和系统操作
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../logger.js';

const execAsync = promisify(exec);
const logger = createLogger('SystemAPI');

// CPU 使用率计算相关变量
let previousCpuInfo = null;

/**
 * 获取 CPU 使用率百分比
 * @returns {string} CPU 使用率字符串，如 "25.5%"
 */
export function getCpuUsagePercent() {
    const cpus = os.cpus();

    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    }

    const currentCpuInfo = {
        idle: totalIdle,
        total: totalTick
    };

    let cpuPercent = 0;

    if (previousCpuInfo) {
        const idleDiff = currentCpuInfo.idle - previousCpuInfo.idle;
        const totalDiff = currentCpuInfo.total - previousCpuInfo.total;

        if (totalDiff > 0) {
            cpuPercent = 100 - (100 * idleDiff / totalDiff);
        }
    }

    previousCpuInfo = currentCpuInfo;

    return `${cpuPercent.toFixed(1)}%`;
}

/**
 * 比较版本号
 * @param {string} v1 - 版本号1
 * @param {string} v2 - 版本号2
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1, v2) {
    // 移除 'v' 前缀（如果有）
    const clean1 = v1.replace(/^v/, '');
    const clean2 = v2.replace(/^v/, '');

    const parts1 = clean1.split('.').map(Number);
    const parts2 = clean2.split('.').map(Number);

    const maxLen = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLen; i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;

        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }

    return 0;
}

/**
 * 检查是否有新版本可用
 * @returns {Promise<Object>} 更新信息
 */
export async function checkForUpdates() {
    const versionFilePath = path.join(process.cwd(), 'VERSION');

    // 读取本地版本
    let localVersion = 'unknown';
    try {
        if (existsSync(versionFilePath)) {
            localVersion = readFileSync(versionFilePath, 'utf8').trim();
        }
    } catch (error) {
        logger.warn('Failed to read local VERSION file', { error: error.message });
    }

    // 检查是否在 git 仓库中
    try {
        await execAsync('git rev-parse --git-dir');
    } catch (error) {
        return {
            hasUpdate: false,
            localVersion,
            latestVersion: null,
            error: 'Current directory is not a Git repository, cannot check for updates'
        };
    }

    // 获取远程 tags
    try {
        logger.info('Fetching remote tags');
        await execAsync('git fetch --tags');
    } catch (error) {
        logger.warn('Failed to fetch tags', { error: error.message });
        return {
            hasUpdate: false,
            localVersion,
            latestVersion: null,
            error: 'Unable to fetch remote tags: ' + error.message
        };
    }

    // 获取最新的 tag（根据操作系统选择合适的命令）
    let latestTag = null;
    const isWindows = process.platform === 'win32';

    try {
        if (isWindows) {
            // Windows: 使用 git for-each-ref，这是跨平台兼容的方式
            const { stdout } = await execAsync('git for-each-ref --sort=-v:refname --format="%(refname:short)" refs/tags --count=1');
            latestTag = stdout.trim();
        } else {
            // Linux/macOS: 使用 head 命令，更高效
            const { stdout } = await execAsync('git tag --sort=-v:refname | head -n 1');
            latestTag = stdout.trim();
        }
    } catch (error) {
        // 备用方案：获取所有 tags 并在 JavaScript 中排序
        try {
            const { stdout } = await execAsync('git tag');
            const tags = stdout.trim().split('\n').filter(t => t);
            if (tags.length > 0) {
                // 按版本号排序（降序）
                tags.sort((a, b) => compareVersions(b, a));
                latestTag = tags[0];
            }
        } catch (e) {
            logger.warn('Failed to get latest tag', { error: e.message });
            return {
                hasUpdate: false,
                localVersion,
                latestVersion: null,
                error: 'Unable to get latest version tag'
            };
        }
    }

    if (!latestTag) {
        return {
            hasUpdate: false,
            localVersion,
            latestVersion: null,
            error: 'No version tags found'
        };
    }

    // 比较版本
    const comparison = compareVersions(latestTag, localVersion);
    const hasUpdate = comparison > 0;

    logger.info('Version check completed', {
        localVersion,
        latestTag,
        hasUpdate
    });

    return {
        hasUpdate,
        localVersion,
        latestVersion: latestTag,
        error: null
    };
}

/**
 * 执行更新操作
 * @returns {Promise<Object>} 更新结果
 */
export async function performUpdate() {
    // 首先检查是否有更新
    const updateInfo = await checkForUpdates();

    if (updateInfo.error) {
        throw new Error(updateInfo.error);
    }

    if (!updateInfo.hasUpdate) {
        return {
            success: true,
            message: 'Already at the latest version',
            localVersion: updateInfo.localVersion,
            latestVersion: updateInfo.latestVersion,
            updated: false
        };
    }

    const latestTag = updateInfo.latestVersion;

    logger.info('Starting update', { latestTag });

    // 检查是否有未提交的更改
    try {
        const { stdout: statusOutput } = await execAsync('git status --porcelain');
        if (statusOutput.trim()) {
            // 有未提交的更改，先 stash
            logger.info('Stashing local changes');
            await execAsync('git stash');
        }
    } catch (error) {
        logger.warn('Failed to check git status', { error: error.message });
    }

    // 执行 checkout 到最新 tag
    try {
        logger.info('Checking out to latest tag', { latestTag });
        await execAsync(`git checkout ${latestTag}`);
    } catch (error) {
        logger.error('Failed to checkout', { error: error.message });
        throw new Error('Failed to switch to new version: ' + error.message);
    }

    // 更新 VERSION 文件（如果 tag 和 VERSION 文件不同步）
    const versionFilePath = path.join(process.cwd(), 'VERSION');
    try {
        writeFileSync(versionFilePath, latestTag, 'utf8');
        logger.info('Updated VERSION file', { version: latestTag });
    } catch (error) {
        logger.warn('Failed to update VERSION file', { error: error.message });
    }

    logger.info('Update completed successfully', {
        from: updateInfo.localVersion,
        to: latestTag
    });

    return {
        success: true,
        message: 'Update completed successfully',
        localVersion: updateInfo.localVersion,
        latestVersion: latestTag,
        updated: true
    };
}

/**
 * 获取系统信息
 * @returns {Object} 系统信息
 */
export function getSystemInfo() {
    return {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        uptime: os.uptime(),
        nodeVersion: process.version,
        cpuUsage: getCpuUsagePercent()
    };
}
