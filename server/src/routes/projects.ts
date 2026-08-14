import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, runSql } from '../db.js';
import { listProjectTemplates, scaffoldProject } from '../templates.js';

const router = Router();

/**
 * GET /api/v1/projects
 * Query 参数：search?: string
 */
router.get('/', async (req, res) => {
  await getDb();
  const { search } = req.query;

  let projects;
  if (search && typeof search === 'string' && search.trim()) {
    const pattern = `%${search.trim()}%`;
    projects = queryAll(
      `SELECT * FROM projects WHERE name LIKE ? OR description LIKE ? ORDER BY last_opened_at DESC, created_at DESC`,
      [pattern, pattern]
    );
  } else {
    projects = queryAll(
      `SELECT * FROM projects ORDER BY last_opened_at DESC, created_at DESC`
    );
  }

  res.json({ projects });
});

/**
 * GET /api/v1/projects/recent
 * Query 参数：limit?: number
 */
router.get('/recent', async (req, res) => {
  await getDb();
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  const projects = queryAll(
    `SELECT * FROM projects WHERE last_opened_at IS NOT NULL ORDER BY last_opened_at DESC LIMIT ?`,
    [limit]
  );
  res.json({ projects });
});

/**
 * GET /api/v1/projects/templates
 * 列出可用的项目模板
 */
router.get('/templates', async (_req, res) => {
  await getDb();
  res.json({ templates: listProjectTemplates() });
});

/**
 * GET /api/v1/projects/:id
 * Path 参数：id: string
 */
router.get('/:id', async (req, res) => {
  await getDb();
  const project = queryOne(`SELECT * FROM projects WHERE id = ?`, [req.params.id]);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  // Update last_opened_at
  runSql(`UPDATE projects SET last_opened_at = datetime('now') WHERE id = ?`, [req.params.id]);

  res.json({ project });
});

/**
 * POST /api/v1/projects
 * Body 参数：name: string, path: string, description?: string, template?: string
 */
router.post('/', async (req, res) => {
  await getDb();
  const { name, path: projectPath, description, template } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!projectPath || typeof projectPath !== 'string' || !projectPath.trim()) {
    return res.status(400).json({ error: 'Path is required' });
  }

  const templateId = typeof template === 'string' && template.trim() ? template.trim() : 'blank';
  let scaffold;
  if (templateId !== 'blank') {
    scaffold = scaffoldProject(projectPath.trim(), templateId, name.trim());
    if (scaffold.created.length === 0 && scaffold.skipped.length === 0) {
      return res.status(400).json({ error: `Unknown template: ${templateId}` });
    }
  }

  const id = randomUUID();
  runSql(
    `INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)`,
    [id, name.trim(), projectPath.trim(), description?.trim() || '']
  );

  const project = queryOne(`SELECT * FROM projects WHERE id = ?`, [id]);
  res.status(201).json({ project, scaffold: scaffold || { created: [], skipped: [] } });
});

/**
 * PUT /api/v1/projects/:id
 * Path 参数：id: string
 * Body 参数：name?: string, path?: string, description?: string
 */
router.put('/:id', async (req, res) => {
  await getDb();
  const { name, path: projectPath, description } = req.body;
  const id = req.params.id;

  const existing = queryOne(`SELECT * FROM projects WHERE id = ?`, [id]);
  if (!existing) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }
    updates.push('name = ?');
    values.push(name.trim());
  }
  if (projectPath !== undefined) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      return res.status(400).json({ error: 'Path cannot be empty' });
    }
    updates.push('path = ?');
    values.push(projectPath.trim());
  }
  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description.trim());
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(id);
    runSql(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, values);
  }

  const project = queryOne(`SELECT * FROM projects WHERE id = ?`, [id]);
  res.json({ project });
});

/**
 * DELETE /api/v1/projects/:id
 * Path 参数：id: string
 */
router.delete('/:id', async (req, res) => {
  await getDb();
  const id = req.params.id;

  const existing = queryOne(`SELECT * FROM projects WHERE id = ?`, [id]);
  if (!existing) {
    return res.status(404).json({ error: 'Project not found' });
  }

  runSql(`DELETE FROM projects WHERE id = ?`, [id]);
  res.json({ success: true });
});

export default router;
