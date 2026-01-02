/**
 * UI 文件上传处理模块
 * 负责处理 OAuth 凭据文件上传
 */

import { promises as fs } from 'fs';
import path from 'path';
import multer from 'multer';
import { broadcastEvent } from './event-broadcaster.js';
import { createLogger } from '../logger.js';

const logger = createLogger('FileUpload');

// 配置multer存储
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            // multer在destination回调时req.body还未解析，先使用默认路径
            // 实际的provider会在文件上传完成后从req.body中获取
            const uploadPath = path.join(process.cwd(), 'configs', 'temp');
            await fs.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (error) {
            logger.error('Failed to create upload directory', { error: error.message });
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${timestamp}_${sanitizedName}`);
    }
});

// 文件类型过滤
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['.json', '.txt', '.key', '.pem', '.p12', '.pfx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
        cb(null, true);
    } else {
        logger.warn('Unsupported file type attempted', { filename: file.originalname, ext });
        cb(new Error('Unsupported file type'), false);
    }
};

// 创建multer实例
export const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB限制
    }
});

/**
 * 处理文件上传请求
 * @param {Object} req - HTTP请求对象
 * @param {Object} res - HTTP响应对象
 * @returns {Promise<boolean>} - 是否成功处理
 */
export async function handleFileUpload(req, res) {
    const uploadMiddleware = upload.single('file');

    return new Promise((resolve) => {
        uploadMiddleware(req, res, async (err) => {
            if (err) {
                logger.error('File upload error', { error: err.message });
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: err.message || 'File upload failed'
                    }
                }));
                resolve(true);
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
                    resolve(true);
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

                logger.info('OAuth credentials file uploaded', {
                    targetFilePath,
                    provider,
                    originalName: req.file.originalname
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'File uploaded successfully',
                    filePath: relativePath,
                    originalName: req.file.originalname,
                    provider: provider
                }));

                resolve(true);
            } catch (error) {
                logger.error('File upload processing error', { error: error.message });
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File upload processing failed: ' + error.message
                    }
                }));
                resolve(true);
            }
        });
    });
}
