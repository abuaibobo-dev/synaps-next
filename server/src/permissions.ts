import { randomUUID } from 'crypto';
import { queryOne, runSql, saveDb } from './db.js';

export type RiskLevel = 'none' | 'medium' | 'high' | 'critical';

export interface RiskAssessment {
  level: RiskLevel;
  impact: string;
}

interface ToolCallShape {
  tool: string;
  command?: string;
  path?: string;
  query?: string;
  manager?: string;
  server?: string;
  method?: string;
}

// 极高风险：默认拒绝，不发确认弹窗
const CRITICAL_PATTERNS: RegExp[] = [
  /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\//,
  /rm\s+-rf\s+(~|\/home|\/etc|\/boot|\/var|\.\.)/,
  /mkfs\./,
  /dd\s+if=.*of=\/(dev|sd|mmc)/,
  /:\(\)\s*\{/,
  /(^|\s)(shutdown|reboot|poweroff|halt)(\s|$)/,
  /chmod\s+-R\s*777\s+\//,
  /sudo\s+rm/,
];

// 高风险：需确认（可信项目自动批准）
const HIGH_PATTERNS: RegExp[] = [
  /git\s+push/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-f/,
  /rm\s+-[rf]/,
  /(^|\s)kill(all)?(\s|$)/,
  /npm\s+publish/,
  /mv\s+/,
  /cp\s+/,
  /chmod\s+/,
  /chown\s+/,
  /curl\s+.*\|\s*(sh|bash)/,
  /wget\s+.*\|\s*(sh|bash)/,
  /drop\s+table/,
  /DELETE\s+FROM/,
  /TRUNCATE\s+/,
];

// 无风险：只读或无副作用，自动执行
const NONE_PATTERNS: RegExp[] = [
  /^(ls|pwd|cat|head|tail|echo|which|whoami|uname|date|find|grep|rg|wc|du|df|tree|free|ps)\b/,
  /^git\s+(status|log|diff|branch|rev-parse|show|remote|config|help)\b/,
  /^(node|npm|git|pnpm|yarn)\s+(-v|--version)\b/,
  /^npm\s+(test|run\s+(test|lint|typecheck|check))\b/,
];

// 中风险：修改项目状态，需确认（可信项目自动批准）
const MEDIUM_PATTERNS: RegExp[] = [
  /^git\s+(add|commit|checkout|merge|rebase|stash|tag|init)\b/,
  /^npm\s+(install|i|run|ci|audit\s+fix)\b/,
  /^npx\s/,
  /^yarn\s/,
  /^pnpm\s/,
  /^make\s/,
];

export function evaluateToolRisk(toolCall: ToolCallShape): RiskAssessment {
  switch (toolCall.tool) {
    case 'read_file':
    case 'list_dir':
    case 'search_file':
    case 'list_skills':
    case 'read_skill':
    case 'run_lint':
    case 'run_typecheck':
    case 'analyze_code':
    case 'check_build_status':
    case 'search_tools':
    case 'list_tools':
    case 'mcp_list_servers':
    case 'mcp_list_tools':
    case 'security_scan':
    case 'run_tests':
    case 'team_plan':
    case 'team_test':
    case 'team_review':
    case 'team_status':
    case 'skill_deps':
    case 'project_export':
    case 'harness_status':
    case 'device_status':
    case 'agent_list':
    case 'agent_status':
    case 'system_diagnostics':
    case 'goal_status':
    case 'rag_search':
    case 'rag_index':
    case 'rag_remember':
      return { level: 'none', impact: '只读分析操作，无副作用' };
    case 'goal_set':
      return { level: 'none', impact: `创建长期目标跟踪记录：${(toolCall as any).title || '?'}` };
    case 'goal_loop':
      return {
        level: 'medium',
        impact: `推进长期目标${(toolCall as any).milestone ? '（里程碑节点，暂停等待确认）' : '（更新目标进度）'}`,
      };
    case 'write_file':
      return {
        level: 'medium',
        impact: `修改文件：${toolCall.path || '未知路径'}（修改前自动创建快照）`,
      };
    case 'auto_fix':
      return { level: 'medium', impact: '自动修改项目文件（修改前创建快照）' };
    case 'trigger_build':
      return { level: 'medium', impact: '触发远程 GitHub Actions 构建' };
    case 'git_commit_push':
      return { level: 'high', impact: '提交并推送到远程仓库，影响远端代码' };
    case 'download_and_install':
      return { level: 'high', impact: '下载 APK 并安装到本机' };
    case 'install_tool':
      return { level: 'high', impact: `安装外部工具：${toolCall.query || '未知包'}（修改运行环境）` };
    case 'mcp_add_server':
      return { level: 'medium', impact: `注册 MCP 服务器：${toolCall.server || '未知'}（${toolCall.manager || '?'}）` };
    case 'mcp_call':
      return { level: 'medium', impact: `调用 MCP 工具：${toolCall.server || '?'}.${toolCall.method || '?'}` };
    case 'security_fix':
      return { level: 'medium', impact: `AI 自动修复安全漏洞：${toolCall.path || '整个项目'}（修改前创建快照）` };
    case 'generate_tests':
      return { level: 'medium', impact: `为文件生成测试：${toolCall.path || '?'}（写入测试文件）` };
    case 'auto_test_fix':
      return { level: 'medium', impact: `根据测试失败自动修复代码：${toolCall.path || '工作区改动文件'}（修改前创建快照）` };
    case 'team_execute':
      return { level: 'medium', impact: `工程师角色执行步骤 ${toolCall.query || '下一待办'}（批量写入文件，修改前创建快照）` };
    case 'project_import':
      return { level: 'medium', impact: '导入 AgentPack 配置（覆盖设置/技能，可信项目与 MCP 配置）' };
    case 'agent_create':
      return { level: 'medium', impact: `创建 Agent 实例：${(toolCall as any).type || '?'}` };
    case 'agent_delegate':
      return { level: 'medium', impact: `将任务委托给子 Agent：${(toolCall as any).type || '?'}（消耗一次 LLM 调用）` };
    case 'agent_clear':
      return { level: 'medium', impact: `清空 Agent 上下文：${(toolCall as any).query || (toolCall as any).params?.id || '?'}` };
    case 'agent_delete':
      return { level: 'medium', impact: `删除 Agent 实例及其上下文：${(toolCall as any).query || (toolCall as any).params?.id || '?'}` };
    case 'device_action':
      return { level: 'medium', impact: `操作手机屏幕：${(toolCall as any).type || '?'}（需无障碍服务，可信项目可自动批准）` };
    case 'harness_run':
      return { level: 'high', impact: '将任务交给 DeepSeek Harness 官方 Agent 在项目目录自主执行（可能修改代码/运行命令/推送）' };
    case 'run_command': {
      const cmd = toolCall.command || '';
      if (CRITICAL_PATTERNS.some((p) => p.test(cmd))) {
        return {
          level: 'critical',
          impact: '极高风险命令：可能破坏系统或删除重要数据，已默认拦截',
        };
      }
      if (HIGH_PATTERNS.some((p) => p.test(cmd))) {
        return {
          level: 'high',
          impact: '高风险命令：可能影响远程仓库、删除/覆盖文件或项目外资源',
        };
      }
      if (NONE_PATTERNS.some((p) => p.test(cmd))) {
        return { level: 'none', impact: '只读或无副作用操作' };
      }
      if (MEDIUM_PATTERNS.some((p) => p.test(cmd))) {
        return { level: 'medium', impact: '修改项目状态或安装依赖' };
      }
      return { level: 'medium', impact: '未识别命令，按中风险处理' };
    }
    default:
      return { level: 'medium', impact: '未知工具调用，按中风险处理' };
  }
}

export function getTrustedProjects(): string[] {
  try {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', ['trusted_projects']);
    if (!row || typeof row.value !== 'string') return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isProjectTrusted(projectId: string): boolean {
  return getTrustedProjects().includes(projectId);
}

export function setTrustedProjects(ids: string[]): void {
  runSql(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('trusted_projects', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [JSON.stringify(ids)]
  );
  saveDb();
}

export function logAudit(
  projectId: string | null,
  action: string,
  detail: string,
  riskLevel: RiskLevel,
  decision: string
): void {
  try {
    runSql(
      'INSERT INTO audit_logs (id, project_id, action, detail, risk_level, decision) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), projectId, action, detail, riskLevel, decision]
    );
    saveDb();
  } catch (err) {
    console.error('Audit log failed:', err);
  }
}
