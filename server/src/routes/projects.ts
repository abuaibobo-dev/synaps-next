import path from 'path';
import * as fs from 'fs';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, runSql } from '../db.js';
import { listProjectTemplates, scaffoldProject } from '../templates.js';

const router = Router();

/**
 * 项目根目录：
 * - 优先使用显式配置（SYNAPS_DATA_DIR）
 * - Android 内嵌运行时：入口脚本位于 <filesDir>/nodejs-project/main.cjs，
 *   项目目录放在 filesDir 下保证可写（process.cwd() 在 Android 上通常是 /）
 * - 其余环境回退到进程工作目录
 */
function getProjectsBaseDir(): string {
  if (process.env.SYNAPS_DATA_DIR) return process.env.SYNAPS_DATA_DIR;
  const isAndroid =
    process.platform === 'android' ||
    !!process.env.ANDROID_ROOT ||
    /^\/data\/user\/0\//.test(process.argv[1] || '');
  if (isAndroid && process.argv[1]) {
    return path.join(path.dirname(process.argv[1]), '..');
  }
  return process.cwd();
}

/**
 * 预校验项目目录可写性。
 * 直接 mkdir 不可写路径可能在内核层挂起（如 /proc 伪文件系统），
 * 这里先用 access 快速失败，避免阻塞整个 Node 事件循环导致“后端失联”。
 */
function assertWritableProjectPath(projectPath: string): string | null {
  try {
    if (fs.existsSync(projectPath)) {
      const st = fs.statSync(projectPath);
      if (!st.isDirectory()) return `路径已存在但不是目录：${projectPath}`;
      fs.accessSync(projectPath, fs.constants.W_OK);
      return null;
    }
    // 路径不存在：向上找到最近的已存在祖先校验可写性，
    // 避免多层不存在路径（如 /sdcard/Projects/new-app）对不存在的父目录误报 ENOENT
    let p = path.dirname(projectPath);
    while (p && p !== path.dirname(p)) {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          fs.accessSync(p, fs.constants.W_OK | fs.constants.X_OK);
          return null;
        }
        break;
      }
      p = path.dirname(p);
    }
    return `目录不可写：${projectPath}（上级目录不可访问），请使用自动填充的默认路径或换一个可写目录`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code || 'EACCES';
    return `目录不可写：${projectPath}（${code}），请使用自动填充的默认路径或换一个可写目录`;
  }
}

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
 * GET /api/v1/projects/default-path
 * Query 参数：name?: string
 * 返回默认项目目录下的建议路径，前端创建项目时自动填充，避免用户不知道路径怎么填
 */
router.get('/default-path', async (req, res) => {
  await getDb();
  const raw = String(req.query.name || '').trim();
  const safe = (raw || 'synaps-app').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'synaps-app';
  const base = path.join(getProjectsBaseDir(), 'synaps-projects');
  res.json({ path: path.join(base, safe) });
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

  const writableError = assertWritableProjectPath(projectPath.trim());
  if (writableError) {
    return res.status(400).json({ error: writableError });
  }

  try {
    const templateId = typeof template === 'string' && template.trim() ? template.trim() : 'blank';
    let scaffold;
    if (templateId !== 'blank') {
      scaffold = scaffoldProject(projectPath.trim(), templateId, name.trim());
      if (scaffold.created.length === 0 && scaffold.skipped.length === 0) {
        return res.status(400).json({ error: `Unknown template: ${templateId}` });
      }
    } else {
      // 空白项目也确保目录存在，避免“保存成功但路径不存在”
      fs.mkdirSync(projectPath.trim(), { recursive: true });
      scaffold = { created: [], skipped: [] };
    }

    const id = randomUUID();
    runSql(
      `INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)`,
      [id, name.trim(), projectPath.trim(), description?.trim() || '']
    );

    const project = queryOne(`SELECT * FROM projects WHERE id = ?`, [id]);
    res.status(201).json({ project, scaffold: scaffold || { created: [], skipped: [] } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[projects-create]', message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ENOENT' || code === 'EPERM' || code === 'ENOTDIR' || code === 'EROFS') {
      return res.status(400).json({
        error: `无法创建项目目录：${projectPath.trim()}（${code}），请换一个可写路径`,
      });
    }
    return res.status(500).json({ error: `保存失败：${message}` });
  }
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
