import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, runSql } from './db.js';
import { getCapabilityRegistry } from './capabilityKernel.js';

export interface ProactiveSuggestion {
  id: string;
  kind: string;
  title: string;
  reason: string;
  action: string;
  priority: number;
  safety: 'safe' | 'canary' | 'gated';
  status: 'pending' | 'accepted' | 'dismissed' | 'snoozed';
  timesSeen: number;
  learningScore: number;
  projectId: string | null;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  getDb();
  runSql(`
    CREATE TABLE IF NOT EXISTS proactive_suggestions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      action TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50,
      safety TEXT NOT NULL DEFAULT 'safe',
      status TEXT NOT NULL DEFAULT 'pending',
      times_seen INTEGER NOT NULL DEFAULT 1,
      learning_score INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  runSql('CREATE INDEX IF NOT EXISTS idx_proactive_status ON proactive_suggestions(status, priority DESC, learning_score DESC)');
  tableReady = true;
}

function rowToSuggestion(row: Record<string, unknown>): ProactiveSuggestion {
  return {
    id: String(row.id),
    kind: String(row.kind),
    title: String(row.title),
    reason: String(row.reason),
    action: String(row.action),
    priority: Number(row.priority || 50),
    safety: (String(row.safety || 'safe') as ProactiveSuggestion['safety']),
    status: (String(row.status || 'pending') as ProactiveSuggestion['status']),
    timesSeen: Number(row.times_seen || 1),
    learningScore: Number(row.learning_score || 0),
    projectId: row.project_id ? String(row.project_id) : null,
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function addSuggestions(items: Array<Omit<ProactiveSuggestion, 'id' | 'status' | 'timesSeen' | 'learningScore' | 'createdAt' | 'updatedAt'>>): Promise<void> {
  const now = new Date().toISOString();
  for (const item of items) {
    const existing = queryOne('SELECT * FROM proactive_suggestions WHERE fingerprint = ?', [item.fingerprint]);
    if (existing) {
      runSql(
        `UPDATE proactive_suggestions
         SET times_seen = times_seen + 1, priority = ?, updated_at = ?
         WHERE fingerprint = ? AND status = 'pending'`,
        [item.priority, now, item.fingerprint]
      );
      continue;
    }
    const values = [
      randomUUID(), item.kind, item.title, item.reason, item.action, item.priority,
      item.safety, item.projectId, item.fingerprint, now, now,
    ];
    runSql(
      `INSERT INTO proactive_suggestions
       (id, kind, title, reason, action, priority, safety, project_id, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values
    );
  }
}

export async function generateProactiveSuggestions(): Promise<void> {
  await getDb();
  ensureTable();
  const registry = await getCapabilityRegistry();
  const items: Array<Omit<ProactiveSuggestion, 'id' | 'status' | 'timesSeen' | 'learningScore' | 'createdAt' | 'updatedAt'>> = [];

  for (const step of registry.evolution.steps) {
    items.push({
      kind: 'evolution',
      title: step.title,
      reason: step.reason,
      action: `打开能力中心并执行：${step.title}`,
      priority: step.trigger === 'automatic' ? 72 : 60,
      safety: step.safety,
      projectId: null,
      fingerprint: `evolution:${step.id}`,
    });
  }

  for (const capability of registry.capabilities.filter(item => item.status !== 'ready')) {
    items.push({
      kind: 'capability-gap',
      title: `增强${capability.name}`,
      reason: capability.summary,
      action: capability.nextUpgrade,
      priority: Math.round((100 - capability.score) * 0.55),
      safety: 'canary',
      projectId: null,
      fingerprint: `capability:${capability.id}:${capability.score >= 40 ? 'partial' : 'missing'}`,
    });
  }

  const failedTasks = queryAll(
    `SELECT id, project_id, name, ended_at FROM tasks
     WHERE status IN ('error', 'failed', 'cancelled') AND ended_at >= ?
     ORDER BY ended_at DESC LIMIT 8`,
    [Date.now() - 24 * 3600 * 1000]
  );
  for (const task of failedTasks) {
    const taskId = String(task.id);
    items.push({
      kind: 'failure-review',
      title: `分析失败任务：${String(task.name).slice(0, 48)}`,
      reason: '最近 24 小时内出现失败或取消，可能存在可自动修复的重复问题。',
      action: '读取任务日志，生成失败原因、修复补丁和回归测试。',
      priority: 82,
      safety: 'canary',
      projectId: task.project_id ? String(task.project_id) : null,
      fingerprint: `failed-task:${taskId}`,
    });
  }

  const staleGoals = queryAll(
    `SELECT id, project_id, title, updated_at FROM goals
     WHERE status = 'active' AND updated_at < ?
     ORDER BY updated_at ASC LIMIT 8`,
    [Date.now() - 24 * 3600 * 1000]
  );
  for (const goal of staleGoals) {
    const goalId = String(goal.id);
    items.push({
      kind: 'stale-goal',
      title: `恢复停滞目标：${String(goal.title).slice(0, 42)}`,
      reason: '目标超过 24 小时没有推进。',
      action: '重新评估剩余步骤；若阻塞，拆出最小可验证下一步。',
      priority: 76,
      safety: 'safe',
      projectId: goal.project_id ? String(goal.project_id) : null,
      fingerprint: `stale-goal:${goalId}:${new Date(Number(goal.updated_at || Date.now())).toISOString().slice(0, 10)}`,
    });
  }

  await addSuggestions(items);
}

export async function listProactiveSuggestions(includeCompleted = false): Promise<ProactiveSuggestion[]> {
  await getDb();
  ensureTable();
  const where = includeCompleted ? '' : "WHERE status = 'pending'";
  return queryAll(
    `SELECT * FROM proactive_suggestions ${where}
     ORDER BY (priority + learning_score) DESC, updated_at DESC LIMIT 80`
  ).map(rowToSuggestion);
}

export async function updateSuggestionFeedback(id: string, action: 'accept' | 'dismiss' | 'snooze'): Promise<ProactiveSuggestion | null> {
  await getDb();
  ensureTable();
  const statusMap = { accept: 'accepted', dismiss: 'dismissed', snooze: 'snoozed' } as const;
  const delta = action === 'accept' ? 8 : action === 'dismiss' ? -6 : 0;
  runSql(
    `UPDATE proactive_suggestions
     SET status = ?, learning_score = learning_score + ?, updated_at = ?
     WHERE id = ?`,
    [statusMap[action], delta, new Date().toISOString(), id]
  );
  const row = queryOne('SELECT * FROM proactive_suggestions WHERE id = ?');
  return row ? rowToSuggestion(row) : null;
}
