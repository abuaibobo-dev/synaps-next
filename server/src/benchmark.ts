import { getDb, queryAll, queryOne } from './db.js';
import { getCapabilityRegistry } from './capabilityKernel.js';

export interface BenchmarkDimension {
  id: string;
  name: string;
  score: number;
  weight: number;
  evidence: Record<string, unknown>;
  bottleneck: string | null;
  nextAction: string;
}

export interface BenchmarkReport {
  generatedAt: string;
  score: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  dimensions: BenchmarkDimension[];
  bottlenecks: string[];
  nextSteps: string[];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function tableExists(name: string): boolean {
  const row = queryOne("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
  return !!row;
}

function count(table: string, where = '', params: unknown[] = []): number {
  if (!tableExists(table)) return 0;
  const row = queryOne(`SELECT COUNT(*) AS value FROM ${table} ${where}`, params);
  return Number(row?.value || 0);
}

function grade(score: number): BenchmarkReport['grade'] {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

export async function getBenchmarkReport(): Promise<BenchmarkReport> {
  await getDb();
  const registry = await getCapabilityRegistry();
  const capabilityScore = (id: string, fallback = 0) =>
    registry.capabilities.find(item => item.id === id)?.score ?? fallback;

  const projectRows = queryAll('SELECT id FROM projects');
  const totalProjects = projectRows.length;
  const indexedProjects = new Set(
    queryAll("SELECT DISTINCT project_id FROM knowledge_chunks WHERE doc_type IN ('file', 'chat')")
      .map(row => String(row.project_id || ''))
      .filter(Boolean)
  ).size;
  const coverage = totalProjects ? indexedProjects / totalProjects : 0;
  const knowledgeTotal = count('knowledge_chunks');
  const knowledgeEmbedded = count('knowledge_chunks', "WHERE embedding != ''");
  const memoryCoverage = clamp((coverage * 55) + (knowledgeTotal ? (knowledgeEmbedded / knowledgeTotal) * 45 : 0));

  const learningRows = tableExists('agent_memory')
    ? queryAll("SELECT value FROM agent_memory WHERE namespace = 'task_learning' ORDER BY created_at DESC LIMIT 50")
    : [];
  const learningScores: number[] = [];
  for (const row of learningRows) {
    try {
      const parsed = JSON.parse(String(row.value || '{}')) as { quality?: unknown };
      if (typeof parsed.quality === 'number') learningScores.push(parsed.quality);
    } catch {}
  }
  const learningQuality = learningScores.length
    ? learningScores.reduce((sum, item) => sum + item, 0) / learningScores.length
    : 0;

  const dagPlans = tableExists('dag_plans')
    ? queryAll('SELECT status, max_parallel, graph_json FROM dag_plans ORDER BY updated_at DESC LIMIT 30')
    : [];
  const completedDags = dagPlans.filter(plan => plan.status === 'completed').length;
  const maxParallelValues = dagPlans.map(plan => Number(plan.max_parallel || 0));
  const dagScore = clamp(
    (dagPlans.length ? (completedDags / dagPlans.length) * 70 + 10 : 25) +
      Math.min(15, Math.max(...maxParallelValues, 0) * 3)
  );

  const suggestions = tableExists('proactive_suggestions')
    ? queryAll('SELECT status FROM proactive_suggestions')
    : [];
  const accepted = suggestions.filter(item => item.status === 'accepted').length;
  const dismissed = suggestions.filter(item => item.status === 'dismissed').length;
  const suggestionHealth = suggestions.length
    ? clamp(45 + ((accepted - dismissed * 0.5) / suggestions.length) * 100)
    : 42;

  const auditLogs = count('audit_logs');
  const approvedRisky = count('audit_logs', "WHERE risk_level IN ('medium','high','critical') AND decision = 'approved'");
  const securityScore = clamp(52 + Math.min(24, auditLogs * 2) + Math.min(24, approvedRisky * 6));

  const raw: Array<Omit<BenchmarkDimension, 'score'> & { score: number }> = [
    {
      id: 'model-routing',
      name: '模型路由',
      weight: 18,
      score: capabilityScore('model-routing'),
      evidence: registry.signals,
      bottleneck: registry.signals.ollamaReady ? null : '本地 Ollama 不可用，云端兜底会增加成本和延迟。',
      nextAction: registry.signals.ollamaReady ? '增加任务复杂度评分与成本感知路由。' : '恢复 Ollama 或配置可用云端 Key。',
    },
    {
      id: 'codex-execution',
      name: 'Codex 执行',
      weight: 14,
      score: capabilityScore('codex-execution'),
      evidence: { codexReady: registry.signals.codexReady },
      bottleneck: registry.signals.codexReady ? null : 'Codex 引擎不可用，项目级代码交付能力受限。',
      nextAction: registry.signals.codexReady ? '加入风险评分、快照回滚与执行时长基线。' : '下载并启用内置 Codex 引擎。',
    },
    {
      id: 'project-memory',
      name: '项目记忆覆盖',
      weight: 16,
      score: memoryCoverage,
      evidence: { projects: totalProjects, indexedProjects, knowledgeTotal, knowledgeEmbedded },
      bottleneck: memoryCoverage >= 80 ? null : '仍有项目文件或对话历史没有进入可检索记忆。',
      nextAction: '对活跃项目执行记忆索引，并开启任务后自动学习。',
    },
    {
      id: 'learning-quality',
      name: '经验质量',
      weight: 12,
      score: learningQuality,
      evidence: { samples: learningScores.length, averageQuality: Math.round(learningQuality) },
      bottleneck: learningScores.length >= 5 ? null : '学习样本不足，还无法稳定判断哪些路径值得复用。',
      nextAction: '完成更多带验证结果的任务，让失败与成功都进入记忆。',
    },
    {
      id: 'parallel-dag',
      name: '并行调度',
      weight: 14,
      score: dagScore,
      evidence: { plans: dagPlans.length, completed: completedDags, maxParallelObserved: Math.max(0, ...maxParallelValues) },
      bottleneck: dagPlans.length ? null : '尚无 DAG 执行样本，无法验证依赖编排稳定性。',
      nextAction: '把多步骤开发任务拆成 DAG，观察并行节点成功率。',
    },
    {
      id: 'proactive-health',
      name: '主动建议健康度',
      weight: 8,
      score: suggestionHealth,
      evidence: { total: suggestions.length, accepted, dismissed },
      bottleneck: accepted > 0 ? null : '建议尚未被用户采纳，优先级或相关性需要校准。',
      nextAction: '根据采纳率压缩低价值建议，并为高频场景建立冷却窗口。',
    },
    {
      id: 'delivery-pipeline',
      name: '交付流水线',
      weight: 10,
      score: clamp(capabilityScore('mcp-tools') * 0.35 + (registry.signals.githubToken ? 65 : 20)),
      evidence: { githubToken: registry.signals.githubToken, mcpServers: registry.signals.enabledMcpServers },
      bottleneck: registry.signals.githubToken ? null : 'GitHub Token 未配置，自动发版链路不完整。',
      nextAction: '配置 GitHub Token 并保持构建、发布、资产校验一体化。',
    },
    {
      id: 'security-audit',
      name: '安全审计',
      weight: 8,
      score: securityScore,
      evidence: { auditLogs, approvedRisky },
      bottleneck: auditLogs > 0 ? null : '审计记录不足，无法证明高风险动作可控。',
      nextAction: '继续保留写文件、命令、发版和设备动作的完整审计链。',
    },
  ];

  const dimensions: BenchmarkDimension[] = raw.map(({ ...item }) => ({ ...item, score: clamp(item.score) }));
  const totalWeight = dimensions.reduce((sum, item) => sum + item.weight, 0);
  const score = clamp(dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight);
  const bottlenecks = dimensions
    .filter(item => item.bottleneck)
    .sort((a, b) => (a.score * a.weight) - (b.score * b.weight))
    .slice(0, 4)
    .map(item => `${item.name}：${item.bottleneck}`);
  const nextSteps = dimensions
    .slice()
    .sort((a, b) => (a.score * a.weight) - (b.score * b.weight))
    .slice(0, 4)
    .map(item => `${item.name}：${item.nextAction}`);

  return {
    generatedAt: new Date().toISOString(),
    score,
    grade: grade(score),
    dimensions,
    bottlenecks,
    nextSteps,
  };
}
