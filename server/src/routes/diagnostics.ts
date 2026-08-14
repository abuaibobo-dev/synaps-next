import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';
import { runDiagnostics } from '../diagnostics.js';

const router = Router();

/**
 * GET /api/v1/diagnostics
 * 一键自检：汇总后端、模型、开发环境、设备控制等状态
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    await getDb();
    res.json(runDiagnostics());
  } catch (error) {
    console.error('Failed to run diagnostics:', error);
    res.status(500).json({ error: 'Failed to run diagnostics: ' + String(error) });
  }
});

export default router;
