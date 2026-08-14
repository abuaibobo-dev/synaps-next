import { queryOne, runSql, saveDb } from './db.js';

export interface SharedContext {
  project: string;
  stack: string;
  preferences: string;
  status: string;
  notes: string;
  updatedAt: string;
}

const EMPTY: SharedContext = { project: '', stack: '', preferences: '', status: '', notes: '', updatedAt: '' };

export function getSharedContext(): SharedContext {
  try {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', ['shared_context']);
    if (!row || typeof row.value !== 'string' || !row.value) return EMPTY;
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    return {
      project: typeof parsed.project === 'string' ? parsed.project : '',
      stack: typeof parsed.stack === 'string' ? parsed.stack : '',
      preferences: typeof parsed.preferences === 'string' ? parsed.preferences : '',
      status: typeof parsed.status === 'string' ? parsed.status : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return EMPTY;
  }
}

export function sharedContextToText(ctx: SharedContext): string {
  const lines: string[] = [];
  if (ctx.project) lines.push(`项目：${ctx.project}`);
  if (ctx.stack) lines.push(`技术栈：${ctx.stack}`);
  if (ctx.preferences) lines.push(`代码偏好：${ctx.preferences}`);
  if (ctx.status) lines.push(`当前状态：${ctx.status}`);
  if (ctx.notes) lines.push(`备注：${ctx.notes}`);
  if (lines.length === 0) return '';
  return lines.join('\n');
}

const TECH_HINTS = ['react', 'reactnative', 'typescript', 'javascript', 'kotlin', 'java', 'python', 'swift', 'go', 'rust', 'vue', 'flutter', 'dart', 'sql', 'node', 'expo', 'rn', 'gradle'];

function classifyLine(line: string): { field: keyof SharedContext; value: string } {
  const l = line.trim();
  const lower = l.toLowerCase();
  if (lower.startsWith('项目') || /[/\\]/.test(l) && l.length > 5) {
    return { field: 'project', value: l.replace(/^项目[：:]?/, '') };
  }
  if (lower.startsWith('技术栈') || TECH_HINTS.some((t) => lower.includes(t))) {
    return { field: 'stack', value: l.replace(/^技术栈[：:]?/, '') };
  }
  if (lower.startsWith('偏好') || lower.includes('缩进') || lower.includes('引号') || lower.includes('风格') || lower.includes('命名')) {
    return { field: 'preferences', value: l.replace(/^偏好[：:]?/, '') };
  }
  if (lower.startsWith('状态') || lower.includes('正在') || lower.includes('进行中') || lower.includes('开发')) {
    return { field: 'status', value: l.replace(/^状态[：:]?/, '') };
  }
  return { field: 'notes', value: l };
}

/**
 * 合并更新共享上下文。content 支持多行，按关键词分到对应字段，其余进备注。
 */
export function mergeSharedContext(content: string): SharedContext {
  const ctx = getSharedContext();
  for (const line of content.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
    const { field, value } = classifyLine(line);
    if (!value) continue;
    if (field === 'notes') {
      ctx.notes = ctx.notes ? `${ctx.notes}\n${value}` : value;
    } else {
      ctx[field] = ctx[field] ? `${ctx[field]}\n${value}` : value;
    }
  }
  ctx.updatedAt = new Date().toISOString();
  runSql(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('shared_context', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [JSON.stringify(ctx)]
  );
  saveDb();
  return ctx;
}

/** 清空共享上下文 */
export function clearSharedContext(): void {
  runSql(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('shared_context', '{}', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  saveDb();
}
