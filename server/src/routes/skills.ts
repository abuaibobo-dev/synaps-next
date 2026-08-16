import { Router } from 'express';
import { getDb, queryAll, queryOne, runSql } from '../db.js';

const router = Router();

interface SkillInput {
  name: string;
  description?: string;
  content: string;
  metadata?: Record<string, unknown>;
  source?: string;
}

// GET /api/v1/skills - 技能列表
router.get('/', async (_req, res) => {
  try {
    await getDb();
    const rows = queryAll('SELECT id, name, description, source, enabled, created_at, metadata FROM skills ORDER BY name') as Record<string, unknown>[];
    res.json({ skills: rows });
  } catch (error) {
    console.error('Failed to list skills:', error);
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

// GET /api/v1/skills/:name - 技能详情
router.get('/:name', async (req, res) => {
  try {
    await getDb();
    const row = queryOne('SELECT * FROM skills WHERE name = ?', [req.params.name]) as Record<string, unknown> | null;
    if (!row) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    res.json(row);
  } catch (error) {
    console.error('Failed to get skill:', error);
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

// POST /api/v1/skills/import - 批量导入（Agent Skills 格式转换结果）
router.post('/import', async (req, res) => {
  try {
    await getDb();
    const items = (req.body?.skills ?? req.body) as SkillInput[];
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'skills array is required' });
      return;
    }
    let imported = 0;
    for (const item of items) {
      if (!item?.name || typeof item.content !== 'string') continue;
      const id = `skill_${Date.now()}_${imported}`;
      runSql(
        `INSERT INTO skills (id, name, description, content, metadata, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           content = excluded.content,
           metadata = excluded.metadata,
           source = excluded.source,
           enabled = 1,
           updated_at = datetime('now')`,
        [id, item.name, item.description ?? '', item.content, JSON.stringify(item.metadata ?? {}), item.source ?? '']
      );
      imported++;
    }
    res.json({ success: true, imported });
  } catch (error) {
    console.error('Failed to import skills:', error);
    res.status(500).json({ error: 'Failed to import skills' });
  }
});

// PUT /api/v1/skills/:name - 启用/禁用
router.put('/:name', async (req, res) => {
  try {
    await getDb();
    const exists = queryOne('SELECT id FROM skills WHERE name = ?', [req.params.name]);
    if (!exists) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    const enabled = req.body?.enabled ? 1 : 0;
    runSql('UPDATE skills SET enabled = ?, updated_at = datetime(\'now\') WHERE name = ?', [enabled, req.params.name]);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update skill:', error);
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

export default router;
