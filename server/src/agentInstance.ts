import { randomUUID } from 'crypto';
import { queryAll, queryOne, runSql } from './db.js';

export type AgentType =
  | 'scheduler'
  | 'code_engineer'
  | 'file_manager'
  | 'search_assistant'
  | 'general_chat'
  | 'automator'
  | 'ui_operator'
  | 'researcher'
  | 'translator'
  | 'memory_admin';

export type AgentStatus = 'idle' | 'running' | 'paused' | 'stopped';

export interface AgentInstance {
  id: string;
  sessionId: string;
  type: AgentType;
  name: string;
  status: AgentStatus;
  systemPrompt: string;
  tools: string[];
  model: string;
  temperature: number;
  currentProject: string | null;
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentContextMessage {
  id: string;
  agentId: string;
  role: string;
  content: string;
  toolCalls: unknown[];
  createdAt: string;
}

export interface AgentTemplate {
  type: AgentType;
  name: string;
  systemPrompt: string;
  tools: string[];
  model: string;
  temperature: number;
}

// ---- 10 种 Agent 模板注册表 ----
export const AGENT_TEMPLATES: Record<AgentType, AgentTemplate> = {
  scheduler: {
    type: 'scheduler',
    name: '调度员',
    systemPrompt:
      '你是 Synaps 的调度员（主 Agent）。负责任务拆解、工作分配与编排：把复杂任务分解成步骤，决定由哪个子 Agent 执行，协调多 Agent 协作（team_plan/team_execute/team_test/team_review），并跟踪整体进度。\n' +
      '执行规则：\n' +
      '1. 紧急小问题（如单文件小改动）可直接用 read_file/write_file/run_command 亲自修复，不必走 team_execute。\n' +
      '2. 子 Agent（team_execute）执行失败时，你会自动获得临时执行权限（write_file/run_command，10 分钟有效），可直接修复失败步骤，修复后运行 team_test 验证，通过后权限自动回收。\n' +
      '3. 用户说“你亲自来”时，你会获得当前任务的临时执行权限（write_file/run_command/install_tool）；修复完成后主动说明权限状态。\n' +
      '4. 所有临时权限的授予与使用都会记录到审计日志；高风险命令仍需要用户确认，不要越权。\n' +
      '5. 需要外部工具时：用 search_tools 搜索 npm/GitHub 上的库 → 与用户确认后 install_tool 安装（安装后立即生效，无需重启）→ list_tools 查看已安装工具；MCP 服务器用 mcp_list_servers/mcp_list_tools/mcp_call 发现并调用外部工具。\n' +
      '执行大脑路由（从“自己干活”升级为“指挥执行大脑干活”）：\n' +
      '你现在可以调度以下执行大脑来完成复杂任务：\n' +
      '1. Codex CLI（codex_exec 工具）— 大型代码开发、多文件重构、深度代码分析（需 Termux 安装桥接；codex_status 查看状态）\n' +
      '2. DeepSeek Harness（harness_status / 现有工具）— 多步骤工具调用与开源 Agent 生态（已集成）\n' +
      '3. Agent 自带工具 — 小任务、单文件操作、命令执行（默认）\n' +
      '4. 专属大脑（brain_exec）— 代码工程师→aider/sage；文件管家→lydia；自动化→aix；记忆→miii；翻译→myai\n' +
      '路由规则：任务涉及 3 个以上文件或多文件重构/深度分析 → 调用 codex_exec 交给 Codex CLI；与专属领域强相关的任务 → 用 brain_exec 交给对应专属大脑；多步工具链 → 用 Harness 或 team_execute；其他简单任务 → 用自带工具。\n' +
      '调用 codex_exec/brain_exec 前先 codex_status/brain_status 确认桥接可用；不可用时返回清晰的 Termux 安装指引（见 docs/EXEC_BRAINS_SETUP.md），不中断任务，并降级到自带工具继续。',
    tools: ['team_plan', 'team_execute', 'team_test', 'team_review', 'team_status', 'list_dir', 'read_file', 'write_file', 'search_file', 'run_command', 'list_skills', 'read_skill', 'skill_deps', 'skill_store_search', 'run_lint', 'run_typecheck', 'analyze_code', 'auto_fix', 'run_tests', 'generate_tests', 'auto_test_fix', 'security_scan', 'security_fix', 'git_commit_push', 'project_export', 'project_import', 'search_tools', 'list_tools', 'install_tool', 'download_and_install', 'mcp_list_servers', 'mcp_list_tools', 'mcp_call', 'mcp_add_server', 'system_diagnostics', 'check_build_status', 'device_status', 'device_action', 'harness_status', 'web_search', 'trigger_build', 'agent_list', 'agent_status', 'agent_delegate', 'codex_status', 'codex_exec', 'brain_status', 'brain_exec'],
    model: 'deepseek-v4-flash',
    temperature: 0.4,
  },
  code_engineer: {
    type: 'code_engineer',
    name: '代码工程师',
    systemPrompt:
      '你是 Synaps 的代码工程师。负责具体的代码编写、修改与重构：先 read_file 理解现状，再 write_file 修改，用 run_lint/run_typecheck/run_tests 验证，失败时用 auto_fix/auto_test_fix 修复，最后可 git_commit_push 提交。保持最小改动、清晰注释。\n' +
      '执行大脑路由：简单任务（单文件修改、小 bug 修复）→ 直接用自带工具完成；复杂任务（多文件重构、大规模代码分析）→ 优先用 brain_exec 调用 Aider（brain=aider，AI 结对编程）；Aider 不可用时用 codex_exec 交给 Codex CLI；Sage（brain=sage）为本地备选。调用前先 brain_status/codex_status 检查执行大脑是否可用，不可用时自动降级到自带工具。',
    tools: ['list_dir', 'read_file', 'write_file', 'search_file', 'run_command', 'run_lint', 'run_typecheck', 'analyze_code', 'auto_fix', 'run_tests', 'generate_tests', 'auto_test_fix', 'security_scan', 'security_fix', 'git_commit_push', 'check_build_status', 'codex_status', 'codex_exec', 'brain_status', 'brain_exec'],
    model: 'deepseek-v4-flash',
    temperature: 0.3,
  },
  file_manager: {
    type: 'file_manager',
    name: '文件管理员',
    systemPrompt:
      '你是 Synaps 的文件管家。负责项目文件的浏览、检索、组织与安全分析：使用 list_dir/read_file/write_file/search_file 管理文件，用 analyze_code/security_scan 检查代码质量与安全。回答要给出清晰的文件路径。\n' +
      '专属执行大脑：Lydia（brain_exec brain=lydia）；未安装时用自带工具。',
    tools: ['list_dir', 'read_file', 'write_file', 'search_file', 'analyze_code', 'security_scan', 'project_export', 'brain_status', 'brain_exec'],
    model: 'deepseek-v4-flash',
    temperature: 0.2,
  },
  search_assistant: {
    type: 'search_assistant',
    name: '搜索助手',
    systemPrompt:
      '你是 Synaps 的搜索助手。负责查找信息与工具：用 web_search 与 DuckDuckGo MCP 联网搜索，用 search_tools 搜索 npm/GitHub 上的库，用 list_tools 查看已安装工具，用 list_skills/read_skill 查阅方法论。给出推荐时要说明理由与用法。\n' +
      '专属能力：内置 web_search + DuckDuckGo MCP（无需外部大脑）。',
    tools: ['search_tools', 'list_tools', 'install_tool', 'list_skills', 'read_skill', 'skill_deps', 'web_search', 'brain_status'],
    model: 'deepseek-v4-flash',
    temperature: 0.4,
  },
  general_chat: {
    type: 'general_chat',
    name: '通用对话',
    systemPrompt:
      '你是 Synaps 的通用对话助手。负责日常问答、概念解释、技术咨询与头脑风暴。用中文回答，简洁清晰；需要动手时才调用工具。\n' +
      '专属能力：DeepSeek 主模型直接回答（无需外部大脑）。',
    tools: ['brain_status'],
    model: 'deepseek-v4-flash',
    temperature: 0.7,
  },
  automator: {
    type: 'automator',
    name: '自动化执行者',
    systemPrompt:
      '你是 Synaps 的自动化执行者。负责执行命令、运行程序、构建与部署：用 run_command 运行测试/构建/脚本，用 trigger_build/check_build_status 管理远程构建，用 download_and_install 安装产物。执行前先说明要做什么。\n' +
      '专属执行大脑：aix（brain_exec brain=aix，40 家提供商含免费渠道）；未安装时用自带工具。',
    tools: ['run_command', 'run_lint', 'run_typecheck', 'run_tests', 'install_tool', 'trigger_build', 'check_build_status', 'download_and_install', 'git_commit_push', 'brain_status', 'brain_exec'],
    model: 'deepseek-v4-flash',
    temperature: 0.3,
  },
  ui_operator: {
    type: 'ui_operator',
    name: '界面操作员',
    systemPrompt:
      '你是 Synaps 的界面操作员。负责操作手机屏幕：用 device_status 检查设备控制状态，用 device_action 点击/滑动/截图/读取界面树/返回/打开应用。操作前先截图或读界面树，确认坐标后再动作，逐步验证。\n' +
      '专属能力：内置无障碍 device_action（无需外部大脑，浏览器自动化类方案在手机上不可靠）。',
    tools: ['device_status', 'device_action', 'list_dir', 'read_file', 'brain_status'],
    model: 'deepseek-v4-flash',
    temperature: 0.3,
  },
  researcher: {
    type: 'researcher',
    name: '调研员',
    systemPrompt:
      '你是 Synaps 的推理研究员。负责技术调研与方案对比：用 web_search 联网搜索，用 search_tools 搜索候选方案，用 list_skills/read_skill 查阅方法论，用 read_file/list_dir 分析项目现状，输出结构化的对比结论与推荐；深度推理用 deepseek-reasoner 模型，复杂实现验证交给 Aider（brain_exec brain=aider）。',
    tools: ['search_tools', 'web_search', 'list_skills', 'read_skill', 'list_dir', 'read_file', 'search_file', 'project_export', 'brain_status', 'brain_exec'],
    model: 'deepseek-v4-flash',
    temperature: 0.5,
  },
  translator: {
    type: 'translator',
    name: '翻译官',
    systemPrompt:
      '你是 Synaps 的翻译官。负责中英互译、代码注释翻译与术语校对。保持专业术语准确，保留代码格式，必要时给出逐行对照。\n' +
      '专属能力：DeepSeek 主模型直接翻译；本地可选 my-ai（brain_exec brain=myai）。',
    tools: ['brain_status', 'brain_exec'],
    model: 'deepseek-v4-flash',
    temperature: 0.3,
  },
  memory_admin: {
    type: 'memory_admin',
    name: '记忆管理员',
    systemPrompt:
      '你是 Synaps 的记忆管理员。负责管理共享上下文与记忆：用 skill_deps 检查技能依赖，用 project_export/project_import 迁移配置，维护用户的项目背景、技术栈与偏好，避免重复解释。\n' +
      '专属执行大脑：miii（brain_exec brain=miii）；未安装时用自带工具。',
    tools: ['skill_deps', 'project_export', 'project_import', 'list_skills', 'read_skill', 'list_dir', 'read_file', 'brain_status', 'brain_exec'],
    model: 'deepseek-v4-flash',
    temperature: 0.3,
  },
};

export const AGENT_TYPES = Object.keys(AGENT_TEMPLATES) as AgentType[];

// ---- 实例读取辅助 ----
function rowToInstance(row: Record<string, unknown>): AgentInstance {
  let tools: string[] = [];
  try {
    const parsed = JSON.parse(String(row.tools ?? '[]'));
    if (Array.isArray(parsed)) tools = parsed.filter((x) => typeof x === 'string');
  } catch {
    tools = [];
  }
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    type: row.agent_type as AgentType,
    name: String(row.name ?? ''),
    status: (row.status as AgentStatus) || 'idle',
    systemPrompt: String(row.system_prompt ?? ''),
    tools,
    model: String(row.model ?? 'deepseek-v4-flash'),
    temperature: typeof row.temperature === 'number' ? row.temperature : 0.7,
    currentProject: row.current_project ? String(row.current_project) : null,
    workingDirectory: row.working_directory ? String(row.working_directory) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---- AgentRegistry：模板 → 实例 ----
export function getAgentTemplate(type: AgentType): AgentTemplate {
  return AGENT_TEMPLATES[type];
}

export function createAgentInstance(
  sessionId: string,
  type: AgentType,
  overrides: Partial<Pick<AgentInstance, 'name' | 'model' | 'temperature' | 'currentProject' | 'workingDirectory'>> = {}
): AgentInstance {
  const tpl = AGENT_TEMPLATES[type];
  const id = randomUUID();
  runSql(
    `INSERT INTO agent_instances (id, session_id, agent_type, name, status, system_prompt, tools, model, temperature, current_project, working_directory)
     VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sessionId,
      type,
      overrides.name ?? tpl.name,
      tpl.systemPrompt,
      JSON.stringify(tpl.tools),
      overrides.model ?? tpl.model,
      overrides.temperature ?? tpl.temperature,
      overrides.currentProject ?? null,
      overrides.workingDirectory ?? null,
    ]
  );
  return getAgentInstance(id)!;
}

export function getOrCreateInstance(sessionId: string, type: AgentType): AgentInstance {
  const existing = queryOne(
    `SELECT * FROM agent_instances WHERE session_id = ? AND agent_type = ? AND status != 'stopped' ORDER BY created_at DESC LIMIT 1`,
    [sessionId, type]
  );
  if (existing) {
    const inst = rowToInstance(existing);
    const tpl = AGENT_TEMPLATES[type];
    if (
      tpl &&
      (JSON.stringify(inst.tools) !== JSON.stringify(tpl.tools) ||
        inst.systemPrompt !== tpl.systemPrompt ||
        inst.model !== tpl.model ||
        inst.temperature !== tpl.temperature)
    ) {
      // 模板升级后自动同步已存在实例，保证工具白名单/角色提示始终与最新模板一致
      return updateAgentInstance(inst.id, {
        tools: tpl.tools,
        systemPrompt: tpl.systemPrompt,
        model: tpl.model,
        temperature: tpl.temperature,
      }) || inst;
    }
    return inst;
  }
  return createAgentInstance(sessionId, type);
}

export function getAgentInstance(id: string): AgentInstance | null {
  const row = queryOne('SELECT * FROM agent_instances WHERE id = ?', [id]);
  return row ? rowToInstance(row) : null;
}

export function listAgentInstances(sessionId?: string): AgentInstance[] {
  const rows = sessionId
    ? queryAll('SELECT * FROM agent_instances WHERE session_id = ? ORDER BY created_at DESC', [sessionId])
    : queryAll('SELECT * FROM agent_instances ORDER BY created_at DESC');
  return rows.map(rowToInstance);
}

export function updateAgentInstance(
  id: string,
  patch: Partial<Pick<AgentInstance, 'status' | 'currentProject' | 'workingDirectory' | 'model' | 'temperature' | 'name' | 'systemPrompt' | 'tools'>>
): AgentInstance | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.currentProject !== undefined) { sets.push('current_project = ?'); params.push(patch.currentProject); }
  if (patch.workingDirectory !== undefined) { sets.push('working_directory = ?'); params.push(patch.workingDirectory); }
  if (patch.model !== undefined) { sets.push('model = ?'); params.push(patch.model); }
  if (patch.temperature !== undefined) { sets.push('temperature = ?'); params.push(patch.temperature); }
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.systemPrompt !== undefined) { sets.push('system_prompt = ?'); params.push(patch.systemPrompt); }
  if (patch.tools !== undefined) { sets.push('tools = ?'); params.push(JSON.stringify(patch.tools)); }
  if (sets.length === 0) return getAgentInstance(id);
  sets.push('updated_at = datetime(\'now\')');
  params.push(id);
  runSql(`UPDATE agent_instances SET ${sets.join(', ')} WHERE id = ?`, params);
  return getAgentInstance(id);
}

export function deleteAgentInstance(id: string): boolean {
  runSql('DELETE FROM agent_contexts WHERE agent_id = ?', [id]);
  runSql('DELETE FROM agent_instances WHERE id = ?', [id]);
  return true;
}

// ---- AgentContextManager：独立上下文 ----
export function appendAgentMessage(
  agentId: string,
  role: string,
  content: string,
  toolCalls: unknown[] = []
): AgentContextMessage {
  const id = randomUUID();
  runSql(
    `INSERT INTO agent_contexts (id, agent_id, role, content, tool_calls)
     VALUES (?, ?, ?, ?, ?)`,
    [id, agentId, role, content, JSON.stringify(toolCalls)]
  );
  return { id, agentId, role, content, toolCalls, createdAt: new Date().toISOString() };
}

export function listAgentMessages(agentId: string, limit = 100): AgentContextMessage[] {
  const rows = queryAll(
    `SELECT * FROM agent_contexts WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    [agentId, limit]
  );
  return rows.map((r) => {
    let toolCalls: unknown[] = [];
    try {
      const parsed = JSON.parse(String(r.tool_calls ?? '[]'));
      if (Array.isArray(parsed)) toolCalls = parsed;
    } catch {
      toolCalls = [];
    }
    return {
      id: String(r.id),
      agentId: String(r.agent_id),
      role: String(r.role),
      content: String(r.content),
      toolCalls,
      createdAt: String(r.created_at),
    };
  });
}

export function clearAgentContext(agentId: string): void {
  runSql('DELETE FROM agent_contexts WHERE agent_id = ?', [agentId]);
}

export function getAgentContextSummary(agentId: string): string {
  const messages = listAgentMessages(agentId);
  if (messages.length === 0) return '(空上下文)';
  const userMsgs = messages.filter((m) => m.role === 'user').slice(-5);
  const lines = userMsgs.map((m) => `- ${m.content.slice(0, 100)}`);
  return `最近用户消息 (${userMsgs.length}/${messages.length} 条消息):\n${lines.join('\n')}`;
}
