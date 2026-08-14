import { Router } from 'express';
import { getDb, queryAll } from '../db.js';

const router = Router();

/**
 * GET /api/v1/audit
 * Query 参数：projectId?: string, limit?: number
 */
router.get('/', async (req, res) => {
  try {
    await getDb();
    const { projectId, limit = 50 } = req.query;
    const maxLimit = Math.min(parseInt(limit as string) || 50, 200);

    const logs = projectId
      ? queryAll(
          'SELECT * FROM audit_logs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          [projectId, maxLimit]
        )
      : queryAll(
          'SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?',
          [maxLimit]
        );

    res.json({ logs });
  } catch (error) {
    console.error('Audit query error:', error);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

export default router;
