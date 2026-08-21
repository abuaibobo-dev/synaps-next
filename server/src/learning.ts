import { queryOne, runSql } from './db.js';
import type { TaskRecordRow, TaskStatus, TaskToolRecord } from './taskStore.js';

interface LearningResult {
  taskId: string;
  status: TaskStatus;
  quality: number;
  pattern: string;
  solution: string;
  tools: string[];
  files: string[];
}

function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function truncate(text: string, length = 700): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}

export function recordTaskLearning(taskId: string, taskStatus: TaskStatus, endedAt: number): LearningResult | null {
  const row = queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!row) return null;
  const task = row as unknown as TaskRecordRow;
  const tools = parseJsonArray(task.tools_json) as unknown as TaskToolRecord[];
  const steps = parseJsonArray(task.steps_json);
  const files = (() => {
    try {
      const parsed = JSON.parse(task.files_json || '[]');
      return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(Boolean).slice(0, 12) : [];
    } catch {
      return [];
    }
  })();

  const failedTools = tools.filter(tool => tool.ok === false || /error|failed|exception/i.test(String(tool.result || '')));
  let quality = taskStatus === 'done' ? 78 : taskStatus === 'cancelled' ? 48 : 34;
  quality -= Math.min(18, failedTools.length * 6);
  if (files.length > 0 && taskStatus === 'done') quality += Math.min(9, files.length * 3);
  if (steps.length > 1) quality += 3;

  const lastAssistant = task.session_id
    ? queryOne(
        `SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
        [task.session_id]
      )
    : null;
  const answer = String(lastAssistant?.content || '');
  if (answer.trim().length < 40) quality -= 14;
  if (/\bError:|执行失败|构建失败|测试失败/.test(answer)) quality -= 16;
  quality = Math.max(0, Math.min(100, quality));

  const toolNames = [...new Set(tools.map(tool => String(tool.name)).filter(Boolean))].slice(0, 12);
  const failedToolNames = [...new Set(failedTools.map(tool => String(tool.name)))].slice(0, 6);
  const failedResult = failedTools.map(tool => String(tool.result || '')).find(Boolean) || answer;

  const pattern = [
    `任务:${truncate(task.name, 100)}`,
    `状态:${taskStatus}`,
    toolNames.length ? `工具:${toolNames.join(',')}` : '',
    files.length ? `文件:${files.join(',')}` : '',
  ].filter(Boolean).join(' | ');

  const solution = [
    `质量评分:${quality}/100`,
    failedToolNames.length ? `疑似失败点:${failedToolNames.join(',')}` : '',
    failedResult ? `证据:${truncate(failedResult, 420)}` : '',
    taskStatus === 'done' && quality >= 75
      ? '可复用路径：保留当前工具顺序，先跑验证再交付。'
      : taskStatus === 'done'
        ? '修正假设：输出完成但证据不足，下一步补充构建/测试检查。'
        : '修正假设：从最后一个失败工具回溯，缩小输入范围后重试，并为该路径补回归测试。',
  ].filter(Boolean).join('\n');

  runSql(
    `DELETE FROM agent_memory WHERE namespace = 'task_learning' AND key = ?`,
    [taskId]
  );
  runSql(
    `INSERT INTO agent_memory
     (id, project_id, namespace, key, value, embedding_text, pattern, solution, context, confidence, use_count)
     VALUES (?, ?, 'task_learning', ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      `learn-${taskId}`,
      task.project_id,
      taskId,
      JSON.stringify({ taskId, status: taskStatus, quality, endedAt, tools: toolNames, files }),
      `${pattern}\n${solution}`.slice(0, 1800),
      pattern,
      solution,
      `durationMs=${Math.max(0, endedAt - Number(task.started_at || endedAt))};steps=${steps.length};tools=${tools.length}`,
      taskStatus === 'done' ? Math.max(0.55, quality / 120) : 0.42,
    ]
  );

  return { taskId, status: taskStatus, quality, pattern, solution, tools: toolNames, files };
}
