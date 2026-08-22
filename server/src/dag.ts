import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, runSql } from './db.js';
import { assignTask, completeTask, spawnAgent } from './swarm/agentLifecycle.js';
import type { AgentType } from './agentInstance.js';

export type DagNodeStatus = 'pending' | 'blocked' | 'ready' | 'running' | 'done' | 'failed';

export interface DagNode {
  id: string;
  title: string;
  detail?: string;
  role: AgentType;
  dependsOn: string[];
  status: DagNodeStatus;
  result?: string;
  assignedAgentId?: string | null;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
}

export interface DagPlan {
  id: string;
  projectId: string | null;
  objective: string;
  status: 'planning' | 'running' | 'completed' | 'failed';
  maxParallel: number;
  nodes: DagNode[];
  createdAt: number;
  updatedAt: number;
}

let ready = false;

function ensureSchema(): void {
  if (ready) return;
  getDb();
  runSql(`
    CREATE TABLE IF NOT EXISTS dag_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      max_parallel INTEGER NOT NULL DEFAULT 3,
      graph_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  runSql('CREATE INDEX IF NOT EXISTS idx_dag_plans_project ON dag_plans(project_id, updated_at DESC)');
  ready = true;
}

function parsePlan(row: Record<string, unknown>): DagPlan {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    objective: String(row.objective),
    status: row.status as DagPlan['status'],
    maxParallel: Number(row.max_parallel || 3),
    nodes: JSON.parse(String(row.graph_json || '[]')),
    createdAt: Number(row.created_at || Date.now()),
    updatedAt: Number(row.updated_at || Date.now()),
  };
}

function persist(plan: DagPlan): void {
  plan.updatedAt = Date.now();
  const allDone = plan.nodes.every(node => node.status === 'done');
  const anyFailed = plan.nodes.some(node => node.status === 'failed');
  plan.status = allDone ? 'completed' : anyFailed ? 'failed' : plan.nodes.some(node => node.status === 'running') ? 'running' : 'planning';
  runSql(
    `UPDATE dag_plans SET status = ?, max_parallel = ?, graph_json = ?, updated_at = ? WHERE id = ?`,
    [plan.status, plan.maxParallel, JSON.stringify(plan.nodes), plan.updatedAt, plan.id]
  );
}

function refreshReady(plan: DagPlan): void {
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  for (const node of plan.nodes) {
    if (node.status !== 'pending') continue;
    const deps = node.dependsOn.map(id => byId.get(id)).filter(Boolean) as DagNode[];
    if (deps.some(dep => dep.status === 'failed')) node.status = 'blocked';
    else if (deps.every(dep => dep.status === 'done')) node.status = 'ready';
  }
}

function assertAcyclic(nodes: DagNode[]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('任务依赖存在循环');
    if (visited.has(id)) return;
    visiting.add(id);
    const node = nodes.find(item => item.id === id);
    for (const dep of node?.dependsOn || []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  nodes.forEach(node => visit(node.id));
}

export function createDagPlan(input: {
  projectId: string | null;
  objective: string;
  maxParallel?: number;
  nodes: Array<{ title: string; detail?: string; role?: AgentType; dependsOn?: string[] }>;
}): DagPlan {
  ensureSchema();
  if (!input.objective.trim()) throw new Error('objective is required');
  if (!input.nodes.length) throw new Error('至少需要一个任务节点');

  const generatedIds = new Map<string, string>();
  input.nodes.forEach((node, index) => generatedIds.set(`#${index + 1}`, randomUUID()));

  const nodes: DagNode[] = input.nodes.map((node, index) => ({
    id: randomUUID(),
    title: node.title.trim() || `任务 ${index + 1}`,
    detail: node.detail,
    role: node.role || 'code_engineer',
    dependsOn: (node.dependsOn || []).map(ref => {
      const mapped = generatedIds.get(ref.trim());
      if (mapped) return mapped;
      const found = input.nodes.findIndex(item => item.title.trim() === ref.trim());
      return found >= 0 ? generatedIds.get(`#${found + 1}`)! : ref.trim();
    }),
    status: 'pending',
    attempts: 0,
  }));

  const ids = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    if (node.dependsOn.some(dep => !ids.has(dep))) throw new Error('依赖节点不存在');
    if (node.dependsOn.includes(node.id)) throw new Error('任务不能依赖自己');
  }
  assertAcyclic(nodes);

  const plan: DagPlan = {
    id: randomUUID(),
    projectId: input.projectId,
    objective: input.objective.trim(),
    status: 'planning',
    maxParallel: Math.max(1, Math.min(6, input.maxParallel || 3)),
    nodes,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  refreshReady(plan);
  runSql(
    `INSERT INTO dag_plans (id, project_id, objective, status, max_parallel, graph_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [plan.id, plan.projectId, plan.objective, plan.status, plan.maxParallel, JSON.stringify(plan.nodes), plan.createdAt, plan.updatedAt]
  );
  return plan;
}

export function getDagPlan(id: string): DagPlan | null {
  ensureSchema();
  const row = queryOne('SELECT * FROM dag_plans WHERE id = ?', [id]);
  return row ? parsePlan(row) : null;
}

export function listDagPlans(projectId?: string | null, limit = 30): DagPlan[] {
  ensureSchema();
  const rows = projectId
    ? queryAll('SELECT * FROM dag_plans WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?', [projectId, limit])
    : queryAll('SELECT * FROM dag_plans ORDER BY updated_at DESC LIMIT ?', [limit]);
  return rows.map(parsePlan);
}

export interface DagDispatch {
  nodeId: string;
  title: string;
  role: AgentType;
  agentId: string;
  instruction: string;
}

export function tickDagPlan(id: string): { plan: DagPlan; dispatches: DagDispatch[] } {
  const plan = getDagPlan(id);
  if (!plan) throw new Error('DAG 计划不存在');
  refreshReady(plan);

  // 超时节点回收，防止后台执行器消失导致计划卡死。
  for (const node of plan.nodes) {
    if (node.status === 'running' && node.startedAt && Date.now() - node.startedAt > 45 * 60 * 1000 && node.attempts < 2) {
      node.status = 'ready';
      node.result = '执行超时，已重新排队。';
    }
  }

  const running = plan.nodes.filter(node => node.status === 'running').length;
  const dispatches: DagDispatch[] = [];
  for (const node of plan.nodes.filter(node => node.status === 'ready')) {
    if (running + dispatches.length >= plan.maxParallel) break;
    const agent = spawnAgent(node.role, `DAG-${node.title.slice(0, 18)}-${Date.now().toString(36)}`, 'dag', node.dependsOn.length > 0 ? 'high' : 'normal');
    assignTask(agent.id, node.title);
    node.status = 'running';
    node.assignedAgentId = agent.id;
    node.attempts += 1;
    node.startedAt = Date.now();
    node.endedAt = undefined;
    dispatches.push({
      nodeId: node.id,
      title: node.title,
      role: node.role,
      agentId: agent.id,
      instruction: `${node.title}${node.detail ? `\n${node.detail}` : ''}\n\n完成后必须调用 dag_report(planId=${plan.id}, nodeId=${node.id}, success=true/false, result=...).`,
    });
  }

  if (!dispatches.length && !plan.nodes.some(node => node.status === 'running') && plan.status !== 'completed') {
    const failed = plan.nodes.some(node => node.status === 'failed');
    const blocked = plan.nodes.some(node => node.status === 'blocked');
    if (failed || blocked) plan.status = failed ? 'failed' : 'planning';
  }
  persist(plan);
  return { plan, dispatches };
}

export function reportDagNode(id: string, nodeId: string, success: boolean, result: string): { plan: DagPlan; dispatches: DagDispatch[] } {
  const plan = getDagPlan(id);
  if (!plan) throw new Error('DAG 计划不存在');
  const node = plan.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error('DAG 节点不存在');
  if (node.status !== 'running') throw new Error(`节点状态为 ${node.status}，不能上报结果`);
  node.status = success ? 'done' : 'failed';
  node.result = result;
  node.endedAt = Date.now();
  if (node.assignedAgentId) completeTask(node.assignedAgentId, success, node.endedAt - (node.startedAt || node.endedAt));
  persist(plan);
  const ticked = tickDagPlan(id);
  return { plan: ticked.plan, dispatches: ticked.dispatches };
}
