/**
 * Swarm Coordinator
 * 借鉴 Ruflo Swarm 架构：协调多个 Agent 并行/串行工作
 * 支持 hierarchical、mesh、ring、flat 四种拓扑
 */

import { randomUUID } from 'crypto';
import { runSql } from '../db.js';
import { analyzeAndRecommend, inferCharacteristics, type Topology } from './topology.js';
import {
  spawnAgent,
  assignTask,
  completeTask,
  listAgents,
  terminateAgent,
  getSwarmOverview,
  type SwarmAgent,
} from './agentLifecycle.js';
import type { AgentType } from '../agentInstance.js';

export interface SwarmTask {
  id: string;
  swarmId: string;
  step: number;
  title: string;
  role: string;
  files: string[];
  status: 'pending' | 'assigned' | 'running' | 'done' | 'failed';
  assignedAgentId: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmSession {
  id: string;
  projectId: string;
  objective: string;
  topology: Topology;
  confidence: number;
  reasoning: string;
  tasks: SwarmTask[];
  status: 'planning' | 'executing' | 'testing' | 'reviewing' | 'completed' | 'failed';
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
}

const ACTIVE_SWARMS = new Map<string, SwarmSession>();

/**
 * Initialize a swarm for a task
 */
export function initSwarm(
  projectId: string,
  objective: string,
  projectStructure: string[] = [],
  previousFailures: number = 0,
  forceTopology?: Topology,
): SwarmSession {
  // 分析任务特征
  const chars = inferCharacteristics(objective, projectStructure, previousFailures);

  // 推荐拓扑
  const recommendation = forceTopology
    ? {
        topology: forceTopology,
        confidence: 1.0,
        reasoning: `用户指定拓扑: ${forceTopology}`,
        maxConcurrency: forceTopology === 'mesh' ? 3 : 1,
        agentRoles: ['code_engineer'],
      }
    : analyzeAndRecommend(chars);

  const swarmId = `swarm-${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  const session: SwarmSession = {
    id: swarmId,
    projectId,
    objective,
    topology: recommendation.topology,
    confidence: recommendation.confidence,
    reasoning: recommendation.reasoning,
    tasks: [],
    status: 'planning',
    agentIds: [],
    createdAt: now,
    updatedAt: now,
  };

  ACTIVE_SWARMS.set(swarmId, session);
  return session;
}

/**
 * Add tasks to swarm and spawn agents
 */
export function populateSwarm(
  swarmId: string,
  tasks: Array<{ step: number; title: string; role: string; files: string[] }>
): void {
  const swarm = ACTIVE_SWARMS.get(swarmId);
  if (!swarm) return;

  const now = new Date().toISOString();

  // 创建任务
  swarm.tasks = tasks.map(t => ({
    id: randomUUID(),
    swarmId,
    step: t.step,
    title: t.title,
    role: t.role,
    files: t.files,
    status: 'pending',
    assignedAgentId: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  }));

  // 根据拓扑决定 Agent 分配策略
  switch (swarm.topology) {
    case 'mesh':
      // 网状：为每个可并行步骤 spawn 一个 Agent
      spawnMeshAgents(swarm);
      break;
    case 'hierarchical':
      // 层级：spawn 调度员 + 工程师 + 审查员
      spawnHierarchicalAgents(swarm);
      break;
    case 'ring':
      // 环形：spawn 工程师 + 测试 + 审查（流水线）
      spawnRingAgents(swarm);
      break;
    case 'flat':
    default:
      // 扁平：spawn 单个工程师
      spawnFlatAgents(swarm);
      break;
  }

  swarm.status = 'executing';
  swarm.updatedAt = new Date().toISOString();
}

/**
 * Execute next pending task in the swarm
 */
export function executeNextTask(swarmId: string): SwarmTask | null {
  const swarm = ACTIVE_SWARMS.get(swarmId);
  if (!swarm) return null;

  const nextTask = swarm.tasks.find(t => t.status === 'pending');
  if (!nextTask) return null;

  // 找到可用 Agent
  const availableAgents = listAgents('active').filter(
    a => swarm.agentIds.includes(a.id) && !a.currentTask
  );

  if (availableAgents.length === 0) return null;

  const agent = availableAgents[0];
  assignTask(agent.id, nextTask.title);

  nextTask.status = 'running';
  nextTask.assignedAgentId = agent.id;
  nextTask.updatedAt = new Date().toISOString();

  return nextTask;
}

/**
 * Report task completion
 */
export function reportTaskResult(
  swarmId: string,
  taskId: string,
  success: boolean,
  result: string,
  responseTimeMs: number = 0
): void {
  const swarm = ACTIVE_SWARMS.get(swarmId);
  if (!swarm) return;

  const task = swarm.tasks.find(t => t.id === taskId);
  if (!task) return;

  task.status = success ? 'done' : 'failed';
  task.result = result;
  task.updatedAt = new Date().toISOString();

  if (task.assignedAgentId) {
    completeTask(task.assignedAgentId, success, responseTimeMs);
  }

  // 检查是否所有任务完成
  const allDone = swarm.tasks.every(t => t.status === 'done' || t.status === 'failed');
  const anyFailed = swarm.tasks.some(t => t.status === 'failed');

  if (allDone) {
    swarm.status = anyFailed ? 'failed' : 'completed';
    // 清理 Agent
    for (const agentId of swarm.agentIds) {
      terminateAgent(agentId, false);
    }
  }

  swarm.updatedAt = new Date().toISOString();
}

/**
 * Get swarm status
 */
export function getSwarmStatus(swarmId: string): SwarmSession | null {
  return ACTIVE_SWARMS.get(swarmId) || null;
}

/**
 * Get all active swarms
 */
export function listSwarms(projectId?: string): SwarmSession[] {
  let swarms = Array.from(ACTIVE_SWARMS.values());
  if (projectId) {
    swarms = swarms.filter(s => s.projectId === projectId);
  }
  return swarms;
}

// ---- Internal spawn helpers ----

function spawnMeshAgents(swarm: SwarmSession): void {
  // 网状拓扑：为每组可并行任务 spawn 一个工程师 Agent
  const pendingTasks = swarm.tasks.filter(t => t.status === 'pending');
  const concurrency = Math.min(pendingTasks.length, 3);

  for (let i = 0; i < concurrency; i++) {
    const agent = spawnAgent(
      'code_engineer' as AgentType,
      `Mesh-Worker-${i + 1}`,
      'mesh',
      'normal',
    );
    swarm.agentIds.push(agent.id);
  }
}

function spawnHierarchicalAgents(swarm: SwarmSession): void {
  // 层级拓扑：调度员 + 工程师 + 审查员
  const scheduler = spawnAgent('scheduler', 'Swarm-Scheduler', 'hierarchical', 'high');
  const engineer = spawnAgent('code_engineer', 'Swarm-Engineer', 'hierarchical', 'normal', scheduler.id);
  const reviewer = spawnAgent('code_engineer', 'Swarm-Reviewer', 'hierarchical', 'normal', scheduler.id);
  swarm.agentIds.push(scheduler.id, engineer.id, reviewer.id);
}

function spawnRingAgents(swarm: SwarmSession): void {
  // 环形拓扑：工程师 → 测试 → 审查（流水线）
  const engineer = spawnAgent('code_engineer', 'Ring-Engineer', 'ring', 'normal');
  const tester = spawnAgent('code_engineer', 'Ring-Tester', 'ring', 'normal');
  const reviewer = spawnAgent('code_engineer', 'Ring-Reviewer', 'ring', 'normal');
  swarm.agentIds.push(engineer.id, tester.id, reviewer.id);
}

function spawnFlatAgents(swarm: SwarmSession): void {
  // 扁平拓扑：单个工程师
  const engineer = spawnAgent('code_engineer', 'Flat-Worker', 'flat', 'normal');
  swarm.agentIds.push(engineer.id);
}

/**
 * Persist swarm to database
 */
export function saveSwarmToDb(swarm: SwarmSession): void {
  try {
    runSql(
      `INSERT OR REPLACE INTO team_tasks (id, project_id, title, tasks_json, status, current_step, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        swarm.id,
        swarm.projectId,
        swarm.objective,
        JSON.stringify({
          topology: swarm.topology,
          confidence: swarm.confidence,
          reasoning: swarm.reasoning,
          tasks: swarm.tasks,
          agentIds: swarm.agentIds,
          status: swarm.status,
        }),
        swarm.status,
        swarm.tasks.findIndex(t => t.status === 'pending'),
      ]
    );
  } catch { /* ignore */ }
}
