import { getDb, queryOne, queryAll } from './db.js';
import { deviceControlEnabled } from './device.js';
import { harnessStatus } from './harness.js';
import { getMcpServers } from './mcp.js';
import { getCodexConfig } from './codex.js';
import { codexLocalInstalled } from './codexLocal.js';
import { cliToolInstalled } from './cliTools.js';

export type CapabilityStatus = 'ready' | 'partial' | 'unavailable';

export interface KernelCapability {
  id: string;
  name: string;
  layer: 'perception' | 'memory' | 'reflection' | 'planning' | 'orchestration' | 'execution' | 'evolution';
  status: CapabilityStatus;
  score: number;
  summary: string;
  detail: Record<string, unknown>;
  nextUpgrade: string;
}

export interface EvolutionStep {
  id: string;
  title: string;
  reason: string;
  trigger: 'automatic' | 'approval';
  expectedGain: number;
  safety: 'safe' | 'canary' | 'gated';
}

export interface CapabilityRegistry {
  version: string;
  generatedAt: string;
  readiness: number;
  layers: Array<{ id: KernelCapability['layer']; name: string; purpose: string }>;
  capabilities: KernelCapability[];
  evolution: {
    mode: 'continuous';
    policy: string[];
    steps: EvolutionStep[];
  };
  signals: Record<string, unknown>;
}

function setting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?');
  return row && typeof row.value === 'string' ? row.value : null;
}

function count(table: string): number {
  const allowed = ['projects', 'skills', 'knowledge_chunks', 'agent_memory', 'goals', 'team_tasks', 'agent_instances', 'audit_logs', 'tasks'];
  if (!allowed.includes(table)) return 0;
  const row = queryOne(`SELECT COUNT(*) AS value FROM ${table}`);
  return Number(row?.value || 0);
}

function status(score: number, unavailable = false): CapabilityStatus {
  if (unavailable) return 'unavailable';
  if (score >= 80) return 'ready';
  if (score >= 40) return 'partial';
  return 'unavailable';
}

function capability(input: Omit<KernelCapability, 'status'> & { unavailable?: boolean }): KernelCapability {
  return { ...input, status: status(input.score, input.unavailable) };
}

export async function getCapabilityRegistry(): Promise<CapabilityRegistry> {
  await getDb();

  const codexCfg = getCodexConfig();
  const codexReady = codexCfg.enabled && (!codexCfg.builtin || codexLocalInstalled());
  const githubToken = setting('github_token');
  const mcpServers = getMcpServers();
  const enabledMcpServers = mcpServers.length;
  const deviceEnabled = deviceControlEnabled();
  const harness = harnessStatus() as Record<string, unknown>;
  const projects = count('projects');
  const skills = count('skills');
  const memories = count('agent_memory') + count('knowledge_chunks');
  const goals = count('goals');
  const tasks = count('tasks');
  const cliToolsInstalled = Number(cliToolInstalled('aichat')) + Number(cliToolInstalled('mods'));

  const capabilities: KernelCapability[] = [
    capability({
      id: 'model-routing',
      name: '模型路由',
      layer: 'orchestration',
      score: setting('ai_api_key') ? 82 : 0,
      summary: setting('ai_api_key') ? '云端 DeepSeek 路由已配置。' : '未配置云端模型。',
      detail: { cloudConfigured: !!setting('ai_api_key') },
      nextUpgrade: setting('ai_api_key') ? '加入任务复杂度评分与成本感知路由。' : '配置 AI API Key。',
    }),
    capability({
      id: 'codex-execution',
      name: 'Codex 执行大脑',
      layer: 'execution',
      score: codexReady ? 90 : codexCfg.enabled ? 45 : 0,
      summary: codexReady ? '可把代码修改、构建和项目级任务交给 Codex CLI。' : 'Codex 引擎未启用或未下载。',
      detail: { enabled: codexCfg.enabled, builtin: codexCfg.builtin, builtinInstalled: codexLocalInstalled(), engineVersion: codexCfg.enabled ? '0.147.0' : null },
      nextUpgrade: codexReady ? '增加执行前风险评分与自动回滚快照。' : '在设置页下载内置 Codex 引擎。',
    }),
    capability({
      id: 'cli-tools',
      name: '免登录 CLI 工具',
      layer: 'execution',
      score: cliToolsInstalled >= 2 ? 88 : cliToolsInstalled === 1 ? 68 : 35,
      summary: cliToolsInstalled > 0 ? `${cliToolsInstalled} 个静态 AI CLI 已就绪。` : 'AIChat 和 Mods 可在设置页一键安装。',
      detail: { installed: cliToolsInstalled, total: 2 },
      nextUpgrade: cliToolsInstalled >= 2 ? '为 CLI 工具增加任务模板与耗时统计。' : '在设置页安装剩余免登录 CLI 工具。',
    }),
    capability({
      id: 'project-memory',
      name: '项目长期记忆',
      layer: 'memory',
      score: Math.min(95, memories > 0 ? 70 + Math.min(25, Math.log2(memories + 1) * 6) : projects > 0 ? 35 : 10),
      summary: memories > 0 ? '已有知识与失败经验记忆，可用于后续任务召回。' : '还没有足够项目记忆。',
      detail: { knowledgeChunks: count('knowledge_chunks'), agentMemories: count('agent_memory'), projects },
      nextUpgrade: '每次任务结束自动抽取架构决策、用户偏好、失败方案和复用片段。',
    }),
    capability({
      id: 'reflection-loop',
      name: '反思与自我修正',
      layer: 'reflection',
      score: count('audit_logs') > 0 ? 68 : 42,
      summary: '记录执行审计和失败分析，但还缺少统一评分器与自动重试策略。',
      detail: { auditLogs: count('audit_logs'), tasks, failureLearning: true },
      nextUpgrade: '为每个结果生成质量评分；低于阈值时自动生成修复假设并重试。',
    }),
    capability({
      id: 'goal-planning',
      name: '目标规划',
      layer: 'planning',
      score: Math.min(90, goals > 0 ? 65 + Math.min(25, goals * 4) : 48),
      summary: goals > 0 ? '目标已拆解并可跟踪里程碑。' : '规划器可用，但还没有长期目标样本。',
      detail: { goals, teamTasks: count('team_tasks') },
      nextUpgrade: '引入 DAG 依赖图、关键路径、并行度和资源预算。',
    }),
    capability({
      id: 'swarm-orchestration',
      name: '多 Agent 调度',
      layer: 'orchestration',
      score: count('agent_instances') > 0 ? 74 : 52,
      summary: '支持层级、网状、流水线等拓扑，但主动调度还偏保守。',
      detail: { agentInstances: count('agent_instances'), topologies: ['hierarchical', 'mesh', 'ring', 'flat'] },
      nextUpgrade: '根据历史成功率动态选择 Agent 和并行度。',
    }),
    capability({
      id: 'skill-evolution',
      name: '技能进化',
      layer: 'evolution',
      score: skills > 0 ? 78 : 40,
      summary: skills > 0 ? `技能库有 ${skills} 个条目，可继续接入自动评估与灰度升级。` : '技能库为空。',
      detail: { skills },
      nextUpgrade: '每个技能加测试样例；更新后先进入测试通道，连续通过才转正。',
    }),
    capability({
      id: 'proactive-assistant',
      name: '主动建议',
      layer: 'reflection',
      score: 58,
      summary: '已有后台循环基础，但缺少统一的主动建议队列与降噪策略。',
      detail: { triggers: ['goal_stall', 'test_failure', 'release_ready', 'memory_conflict'], quietHours: false },
      nextUpgrade: '建立建议优先级、冷却时间、用户反馈学习和免打扰窗口。',
    }),
    capability({
      id: 'mcp-tools',
      name: '外部工具协议',
      layer: 'execution',
      score: enabledMcpServers > 0 ? 85 : 50,
      summary: enabledMcpServers > 0 ? `${enabledMcpServers} 个 MCP 服务已配置。` : 'MCP 协议可用，但没有启用服务。',
      detail: { servers: mcpServers.length, enabled: enabledMcpServers },
      nextUpgrade: '为工具添加 schema 校验、耗时统计、失败率和自动禁用。',
    }),
    capability({
      id: 'device-control',
      name: '设备控制',
      layer: 'perception',
      score: deviceEnabled ? 82 : 20,
      summary: deviceEnabled ? '设备动作通道已开启。' : '设备控制未开启。',
      detail: { enabled: deviceEnabled },
      nextUpgrade: '增加屏幕语义理解、操作回放和异常检测。',
      unavailable: !deviceEnabled,
    }),
    capability({
      id: 'delivery-pipeline',
      name: '交付流水线',
      layer: 'execution',
      score: githubToken ? 88 : 35,
      summary: githubToken ? 'GitHub Token 已配置，可推送、打 tag 并触发 APK 构建。' : '未配置 GitHub Token，只能本地交付。',
      detail: { githubToken: !!githubToken, build: 'GitHub Actions' },
      nextUpgrade: '发布前自动运行冒烟测试、包体检查和版本变更摘要。',
    }),
    capability({
      id: 'harness-upgrade',
      name: 'Harness 升级通道',
      layer: 'evolution',
      score: harness.enabled && harness.apiKeyConfigured ? 80 : harness.nodeSatisfied ? 55 : 30,
      summary: harness.enabled ? 'Harness 已启用，可用于外部执行与升级验证。' : 'Harness 未启用。',
      detail: harness,
      nextUpgrade: '将 Node、引擎、技能和提示词升级全部纳入灰度通道。',
    }),
  ];

  const readiness = Math.round(capabilities.reduce((sum, item) => sum + item.score, 0) / capabilities.length);
  const byId = new Map(capabilities.map(item => [item.id, item]));

  const steps: EvolutionStep[] = [];
  if (cliToolsInstalled < 2) {
    steps.push({ id: 'install-cli-tools', title: '补齐免登录 CLI 工具', reason: '静态 AIChat/Mods 可以增强命令行执行能力。', trigger: 'approval', expectedGain: 6, safety: 'canary' });
  }
  if ((byId.get('project-memory')?.score || 0) < 85) {
    steps.push({ id: 'memory-distillation', title: '启用任务结束记忆蒸馏', reason: '从成功和失败任务中提取长期可复用知识。', trigger: 'automatic', expectedGain: 7, safety: 'canary' });
  }
  if ((byId.get('reflection-loop')?.score || 0) < 85) {
    steps.push({ id: 'quality-scorer', title: '加入结果质量评分器', reason: '让系统能判断回答是否真的完成目标。', trigger: 'automatic', expectedGain: 9, safety: 'canary' });
  }
  if ((byId.get('goal-planning')?.score || 0) < 85) {
    steps.push({ id: 'dag-planner', title: '升级为依赖图规划器', reason: '支持并行子任务、阻塞检测和关键路径优化。', trigger: 'approval', expectedGain: 12, safety: 'gated' });
  }
  if (!githubToken) {
    steps.push({ id: 'configure-github', title: '配置 GitHub Token', reason: '解锁自动推送、tag 构建和 APK 发布。', trigger: 'approval', expectedGain: 6, safety: 'gated' });
  }
  if (steps.length === 0) {
    steps.push({ id: 'benchmark-suite', title: '运行长期基准测试', reason: '用固定任务集寻找下一处瓶颈。', trigger: 'automatic', expectedGain: 5, safety: 'safe' });
  }

  return {
    version: 'kernel-v1',
    generatedAt: new Date().toISOString(),
    readiness,
    layers: [
      { id: 'perception', name: '感知层', purpose: '读取项目、文件、设备、截图和用户意图。' },
      { id: 'memory', name: '记忆层', purpose: '保存事实、偏好、失败经验和项目上下文。' },
      { id: 'reflection', name: '反思层', purpose: '评分结果、分析失败、提出修正假设。' },
      { id: 'planning', name: '规划层', purpose: '拆解目标、识别依赖、估算风险和成本。' },
      { id: 'orchestration', name: '调度层', purpose: '选择模型、Agent、工具和并行策略。' },
      { id: 'execution', name: '执行层', purpose: '安全修改文件、运行命令、调用设备和交付结果。' },
      { id: 'evolution', name: '进化层', purpose: '灰度升级技能、提示词、模型路由和执行器。' },
    ],
    capabilities,
    evolution: {
      mode: 'continuous',
      policy: [
        '技能与提示词：自动进入测试通道，连续通过后转正。',
        '模型路由：先小流量试新策略，指标下降自动回滚。',
        '核心引擎：只接受签名版本，升级前必须创建快照。',
        '危险动作：写文件、删文件、发版、设备控制必须审批或符合白名单。',
        '每次升级保留旧版本，可在 5 分钟内一键回滚。',
      ],
      steps,
    },
    signals: {
      cloudConfigured: !!setting('ai_api_key'),
      codexReady,
      githubToken: !!githubToken,
      mcpServers: mcpServers.length,
      enabledMcpServers,
      deviceEnabled,
      projects,
      skills,
      memories,
      goals,
      tasks,
      queryAllAvailable: queryAll('SELECT 1 AS ok').length > 0,
    },
  };
}
