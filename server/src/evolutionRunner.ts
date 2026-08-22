import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, runSql } from './db.js';
import { getCapabilityRegistry } from './capabilityKernel.js';
import { recordTaskLearning } from './learning.js';
import { installCliTool, CLI_TOOL_IDS } from './cliTools.js';
import { listDagPlans, tickDagPlan } from './dag.js';

export interface EvolutionRun {
  id: string;
  stepId: string;
  title: string;
  status: 'success' | 'failed' | 'blocked' | 'requires_approval';
  message: string;
  mode: 'automatic' | 'approved' | 'manual';
  createdAt: number;
}

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  getDb();
  runSql(`
    CREATE TABLE IF NOT EXISTS kernel_evolution_runs (
      id TEXT PRIMARY KEY,
      step_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  runSql('CREATE INDEX IF NOT EXISTS idx_kernel_evolution_step ON kernel_evolution_runs(step_id, created_at DESC)');
  tableReady = true;
}

function saveRun(row: Omit<EvolutionRun, 'id'>): EvolutionRun {
  const id = randomUUID();
  runSql(
    `INSERT INTO kernel_evolution_runs (id, step_id, title, status, message, mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, row.stepId, row.title, row.status, row.message, row.mode, row.createdAt]
  );
  return { id, ...row };
}

async function distillProjectMemories(): Promise<string> {
  const rows = queryAll(`
    SELECT project_id,
           COUNT(*) AS total,
           SUM(CASE WHEN solution LIKE '%质量评分:7%' OR solution LIKE '%质量评分:8%' OR solution LIKE '%质量评分:9%' THEN 1 ELSE 0 END) AS good,
           SUM(CASE WHEN solution LIKE '%状态:error%' OR solution LIKE '%状态:cancelled%' THEN 1 ELSE 0 END) AS bad,
           MIN(created_at) AS first_seen,
           MAX(created_at) AS last_seen
    FROM agent_memory
    WHERE namespace = 'task_learning'
    GROUP BY project_id
    LIMIT 30
  `);
  let written = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    const projectId = row.project_id ? String(row.project_id) : null;
    const total = Number(row.total || 0);
    const good = Number(row.good || 0);
    const bad = Number(row.bad || 0);
    if (total < 3) continue;
    const fingerprint = `project:${projectId || 'global'}:${new Date(Number(row.last_seen || Date.now())).toISOString().slice(0, 10)}`;
    const existing = queryOne('SELECT id FROM agent_memory WHERE namespace = ? AND fingerprint = ?', ['project_insight', fingerprint]);
    if (existing) continue;
    runSql(
      `INSERT INTO agent_memory
       (id, project_id, namespace, key, value, embedding_text, pattern, solution, context, confidence, use_count)
       VALUES (?, ?, 'project_insight', ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        randomUUID(),
        projectId,
        fingerprint,
        JSON.stringify({ total, good, bad, generatedAt: now }),
        `项目任务蒸馏：样本 ${total}，成功倾向 ${good}，失败倾向 ${bad}`,
        `项目经验蒸馏 | 样本:${total} | 成功:${good} | 失败:${bad}`,
        `优先复用成功路径；失败任务先检查最后工具和验证证据。\n统计窗口：${Number(row.first_seen || Date.now())} - ${Number(row.last_seen || Date.now())}`,
        `generatedAt=${now}`,
        Math.min(0.82, 0.55 + total * 0.03),
      ]
    );
    written++;
  }
  return written > 0 ? `已生成 ${written} 条项目级洞察。` : '暂无足够新任务样本。';
}

function backfillTaskScores(): string {
  const rows = queryAll(`
    SELECT t.id FROM tasks t
    LEFT JOIN agent_memory m ON m.namespace = 'task_learning' AND m.key = t.id
    WHERE m.id IS NULL AND t.status != 'running'
    ORDER BY t.ended_at DESC LIMIT 50
  `);
  let scored = 0;
  for (const row of rows) {
    const task = queryOne('SELECT started_at, ended_at FROM tasks WHERE id = ?', [String(row.id)]);
    if (!task) continue;
    recordTaskLearning(String(row.id), String(task.status === 'done' ? 'done' : task.status || 'error') as any, Number(task.ended_at || Date.now()));
    scored++;
  }
  return scored > 0 ? `已补建 ${scored} 个任务评分。` : '所有近期任务已有评分。';
}

async function installNoLoginCliTools(): Promise<string> {
  for (const id of CLI_TOOL_IDS) {
    await installCliTool(id);
  }
  return `免登录 CLI 工具已就绪：${CLI_TOOL_IDS.join(' / ')}`;
}

function reviveDagPlans(): string {
  const plans = listDagPlans(null, 30).filter(plan => plan.status === 'planning' || plan.status === 'running');
  let dispatchCount = 0;
  for (const plan of plans) {
    dispatchCount += tickDagPlan(plan.id).dispatches.length;
  }
  return `检查 ${plans.length} 个 DAG 计划，新派发 ${dispatchCount} 个节点。`;
}

export async function runEvolutionStep(stepId: string, approved = false): Promise<{ run: EvolutionRun; requiresApproval?: boolean }> {
  await getDb();
  ensureTable();
  const registry = await getCapabilityRegistry();
  const step = registry.evolution.steps.find(item => item.id === stepId);
  if (!step) throw new Error('升级步骤不存在');
  if (step.safety !== 'safe' && !approved) {
    const run = saveRun({
      stepId,
      title: step.title,
      status: 'requires_approval',
      message: step.safety === 'gated' ? '核心/高风险升级需要用户审批。' : '灰度升级需要确认后进入测试通道。',
      mode: approved ? 'approved' : 'manual',
      createdAt: Date.now(),
    });
    return { run, requiresApproval: true };
  }

  try {
    let message = '';
    if (stepId === 'memory-distillation') {
      message = await distillProjectMemories();
    } else if (stepId === 'install-cli-tools') {
      message = await installNoLoginCliTools();
    } else if (stepId === 'quality-scorer') {
      message = backfillTaskScores();
    } else if (stepId === 'benchmark-suite') {
      const lessonCount = Number(queryOne("SELECT COUNT(*) AS value FROM agent_memory WHERE namespace = 'task_learning'")?.value || 0);
      message = `基准检查完成：当前可复用经验 ${lessonCount} 条；能力 readiness ${registry.readiness}%。`;
    } else if (stepId === 'dag-planner') {
      message = reviveDagPlans();
    } else if (stepId === 'configure-github') {
      message = '请填写 GitHub Token 后重试交付流水线升级。';
    } else {
      message = '该步骤暂无自动动作。';
    }

    return { run: saveRun({ stepId, title: step.title, status: 'success', message, mode: approved ? 'approved' : 'automatic', createdAt: Date.now() }) };
  } catch (error) {
    return { run: saveRun({ stepId, title: step.title, status: 'failed', message: String((error as Error).message || error), mode: approved ? 'approved' : 'automatic', createdAt: Date.now() }) };
  }
}

export function listEvolutionRuns(limit = 40): EvolutionRun[] {
  ensureTable();
  return queryAll('SELECT * FROM kernel_evolution_runs ORDER BY created_at DESC LIMIT ?', [limit]).map(row => ({
    id: String(row.id),
    stepId: String(row.step_id),
    title: String(row.title),
    status: String(row.status) as EvolutionRun['status'],
    message: String(row.message),
    mode: String(row.mode) as EvolutionRun['mode'],
    createdAt: Number(row.created_at),
  }));
}
