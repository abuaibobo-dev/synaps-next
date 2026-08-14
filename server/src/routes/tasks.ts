import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';
import { listTasks } from '../taskStore.js';

const router = Router();

/**
 * GET /api/v1/tasks
 * Query: projectId?: string, limit?: number
 * 返回最近的任务记录（含步骤/工具/文件，JSON 字符串）
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    await getDb();
    const projectId =
      typeof req.query.projectId === 'string' && req.query.projectId.trim()
        ? req.query.projectId.trim()
        : null;
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    res.json({ tasks: listTasks(projectId, limit) });
  } catch (error) {
    console.error('Failed to list tasks:', error);
    res.status(500).json({ error: 'Failed to list tasks: ' + String(error) });
  }
});

export default router;
