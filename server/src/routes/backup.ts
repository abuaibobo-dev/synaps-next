import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, queryAll, saveDb } from '../db.js';

const router = Router();

const BACKUP_TABLES = [
  'projects',
  'chat_sessions',
  'chat_messages',
  'settings',
  'snapshots',
  'snapshot_files',
  'command_history',
  'skills',
  'agent_memory',
  'team_tasks',
  'agent_instances',
  'agent_contexts',
  'audit_logs',
];

function getTableColumns(db: ReturnType<typeof getDb> extends Promise<infer T> ? T : never, table: string): string[] {
  const info = db.exec(`PRAGMA table_info(${table})`);
  if (!info[0]) return [];
  return info[0].values.map((row) => String(row[1]));
}

/**
 * GET /api/v1/backup/export
 * 导出全量数据备份（JSON），用于跨设备迁移 / 恢复
 */
router.get('/export', async (_req: Request, res: Response) => {
  try {
    await getDb();
    const tables: Record<string, unknown[]> = {};
    for (const table of BACKUP_TABLES) {
      tables[table] = queryAll(`SELECT * FROM ${table}`);
    }
    res.json({
      meta: {
        app: 'synaps',
        version: '1.1.0',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
      },
      tables,
    });
  } catch (error) {
    console.error('Failed to export backup:', error);
    res.status(500).json({ error: 'Failed to export backup' });
  }
});

/**
 * GET /api/v1/backup/logs
 * 导出日志（审计日志 + 命令历史），用于排查问题
 */
router.get('/logs', async (_req: Request, res: Response) => {
  try {
    await getDb();
    res.json({
      exportedAt: new Date().toISOString(),
      auditLogs: queryAll('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000'),
      commandHistory: queryAll('SELECT * FROM command_history ORDER BY executed_at DESC LIMIT 1000'),
    });
  } catch (error) {
    console.error('Failed to export logs:', error);
    res.status(500).json({ error: 'Failed to export logs' });
  }
});

/**
 * POST /api/v1/backup/import
 * Body: { data: { meta?, tables: { <table>: rows[] } } }
 * 用备份数据整体替换当前数据库内容
 */
router.post('/import', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const body = req.body as { data?: { tables?: Record<string, unknown[]> }; tables?: Record<string, unknown[]> };
    const tables = body?.data?.tables ?? body?.tables;

    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
      return res.status(400).json({ error: '无效的备份格式：缺少 tables' });
    }

    const counts: Record<string, number> = {};
    for (const table of BACKUP_TABLES) {
      const rows = Array.isArray(tables[table]) ? (tables[table] as Record<string, unknown>[]) : [];
      const cols = getTableColumns(db, table);
      db.run(`DELETE FROM ${table}`);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const keys = cols.filter((c) => row[c] !== undefined && row[c] !== null);
        if (keys.length === 0) continue;
        const placeholders = keys.map(() => '?').join(', ');
        db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`, keys.map((c) => row[c] as any));
      }
      counts[table] = rows.length;
    }
    saveDb();
    res.json({ success: true, counts });
  } catch (error) {
    console.error('Failed to import backup:', error);
    res.status(500).json({ error: 'Failed to import backup: ' + String(error) });
  }
});

export default router;
