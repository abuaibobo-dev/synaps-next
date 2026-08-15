import { Router } from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { getDb, queryOne } from '../db.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/**
 * POST /api/v1/uploads
 * FormData: file（必填）, projectId（可选）
 * 保存到项目目录 .synaps/uploads/（未绑定项目时保存到数据目录 uploads/）
 * Response: { success, name, size, path, absolutePath }
 */
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }
  try {
    await getDb();

    const projectId =
      typeof req.body?.projectId === 'string' && req.body.projectId
        ? req.body.projectId
        : undefined;

    let uploadDir: string;
    let relativeBase: string;
    if (projectId) {
      const project = queryOne('SELECT path FROM projects WHERE id = ?', [projectId]) as Record<string, string> | null;
      if (!project) {
        return res.status(400).json({ error: '项目不存在' });
      }
      uploadDir = path.join(project.path, '.synaps', 'uploads');
      relativeBase = '.synaps/uploads';
    } else {
      const dataDir = process.env.SYNAPS_DATA_DIR
        ? process.env.SYNAPS_DATA_DIR
        : path.join(__dirname, '../../data');
      uploadDir = path.join(dataDir, 'uploads');
      relativeBase = 'uploads';
    }

    fs.mkdirSync(uploadDir, { recursive: true });

    const originalName = Buffer.from(req.file.originalname, 'latin1')
      .toString('utf8')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim();
    const safeName = (originalName || 'upload.bin').replace(/\s+/g, '_');
    const uniqueName = `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${safeName}`;
    const absolutePath = path.join(uploadDir, uniqueName);
    fs.writeFileSync(absolutePath, req.file.buffer);

    const relPath = path.join(relativeBase, uniqueName).split(path.sep).join('/');
    return res.json({
      success: true,
      name: originalName || safeName,
      size: req.file.size,
      path: relPath,
      absolutePath,
    });
  } catch (err) {
    console.error('[uploads] failed:', err);
    return res.status(500).json({ error: '上传失败，请稍后重试' });
  }
});

export default router;
