import { queryAll, runSql } from './db.js';

export type TaskStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface TaskStepRecord {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export interface TaskToolRecord {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  ts: number;
}

export interface TaskRecordRow {
  id: string;
  project_id: string | null;
  session_id: string | null;
  name: string;
  status: TaskStatus;
  steps_json: string;
  tools_json: string;
  files_json: string;
  started_at: number;
  ended_at: number | null;
}

export function createTask(
  taskId: string,
  projectId: string | null,
  sessionId: string | null,
  name: string,
  startedAt: number
): void {
  try {
    runSql(
      `INSERT INTO tasks (id, project_id, session_id, name, status, steps_json, tools_json, files_json, started_at)
       VALUES (?, ?, ?, ?, 'running', '[]', '[]', '[]', ?)`,
      [taskId, projectId, sessionId, name, startedAt]
    );
  } catch (err) {
    console.error('Failed to create task record:', err);
  }
}

export function saveTaskProgress(
  taskId: string,
  steps: TaskStepRecord[],
  tools: TaskToolRecord[],
  files: string[]
): void {
  try {
    runSql(
      `UPDATE tasks SET steps_json = ?, tools_json = ?, files_json = ? WHERE id = ?`,
      [JSON.stringify(steps), JSON.stringify(tools), JSON.stringify(files), taskId]
    );
  } catch (err) {
    console.error('Failed to save task progress:', err);
  }
}

export function finishTask(taskId: string, status: TaskStatus, endedAt: number): void {
  try {
    runSql(`UPDATE tasks SET status = ?, ended_at = ? WHERE id = ?`, [status, endedAt, taskId]);
  } catch (err) {
    console.error('Failed to finish task record:', err);
  }
}

export function listTasks(projectId?: string | null, limit = 50): TaskRecordRow[] {
  const rows = projectId
    ? queryAll(
        `SELECT * FROM tasks WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`,
        [projectId, limit]
      )
    : queryAll(`SELECT * FROM tasks ORDER BY started_at DESC LIMIT ?`, [limit]);
  return rows as unknown as TaskRecordRow[];
}

// 服务端等价于前端 TaskPanel 的 isFileModifyingTool
const FILE_MODIFY_TOOLS = new Set([
  'write_file',
  'auto_fix',
  'security_fix',
  'generate_tests',
  'auto_test_fix',
  'team_execute',
  'project_import',
]);

export function isFileModifyingToolServer(tool: string, args?: Record<string, unknown>): boolean {
  if (!FILE_MODIFY_TOOLS.has(tool)) return false;
  return typeof args?.path === 'string' || typeof args?.query === 'string' || tool === 'team_execute';
}

export function taskFilesFromTools(tools: TaskToolRecord[]): string[] {
  const files: string[] = [];
  for (const t of tools) {
    if (!isFileModifyingToolServer(t.name, t.args)) continue;
    const p = typeof t.args?.path === 'string' ? t.args.path : '';
    if (p && !files.includes(p)) files.push(p);
  }
  return files;
}
