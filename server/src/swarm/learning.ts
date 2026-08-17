/**
 * Learning Loop
 * 借鉴 Ruflo SONA (Self-Organizing Neural Architecture)
 * 从每次任务执行的成功/失败中学习，自动优化后续决策
 */

import { runSql, queryAll, queryOne } from '../db.js';

export interface LearningRecord {
  id: string;
  projectId: string;
  taskType: string;          // 任务类型（重构、新功能、bug修复等）
  topology: string;          // 使用的拓扑
  success: boolean;
  factors: {
    complexity: number;
    fileCount: number;
    steps: number;
    responseTimeMs: number;
    retryCount: number;
    toolsUsed: string[];
  };
  insight: string;           // 学到的经验
  createdAt: string;
}

export interface OptimizationSuggestion {
  type: 'topology' | 'tool' | 'agent' | 'timeout';
  suggestion: string;
  confidence: number;
  basedOn: number; // 基于多少条记录
}

/**
 * 记录一次任务执行结果
 */
export function recordExecution(
  projectId: string,
  taskType: string,
  topology: string,
  success: boolean,
  factors: LearningRecord['factors'],
  insight: string = ''
): void {
  const id = `lrn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  try {
    runSql(
      `INSERT INTO agent_memory (id, project_id, namespace, key, value, embedding_text, created_at)
       VALUES (?, ?, 'learning', ?, ?, ?, ?)`,
      [
        id,
        projectId,
        `exec:${taskType}:${topology}:${success ? 'ok' : 'fail'}`,
        JSON.stringify({ topology, success, factors, insight }),
        `${taskType} ${topology} ${success ? '成功' : '失败'}: ${insight}`,
        now,
      ]
    );
  } catch { /* ignore */ }
}

/**
 * 分析历史记录，给出优化建议
 */
export function analyzeAndSuggest(projectId?: string): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];
  const namespace = 'learning';

  let records: Record<string, unknown>[];
  if (projectId) {
    records = queryAll(
      `SELECT value FROM agent_memory WHERE project_id = ? AND namespace = ? ORDER BY created_at DESC LIMIT 50`,
      [projectId, namespace]
    );
  } else {
    records = queryAll(
      `SELECT value FROM agent_memory WHERE namespace = ? ORDER BY created_at DESC LIMIT 50`,
      [namespace]
    );
  }

  if (records.length === 0) return suggestions;

  // 分析拓扑成功率
  const topologyStats = new Map<string, { success: number; total: number }>();
  for (const r of records) {
    try {
      const data = JSON.parse(String(r.value || ''));
      const stats = topologyStats.get(data.topology) || { success: 0, total: 0 };
      stats.total++;
      if (data.success) stats.success++;
      topologyStats.set(data.topology, stats);
    } catch { /* ignore */ }
  }

  // 找出最佳拓扑
  let bestTopology = 'flat';
  let bestRate = 0;
  for (const [topo, stats] of topologyStats) {
    const rate = stats.success / stats.total;
    if (rate > bestRate && stats.total >= 3) {
      bestRate = rate;
      bestTopology = topo;
    }
  }

  if (bestRate > 0.8) {
    suggestions.push({
      type: 'topology',
      suggestion: `基于 ${Math.round(bestRate * 100)}% 的成功率，推荐使用「${bestTopology}」拓扑`,
      confidence: bestRate,
      basedOn: topologyStats.get(bestTopology)?.total || 0,
    });
  }

  // 分析失败原因
  const failureRecords = records.filter(r => {
    try { return !JSON.parse(String(r.value || '')).success; } catch { return false; }
  });

  if (failureRecords.length >= 3) {
    const avgRetries = failureRecords.reduce((sum, r) => {
      try { return sum + (JSON.parse(String(r.value || '')).factors?.retryCount || 0); } catch { return sum; }
    }, 0) / failureRecords.length;

    if (avgRetries > 2) {
      suggestions.push({
        type: 'timeout',
        suggestion: `平均重试 ${avgRetries.toFixed(1)} 次，建议增加超时时间或简化任务拆分`,
        confidence: 0.7,
        basedOn: failureRecords.length,
      });
    }
  }

  // 分析工具使用频率
  const toolUsage = new Map<string, number>();
  for (const r of records) {
    try {
      const data = JSON.parse(String(r.value || ''));
      if (data.factors?.toolsUsed) {
        for (const tool of data.factors.toolsUsed) {
          toolUsage.set(tool, (toolUsage.get(tool) || 0) + 1);
        }
      }
    } catch { /* ignore */ }
  }

  const topTools = Array.from(toolUsage.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topTools.length > 0) {
    suggestions.push({
      type: 'tool',
      suggestion: `最常用工具: ${topTools.map(([t, c]) => `${t}(${c})`).join(', ')}`,
      confidence: 0.9,
      basedOn: records.length,
    });
  }

  return suggestions;
}

/**
 * 获取学习统计
 */
export function getLearningStats(projectId?: string): {
  totalExecutions: number;
  successRate: number;
  avgResponseTime: number;
  topologies: Record<string, { success: number; total: number }>;
  recentInsights: string[];
} {
  const namespace = 'learning';
  const records = projectId
    ? queryAll(`SELECT value FROM agent_memory WHERE project_id = ? AND namespace = ? ORDER BY created_at DESC LIMIT 100`, [projectId, namespace])
    : queryAll(`SELECT value FROM agent_memory WHERE namespace = ? ORDER BY created_at DESC LIMIT 100`, [namespace]);

  let totalExecutions = 0;
  let successCount = 0;
  let totalResponseTime = 0;
  const topologies: Record<string, { success: number; total: number }> = {};
  const recentInsights: string[] = [];

  for (const r of records) {
    try {
      const data = JSON.parse(String(r.value || ''));
      totalExecutions++;
      if (data.success) successCount++;
      totalResponseTime += data.factors?.responseTimeMs || 0;

      const topo = data.topology || 'unknown';
      if (!topologies[topo]) topologies[topo] = { success: 0, total: 0 };
      topologies[topo].total++;
      if (data.success) topologies[topo].success++;

      if (data.insight && recentInsights.length < 5) {
        recentInsights.push(data.insight);
      }
    } catch { /* ignore */ }
  }

  return {
    totalExecutions,
    successRate: totalExecutions > 0 ? successCount / totalExecutions : 0,
    avgResponseTime: totalExecutions > 0 ? totalResponseTime / totalExecutions : 0,
    topologies,
    recentInsights,
  };
}
