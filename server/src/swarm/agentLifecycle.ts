/**
 * Agent Lifecycle Manager
 * 借鉴 Ruflo agent-tools.ts：完整的 Agent 生命周期管理
 * spawn → activate → execute → pause/resume → terminate
 */

import { randomUUID } from 'crypto';
import { runSql, queryOne, queryAll } from '../db.js';
import type { AgentType } from '../agentInstance.js';

export type AgentLifecycleStatus = 'spawning' | 'active' | 'idle' | 'running' | 'paused' | 'terminating' | 'terminated' | 'failed';

export interface SwarmAgent {
  id: string;
  type: AgentType;
  name: string;
  status: AgentLifecycleStatus;
  topology: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  currentTask: string | null;
  parentId: string | null;
  children: string[];
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    avgResponseTime: number;
    lastActiveAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

const SWARM_AGENTS = new Map<string, SwarmAgent>();

/**
 * 生成唯一 Agent ID（借鉴 Ruflo generateSecureAgentId）
 */
function generateAgentId(): string {
  const ts = Date.now().toString(36);
  const rand = randomUUID().slice(0, 8);
  return `swarm-${ts}-${rand}`;
}

/**
 * Spawn a new agent
 */
export function spawnAgent(
  type: AgentType,
  name: string,
  topology: string = 'flat',
  priority: SwarmAgent['priority'] = 'normal',
  parentId: string | null = null,
): SwarmAgent {
  const id = generateAgentId();
  const now = new Date().toISOString();

  const agent: SwarmAgent = {
    id,
    type,
    name,
    status: 'spawning',
    topology,
    priority,
    currentTask: null,
    parentId,
    children: [],
    metrics: {
      tasksCompleted: 0,
      tasksFailed: 0,
      avgResponseTime: 0,
      lastActiveAt: null,
    },
    createdAt: now,
    updatedAt: now,
  };

  SWARM_AGENTS.set(id, agent);

  // 如果有父 Agent，建立父子关系
  if (parentId) {
    const parent = SWARM_AGENTS.get(parentId);
    if (parent) {
      parent.children.push(id);
      parent.updatedAt = now;
    }
  }

  // 记录到数据库
  try {
    runSql(
      `INSERT INTO agent_instances (id, session_id, agent_type, name, status, tools, model, temperature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'swarm', type, name, 'spawning', '[]', 'deepseek-v4-flash', 0.4]
    );
  } catch { /* ignore */ }

  // 自动激活
  agent.status = 'active';
  agent.updatedAt = new Date().toISOString();
  updateDbStatus(id, 'active');

  return agent;
}

/**
 * List all agents (with optional filters)
 */
export function listAgents(
  status?: AgentLifecycleStatus | 'all',
  type?: string,
  limit: number = 100
): SwarmAgent[] {
  let agents = Array.from(SWARM_AGENTS.values());
  if (status && status !== 'all') {
    agents = agents.filter(a => a.status === status);
  }
  if (type) {
    agents = agents.filter(a => a.type === type);
  }
  return agents.slice(0, limit);
}

/**
 * Get agent status
 */
export function getAgentStatus(agentId: string): SwarmAgent | null {
  return SWARM_AGENTS.get(agentId) || null;
}

/**
 * Assign task to agent
 */
export function assignTask(agentId: string, taskDescription: string): boolean {
  const agent = SWARM_AGENTS.get(agentId);
  if (!agent || agent.status !== 'active' && agent.status !== 'idle') return false;

  agent.currentTask = taskDescription;
  agent.status = 'running';
  agent.updatedAt = new Date().toISOString();
  updateDbStatus(agentId, 'running');
  return true;
}

/**
 * Complete task
 */
export function completeTask(agentId: string, success: boolean, responseTimeMs: number = 0): void {
  const agent = SWARM_AGENTS.get(agentId);
  if (!agent) return;

  if (success) {
    agent.metrics.tasksCompleted++;
  } else {
    agent.metrics.tasksFailed++;
  }

  // 更新平均响应时间（指数移动平均）
  const alpha = 0.3;
  agent.metrics.avgResponseTime = agent.metrics.avgResponseTime * (1 - alpha) + responseTimeMs * alpha;
  agent.metrics.lastActiveAt = new Date().toISOString();

  agent.currentTask = null;
  agent.status = 'active';
  agent.updatedAt = new Date().toISOString();
  updateDbStatus(agentId, 'active');
}

/**
 * Pause agent
 */
export function pauseAgent(agentId: string): boolean {
  const agent = SWARM_AGENTS.get(agentId);
  if (!agent || agent.status !== 'running' && agent.status !== 'active') return false;
  agent.status = 'paused';
  agent.updatedAt = new Date().toISOString();
  updateDbStatus(agentId, 'paused');
  return true;
}

/**
 * Resume agent
 */
export function resumeAgent(agentId: string): boolean {
  const agent = SWARM_AGENTS.get(agentId);
  if (!agent || agent.status !== 'paused') return false;
  agent.status = 'active';
  agent.updatedAt = new Date().toISOString();
  updateDbStatus(agentId, 'active');
  return true;
}

/**
 * Terminate agent
 */
export function terminateAgent(agentId: string, graceful: boolean = true): boolean {
  const agent = SWARM_AGENTS.get(agentId);
  if (!agent) return false;

  agent.status = 'terminating';
  agent.updatedAt = new Date().toISOString();

  // 如果有子 Agent，先终止子 Agent
  if (graceful && agent.children.length > 0) {
    for (const childId of agent.children) {
      terminateAgent(childId, true);
    }
  }

  // 从父 Agent 的 children 列表中移除
  if (agent.parentId) {
    const parent = SWARM_AGENTS.get(agent.parentId);
    if (parent) {
      parent.children = parent.children.filter(id => id !== agentId);
      parent.updatedAt = new Date().toISOString();
    }
  }

  agent.status = 'terminated';
  agent.updatedAt = new Date().toISOString();
  updateDbStatus(agentId, 'terminated');
  SWARM_AGENTS.delete(agentId);
  return true;
}

function updateDbStatus(agentId: string, status: string): void {
  try {
    runSql(
      `UPDATE agent_instances SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      [status, agentId]
    );
  } catch { /* ignore */ }
}

/**
 * Get swarm overview metrics
 */
export function getSwarmOverview(): {
  total: number;
  active: number;
  running: number;
  idle: number;
  paused: number;
  terminated: number;
  totalCompleted: number;
  totalFailed: number;
} {
  const agents = Array.from(SWARM_AGENTS.values());
  return {
    total: agents.length,
    active: agents.filter(a => a.status === 'active').length,
    running: agents.filter(a => a.status === 'running').length,
    idle: agents.filter(a => a.status === 'idle').length,
    paused: agents.filter(a => a.status === 'paused').length,
    terminated: agents.filter(a => a.status === 'terminated').length,
    totalCompleted: agents.reduce((sum, a) => sum + a.metrics.tasksCompleted, 0),
    totalFailed: agents.reduce((sum, a) => sum + a.metrics.tasksFailed, 0),
  };
}
