import { getDb, queryAll, queryOne, runSql, saveDb } from './db.js';
import { logAudit } from './permissions.js';
import { getCodexConfig } from './codex.js';
import { codexLocalInstalled, runCodexLocal } from './codexLocal.js';

const TICK_MS = 30_000;
const STEP_INTERVAL_MS = 5_000;
const MAX_NOTE_CHARS = 1200;

let started = false;
let draining = false;

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function appendNote(notes: string[], note: string): string[] {
  const next = [...notes, note];
  while (next.join('\n').length > MAX_NOTE_CHARS && next.length > 1) next.shift();
  return next;
}

function isMilestone(step: string, index: number): boolean {
  return /\[milestone\]|\(milestone\)|里程碑|发布|上线|关键节点/i.test(step) || (index + 1) % 3 === 0;
}

async function drainDueGoals(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const goals = queryAll(
      `SELECT * FROM goals
       WHERE auto_run = 1 AND status = 'active'
         AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC LIMIT 3`,
      [Date.now()]
    ) as Array<Record<string, unknown>>;

    for (const goal of goals) {
      const steps = parseJsonArray(goal.steps_json);
      let notes = parseJsonArray(goal.notes_json);
      const stepIndex = Number(goal.current_step || 0);

      if (steps.length === 0 || stepIndex >= steps.length) {
        runSql("UPDATE goals SET status = 'done', next_run_at = NULL, updated_at = ? WHERE id = ?", [Date.now(), String(goal.id)]);
        saveDb();
        logAudit(goal.project_id as string | null, 'goal_loop', `后台目标完成：${String(goal.title)}`, 'medium', 'auto');
        continue;
      }

      const step = steps[stepIndex];
      if (isMilestone(step, stepIndex)) {
        notes = appendNote(notes, `[等待审批] 第 ${stepIndex + 1} 步：${step}`);
        runSql(
          "UPDATE goals SET status = 'waiting_approval', approval_note = ?, next_run_at = NULL, notes_json = ?, updated_at = ? WHERE id = ?",
          [step, JSON.stringify(notes), Date.now(), String(goal.id)]
        );
        saveDb();
        logAudit(goal.project_id as string | null, 'goal_loop', `后台目标等待审批：${String(goal.title)} 第 ${stepIndex + 1} 步`, 'high', 'approved');
        continue;
      }

      const config = getCodexConfig();
      if (!config.enabled || !config.builtin || !codexLocalInstalled()) {
        notes = appendNote(notes, '[阻塞] 内置 Codex 引擎未启用或未安装');
        runSql("UPDATE goals SET status = 'blocked', next_run_at = NULL, notes_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(notes), Date.now(), String(goal.id)]);
        saveDb();
        continue;
      }

      const project = queryOne('SELECT path FROM projects WHERE id = ?', [goal.project_id]) as Record<string, string> | null;
      if (!project?.path) {
        notes = appendNote(notes, '[阻塞] 目标未绑定可访问项目目录');
        runSql("UPDATE goals SET status = 'blocked', next_run_at = NULL, notes_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(notes), Date.now(), String(goal.id)]);
        saveDb();
        continue;
      }

      runSql("UPDATE goals SET status = 'running', next_run_at = ?, updated_at = ? WHERE id = ?", [
        Date.now() + 10 * 60_000, Date.now(), String(goal.id),
      ]);
      saveDb();

      const completed = steps.slice(0, stepIndex).map((item, index) => `${index + 1}. ${item}（已完成）`);
      const prompt = [
        `长期目标：${String(goal.title)}`,
        goal.description ? `目标描述：${String(goal.description)}` : '',
        completed.length ? `已完成步骤：\n${completed.join('\n')}` : '',
        `只执行当前第 ${stepIndex + 1} 步：${step}`,
        '要求：优先做最小可验证实现；不推送远端；不删除数据；完成后简要说明结果和验证方式。',
      ].filter(Boolean).join('\n\n');

      const result = await runCodexLocal({
        task: prompt,
        cwd: project.path,
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        wireApi: config.wireApi,
        timeoutMs: 600_000,
        sandbox: 'workspace-write',
      });

      const output = result.lastMessage || result.output || '(无输出)';
      notes = appendNote(notes, `[第 ${stepIndex + 1} 步 ${result.failed ? '失败' : '完成'}] ${output.replace(/\s+/g, ' ').slice(0, 500)}`);
      if (result.failed) {
        runSql("UPDATE goals SET status = 'blocked', next_run_at = NULL, notes_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(notes), Date.now(), String(goal.id)]);
        saveDb();
        logAudit(goal.project_id as string | null, 'goal_loop', `后台目标步骤失败：${String(goal.title)} 第 ${stepIndex + 1} 步`, 'high', 'auto');
        continue;
      }

      const nextStep = stepIndex + 1;
      const done = nextStep >= steps.length;
      runSql(
        "UPDATE goals SET status = ?, current_step = ?, next_run_at = ?, notes_json = ?, updated_at = ? WHERE id = ?",
        [done ? 'done' : 'active', nextStep, done ? null : Date.now() + STEP_INTERVAL_MS, JSON.stringify(notes), Date.now(), String(goal.id)]
      );
      saveDb();
      logAudit(goal.project_id as string | null, 'goal_loop', `后台目标推进：${String(goal.title)} 至第 ${nextStep} 步`, 'medium', 'auto');
    }
  } catch (error) {
    console.error('[autonomous-loop]', error);
  } finally {
    draining = false;
  }
}

export async function startAutonomousLoop(): Promise<void> {
  if (started) return;
  started = true;
  await getDb();
  // 后端重启后恢复被中断的 running 状态，避免目标永久卡住。
  try {
    runSql("UPDATE goals SET status = 'active', next_run_at = ? WHERE auto_run = 1 AND status = 'running'", [Date.now() + 2000]);
    saveDb();
  } catch (error) {
    console.error('[autonomous-loop] recovery failed', error);
  }
  setTimeout(() => void drainDueGoals(), 5000).unref?.();
  setInterval(() => void drainDueGoals(), TICK_MS).unref?.();
}
