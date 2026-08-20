import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { getDb, queryAll, queryOne, runSql, saveDb } from '../db.js';
import { evaluateToolRisk, isProjectTrusted, logAudit, getTrustedProjects, setTrustedProjects, type RiskAssessment } from '../permissions.js';
import { getMcpServers, setMcpServers, mcpListTools, mcpCallTool } from '../mcp.js';
import { scanProject, scanFile, formatIssues, type SecurityIssue } from '../security.js';
import { runProcess, isAndroidRuntime } from '../nativeProc.js';
import { runHarnessTask, harnessStatus } from '../harness.js';
import { generateDiagramSVG, type DiagramNode, type DiagramEdge } from '../diagram.js';
import { runSpecKit, specKitStatus } from '../specKit.js';
import { runCodexTask, runBrainTask, BRAIN_IDS, codexStatus, checkCodexBridge } from '../codex.js';
import { codexLocalInstalled } from '../codexLocal.js';
import { searchStoreSkills, installStoreSkill, markSkillUsed, rememberTurnSkill, noteTurnSkillFailures } from '../skillStore.js';
import {
  deviceControlEnabled,
  enqueueDeviceAction,
  getDeviceAction,
  deviceStatusSummary,
  type DeviceActionType,
} from '../device.js';
import { isFailureResult, analyzeFailure } from '../failureAnalysis.js';
import { getSharedContext, mergeSharedContext, sharedContextToText } from '../context.js';
import { runDiagnostics, diagnosticsToText } from '../diagnostics.js';
import { isOllamaAvailable, callOllama, detectIntent, OLLAMA_MODELS } from '../ollama.js';
import { indexProjectFiles, indexChatHistory, rememberNote, searchKnowledge, ensureKnowledgeTable, rememberMemory, recallMemories } from '../rag.js';
import {
  createTask,
  saveTaskProgress,
  finishTask,
  taskFilesFromTools,
  type TaskStepRecord,
  type TaskToolRecord,
} from '../taskStore.js';
import {
  getAgentTemplate,
  createAgentInstance,
  getOrCreateInstance,
  getAgentInstance,
  listAgentInstances,
  updateAgentInstance,
  deleteAgentInstance,
  getAgentContextSummary,
  clearAgentContext,
  appendAgentMessage,
  listAgentMessages,
  AGENT_TYPES,
  type AgentType,
} from '../agentInstance.js';
import {
  getStoryBible, createNovelProject, updateStoryBible, ensureNovelTables,
  assembleNovelContext, novelContextToSystemPrompt,
  addChapter, updateChapterSummary, getRecentChapters, getChapterByNumber,
  upsertCharacter, getCharacters, getActiveCharacters, recordCharacterDiff,
  addForeshadowing, advanceForeshadowing, getActiveForeshadowing, getAllForeshadowing,
  addPartSummary, addVolumeSummary, createMemorySnapshot, getLatestSnapshot,
  processPostWrite,
  toolGetNovelContext, toolCreateCharacter, toolUpdateCharacter,
  toolListCharacters, toolAddForeshadowing, toolListForeshadowing, toolSnapshot,
} from '../novelMemory.js';

const router = express.Router();

// 任务取消注册表：requestId -> 是否请求取消（agent 循环在步骤间检查）
const abortRegistry = new Map<string, boolean>();

// SSE 连接错误兜底：客户端断开后 write 抛错会触发 res 'error' 事件，挂一个空监听防止进程崩溃
const sseErrorGuarded = new WeakSet<express.Response>();
function guardSseErrors(res: express.Response): void {
  if (sseErrorGuarded.has(res)) return;
  sseErrorGuarded.add(res);
  res.on('error', () => {});
}

// 工具执行期间（executeTool / 失败诊断，可能阻塞 30-180s）持续发送心跳，
// 保证前端看门狗不会误判超时；同时响应取消请求。
async function withToolHeartbeat<T>(
  res: express.Response,
  taskId: string,
  fn: () => Promise<T>
): Promise<T> {
  guardSseErrors(res);
  let heartbeat: NodeJS.Timeout | null = null;
  heartbeat = setInterval(() => {
    try {
      if (abortRegistry.get(taskId)) {
        if (heartbeat) clearInterval(heartbeat);
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
      }
    } catch {
      // SSE 已关闭，忽略
    }
  }, 15_000);
  try {
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

// ---- 调度员临时执行权限（内存态，重启即清；到期/修复完成自动回收） ----
interface TempGrant {
  tools: string[];
  reason: string;
  source: string;
  grantedAt: number;
  expiresAt: number;
}

const tempPermissionRegistry = new Map<string, TempGrant[]>();
const TEMP_PERM_TTL_MS = 10 * 60 * 1000; // 10 分钟
const SCHEDULER_TEMP_TOOLS = ['write_file', 'run_command'];
const SCHEDULER_TEMP_TOOLS_FULL = ['write_file', 'run_command', 'install_tool'];

function getTempGrants(sessionId: string): TempGrant[] {
  const now = Date.now();
  const all = tempPermissionRegistry.get(sessionId) || [];
  const fresh = all.filter((g) => g.expiresAt > now);
  if (fresh.length === 0) tempPermissionRegistry.delete(sessionId);
  else if (fresh.length !== all.length) tempPermissionRegistry.set(sessionId, fresh);
  return fresh;
}

function hasTempPermission(sessionId: string, tool: string): TempGrant | null {
  return getTempGrants(sessionId).find((g) => g.tools.includes(tool)) || null;
}

function grantSchedulerTempPerms(
  projectId: string | null,
  sessionId: string,
  tools: string[],
  reason: string,
  source: 'auto' | 'user_request'
): void {
  const now = Date.now();
  const grants = getTempGrants(sessionId).filter((g) => !tools.some((t) => g.tools.includes(t)));
  grants.push({ tools, reason, source, grantedAt: now, expiresAt: now + TEMP_PERM_TTL_MS });
  tempPermissionRegistry.set(sessionId, grants);
  logAudit(projectId, 'temp_permission_grant', `${reason}（tools: ${tools.join(', ')}，有效期 10 分钟）`, 'medium', source);
}

function revokeSchedulerTempPerms(projectId: string | null, sessionId: string, reason: string): void {
  const revoked = getTempGrants(sessionId);
  if (revoked.length === 0) return;
  tempPermissionRegistry.delete(sessionId);
  const tools = [...new Set(revoked.flatMap((g) => g.tools))];
  logAudit(projectId, 'temp_permission_revoke', `${reason}（tools: ${tools.join(', ')}）`, 'medium', 'auto');
}

const URGENT_FIX_PATTERNS: RegExp[] = [
  /(你|请|帮我)?直接(改|修|删|加|执行|处理)/,
  /(你|帮我|请)改/,
  /改(一下|一行|成|为|一个|这个|那个|颜色|文案|名字|标题|内容)/,
  /(修|修复)(一下|这个|好|bug|Bug|BUG|问题|错误|报错)/,
  /删(掉|除|了|一行|个)/,
  /加(一行|个|一个|上|一条|个按钮)/,
  /把.+改成/,
];

function isUrgentFixRequest(content: string): boolean {
  return URGENT_FIX_PATTERNS.some((p) => p.test(content));
}

// Enhanced Agent system prompt with better intelligence
const AGENT_SYSTEM_PROMPT = `You are 妙笔 (MiaoBi), an AI writing and development agent running on a mobile phone.
You help users develop, debug, build, and publish software through natural language.

## Your Capabilities
You have access to tools that let you interact with the project files:
- list_dir: List files in a directory
- read_file: Read file contents
- write_file: Create or modify files
- search_file: Search for files by name
- list_skills: List available skills (methodologies/guides)
- read_skill: Read a skill's full content by name
- skill_store_search: Search the CocoLoop skill store (170k+ free skills) by keyword and AUTO-INSTALL the best match, then call read_skill to load it. Args: query (关键词，如 "小红书运营"), install (false 时只列结果不安装；默认自动安装). Fully automatic, no user confirmation needed. Auto-installed skills enter a 3-day testing channel and promote to stable automatically if no issues.
- run_command: Execute a shell command in the project directory (e.g. npm test, git status, git diff, git log, ls -la). Include the exact command string in the "command" field.
- run_lint: Run lint checks in the project; returns a list of errors
- run_typecheck: Run type checking; returns a list of errors
- analyze_code: Analyze code quality; returns issues with severity ([HIGH]/[MEDIUM]/[LOW])
- auto_fix: Apply automatic fixes for lint/typecheck issues (creates a snapshot before changing files)
- git_commit_push: Stage, commit and push all current changes (args: message optional; high risk, requires confirmation)
- trigger_build: Trigger a GitHub Actions build (args: repo "owner/name", ref optional, workflowId optional)
- check_build_status: Query the latest GitHub Actions runs (args: repo "owner/name" optional, inferred from git remote)
- download_and_install: Download an APK and install it on this phone (args: url; high risk, requires confirmation)
- search_tools: Search for external tools/packages (npm registry and GitHub). Args: query
- web_search: Search the web via DuckDuckGo (no API key needed). Args: query. Returns up to 6 results (title + url + snippet). Use when you need real-time or external information.
- install_tool: Install an external tool/package (npm global or pip). Args: query (package/tool name), manager ("npm" | "pip" | "auto"). High risk, requires confirmation. The tool is available immediately after install, no restart needed.
- list_tools: List tools previously installed through install_tool
- mcp_list_servers: List configured MCP servers (from Settings)
- mcp_add_server: Register an MCP server (args: server "name", manager "stdio"|"sse", command for stdio, url for sse, params.args for stdio command args). Medium risk, requires confirmation.
- mcp_list_tools: List tools exposed by an MCP server (args: server "name")
- mcp_call: Call a tool on an MCP server (args: server "name", method "tool name", params object with the tool arguments). Medium risk, requires confirmation. Use after mcp_list_tools to see available tools.
- security_scan: Scan the project (or a specific path) for security vulnerabilities; returns issues with severity, rule and line numbers
- security_fix: Use AI to generate and apply fixes for security issues (creates a snapshot before changing files)
- generate_tests: Generate unit tests for a file (args: path). Detects jest/vitest/pytest and writes a test file (creates a snapshot first)
- run_tests: Run the project test suite (auto-detects npm test / jest / vitest / pytest); returns output and exit code
- auto_test_fix: Run tests, analyze failures, and fix the code automatically (args: path optional; uses the current working-tree changes if path omitted). Creates a snapshot before changing files
- team_plan: PLANNER role — break a task into a persisted step list (args: query "任务描述")
- team_execute: CODE ENGINEER role — implement a plan step (args: query "step number" or auto-pick next pending step); writes files with snapshots
- team_test: QA role — run the test suite and analyze failures
- team_review: REVIEWER role — review changes (lint/typecheck/security/diff) and decide pass/fail
- team_status: Show the current team plan and step progress
- skill_deps: Check a skill's declared dependencies (dependsOn skills, MCP servers, packages, env vars). Args: query "skill name"
- project_export: Export the project config as a standardized AgentPack JSON (settings, trusted projects, MCP servers, installed tools, skills)
- project_import: Import an AgentPack JSON to restore/migrate a project config (args: params.config with the JSON string). Medium risk, requires confirmation
- harness_status: Check whether DeepSeek Harness is available (returns Node version, config status). Read-only.
- harness_run: Delegate a complex task to the official DeepSeek Harness agent (args: task). Use for repo-level workflows, multi-step refactoring, "implement X then test and verify" jobs, or tasks that need an autonomous agent loop. The task runs in the current project directory. High risk, requires confirmation.
- codex_status: Check whether the Codex CLI bridge is reachable (returns bridge status, Codex version, model config). Read-only.
- codex_exec: Delegate a complex task to the official Codex CLI agent (args: task). Use for repo-level autonomous workflows, deep refactoring, "implement X then verify" jobs, or tasks needing Codex's own agent loop. Runs in the current project directory. High risk, requires confirmation.
- brain_status: Check whether the Codex CLI execution brain is reachable (bridge status + built-in engine). Read-only.
- brain_exec: Run a task through the Codex CLI execution brain (args: brain "codex" + task). Use for repo-level autonomous workflows. If not installed, the result returns an install hint; fall back to built-in tools. High risk, requires confirmation.
- device_status: Check whether device control is enabled (Settings → 设备控制) and how many actions are queued. Read-only.
- system_diagnostics: Run a full self-check of the 妙笔 environment (Node version, AI API key, Termux path, device control, MCP servers, Harness, DB stats). Read-only, returns a summary with recommended fixes.
- agent_list: List agent instances for the current session (id/type/name/status/context length). Read-only.
- agent_create: Create a new agent instance (args: type one of scheduler/code_engineer/file_manager/search_assistant/general_chat/automator/ui_operator/researcher/translator/memory_admin/novel_memory_mgr, name optional). Medium risk, requires confirmation.
- agent_delegate: Delegate a task to a sub-agent by type (args: type + task). The sub-agent answers with its own role prompt; useful for specialized opinions (review, research, translation). Medium risk.
- agent_status: Show the status of all agent instances (idle/running/paused/stopped) and their context summaries. Read-only.
- agent_clear: Clear an agent instance's independent context (args: id). Medium risk.
- agent_delete: Delete an agent instance and its context (args: id). Medium risk.

- rag_index: Rebuild the project knowledge base index (args: scope "all" | "project" | "chat"; indexes project docs + chat history into retrievable chunks). Auto-executed.
- rag_search: Search the knowledge base with source citations (args: query, topK optional). Use before answering questions that reference project docs or history.
- rag_remember: Store a long-term fact/note into the knowledge base (args: content or query, title optional).
- memory_remember: Store a reusable experience/pattern into memory (args: pattern 情境, solution 做法, context optional). Auto-recalled in future sessions.
- memory_recall: Retrieve past experiences by similarity (args: query, topK optional).

- goal_set: Create a long-term autonomous goal (args: title, description optional, steps optional array of strings). Persisted per project; use for multi-turn/long-horizon tasks.
- goal_status: Show the current active goal's progress (args: goalId optional; defaults to latest active goal for the project). Read-only.
- goal_loop: Advance the current goal (args: note optional, milestone true at key checkpoints, done true to finish, nextStep optional). Medium risk: milestone checkpoints pause and require user approval.
- swarm_init: Initialize a multi-agent swarm for a complex task (args: query "任务描述", topology optional "flat"|"hierarchical"|"mesh"|"ring"). Analyzes task characteristics and auto-selects the best coordination topology. Returns swarm ID and recommended topology.
- swarm_status: Show swarm status (args: swarmId). Returns topology, agent list, task progress, and consensus state.
- swarm_list: List all active swarms for the current project. Read-only.
- swarm_execute: Execute the next pending task in a swarm (args: swarmId). Assigns task to available agent and returns execution details.
- swarm_report: Report task result back to swarm (args: swarmId, taskId, success boolean, result). Updates agent metrics and checks if swarm is complete.
- agent_spawn: Spawn a new swarm agent (args: type, name optional, topology optional). Returns agent ID and status.
- agent_terminate: Terminate a swarm agent (args: agentId, graceful optional). Cleans up child agents if graceful.
- consensus_submit: Submit a file change proposal for consensus (args: filePath, content). Other agents vote on the change.
- consensus_vote: Vote on a proposal (args: proposalId, approve boolean). Majority wins.
- learning_stats: Show learning statistics (args: projectId optional). Returns success rate, topology performance, and recent insights.
- learning_suggest: Get optimization suggestions based on historical data. Returns topology/tool/timeout recommendations.

- device_action: Control this phone's screen. Args: type one of "tap" (params x,y), "swipe" (params x1,y1,x2,y2,duration), "screenshot" (no params, returns saved PNG path + size), "ui_dump" (no params, returns the visible UI tree with bounds), "back", "home", "launch_app" (params package). Requires the accessibility service enabled in Settings → 设备控制. Medium risk, requires confirmation.
- generate_diagram: Create an editorial SVG diagram (no Mermaid). Args: type one of flowchart/architecture/sequence/erd/dependency/roadmap/timeline/swimlane, title, nodes [{id,label,kind?,layer?,lane?,fields?}], edges [{from,to,label?}]. Use when user asks 画架构图/流程图/依赖图/时序图/ER图/路线图/项目规划/调用链/泳道. Returns __SYNAPS_DIAGRAM__ + SVG which MUST be echoed verbatim in your final reply (the chat renders it as an image). Before drawing, read_skill "diagram-design". Medium risk.
- spec_kit: Spec-Driven Development (github.com/github/spec-kit). Args: action one of status/init/spec/plan/tasks/implement/test, requirement, title. Flow for feature requests: 1) spec_kit spec → show the generated docs/specs/*.md to the user and WAIT for confirmation; 2) after confirmation spec_kit plan → implement → spec_kit test (generates tests from acceptance criteria). Store specs under docs/specs/. Medium risk.

- novel_init: Initialize a novel project for the current project (args: title, genre, synopsis, styleGuide optional, totalVolumes optional). Creates the 6-layer memory structure. Auto-executed when user wants to write a novel.
- novel_get_context: Get the full writing context assembled from 6 memory layers (args: chapterNumber optional). Returns story bible, volume summary, recent chapter summaries, last chapter ending, active characters, foreshadowing, and memory chunks.
- novel_add_chapter: Save a completed chapter (args: chapterNumber, title, body, summary optional). Automatically triggers post-write memory update (character diffs, foreshadowing flow, chunk freezing).
- novel_list_characters: List all characters in the novel. Read-only.
- novel_create_character: Create a new character (args: name, traits, backstory, currentState).
- novel_update_character: Update a character's state/trait/status (args: name, field, newValue). Only records the diff, does not overwrite the full card.
- novel_list_foreshadowing: List all foreshadowing with their current status. Read-only.
- novel_add_foreshadowing: Plant a new foreshadowing (args: title, description, chapterNumber optional).
- novel_advance_foreshadowing: Advance foreshadowing status (args: id, newStatus one of developing|resolving|resolved|abandoned, resolvedChapter optional).
- novel_snapshot: Create a memory snapshot for rollback (args: label optional).
- novel_update_bible: Update story bible settings (args: title, genre, synopsis, styleGuide, totalVolumes).

## Working Style
1. **Understand First**: Always analyze the project structure before making changes
2. **Plan**: Break complex tasks into steps
3. **Execute**: Use tools to implement changes
4. **Verify**: Read back modified files to confirm changes

## Rules
- ALWAYS read files before modifying them
- Make minimal, focused changes
- Explain what you're doing at each step
- If you encounter an error, try to understand and fix it
- All paths are relative to the project root
- 未绑定项目时，只能执行不依赖项目的工具（system_diagnostics、list_skills、read_skill、harness_status、codex_status、brain_status、device_status、mcp_*、search_tools、web_search、install_tool、memory_*、goal_*、rag_search、rag_remember）；文件/命令/团队/构建类工具需要先绑定项目，未绑定时工具会返回明确错误，请据此引导用户先选择项目。
- Use run_command to verify changes: run tests, builds, git diff, git status, git log
- Git operations (add/commit/push/branch/log/diff) are done through run_command
- Never run destructive commands (rm -rf /, mkfs, dd) or commands that modify files outside the project
- Commands run in the project root, time out after 30 seconds, and output is truncated

## Repair Workflow
When the user asks you to "fix" or "repair" the project (e.g. "修复我", "检查代码并修复"):
1. Run run_lint and run_typecheck to find errors
2. Run analyze_code to surface quality issues
3. Run auto_fix for fixable issues, then re-run run_lint/run_typecheck to verify
3.5. Run security_scan, then security_fix for any issues, then re-scan to verify
4. Run generate_tests (if the project has no tests) then run_tests
5. If tests fail, run auto_test_fix and re-run run_tests until green
6. Run git_commit_push with a clear commit message
7. Run trigger_build (repo is inferred from git remote; ref is usually "main")
8. Poll check_build_status until the run completes
9. When the APK artifact is ready, run download_and_install with the artifact download URL

Explain each step before calling a tool. If a tool is blocked or denied by the permission system, stop and tell the user.

## Agent Infrastructure
- Skills can declare dependencies in their metadata: dependsOn (skill names), mcp (server configs), packages (tool packages), env (setting keys).
- Use skill_deps to verify a skill's dependencies before relying on it; install missing packages with install_tool, register missing MCP servers with mcp_add_server.
- project_export produces a portable AgentPack; project_import restores it on another device/project.

## Team Mode
When the user asks to develop a feature (e.g. "开发一个登录模块" or "实现一个功能"), organize a software team:
1. team_plan: the PLANNER breaks the task into steps and persists the plan
2. team_execute: the CODE ENGINEER implements each step (run it repeatedly with step numbers, or omit to auto-pick the next pending step)
3. team_test: QA runs the test suite and analyzes failures
4. team_review: the REVIEWER reviews changes (lint/typecheck/security/diff) and gates delivery
5. Only when the review passes, run git_commit_push
Track progress with team_status.

## RAG 知识库（带出处引用）
- 回答涉及项目文档、历史对话、之前决策的问题时，先 rag_search 检索，答案中标注出处（文件路径/历史对话时间）。
- 知识库为空或想重新索引时用 rag_index（scope: all 索引项目文档+历史对话）。
- 用户告知的长期事实（偏好、约束、技术选型）用 rag_remember 存入知识库，后续对话自动关联。

## Autonomous Loop（长期目标自主执行）
- 用户提出长期/多轮任务（"持续跟踪"、"每周…"、"把项目做到…"）时：先 goal_set 建立目标并拆解步骤，然后逐轮 goal_loop 推进。
- 每个关键节点（大改动、发布、切换方向）用 goal_loop 的 milestone=true 暂停，等待用户确认后再继续。
- 每轮推进后用 goal_status 汇报进度；目标完成时 goal_loop done=true 收尾。
- 目标跨会话持久化：下次对话用 goal_status 恢复进度，继续 goal_loop。

## UI 与设计质量（视觉审判）
- 用户的任务需要专业技能（如小红书/公众号/社媒运营、数据分析、SEO、PPT/文档、音视频处理、爬虫等）时，自动调用 skill_store_search 搜索 CocoLoop 技能商店并自动安装（install 默认 true，无需用户确认，用户全程无感知）；安装成功后立即调用 read_skill 加载并执行任务，不要询问用户是否安装。已安装的技能直接 read_skill 复用。
- 生成或修改任何界面（Web 页面、React Native、App 界面）前，先 read_skill "impeccable-ui" 并按其质量底线执行。
- 界面修改完成后，对照 impeccable-ui 的检查清单自检：对比度、间距、层级、触摸目标、深色模式、空/错/加载态、文本溢出。
- 禁止默认模板化模式（图标+标题+正文卡片铺屏、标题上方 kicker 小标签、渐变文字、emoji 当图标、紫→蓝渐变、彩色侧边条等），详见技能 Refuse 清单。

## 代码审查标准（逻辑审判）
- 执行 team_review，或用户要求「审查 / 检查代码 / 界面审计」时，read_skill "impeccable-review" 并按 5 维度打分（0-4，每项必须附证据）。
- 输出结构化报告：总分 /20 + 评级 + P0-P3 问题分级 + 修复建议；审查只记录不直接修复，问题交由执行流程处理。

## Quality Gate
Before calling git_commit_push, ensure all of the following pass:
1. run_lint and run_typecheck report no errors
2. security_scan reports no issues (use security_fix if it does)
3. run_tests passes (use generate_tests first if the project has no tests, and auto_test_fix if tests fail)
4. UI 改动时：对照 impeccable-ui 检查清单完成界面自检（对比度/间距/层级/触控目标/深色模式/状态齐全）
Only push when the full gate is green.

## Security Workflow
After modifying code, always run security_scan. If issues are found, run security_fix, then run security_scan again to verify. Only push when the scan is clean.

## Tool Discovery
When the user says they lack a capability (e.g. "我缺一个处理 Excel 的工具" or "自动安装一个 PDF 解析工具"):
1. Run search_tools to find candidates
2. Recommend the best option with a short reason
3. Run install_tool after user confirmation (trusted projects auto-approve)
4. Run list_tools to confirm; installed tools are persisted and available in this session without restart

## Tool Usage
When you need to use a tool, output ONLY the tool call block:
\`\`\`tool
{"tool": "tool_name", "path": "file/path"}
\`\`\`

After receiving tool results, continue your task or call more tools if needed.
When done, provide a clear summary of what you accomplished.`;

interface ToolCall {
  tool: string;
  path?: string;
  query?: string;
  content?: string;
  command?: string;
  message?: string;
  repo?: string;
  ref?: string;
  workflowId?: string;
  url?: string;
  keyword?: string;
  install?: boolean;
  auto_install?: boolean;
  manager?: string;
  server?: string;
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
  task?: string;
  brain?: string;
  title?: string;
  description?: string;
  steps?: string[];
  note?: string;
  milestone?: boolean;
  done?: boolean;
  goalId?: string;
  scope?: string;
  topK?: number;
  pattern?: string;
  solution?: string;
  nodes?: Array<{ id: string; label: string; kind?: string; layer?: string; lane?: string; fields?: string[] }>;
  edges?: Array<{ from: string; to: string; label?: string }>;
  action?: string;
  requirement?: string;
  context?: string;
}

interface TeamTask {
  step: number;
  title: string;
  role: string;
  files: string[];
  status: 'pending' | 'done' | 'failed';
  detail?: string;
}

interface TeamPlan {
  id: string;
  title: string;
  tasks: TeamTask[];
}

/**
 * 从模型回复中提取纯文本（排除 ```tool / ```json 代码块）
 */
function extractPlainText(response: string): string {
  return response
    .replace(/```(?:tool|json)\s*\n?[\s\S]*?\n?```/g, '')
    .trim();
}

function parseToolCalls(response: string): ToolCall[] {
  const results: ToolCall[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    try {
      const parsed = JSON.parse(raw.trim());
      if (
        parsed &&
        typeof parsed.tool === 'string' &&
        /^[a-z_]+$/.test(parsed.tool) &&
        !seen.has(parsed.tool + JSON.stringify(parsed))
      ) {
        seen.add(parsed.tool + JSON.stringify(parsed));
        results.push(parsed as ToolCall);
      }
    } catch {
      // 忽略无法解析的块
    }
  };
  // 支持一条回复里多个 ```tool / ```json 块
  const blockRe = /```(?:tool|json)\s*\n?([\s\S]*?)\n?```/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(response)) !== null) {
    push(m[1]);
  }
  // 没有代码块时，兜底扫描裸 JSON 对象（要求 tool 是合法小写标识符）
  if (results.length === 0) {
    const bareRe = /\{[\s\S]*?\}/g;
    let b: RegExpExecArray | null;
    while ((b = bareRe.exec(response)) !== null) {
      push(b[0]);
    }
  }
  return results;
}

function resolveProjectPath(projectId: string | null, relativePath: string): string {
  if (!projectId) throw new Error('Project not found');
  const project = queryOne(`SELECT path FROM projects WHERE id = ?`, [projectId]) as Record<string, string> | null;
  if (!project) throw new Error('Project not found');

  const projectPath = project.path;
  const resolved = path.resolve(projectPath, relativePath);

  if (!resolved.startsWith(path.resolve(projectPath))) {
    throw new Error('Path traversal not allowed');
  }

  return resolved;
}

function ensureSession(projectId?: string | null): string {
  let existing: Record<string, unknown> | null = null;
  if (projectId) {
    existing = queryOne(
      `SELECT id FROM chat_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [projectId]
    );
  } else {
    existing = queryOne(
      `SELECT id FROM chat_sessions WHERE project_id IS NULL ORDER BY updated_at DESC LIMIT 1`
    );
  }
  if (existing) {
    runSql(`UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`, [existing.id as string]);
    return existing.id as string;
  }
  const id = crypto.randomUUID();
  runSql(`INSERT INTO chat_sessions (id, project_id, title) VALUES (?, ?, ?)`, [id, projectId ?? null, 'New Chat']);
  return id;
}

function saveChatMessage(sessionId: string, role: 'user' | 'assistant', content: string): void {
  if (!content.trim()) return;
  const id = crypto.randomUUID();
  runSql(`INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`, [id, sessionId, role, content]);
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  projectId: string | null;
}

const pendingApprovals = new Map<string, PendingApproval>();

function describeDetail(toolCall: ToolCall): string {
  return toolCall.command || toolCall.path || toolCall.query || toolCall.tool;
}

function truncateText(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`
    : text;
}

async function execInProject(
  cwd: string,
  command: string,
  timeout = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number; duration: number }> {
  // Android（nodejs-mobile）不支持 child_process，统一走原生执行器；本地/CI 回退 child_process
  const startTime = Date.now();
  const shell = isAndroidRuntime() ? '/system/bin/sh' : '/bin/sh';
  const r = await runProcess({
    cmd: shell,
    args: ['-c', command],
    cwd,
    timeoutMs: timeout,
  });
  return {
    stdout: r.stdout,
    stderr: r.error && !r.stderr ? `[启动失败] ${r.error}` : r.stderr,
    exitCode: r.timedOut ? -1 : r.exitCode,
    duration: Date.now() - startTime,
  };
}

async function inferRepo(cwd: string): Promise<string | null> {
  const r = await execInProject(cwd, 'git remote get-url origin');
  const url = r.stdout.trim();
  if (!url) return null;
  const m = url.match(/(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function getGithubTokenFromSettings(): string | null {
  try {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', ['github_token']);
    if (row && typeof row.value === 'string' && row.value) return row.value;
  } catch {
    // ignore
  }
  return process.env.GITHUB_TOKEN || null;
}

function createSnapshot(
  projectId: string | null,
  label: string,
  files: Array<{ path: string; content: string }>
): void {
  try {
    const snapshotId = crypto.randomUUID();
    runSql(
      'INSERT INTO snapshots (id, project_id, label, file_count) VALUES (?, ?, ?, ?)',
      [snapshotId, projectId, label, files.length]
    );
    for (const file of files) {
      runSql(
        'INSERT INTO snapshot_files (id, snapshot_id, file_path, original_content) VALUES (?, ?, ?, ?)',
        [crypto.randomUUID(), snapshotId, file.path, file.content]
      );
    }
    saveDb();
  } catch (err) {
    console.error('Failed to create snapshot:', err);
  }
}

function requestApproval(
  res: express.Response,
  toolCall: ToolCall,
  assessment: RiskAssessment,
  projectId: string | null
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        pendingApprovals.delete(requestId);
        resolve(false);
      }
    }, 60_000);

    pendingApprovals.set(requestId, { resolve, timer, projectId });

    res.write(`data: ${JSON.stringify({
      permission_request: {
        id: requestId,
        level: assessment.level,
        tool: toolCall.tool,
        args: {
          command: toolCall.command,
          path: toolCall.path,
          query: toolCall.query,
          message: toolCall.message,
          repo: toolCall.repo,
          url: toolCall.url,
          server: toolCall.server,
          method: toolCall.method,
          params: toolCall.params,
        },
        impact: assessment.impact,
      },
    })}\n\n`);
  });
}

function currentExecutorLabel(): string {
  try {
    const enabled = queryOne('SELECT value FROM settings WHERE key = ?', ['codex_enabled']);
    const builtin = queryOne('SELECT value FROM settings WHERE key = ?', ['codex_builtin']);
    const codexOn = String((enabled?.value as string | null) || '') === 'true';
    const useBuiltin = String((builtin?.value as string | null) || '') === 'true';
    if (codexOn) {
      return useBuiltin && codexLocalInstalled()
        ? 'Codex CLI · 内置引擎'
        : 'Codex CLI · Termux 桥接';
    }
  } catch {
    // 设置读取失败按默认处理
  }
  return '内置能力 · DeepSeek 主模型';
}

function getAiConfig(): { apiKey: string; baseUrl: string; model: string } {
  const apiKeyRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_api_key']);
  const baseUrlRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_base_url']);
  const modelRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_model']);
  return {
    apiKey: apiKeyRow && typeof apiKeyRow.value === 'string' ? apiKeyRow.value : '',
    baseUrl:
      baseUrlRow && typeof baseUrlRow.value === 'string' && baseUrlRow.value
        ? baseUrlRow.value
        : 'https://api.deepseek.com',
    model:
      modelRow && typeof modelRow.value === 'string' && modelRow.value
        ? modelRow.value
        : 'deepseek-v4-flash',
  };
}

async function deepseekComplete(
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  user: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: 8000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content || '';
    const m = raw.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return m ? m[1] : raw;
  } finally {
    clearTimeout(timer);
  }
}

// 智能路由：Ollama 优先 → DeepSeek 兜底
async function aiComplete(
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  user: string
): Promise<string> {
  const ollamaOk = await isOllamaAvailable();
  
  if (ollamaOk) {
    const intent = detectIntent(user);
    const ollamaModel = intent === 'reasoning' ? OLLAMA_MODELS.REASONING : OLLAMA_MODELS.CHAT;
    const result = await callOllama(
      ollamaModel,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      0.7, 4096
    );
    if (!result.error && result.content) return result.content;
    console.log('[Ollama] 本地模型失败，降级到 DeepSeek:', result.error);
  }
  
  return deepseekComplete(apiKey, baseUrl, model, system, user);
}

/**
 * 流式读取 LLM 响应并带看门狗：空闲超时（长时间无数据）或总超时后中断，
 * 避免网络/模型异常导致 Agent 循环无限等待。
 */
async function streamWithForwarding(
  client: LLMClient,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { temperature?: number; model?: string },
  res: express.Response,
  idleTimeoutMs = 60_000,
  totalTimeoutMs = 180_000,
  taskId?: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    guardSseErrors(res);
    let out = '';
    let idleTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const totalTimer = setTimeout(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reject(new Error('LLM 响应超时，请稍后重试'));
    }, totalTimeoutMs);

    // 心跳：任务处理中保持 SSE 活跃，前端看门狗不会误判超时；同时响应取消请求
    heartbeatTimer = setInterval(() => {
      try {
        if (taskId && abortRegistry.get(taskId)) {
          clearTimeout(totalTimer);
          if (idleTimer) clearTimeout(idleTimer);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          reject(new Error('任务已取消'));
        } else if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
        }
      } catch {
        // SSE 已关闭，忽略
      }
    }, 15_000);

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        clearTimeout(totalTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        reject(new Error('LLM 响应中断（长时间无数据），请稍后重试'));
      }, idleTimeoutMs);
    };

    (async () => {
      try {
        const stream = client.stream(messages, options);
        armIdle();
        for await (const chunk of stream) {
          if (chunk.content) {
            const text = chunk.content.toString();
            if (text) {
              out += text;
              res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
            }
            armIdle();
          }
        }
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        resolve(out);
      } catch (err) {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        reject(err);
      }
    })();
  });
}

async function streamWithWatchdog(
  client: LLMClient,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { temperature?: number; model?: string },
  res?: express.Response,
  idleTimeoutMs = 60_000,
  totalTimeoutMs = 180_000,
  taskId?: string,
  onChunk?: (text: string) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let out = '';
    let idleTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const totalTimer = setTimeout(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reject(new Error('LLM 响应超时，请稍后重试'));
    }, totalTimeoutMs);

    if (res) {
      guardSseErrors(res);
      heartbeatTimer = setInterval(() => {
        try {
          if (taskId && abortRegistry.get(taskId)) {
            clearTimeout(totalTimer);
            if (idleTimer) clearTimeout(idleTimer);
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            reject(new Error('任务已取消'));
          } else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
          }
        } catch {
          // SSE 已关闭，忽略
        }
      }, 15_000);
    }

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        clearTimeout(totalTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        reject(new Error('LLM 响应中断（长时间无数据），请稍后重试'));
      }, idleTimeoutMs);
    };

    (async () => {
      try {
        const stream = client.stream(messages, options);
        armIdle();
        for await (const chunk of stream) {
          if (chunk.content) {
            const text = chunk.content.toString();
            if (text) {
              out += text;
              if (onChunk) onChunk(text);
            }
            armIdle();
          }
        }
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        resolve(out);
      } catch (err) {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        reject(err);
      }
    })();
  });
}

function parseTaskList(text: string): TeamTask[] {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidate = m ? m[1] : text;
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];
  try {
    const parsed = JSON.parse(arrMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t: any) => t && typeof t.title === 'string')
      .map((t: any, i: number) => ({
        step: typeof t.step === 'number' ? t.step : i + 1,
        title: t.title,
        role: typeof t.role === 'string' ? t.role : 'engineer',
        files: Array.isArray(t.files) ? t.files.filter((f: unknown) => typeof f === 'string') : [],
        status: 'pending' as const,
      }));
  } catch {
    return [];
  }
}

function parseEngineerOutput(text: string): { files: Array<{ path: string; content: string }>; note: string } {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidate = m ? m[1] : text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  try {
    const parsed = objMatch ? JSON.parse(objMatch[0]) : {};
    const files = Array.isArray(parsed.files)
      ? parsed.files
          .filter((f: any) => f && typeof f.path === 'string' && typeof f.content === 'string')
          .map((f: any) => ({ path: f.path as string, content: f.content as string }))
      : [];
    return { files, note: typeof parsed.note === 'string' ? parsed.note : '' };
  } catch {
    return { files: [], note: text.slice(0, 500) };
  }
}

function saveTeamPlan(projectId: string | null, title: string, tasks: TeamTask[]): string {
  const id = crypto.randomUUID();
  runSql(
    'INSERT INTO team_tasks (id, project_id, title, tasks_json) VALUES (?, ?, ?, ?)',
    [id, projectId, title, JSON.stringify(tasks)]
  );
  saveDb();
  return id;
}

function loadTeamPlan(projectId: string | null): TeamPlan | null {
  const rows = queryAll('SELECT * FROM team_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', [
    projectId,
  ]) as Record<string, string>[];
  if (rows.length === 0) return null;
  try {
    const tasks = JSON.parse(rows[0].tasks_json);
    return {
      id: rows[0].id,
      title: rows[0].title,
      tasks: Array.isArray(tasks) ? (tasks as TeamTask[]) : [],
    };
  } catch {
    return null;
  }
}

function updateTeamPlan(plan: TeamPlan): void {
  runSql(
    "UPDATE team_tasks SET tasks_json = ?, status = 'active', current_step = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(plan.tasks), plan.tasks.filter((t) => t.status === 'done').length, plan.id]
  );
  saveDb();
}

function buildProjectContext(cwd: string, files: string[]): string {
  const parts: string[] = [];
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const structure = entries
      .filter((e) => !e.name.startsWith('.') && !['node_modules', 'dist', 'build', '.git'].includes(e.name))
      .slice(0, 30)
      .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
      .join('\n');
    parts.push(`Project structure (top level):\n${structure || '(empty)'}`);
  } catch {
    // ignore
  }
  for (const rel of files.slice(0, 5)) {
    const full = path.join(cwd, rel);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
    try {
      const stat = fs.statSync(full);
      if (stat.size > 200 * 1024) continue;
      parts.push(`File ${rel}:\n\`\`\`\n${fs.readFileSync(full, 'utf-8')}\n\`\`\``);
    } catch {
      // skip
    }
  }
  return parts.join('\n\n');
}

function detectTestCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.test) return 'npm test';
      return 'npx jest --passWithNoTests 2>/dev/null || npx vitest run 2>/dev/null || echo NO_TEST_RUNNER';
    } catch {
      return 'npx jest --passWithNoTests 2>/dev/null || npx vitest run 2>/dev/null || echo NO_TEST_RUNNER';
    }
  }
  if (
    fs.existsSync(path.join(cwd, 'pytest.ini')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(cwd, 'requirements.txt'))
  ) {
    return 'python3 -m pytest -q 2>/dev/null || echo NO_TEST_RUNNER';
  }
  return null;
}

function formatGoalStatus(goal: Record<string, unknown>, paused = false): string {
  let steps: string[] = [];
  try { steps = JSON.parse(String(goal.steps_json || '[]')); } catch { steps = []; }
  let notes: string[] = [];
  try { notes = JSON.parse(String(goal.notes_json || '[]')); } catch { notes = []; }
  const currentStep = Number(goal.current_step || 0);
  const statusIcon = goal.status === 'done' ? '✅' : paused ? '⏸️' : '🔄';
  const lines = [
    `${statusIcon} Goal: ${goal.title}`,
    `状态：${goal.status === 'done' ? '已完成' : paused ? '已暂停（等待确认）' : '进行中'}`,
    `进度：${Math.min(currentStep, steps.length)} / ${steps.length || '∞'} 步`,
  ];
  if (steps.length > 0) {
    lines.push('步骤：');
    steps.forEach((st, i) => {
      if (i < currentStep) lines.push(`  ✅ ${st}`);
      else if (i === currentStep) lines.push(`  ⏳ ${st}`);
      else lines.push(`  ⬜ ${st}`);
    });
  }
  if (notes.length > 0) {
    lines.push('进度记录：');
    notes.slice(-6).forEach((n) => lines.push(`  - ${n}`));
  }
  return lines.join('\n');
}

async function executeTool(projectId: string | null, toolCall: ToolCall, sessionId: string): Promise<string> {
  await getDb();

  switch (toolCall.tool) {
    case 'list_dir': {
      const dirPath = resolveProjectPath(projectId, toolCall.path || '');
      if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${toolCall.path}`;

      const entries = fs.readdirSync(dirPath);
      const items = entries
        .filter(name => !name.startsWith('.'))
        .map(name => {
          const fullPath = path.join(dirPath, name);
          try {
            const stat = fs.statSync(fullPath);
            return `${stat.isDirectory() ? '📁' : '📄'} ${name}${stat.isDirectory() ? '/' : ''}`;
          } catch {
            return `? ${name}`;
          }
        });

      return items.length > 0 ? items.join('\n') : '(empty directory)';
    }

    case 'read_file': {
      if (!toolCall.path) return 'Error: path is required';
      const filePath = resolveProjectPath(projectId, toolCall.path);
      if (!fs.existsSync(filePath)) return `Error: File not found: ${toolCall.path}`;

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return `Error: ${toolCall.path} is a directory`;
      if (stat.size > 500 * 1024) return `Error: File too large (${stat.size} bytes, max 500KB)`;

      const content = fs.readFileSync(filePath, 'utf-8');
      return content;
    }

    case 'write_file': {
      if (!toolCall.path) return 'Error: path is required';
      if (toolCall.content === undefined) return 'Error: content is required';

      const filePath = resolveProjectPath(projectId, toolCall.path);
      const dir = path.dirname(filePath);

      // Auto-create snapshot before modifying file
      try {
        const db = await getDb();
        const snapshotId = crypto.randomUUID();
        const now = new Date().toISOString();
        
        // Read existing file content if it exists
        let existingContent = '';
        if (fs.existsSync(filePath)) {
          existingContent = fs.readFileSync(filePath, 'utf-8');
        }
        
        // Create snapshot record
        db.run(
          `INSERT INTO snapshots (id, project_id, label, created_at) VALUES (?, ?, ?, ?)`,
          [snapshotId, projectId, `Auto-snapshot before Agent edit`, now]
        );
        
        // Save file to snapshot
        db.run(
          `INSERT INTO snapshot_files (snapshot_id, path, content) VALUES (?, ?, ?)`,
          [snapshotId, toolCall.path, existingContent]
        );
      } catch (err) {
        console.error('Failed to create auto-snapshot:', err);
        // Continue with write even if snapshot fails
      }

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, toolCall.content, 'utf-8');
      return `Successfully wrote ${toolCall.content.length} bytes to ${toolCall.path}`;
    }

    case 'search_file': {
      if (!toolCall.query) return 'Error: query is required';
      const projectRoot = resolveProjectPath(projectId, '');
      const results: string[] = [];
      const maxResults = 50;
      const queryLower = toolCall.query.toLowerCase();

      function walkDir(dir: string, depth: number) {
        if (depth > 8 || results.length >= maxResults) return;
        const entries = fs.readdirSync(dir);

        for (const name of entries) {
          if (name.startsWith('.') || name === 'node_modules' || name === 'build') continue;
          if (results.length >= maxResults) break;

          const fullPath = path.join(dir, name);
          const relPath = path.relative(projectRoot, fullPath);

          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              if (name.toLowerCase().includes(queryLower)) {
                results.push(`📁 ${relPath}/`);
              }
              walkDir(fullPath, depth + 1);
            } else {
              if (name.toLowerCase().includes(queryLower)) {
                results.push(`📄 ${relPath}`);
              }
            }
          } catch {
            // skip
          }
        }
      }

      walkDir(projectRoot, 0);
      return results.length > 0 ? results.join('\n') : `No files matching "${toolCall.query}"`;
    }

    case 'skill_store_search': {
      const rawQuery = String(toolCall.query || toolCall.keyword || '').trim();
      const listOnly = toolCall.install === false;
      if (!rawQuery) return 'Error: skill_store_search requires a query (e.g. 小红书运营)';
      // 从自然语言里提炼搜索关键词（去掉 帮我/写/使用说明/文档 等填充词），过长查询会导致 CocoLoop 搜不到
      const STOPWORDS = new Set(['使用','说明','文档','教程','技术','帮我','给我','写','生成','创建','制作','一份','一个','如何','怎么','用','的','简单','快速','请','我','要','内容','资料']);
      const deriveKeywords = (q: string): string[] => {
        const tokens = q.toLowerCase().split(/[\s,，、.:：/\\-]+/).filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
        if (tokens.length === 0) return [q];
        return [tokens.join(' '), tokens[0]];
      };
      const keywords = deriveKeywords(rawQuery);
      // 本地已装同主题技能 → 直接复用，不重复安装
      try {
        const like = keywords.map((k) => `%${k}%`).join(',');
        const local = queryAll(
          'SELECT name, description, metadata FROM skills WHERE enabled = 1 AND (name LIKE ? OR description LIKE ?)',
          [`%${keywords[0]}%`, `%${keywords[0]}%`]
        ) as Array<{ name: string; description: string; metadata: string }>;
        const match = local.find((sk) => keywords.some((k) => sk.name.toLowerCase().includes(k) || sk.description.toLowerCase().includes(k)));
        if (match) {
          let meta: Record<string, unknown> = {};
          try {
            meta = JSON.parse(match.metadata || '{}');
          } catch {
            // 忽略解析失败
          }
          const channelNote = meta.channel === 'testing' ? '（测试通道）' : '';
          return `✅ 本地技能库已安装「${match.name}」${channelNote}，无需重复安装。\n简介：${match.description || ''}\n请用 read_skill "${match.name}" 加载并使用。`;
        }
      } catch {
        // 本地检查失败不影响商店检索
      }
      // 商店搜索：关键词回退（完整 → 精简 → 首个词），任一命中即停
      let found = { items: [] as { id: number; name: string; subtitle: string; brief: string; category: string; security_level: string; downloads: string; author: string }[], total: 0 };
      let lastErr: Error | null = null;
      for (const k of keywords) {
        try {
          const r = await searchStoreSkills({ keyword: k, pageSize: 8, sort: 'downloads' });
          if (r.items.length > 0) {
            found = r as typeof found;
            break;
          }
        } catch (err) {
          lastErr = err as Error;
        }
      }
      if (found.items.length === 0) {
        return lastErr ? `技能商店暂时不可用：${lastErr.message}` : `技能商店没有找到与「${rawQuery}」相关的技能（共 0 条）`;
      }
      if (listOnly) {
        return `技能商店「${rawQuery}」共 ${found.total} 条结果（前 ${found.items.length} 条）：\n` +
          found.items.map((it, i) =>
            `${i + 1}. ${it.name}（${it.category || '未分类'}｜安全 ${it.security_level || '-'}｜下载 ${it.downloads || '0'}｜作者 ${it.author || '-'}）\n   ${it.subtitle || it.brief || '暂无简介'}`
          ).join('\n') +
          `\n\n默认会自动安装排名第一的技能，如需自动安装请直接调用 skill_store_search（不带 install: false）。`;
      }
      // 自动选最佳匹配：关键词命中越多越靠前，其次按商店排序
      const scored = found.items.map((it, i) => {
        const hay = `${it.name} ${it.subtitle} ${it.brief}`.toLowerCase();
        const score = keywords.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0);
        return { it, score, i };
      });
      const best = scored.sort((a, b) => b.score - a.score || a.i - b.i)[0].it;
      const result = await installStoreSkill(best.id, { auto: true });
      const channelNote = result.channel === 'testing' ? '（已进入测试通道，3 天无问题自动转正式）' : '';
      return `✅ 已自动安装技能「${result.name}」${result.version ? `(${result.version})` : ''}${channelNote}\n来源：${best.category || '未分类'}，安全等级 ${best.security_level || '-'}\n简介：${best.subtitle || best.brief || ''}\n已包含文件：${result.files.slice(0, 8).join(', ')}${result.files.length > 8 ? '…' : ''}\n现在请立即调用 read_skill "${result.name}" 加载并使用该技能完成任务。`;
    }


    case 'list_skills': {
      const rows = queryAll('SELECT name, description FROM skills WHERE enabled = 1 ORDER BY name') as Record<string, string>[];
      if (rows.length === 0) return 'No skills available.';
      return rows.map((r) => `- ${r.name}: ${r.description}`).join('\n');
    }

    case 'read_skill': {
      if (!toolCall.query) return 'Error: query (skill name) is required';
      const skill = queryOne('SELECT name, description, content FROM skills WHERE name = ? AND enabled = 1', [toolCall.query]) as Record<string, string> | null;
      if (!skill) return `Skill "${toolCall.query}" not found. Use list_skills to see available skills.`;
      markSkillUsed(skill.name);
      rememberTurnSkill(sessionId, skill.name);
      return `## ${skill.name}\n\n${skill.description}\n\n---\n\n${skill.content}`;
    }

    case 'rag_index': {
      await ensureKnowledgeTable();
      const scope = toolCall.scope || 'all';
      let projectCount = 0;
      let chatCount = 0;
      if (projectId && (scope === 'all' || scope === 'project')) {
        const root = resolveProjectPath(projectId, '');
        if (fs.existsSync(root)) projectCount = indexProjectFiles(projectId, root);
      }
      if (projectId && (scope === 'all' || scope === 'chat')) {
        chatCount = indexChatHistory(projectId);
      }
      return `Knowledge index rebuilt (scope: ${scope}):\n- 项目文档：${projectCount} 块\n- 历史对话：${chatCount} 块\n\n使用 rag_search 检索知识库。`;
    }

    case 'rag_search': {
      if (!toolCall.query) return 'Error: query is required';
      await ensureKnowledgeTable();
      const topK = Math.min(10, Math.max(1, Number(toolCall.topK) || 5));
      return searchKnowledge(projectId, toolCall.query, topK);
    }

    case 'rag_remember': {
      const content = toolCall.content || toolCall.query;
      if (!content) return 'Error: content is required';
      const title = toolCall.title || '用户备注';
      await ensureKnowledgeTable();
      const n = rememberNote(projectId, title, content);
      logAudit(projectId, 'rag_remember', `存入知识库备注：${title}（${n} 块）`, 'none', 'auto');
      return `Saved ${n} chunk(s) to knowledge base: ${title}`;
    }

    case 'memory_remember': {
      if (!toolCall.pattern || !toolCall.solution) return 'Error: pattern and solution are required';
      rememberMemory(projectId, toolCall.pattern, toolCall.solution, toolCall.context || '');
      logAudit(projectId, 'memory_remember', `存入经验记忆：${toolCall.pattern.slice(0, 80)}`, 'none', 'auto');
      return `Memory saved. 情境：${toolCall.pattern.slice(0, 120)}\n做法：${toolCall.solution.slice(0, 200)}`;
    }

    case 'novel_init': {
      const tc = toolCall as any;
      const novelTitle = tc.title || '未命名小说';
      const novelGenre = tc.genre || '未知';
      const novelSyn = tc.synopsis || '';
      const novelStyle = tc.styleGuide || '';
      const novelVols = Number(tc.totalVolumes) || 1;
      ensureNovelTables();
      createNovelProject(projectId!, novelTitle, novelGenre, novelSyn, novelStyle, novelVols);
      logAudit(projectId, 'novel_init', `创建小说项目：${novelTitle}（${novelGenre}）`, 'none', 'auto');
      return `✅ 小说项目「${novelTitle}」已创建（类型：${novelGenre}，卷数：${novelVols}）。六层记忆系统已就绪，可以开始写作。使用 novel_get_context 获取写作上下文。`;
    }

    case 'novel_get_context': {
      const tc = toolCall as any;
      const bible = getStoryBible(projectId!);
      if (!bible) return '❌ 该项目尚未创建小说项目。请先使用 novel_init 初始化。';
      const nextCh = Number(tc.chapterNumber) || bible.totalChapters + 1;
      const ctx = novelContextToSystemPrompt(projectId!, bible.id, nextCh, bible.currentVolume);
      return ctx || '暂无记忆数据，这是全新开始。';
    }

    case 'novel_add_chapter': {
      const tc = toolCall as any;
      const novelBible = getStoryBible(projectId!);
      if (!novelBible) return '❌ 未创建小说项目。';
      const chNum = Number(tc.chapterNumber) || novelBible.totalChapters + 1;
      const chTitle = tc.title || `第${chNum}章`;
      const chBody = tc.body || '';
      const chSummary = tc.summary || '';
      const chRec = addChapter(projectId!, novelBible.id, novelBible.currentVolume, chNum, chTitle, chBody, chSummary);
      if (chSummary) updateChapterSummary(projectId!, chRec.id, chSummary);
      // 自动处理写后更新（角色变化 + 伏笔流转由 AI 在下次调用时触发）
      logAudit(projectId, 'novel_add_chapter', `新增章节：${chTitle}（${chBody.length}字）`, 'none', 'auto');
      return `✅ 第${chNum}章「${chTitle}」已保存（${chBody.length}字）。请使用 novel_update_character / novel_advance_foreshadowing 更新角色和伏笔状态。`;
    }

    case 'novel_list_characters': {
      const tc = toolCall as any;
      const chars = getCharacters(projectId!, (() => { const b = getStoryBible(projectId!); return b ? b.id : ''; })());
      if (chars.length === 0) return '暂无角色。使用 novel_create_character 创建。';
      return chars.map(c => `**${c.name}** [${c.status}] 性格：${c.traits} | 当前：${c.currentState} | 出场：ch${c.firstAppearance}-${c.lastAppearance}`).join('\n');
    }

    case 'novel_create_character': {
      const tc = toolCall as any;
      if (!tc.name) return 'Error: name is required';
      const novelB2 = getStoryBible(projectId!);
      if (!novelB2) return '❌ 未创建小说项目。';
      upsertCharacter(projectId!, novelB2.id, tc.name, tc.traits || '', tc.backstory || '', tc.currentState || '', novelB2.totalChapters + 1);
      logAudit(projectId, 'novel_create_character', `创建角色：${tc.name}`, 'none', 'auto');
      return `✅ 角色「${tc.name}」已创建。`;
    }

    case 'novel_update_character': {
      const tc = toolCall as any;
      if (!tc.name || !tc.field || !tc.newValue) return 'Error: name, field, newValue are required';
      const novelB3 = getStoryBible(projectId!);
      if (!novelB3) return '❌ 未创建小说项目。';
      const field = tc.field;
      recordCharacterDiff(projectId!, novelB3.id, tc.name, novelB3.totalChapters, field, tc.oldValue || '', tc.newValue);
      logAudit(projectId, 'novel_update_character', `角色变化：${tc.name} ${field} → ${tc.newValue}`, 'none', 'auto');
      return `✅ 角色「${tc.name}」的 ${field} 已记录变化。`;
    }

    case 'novel_list_foreshadowing': {
      const tc = toolCall as any;
      const novelB4 = getStoryBible(projectId!);
      if (!novelB4) return '暂无小说项目。';
      const fs = getAllForeshadowing(projectId!, novelB4.id);
      if (fs.length === 0) return '暂无伏笔。使用 novel_add_foreshadowing 埋下。';
      return fs.map(f => {
        const e: Record<string, string> = { planted: '🌱', developing: '🌿', resolving: '🔄', resolved: '✅', abandoned: '❌' };
        return `${e[f.status] || '❓'} **${f.title}** [${f.status}] ch${f.plantedChapter}${f.resolvedChapter ? `→ch${f.resolvedChapter}` : ''} — ${f.description}`;
      }).join('\n');
    }

    case 'novel_add_foreshadowing': {
      const tc = toolCall as any;
      if (!tc.title || !tc.description) return 'Error: title and description are required';
      const novelB5 = getStoryBible(projectId!);
      if (!novelB5) return '❌ 未创建小说项目。';
      addForeshadowing(projectId!, novelB5.id, tc.title, tc.description, Number(tc.chapterNumber) || novelB5.totalChapters + 1, tc.relatedCharacters || []);
      logAudit(projectId, 'novel_add_foreshadowing', `埋下伏笔：${tc.title}`, 'none', 'auto');
      return `✅ 伏笔「${tc.title}」已埋下。`;
    }

    case 'novel_advance_foreshadowing': {
      const tc = toolCall as any;
      if (!tc.id || !tc.newStatus) return 'Error: id and newStatus are required';
      const novelB6 = getStoryBible(projectId!);
      if (!novelB6) return '❌ 未创建小说项目。';
      advanceForeshadowing(projectId!, novelB6.id, tc.id, tc.newStatus, tc.resolvedChapter ? Number(tc.resolvedChapter) : undefined);
      logAudit(projectId, 'novel_advance_foreshadowing', `伏笔状态变更：${tc.id} → ${tc.newStatus}`, 'none', 'auto');
      return `✅ 伏笔状态已更新为 ${tc.newStatus}。`;
    }

    case 'novel_snapshot': {
      const tc = toolCall as any;
      const novelB7 = getStoryBible(projectId!);
      if (!novelB7) return '❌ 未创建小说项目。';
      const snap = createMemorySnapshot(projectId!, novelB7.id, tc.label || `手动快照-ch${novelB7.totalChapters}`, novelB7.totalChapters, novelB7.currentVolume);
      logAudit(projectId, 'novel_snapshot', `创建记忆快照：${snap.label}`, 'none', 'auto');
      return `✅ 快照已创建：${snap.label}（ID: ${snap.id.slice(0, 8)}）`;
    }

    case 'novel_update_bible': {
      const tc = toolCall as any;
      const novelB8 = getStoryBible(projectId!);
      if (!novelB8) return '❌ 未创建小说项目。';
      const updates: Record<string, unknown> = {};
      if (tc.title) updates.title = tc.title;
      if (tc.genre) updates.genre = tc.genre;
      if (tc.synopsis) updates.synopsis = tc.synopsis;
      if (tc.styleGuide) updates.styleGuide = tc.styleGuide;
      if (tc.totalVolumes) updates.totalVolumes = Number(tc.totalVolumes);
      updateStoryBible(projectId!, updates as any);
      logAudit(projectId, 'novel_update_bible', `更新全书设定`, 'none', 'auto');
      return '✅ 全书设定已更新。';
    }

    case 'memory_recall': {
      if (!toolCall.query) return 'Error: query is required';
      const res = recallMemories(projectId, toolCall.query, Math.min(10, Math.max(1, Number(toolCall.topK) || 5)));
      return res || 'No related memories found. Use memory_remember to store experiences.';
    }

    case 'goal_set': {
      if (!toolCall.title) return 'Error: title is required';
      const steps = Array.isArray(toolCall.steps) ? toolCall.steps.filter((x) => typeof x === 'string') : [];
      const goalId = crypto.randomUUID();
      const now = Date.now();
      runSql(
        `INSERT INTO goals (id, project_id, title, description, status, current_step, total_steps, steps_json, notes_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`,
        [
          goalId,
          projectId || null,
          toolCall.title,
          toolCall.description || '',
          steps.length,
          JSON.stringify(steps),
          JSON.stringify([]),
          now,
          now,
        ]
      );
      saveDb();
      logAudit(projectId, 'goal_set', `创建长期目标：${toolCall.title}（${steps.length} 步）`, 'none', 'auto');
      return `Goal created: ${goalId}\n标题：${toolCall.title}\n描述：${toolCall.description || '-'}\n步骤（${steps.length}）：\n${steps.map((st, i) => `${i + 1}. ${st}`).join('\n') || '(未拆分步骤，可在 goal_loop 中逐步推进)'}\n\n使用 goal_loop 推进目标，goal_status 查看进度。`;
    }

    case 'goal_status': {
      const goal = toolCall.goalId
        ? (queryOne('SELECT * FROM goals WHERE id = ?', [toolCall.goalId]) as Record<string, unknown> | null)
        : (queryOne(
            'SELECT * FROM goals WHERE project_id = ? AND status != \'done\' ORDER BY updated_at DESC LIMIT 1',
            [projectId || null]
          ) as Record<string, unknown> | null) ||
          (queryOne('SELECT * FROM goals ORDER BY updated_at DESC LIMIT 1') as Record<string, unknown> | null);
      if (!goal) return 'No active goal. Use goal_set to create one.';
      return formatGoalStatus(goal);
    }

    case 'goal_loop': {
      const goal = toolCall.goalId
        ? (queryOne('SELECT * FROM goals WHERE id = ?', [toolCall.goalId]) as Record<string, unknown> | null)
        : (queryOne(
            'SELECT * FROM goals WHERE project_id = ? AND status != \'done\' ORDER BY updated_at DESC LIMIT 1',
            [projectId || null]
          ) as Record<string, unknown> | null) ||
          (queryOne('SELECT * FROM goals ORDER BY updated_at DESC LIMIT 1') as Record<string, unknown> | null);
      if (!goal) return 'No active goal. Use goal_set to create one first.';
      if (goal.status === 'done') return 'Goal already done. Use goal_set to create a new one.';

      let steps: string[] = [];
      try { steps = JSON.parse(String(goal.steps_json || '[]')); } catch { steps = []; }
      let notes: string[] = [];
      try { notes = JSON.parse(String(goal.notes_json || '[]')); } catch { notes = []; }

      let currentStep = Number(goal.current_step || 0);
      const noteText = toolCall.note || toolCall.query || '';
      if (noteText) {
        notes.push(`[步骤 ${currentStep + 1}] ${noteText}`);
      }
      if (toolCall.done) {
        runSql("UPDATE goals SET status = 'done', notes_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(notes), Date.now(), goal.id]);
        saveDb();
        logAudit(projectId, 'goal_loop', `完成长期目标：${goal.title}`, 'medium', 'auto');
        return formatGoalStatus({ ...goal, status: 'done', notes_json: JSON.stringify(notes) });
      }
      if (toolCall.milestone) {
        // 里程碑：暂停等待人工确认（权限门会在执行前弹确认）
        runSql("UPDATE goals SET notes_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(notes), Date.now(), goal.id]);
        saveDb();
        logAudit(projectId, 'goal_loop', `目标里程碑暂停待确认：${goal.title}（${noteText || '关键节点'}）`, 'medium', 'approved');
        return formatGoalStatus({ ...goal, current_step: currentStep, notes_json: JSON.stringify(notes) }, true);
      }
      // 普通推进：进入下一步
      if (currentStep < steps.length) currentStep += 1;
      else currentStep += 1;
      runSql("UPDATE goals SET current_step = ?, notes_json = ?, updated_at = ? WHERE id = ?", [currentStep, JSON.stringify(notes), Date.now(), goal.id]);
      saveDb();
      logAudit(projectId, 'goal_loop', `推进目标：${goal.title} 至第 ${currentStep} 步`, 'medium', 'auto');
      return formatGoalStatus({ ...goal, current_step: currentStep, notes_json: JSON.stringify(notes) });
    }


    case 'swarm_init': {
      const tc = toolCall as any;
      const taskDesc = tc.query || tc.message || '未指定任务';
      const topology = tc.topology || undefined;
      const cwd = resolveProjectPath(projectId, '');
      let structure: string[] = [];
      try {
        const entries = fs.readdirSync(cwd, { withFileTypes: true });
        structure = entries
          .filter((e) => !e.name.startsWith('.') && !['node_modules', 'dist', 'build', '.git'].includes(e.name))
          .slice(0, 30)
          .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
      } catch { /* ignore */ }

      // 获取历史失败次数
      const prevFailures = queryOne(
        `SELECT COUNT(*) as cnt FROM agent_memory WHERE namespace = 'learning' AND value LIKE '%false%'`,
        []
      ) as any;
      const failureCount = prevFailures?.cnt || 0;

      const { initSwarm, populateSwarm, saveSwarmToDb } = await import('../swarm/index.js');
      const { inferCharacteristics, analyzeAndRecommend } = await import('../swarm/topology.js');

      const chars = inferCharacteristics(taskDesc, structure, failureCount);
      const rec = topology ? { topology, confidence: 1.0, reasoning: '用户指定', maxConcurrency: 1, agentRoles: [] } : analyzeAndRecommend(chars);

      const swarm = initSwarm(projectId || '', taskDesc, structure, failureCount, topology);
      
      logAudit(projectId, 'swarm_init', `初始化蜂群：${taskDesc.slice(0, 80)}（拓扑: ${rec.topology}，置信度: ${rec.confidence}）`, 'none', 'auto');
      
      return `🐝 Swarm 初始化完成\n\n拓扑: ${rec.topology}\n置信度: ${(rec.confidence * 100).toFixed(0)}%\n原因: ${rec.reasoning}\n最大并发: ${rec.maxConcurrency}\n\n建议角色: ${rec.agentRoles.join(', ')}\n\n使用 swarm_execute 推进任务，team_plan 先制定步骤。`;
    }

    case 'swarm_status': {
      const tc = toolCall as any;
      const { getSwarmStatus, listSwarms } = await import('../swarm/index.js');
      const swarmId = tc.swarmId || tc.query;
      if (swarmId) {
        const swarm = getSwarmStatus(swarmId);
        if (!swarm) return 'Swarm not found: ' + swarmId;
        return `🐝 Swarm ${swarm.id}\n拓扑: ${swarm.topology}\n状态: ${swarm.status}\n任务: ${swarm.tasks.length} 个（${swarm.tasks.filter(t => t.status === 'done').length} 完成）\nAgent: ${swarm.agentIds.length} 个`;
      }
      const swarms = listSwarms(projectId || undefined);
      if (swarms.length === 0) return '当前项目没有活跃的 Swarm。使用 swarm_init 创建。';
      return swarms.map(s => `🐝 ${s.id} | ${s.topology} | ${s.status} | ${s.tasks.length} tasks`).join('\n');
    }

    case 'swarm_list': {
      const { listSwarms } = await import('../swarm/index.js');
      const swarms = listSwarms(projectId || undefined);
      if (swarms.length === 0) return '当前项目没有活跃的 Swarm。';
      return swarms.map(s => `🐝 ${s.id}\n  拓扑: ${s.topology} | 状态: ${s.status}\n  任务: ${s.tasks.filter(t => t.status === 'done').length}/${s.tasks.length} 完成\n  Agent: ${s.agentIds.length} 个`).join('\n\n');
    }

    case 'swarm_execute': {
      const tc = toolCall as any;
      const { executeNextTask, getSwarmStatus } = await import('../swarm/index.js');
      const swarmId = tc.swarmId || tc.query;
      if (!swarmId) return 'Error: swarmId required';
      const task = executeNextTask(swarmId);
      if (!task) return '没有待执行的任务，或没有可用的 Agent。';
      return `⚡ 执行任务 #${task.step}: ${task.title}\n分配给: ${task.assignedAgentId}\n文件: ${task.files.join(', ') || '-'}`;
    }

    case 'swarm_report': {
      const tc = toolCall as any;
      const { reportTaskResult, getSwarmStatus, saveSwarmToDb } = await import('../swarm/index.js');
      const { recordExecution } = await import('../swarm/learning.js');
      const swarmId = tc.swarmId;
      const taskId = tc.taskId;
      const success = tc.success !== false;
      const result = tc.result || tc.query || '';
      if (!swarmId || !taskId) return 'Error: swarmId and taskId required';
      reportTaskResult(swarmId, taskId, success, result);
      const swarm = getSwarmStatus(swarmId);
      if (swarm) {
        if (swarm) saveSwarmToDb(swarm);
        if (swarm.status === 'completed' || swarm.status === 'failed') {
          recordExecution(projectId || '', swarm.objective, swarm.topology, swarm.status === 'completed', {
            complexity: 0, fileCount: 0, steps: swarm.tasks.length, responseTimeMs: 0, retryCount: 0, toolsUsed: [],
          }, swarm.status === 'completed' ? 'Swarm 任务全部完成' : 'Swarm 部分任务失败');
        }
      }
      return `✅ 结果已报告。Swarm 状态: ${swarm?.status || 'unknown'}`;
    }

    case 'agent_spawn': {
      const tc = toolCall as any;
      const { spawnAgent } = await import('../swarm/agentLifecycle.js');
      const type = (tc.type || 'code_engineer') as any;
      const name = tc.name || 'Swarm-Agent';
      const topo = tc.topology || 'flat';
      const agent = spawnAgent(type, name, topo);
      logAudit(projectId, 'agent_spawn', `Spawn Agent: ${name} (${type}, ${topo})`, 'none', 'auto');
      return `🤖 Agent spawned: ${agent.id}\n类型: ${agent.type}\n名称: ${agent.name}\n拓扑: ${agent.topology}\n状态: ${agent.status}`;
    }

    case 'agent_terminate': {
      const tc = toolCall as any;
      const { terminateAgent } = await import('../swarm/agentLifecycle.js');
      const agentId = tc.agentId || tc.query;
      if (!agentId) return 'Error: agentId required';
      const graceful = tc.graceful !== false;
      const ok = terminateAgent(agentId, graceful);
      return ok ? `🔴 Agent ${agentId} terminated` : `Agent ${agentId} not found`;
    }

    case 'consensus_submit': {
      const tc = toolCall as any;
      const { submitProposal } = await import('../swarm/consensus.js');
      const filePath = tc.filePath || tc.path;
      const contentVal = tc.content || tc.query || '';
      if (!filePath) return 'Error: filePath required';
      const proposal = submitProposal('current', 'scheduler', 'file_write', filePath, contentVal);
      logAudit(projectId, 'consensus_submit', `提交变更提案: ${filePath}`, 'medium', 'auto');
      return `📋 提案已提交: ${proposal.id}\n文件: ${filePath}\n状态: ${proposal.state}`;
    }

    case 'consensus_vote': {
      const tc = toolCall as any;
      const { vote } = await import('../swarm/consensus.js');
      const proposalId = tc.proposalId;
      const approve = tc.approve !== false;
      if (!proposalId) return 'Error: proposalId required';
      const result = vote(proposalId, 'scheduler', approve);
      return `🗳️ 投票结果: ${result.accepted ? '✅ 通过' : '⏳ 等待更多投票'}\n票数: ${result.totalVotes}/${result.requiredVotes}`;
    }

    case 'learning_stats': {
      const tc = toolCall as any;
      const { getLearningStats } = await import('../swarm/learning.js');
      const pid = tc.projectId || projectId;
      const stats = getLearningStats(pid);
      return `📊 学习统计\n总执行: ${stats.totalExecutions}\n成功率: ${(stats.successRate * 100).toFixed(1)}%\n平均响应: ${(stats.avgResponseTime / 1000).toFixed(1)}s\n拓扑分布: ${JSON.stringify(stats.topologies)}\n最近洞察: ${stats.recentInsights.join('; ') || '暂无'}`;
    }

    case 'learning_suggest': {
      const { analyzeAndSuggest } = await import('../swarm/learning.js');
      const suggestions = analyzeAndSuggest(projectId || undefined);
      if (suggestions.length === 0) return '暂无优化建议（需要更多执行数据）';
      return suggestions.map(s => `💡 [${s.type}] ${s.suggestion} (置信度: ${(s.confidence * 100).toFixed(0)}%, 基于 ${s.basedOn} 条记录)`).join('\n');
    }

    case 'run_command': {
      if (!toolCall.command) return 'Error: command is required';

      const cwd = resolveProjectPath(projectId, '');
      if (!fs.existsSync(cwd)) return `Error: project directory not found: ${cwd}`;

      const dangerousPatterns = [
        /rm\s+-rf\s+\//,
        /mkfs\./,
        /dd\s+if=/,
        /:\(\)\s*\{/,
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(toolCall.command)) {
          return `Error: Dangerous command blocked: ${toolCall.command}`;
        }
      }

      const { stdout, stderr, exitCode, duration } = await execInProject(cwd, toolCall.command, 30000);

      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return `$ ${toolCall.command} (${duration}ms, exit ${exitCode})\n\n${truncateText(output || '(no output)', 4000)}`;
    }

    case 'run_lint': {
      const cwd = resolveProjectPath(projectId, '');
      const pkgPath = path.join(cwd, 'package.json');
      let cmd = '';
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.scripts?.lint) cmd = 'npm run lint';
          else if (pkg.scripts?.eslint) cmd = 'npm run eslint';
          else cmd = 'npx eslint . --ext .js,.jsx,.ts,.tsx 2>/dev/null || true';
        } catch {
          cmd = 'npx eslint . --ext .js,.jsx,.ts,.tsx 2>/dev/null || true';
        }
      } else if (
        fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
        fs.existsSync(path.join(cwd, 'requirements.txt'))
      ) {
        cmd = 'python3 -m ruff check . 2>/dev/null || python3 -m flake8 . 2>/dev/null || echo "No Python linter found"';
      } else {
        return 'No lint configuration detected (package.json or Python project not found).';
      }
      const { stdout, stderr, exitCode } = await execInProject(cwd, cmd, 120000);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return `Lint ${exitCode === 0 ? 'PASSED' : 'FAILED'} (exit ${exitCode})\n\n${truncateText(output || '(no output)', 6000)}`;
    }

    case 'run_typecheck': {
      const cwd = resolveProjectPath(projectId, '');
      const pkgPath = path.join(cwd, 'package.json');
      let cmd = 'npx tsc --noEmit';
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.scripts?.typecheck) cmd = 'npm run typecheck';
          else if (pkg.scripts?.tsc) cmd = 'npm run tsc';
        } catch {
          // fall back to npx tsc --noEmit
        }
      }
      if (!fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
        return 'No tsconfig.json found; TypeScript typecheck not applicable.';
      }
      const { stdout, stderr, exitCode } = await execInProject(cwd, cmd, 120000);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return `Typecheck ${exitCode === 0 ? 'PASSED' : 'FAILED'} (exit ${exitCode})\n\n${truncateText(output || '(no output)', 6000)}`;
    }

    case 'analyze_code': {
      const cwd = resolveProjectPath(projectId, '');
      const issues: string[] = [];
      let scanned = 0;
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || scanned > 80) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (
            entry.name.startsWith('.') ||
            ['node_modules', 'dist', 'build', 'coverage', '.git'].includes(entry.name)
          ) {
            continue;
          }
          const full = path.join(dir, entry.name);
          const rel = path.relative(cwd, full);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (/\.(ts|tsx|js|jsx|py)$/.test(entry.name)) {
            if (scanned > 80) return;
            scanned++;
            try {
              const stat = fs.statSync(full);
              if (stat.size > 200 * 1024) {
                issues.push(`[HIGH] ${rel}: 文件过大 (${Math.round(stat.size / 1024)}KB)`);
              }
              const content = fs.readFileSync(full, 'utf-8');
              const lines = content.split('\n');
              if (lines.length > 600) {
                issues.push(`[MEDIUM] ${rel}: 行数过多 (${lines.length} 行)`);
              }
              lines.forEach((line, i) => {
                const n = i + 1;
                if (/console\.(log|debug|warn)/.test(line)) issues.push(`[LOW] ${rel}:${n} console 日志残留`);
                else if (/TODO|FIXME|HACK/.test(line)) issues.push(`[LOW] ${rel}:${n} TODO/FIXME 注释`);
                else if (/catch\s*\(.*\)\s*\{\s*\}/.test(line)) issues.push(`[MEDIUM] ${rel}:${n} 空 catch 块`);
                else if (line.length > 120) issues.push(`[LOW] ${rel}:${n} 行过长 (>120)`);
              });
            } catch {
              // skip unreadable files
            }
          }
        }
      };
      walk(cwd, 0);
      if (issues.length === 0) return 'No obvious code quality issues detected.';
      return `Found ${issues.length} issue(s) in ${scanned} file(s):\n\n${issues.slice(0, 50).join('\n')}`;
    }

    case 'auto_fix': {
      const cwd = resolveProjectPath(projectId, '');
      const pkgPath = path.join(cwd, 'package.json');
      let lintCmd = '';
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.scripts?.lint) lintCmd = 'npm run lint -- --fix';
          else lintCmd = 'npx eslint . --fix --ext .js,.jsx,.ts,.tsx';
        } catch {
          lintCmd = 'npx eslint . --fix --ext .js,.jsx,.ts,.tsx';
        }
      } else if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
        lintCmd = 'python3 -m ruff check . --fix 2>/dev/null || echo "No auto-fix tool found"';
      } else {
        return 'No lint/auto-fix configuration detected.';
      }

      const parseChanged = (out: string) =>
        out
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => l.slice(3));

      const before = await execInProject(cwd, 'git status --porcelain');
      const fix = await execInProject(cwd, lintCmd, 120000);
      const after = await execInProject(cwd, 'git status --porcelain');
      const beforeSet = new Set(parseChanged(before.stdout));
      const changed = parseChanged(after.stdout).filter((f) => !beforeSet.has(f));

      // Snapshot changed files (original content from git HEAD)
      try {
        const files: Array<{ path: string; content: string }> = [];
        for (const file of changed.slice(0, 50)) {
          const show = await execInProject(cwd, `git show HEAD:${file}`);
          if (show.exitCode === 0) files.push({ path: file, content: show.stdout });
        }
        if (files.length > 0) createSnapshot(projectId, 'auto-fix 前快照', files);
      } catch {
        // snapshot is best-effort
      }

      const fixOutput = [fix.stdout.trim(), fix.stderr.trim()].filter(Boolean).join('\n') || '(no output)';
      const changedList = changed.length > 0 ? changed.join('\n') : '(no files changed)';

      // 反思评分：修复后重新跑 lint/typecheck，统计剩余错误并给出质量分
      const reLint = await execInProject(cwd, lintCmd.replace(/ --fix/g, ''), 120000);
      const lintErrLines = reLint.stdout.split('\n').filter((l) => /error/i.test(l) && !/\d+ problems?/.test(l)).length;
      let typeErrLines = 0;
      let typeSummary = '(无 tsconfig，跳过类型检查)';
      if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
        const tc = await execInProject(cwd, 'npx tsc --noEmit', 120000);
        typeErrLines = tc.stdout.split('\n').filter((l) => /error TS/i.test(l)).length;
        typeSummary = typeErrLines > 0 ? `${typeErrLines} 个类型错误` : '类型检查通过';
      }
      const qualityScore = Math.max(
        0,
        Math.min(100, 100 - lintErrLines * 8 - typeErrLines * 5 - (changed.length > 30 ? 10 : 0))
      );
      const verdict =
        qualityScore >= 90
          ? '质量达标，可以停止迭代'
          : qualityScore >= 70
            ? '基本稳定，建议再跑一轮 auto_fix 或 analyze_code 收尾'
            : '仍有多处问题，建议继续 auto_fix / analyze_code 直到分数稳定';

      return `Auto-fix finished (exit ${fix.exitCode}):\n${truncateText(fixOutput, 2000)}\n\nChanged files:\n${truncateText(changedList, 1500)}\n\n📊 quality_score: ${qualityScore}/100\n- 剩余 lint 错误：${lintErrLines}\n- 类型检查：${typeSummary}\n- 修改文件数：${changed.length}\n- 判断：${verdict}`;
    }

    case 'git_commit_push': {
      const cwd = resolveProjectPath(projectId, '');
      const message = (toolCall.message || 'chore: auto-fix').replace(/'/g, `'\\''`);
      const add = await execInProject(cwd, 'git add -A');
      if (add.exitCode !== 0) return `git add failed:\n${truncateText(add.stderr, 2000)}`;
      const status = await execInProject(cwd, 'git status --short');
      if (!status.stdout.trim()) return 'No changes to commit.';
      const commit = await execInProject(cwd, `git commit -m '${message}'`);
      if (commit.exitCode !== 0) return `git commit failed:\n${truncateText(commit.stderr, 2000)}`;
      const push = await execInProject(cwd, 'git push');
      const pushOut = [push.stdout.trim(), push.stderr.trim()].filter(Boolean).join('\n');
      return `Committed and pushed.\n\nChanges:\n${truncateText(status.stdout, 2000)}\n\n${commit.stdout.trim()}\n${pushOut}`;
    }

    case 'trigger_build': {
      const cwd = resolveProjectPath(projectId, '');
      const token = getGithubTokenFromSettings();
      if (!token) return 'Error: GitHub token not configured (Settings → GitHub → Access Token)';
      let repo = toolCall.repo;
      if (!repo) {
        const inferred = await inferRepo(cwd);
        if (!inferred) return 'Error: repo (owner/name) is required and could not be inferred from git remote';
        repo = inferred;
      }
      const ref = toolCall.ref || 'main';
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Synaps-App',
        'Content-Type': 'application/json',
      };
      let workflowId = toolCall.workflowId;
      if (!workflowId) {
        const wfRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows`, { headers });
        const wfData = (await wfRes.json()) as { workflows?: Array<{ id?: number }> };
        workflowId = String(wfData.workflows?.[0]?.id);
        if (!workflowId) return `Error: no workflows found for ${repo}`;
      }
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref }),
      });
      if (!res.ok) return `Error: build trigger failed (${res.status}): ${await res.text()}`;
      return `Build triggered for ${repo} (workflow ${workflowId}, ref ${ref}).`;
    }

    case 'check_build_status': {
      const cwd = resolveProjectPath(projectId, '');
      const token = getGithubTokenFromSettings();
      if (!token) return 'Error: GitHub token not configured (Settings → GitHub → Access Token)';
      let repo = toolCall.repo;
      if (!repo) {
        const inferred = await inferRepo(cwd);
        if (!inferred) return 'Error: repo (owner/name) is required and could not be inferred from git remote';
        repo = inferred;
      }
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Synaps-App',
      };
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=5`, { headers });
      if (!res.ok) return `Error: query failed (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        workflow_runs?: Array<{
          status?: string;
          conclusion?: string | null;
          name?: string;
          run_number?: number;
          created_at?: string;
        }>;
      };
      const runs = (data.workflow_runs || []).map((r: any) =>
        `${r.status}${r.conclusion ? '/' + r.conclusion : ''} ${r.name} #${r.run_number} ${r.created_at}`
      );
      return runs.length > 0 ? runs.join('\n') : 'No build runs found.';
    }

    case 'download_and_install': {
      const url = (toolCall.url || '').replace(/'/g, '');
      if (!url) return 'Error: url (APK download link) is required';
      if (!/^https?:\/\//.test(url)) return 'Error: invalid url (must start with http/https)';
      const apkPath = `/sdcard/Download/synaps-${Date.now()}.apk`;
      const dl = await execInProject(process.cwd(), `curl -sL --max-time 300 -o '${apkPath}' '${url}'`, 320000);
      let size = -1;
      try {
        size = fs.statSync(apkPath).size;
      } catch {
        // not downloaded
      }
      if (size <= 0) return `Error: APK download failed.\n${truncateText(dl.stderr, 2000)}`;
      const install = await execInProject(process.cwd(), `su -c "pm install -r '${apkPath}'"`, 60000);
      if (install.exitCode === 0) {
        return `APK installed successfully (${Math.round(size / 1024 / 1024)}MB). Path: ${apkPath}`;
      }
      return `APK downloaded to ${apkPath} (${Math.round(size / 1024 / 1024)}MB), but automatic install failed:\n${truncateText(install.stderr, 2000)}\n\nYou can install it manually from the Download folder.`;
    }

    case 'search_tools': {
      const query = toolCall.query;
      if (!query) return 'Error: query is required';
      const results: string[] = [];

      try {
        const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`);
        const data = (await res.json()) as {
          objects?: Array<{ package?: { name?: string; version?: string; description?: string } }>;
        };
        if (data.objects && data.objects.length > 0) {
          results.push('npm packages:');
          for (const obj of data.objects.slice(0, 5)) {
            const pkg = obj.package || {};
            results.push(`- ${pkg.name}@${pkg.version || ''}${pkg.description ? `: ${pkg.description}` : ''}`);
          }
        }
      } catch {
        results.push('(npm search unavailable)');
      }

      try {
        const res = await fetch(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`,
          { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Synaps-App' } }
        );
        const data = (await res.json()) as {
          items?: Array<{ full_name?: string; description?: string | null; stargazers_count?: number }>;
        };
        if (data.items && data.items.length > 0) {
          results.push('GitHub repos:');
          for (const item of data.items.slice(0, 5)) {
            results.push(`- ${item.full_name} (${item.stargazers_count || 0}★): ${item.description || ''}`);
          }
        }
      } catch {
        results.push('(GitHub search unavailable)');
      }

      return results.length > 0
        ? results.join('\n')
        : `No results found for "${query}".`;
    }

    case 'web_search': {
      const query = toolCall.query || toolCall.task;
      if (!query) return 'Error: web_search requires a query argument';
      const clean = (t: string) =>
        t
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim();
      const format = (rs: Array<{ title: string; url: string; snippet: string }>) =>
        rs.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
      try {
        // 1) DuckDuckGo lite（免 Key；数据中心 IP 可能触发验证码）
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const res = await fetch('https://lite.duckduckgo.com/lite/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `q=${encodeURIComponent(query)}`,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const html = await res.text();
        const linkRe = /<a\b[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/g;
        const snipRe = /<td class='result-snippet'>([\s\S]*?)<\/td>/g;
        const links: Array<{ url: string; title: string }> = [];
        let lm: RegExpExecArray | null;
        while ((lm = linkRe.exec(html)) && links.length < 6) {
          const href = lm[0].match(/href="([^"]+)"/);
          links.push({ url: clean(href ? href[1] : ''), title: clean(lm[1] || '(无标题)') });
        }
        const snips: string[] = [];
        let sm: RegExpExecArray | null;
        while ((sm = snipRe.exec(html))) {
          snips.push(clean(sm[1]));
        }
        const ddgResults = links.map((l, i) => ({ title: l.title, url: l.url, snippet: snips[i] || '' })).filter((r) => r.url);
        if (ddgResults.length > 0) {
          return format(ddgResults);
        }

        // 2) 回退：Bing 网页搜索（免 Key）
        const bingRes = await fetch(
          `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&mkt=zh-CN`,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
              'Accept-Language': 'zh-CN,zh;q=0.9',
            },
            signal: AbortSignal.timeout(12000),
          }
        );
        const bingHtml = await bingRes.text();
        const bingResults: Array<{ title: string; url: string; snippet: string }> = [];
        let pos = 0;
        while (bingResults.length < 6) {
          const start = bingHtml.indexOf('<li class="b_algo"', pos);
          if (start < 0) break;
          let depth = 0;
          let i = start;
          for (; i < bingHtml.length; i++) {
            if (bingHtml.startsWith('<li', i)) depth++;
            if (bingHtml.startsWith('</li>', i)) depth--;
            if (depth === 0) break;
          }
          const block = bingHtml.slice(start, i + 5);
          const h = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*><h2[^>]*>([\s\S]*?)<\/h2><\/a>/);
          const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          if (h) {
            bingResults.push({ url: clean(h[1]), title: clean(h[2]), snippet: p ? clean(p[1]) : '' });
          }
          pos = i + 5;
        }
        if (bingResults.length > 0) {
          return format(bingResults);
        }
        return `web_search「${query}」无结果（DuckDuckGo 与 Bing 均未返回内容，可能是临时限流，可稍后重试）`;
      } catch (err) {
        return `web_search 失败：${(err as Error).message}`;
      }
    }

    case 'install_tool': {
      const toolName = toolCall.query;
      if (!toolName) return 'Error: query (package/tool name) is required';
      const manager = (toolCall.manager || 'auto').toLowerCase();

      let cmd = '';
      if (manager === 'npm') {
        cmd = `npm install -g ${toolName}`;
      } else if (manager === 'pip' || manager === 'python') {
        cmd = `pip install ${toolName} 2>/dev/null || pip3 install ${toolName}`;
      } else if (manager === 'auto') {
        if (/^[a-z0-9-_.]+$/.test(toolName)) {
          cmd = `npm install -g ${toolName} 2>/dev/null || pip install ${toolName} 2>/dev/null || pip3 install ${toolName}`;
        } else {
          cmd = `pip install ${toolName} 2>/dev/null || pip3 install ${toolName}`;
        }
      } else {
        return 'Error: unsupported manager (use npm, pip, or auto)';
      }

      const cwd = resolveProjectPath(projectId, '');
      const r = await execInProject(cwd, cmd, 180000);

      if (r.exitCode === 0) {
        try {
          const row = queryOne('SELECT value FROM settings WHERE key = ?', ['installed_tools']);
          let list: string[] = [];
          try {
            const parsed = JSON.parse((row && typeof row.value === 'string' ? row.value : '[]'));
            if (Array.isArray(parsed)) list = parsed.filter((x) => typeof x === 'string');
          } catch {
            // reset list
          }
          if (!list.includes(toolName)) {
            list.push(toolName);
            runSql(
              `INSERT INTO settings (key, value, updated_at) VALUES ('installed_tools', ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
              [JSON.stringify(list)]
            );
            saveDb();
          }
        } catch (err) {
          console.error('Failed to persist installed tool:', err);
        }
      }

      const output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
      return r.exitCode === 0
        ? `Tool installed: ${toolName} (${manager}). It is available immediately; no restart needed.\n\n${truncateText(output, 2000)}`
        : `Install failed (exit ${r.exitCode}):\n${truncateText(output, 2000)}`;
    }

    case 'list_tools': {
      try {
        const row = queryOne('SELECT value FROM settings WHERE key = ?', ['installed_tools']);
        let list: string[] = [];
        try {
          const parsed = JSON.parse((row && typeof row.value === 'string' ? row.value : '[]'));
          if (Array.isArray(parsed)) list = parsed.filter((x) => typeof x === 'string');
        } catch {
          // treat as empty
        }
        return list.length > 0
          ? `Installed tools (${list.length}):\n${list.map((t) => `- ${t}`).join('\n')}`
          : 'No tools installed yet. Use install_tool to install one.';
      } catch {
        return 'No tools installed yet.';
      }
    }

    case 'mcp_list_servers': {
      const servers = getMcpServers();
      if (servers.length === 0) {
        return 'No MCP servers configured. Use mcp_add_server to add one (stdio or sse).';
      }
      return servers
        .map((srv) => `- ${srv.name} (${srv.transport}${srv.transport === 'stdio' ? `: ${srv.command || ''} ${(srv.args || []).join(' ')}` : `: ${srv.url || ''}`})`)
        .join('\n');
    }

    case 'mcp_add_server': {
      const name = toolCall.server;
      if (!name) return 'Error: server (name) is required';
      const transport = (toolCall.manager || '').toLowerCase();
      if (transport !== 'stdio' && transport !== 'sse') {
        return 'Error: manager must be "stdio" or "sse"';
      }
      if (transport === 'stdio' && !toolCall.command) {
        return 'Error: stdio server requires a command';
      }
      if (transport === 'sse' && !toolCall.url) {
        return 'Error: sse server requires a url';
      }
      const servers = getMcpServers().filter((srv) => srv.name !== name);
      const args = Array.isArray(toolCall.params?.args) ? (toolCall.params.args as unknown[]).map(String) : [];
      servers.push({ name, transport, command: toolCall.command, args, url: toolCall.url });
      setMcpServers(servers);
      return `MCP server "${name}" registered (${transport}). Use mcp_list_tools to discover its tools.`;
    }

    case 'mcp_list_tools': {
      const serverName = toolCall.server;
      if (!serverName) return 'Error: server (name) is required';
      return await mcpListTools(serverName);
    }

    case 'mcp_call': {
      const serverName = toolCall.server;
      const method = toolCall.method;
      if (!serverName) return 'Error: server (name) is required';
      if (!method) return 'Error: method (MCP tool name) is required';
      return await mcpCallTool(serverName, method, toolCall.params || {});
    }

    case 'security_scan': {
      const cwd = resolveProjectPath(projectId, '');
      const target = toolCall.path ? resolveProjectPath(projectId, toolCall.path) : cwd;
      if (!fs.existsSync(target)) return `Error: path not found: ${toolCall.path || '(project root)'}`;
      const issues = fs.statSync(target).isDirectory() ? scanProject(target) : scanFile(target);
      return `Security scan of ${toolCall.path || '.'}:\n\n${formatIssues(issues)}`;
    }

    case 'security_fix': {
      const apiKeyRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_api_key']);
      const apiKey = apiKeyRow && typeof apiKeyRow.value === 'string' ? apiKeyRow.value : '';
      if (!apiKey) return 'Error: DeepSeek API Key not configured (Settings → AI 模型)';
      const baseUrlRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_base_url']);
      const baseUrl = baseUrlRow && typeof baseUrlRow.value === 'string' && baseUrlRow.value
        ? baseUrlRow.value
        : 'https://api.deepseek.com';
      const modelRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_model']);
      const model = modelRow && typeof modelRow.value === 'string' && modelRow.value
        ? modelRow.value
        : 'deepseek-v4-flash';

      const cwd = resolveProjectPath(projectId, '');
      const target = toolCall.path ? resolveProjectPath(projectId, toolCall.path) : cwd;
      if (!fs.existsSync(target)) return `Error: path not found: ${toolCall.path || '(project root)'}`;
      const issues = fs.statSync(target).isDirectory() ? scanProject(target) : scanFile(target);
      if (issues.length === 0) return 'No security issues found; nothing to fix.';

      const byFile = new Map<string, SecurityIssue[]>();
      for (const issue of issues) {
        const list = byFile.get(issue.file) || [];
        list.push(issue);
        byFile.set(issue.file, list);
      }

      const fixes: string[] = [];
      for (const [rel, fileIssues] of [...byFile.entries()].slice(0, 5)) {
        const full = path.join(cwd, rel);
        let content: string;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 300 * 1024) {
            fixes.push(`Skipped ${rel}: file too large (${Math.round(stat.size / 1024)}KB)`);
            continue;
          }
          content = fs.readFileSync(full, 'utf-8');
        } catch {
          fixes.push(`Skipped ${rel}: unreadable`);
          continue;
        }

        const issueList = fileIssues
          .map((i) => `- [${i.severity}] line ${i.line}: ${i.message} (${i.rule})`)
          .join('\n');
        const userPrompt = `Fix the security issues in this file. Return ONLY the complete fixed file content wrapped in a single code block, no explanations, no diff.\n\nSecurity issues:\n${issueList}\n\nFile: ${rel}\n\n\`\`\`\n${content}\n\`\`\``;

        let fixed: string;
        try {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: 'You are a senior security engineer. Only output code, never explanations.' },
                { role: 'user', content: userPrompt },
              ],
              temperature: 0.1,
              max_tokens: 8000,
            }),
          });
          if (!res.ok) {
            fixes.push(`Fix failed for ${rel}: HTTP ${res.status}`);
            continue;
          }
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const raw = data.choices?.[0]?.message?.content || '';
          const m = raw.match(/```(?:\w+)?\n([\s\S]*?)```/);
          fixed = m ? m[1] : raw;
        } catch (err: any) {
          fixes.push(`Fix failed for ${rel}: ${err?.message || String(err)}`);
          continue;
        }

        if (!fixed.trim() || fixed.trim() === content.trim()) {
          fixes.push(`No change for ${rel}`);
          continue;
        }

        try {
          createSnapshot(projectId, 'security_fix 前快照', [{ path: rel, content }]);
        } catch {
          // best-effort
        }
        fs.writeFileSync(full, fixed, 'utf-8');
        fixes.push(`Fixed ${rel} (${content.length} → ${fixed.length} bytes)`);
      }

      const remaining = fs.statSync(target).isDirectory() ? scanProject(target) : scanFile(target);
      return `Applied fixes:\n${fixes.join('\n') || '(none)'}\n\nRe-scan: ${remaining.length} issue(s) remaining.\n\n${formatIssues(remaining.slice(0, 10))}`;
    }

    case 'generate_tests': {
      const relPath = toolCall.path;
      if (!relPath) return 'Error: path is required';
      if (/\.(test|spec)\./.test(relPath)) return `Error: ${relPath} looks like a test file already`;
      const cwd = resolveProjectPath(projectId, '');
      const filePath = resolveProjectPath(projectId, relPath);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return `Error: file not found: ${relPath}`;
      }
      const stat = fs.statSync(filePath);
      if (stat.size > 300 * 1024) return `Error: file too large (${Math.round(stat.size / 1024)}KB)`;
      const content = fs.readFileSync(filePath, 'utf-8');

      let framework = 'jest';
      let testPath = relPath.replace(/(\.tsx?|\.jsx?|\.mjs)$/, '') + '.test.ts';
      const pkgPath = path.join(cwd, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          if (deps.vitest) framework = 'vitest';
        } catch {
          // keep jest default
        }
      } else if (/\.py$/.test(relPath)) {
        framework = 'pytest';
        testPath = relPath.replace(/(^|\/)([^/]+)\.py$/, '$1test_$2.py');
      }

      const { apiKey, baseUrl, model } = getAiConfig();
      if (!apiKey) return 'Error: DeepSeek API Key not configured (Settings → AI 模型)';

      const userPrompt = `Generate unit tests for the file below using ${framework}. Return ONLY the complete test file content in a single code block, no explanations.\n\nFile: ${relPath}\n\n\`\`\`\n${content}\n\`\`\``;
      let testContent: string;
      try {
        testContent = await aiComplete(
          apiKey,
          baseUrl,
          model,
          `You are a senior test engineer. Only output code, never explanations. Use ${framework}.`,
          userPrompt
        );
      } catch (err: any) {
        return `Error generating tests: ${err?.message || String(err)}`;
      }
      if (!testContent.trim()) return 'Error: model returned empty test content';

      const absTestPath = path.join(cwd, testPath);
      const testDir = path.dirname(absTestPath);
      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
      try {
        createSnapshot(projectId, 'generate_tests 前快照', [
          { path: testPath, content: fs.existsSync(absTestPath) ? fs.readFileSync(absTestPath, 'utf-8') : '' },
        ]);
      } catch {
        // best-effort
      }
      fs.writeFileSync(absTestPath, testContent, 'utf-8');
      return `Generated ${testPath} (${testContent.length} bytes, ${framework}).\n\nRun run_tests to execute the suite.`;
    }

    case 'run_tests': {
      const cwd = resolveProjectPath(projectId, '');
      const cmd = detectTestCommand(cwd);
      if (!cmd) {
        return 'No test configuration detected (package.json test script, jest/vitest, or pytest).';
      }
      const r = await execInProject(cwd, cmd, 300000);
      const output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
      return `Tests ${r.exitCode === 0 ? 'PASSED' : 'FAILED'} (exit ${r.exitCode}, ${r.duration}ms)\n\n${truncateText(output || '(no output)', 6000)}`;
    }

    case 'auto_test_fix': {
      const { apiKey, baseUrl, model } = getAiConfig();
      if (!apiKey) return 'Error: DeepSeek API Key not configured (Settings → AI 模型)';
      const cwd = resolveProjectPath(projectId, '');
      const testCmd = detectTestCommand(cwd);
      if (!testCmd) return 'No test configuration detected.';

      const run = await execInProject(cwd, testCmd, 300000);
      const testOutput = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n');
      if (run.exitCode === 0) return `Tests already pass (exit 0).\n\n${truncateText(testOutput, 3000)}`;

      let files: string[] = [];
      if (toolCall.path) {
        files = [toolCall.path];
      } else {
        const status = await execInProject(cwd, 'git status --porcelain');
        files = status.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => l.slice(3));
      }
      if (files.length === 0) {
        return `Tests failed:\n${truncateText(testOutput, 3000)}\n\nNo changed files to fix and no path given. Pass path to auto_test_fix.`;
      }

      const failureSnippet = testOutput.slice(-4000);
      const fixes: string[] = [];
      for (const rel of files.slice(0, 3)) {
        const full = path.join(cwd, rel);
        if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
        if (!/\.(ts|tsx|js|jsx|py)$/.test(rel)) continue;
        const fstat = fs.statSync(full);
        if (fstat.size > 300 * 1024) {
          fixes.push(`Skipped ${rel}: too large`);
          continue;
        }
        const content = fs.readFileSync(full, 'utf-8');
        const userPrompt = `Tests are failing. Fix the code in this file so the tests pass. Return ONLY the complete fixed file content in a single code block, no explanations.\n\nTest output (tail):\n${failureSnippet}\n\nFile: ${rel}\n\n\`\`\`\n${content}\n\`\`\``;
        let fixed: string;
        try {
          fixed = await aiComplete(
            apiKey,
            baseUrl,
            model,
            'You are a senior software engineer. Only output code, never explanations.',
            userPrompt
          );
        } catch (err: any) {
          fixes.push(`Fix failed for ${rel}: ${err?.message || String(err)}`);
          continue;
        }
        if (!fixed.trim() || fixed.trim() === content.trim()) {
          fixes.push(`No change for ${rel}`);
          continue;
        }
        try {
          createSnapshot(projectId, 'auto_test_fix 前快照', [{ path: rel, content }]);
        } catch {
          // best-effort
        }
        fs.writeFileSync(full, fixed, 'utf-8');
        fixes.push(`Fixed ${rel} (${content.length} → ${fixed.length} bytes)`);
      }

      const rerun = await execInProject(cwd, testCmd, 300000);
      const rerunOut = [rerun.stdout.trim(), rerun.stderr.trim()].filter(Boolean).join('\n');
      return `Applied fixes:\n${fixes.join('\n') || '(none)'}\n\nRe-run tests: ${rerun.exitCode === 0 ? 'PASSED' : 'STILL FAILING'} (exit ${rerun.exitCode})\n\n${truncateText(rerunOut.slice(-3000), 3000)}`;
    }

    case 'team_plan': {
      if (!projectId) return 'Error: 制定团队计划需要先绑定项目（请在聊天页顶部选择或创建一个项目后再试）';
      const { apiKey, baseUrl, model } = getAiConfig();
      if (!apiKey) return 'Error: DeepSeek API Key not configured (Settings → AI 模型)';
      const task = toolCall.query || '未指定任务';
      const cwd = resolveProjectPath(projectId, '');
      let structure = '';
      try {
        const entries = fs.readdirSync(cwd, { withFileTypes: true });
        structure = entries
          .filter((e) => !e.name.startsWith('.') && !['node_modules', 'dist', 'build', '.git'].includes(e.name))
          .slice(0, 30)
          .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
          .join('\n');
      } catch {
        // ignore
      }
      const system =
        'You are the PLANNER on a software engineering team. Break the task into concrete implementation steps. ' +
        'Output ONLY a JSON array (no markdown fences, no explanations) with this shape: ' +
        '[{"step":1,"title":"具体步骤","role":"engineer","files":["涉及文件路径"]}]. ' +
        'Each step must be small enough for one agent action. Roles: engineer only.';
      const user = `Task: ${task}\n\nProject structure (top level):\n${structure || '(empty)'}`;
      let raw: string;
      try {
        raw = await aiComplete(apiKey, baseUrl, model, system, user);
      } catch (err: any) {
        return `Planning failed: ${err?.message || String(err)}`;
      }
      const tasks = parseTaskList(raw);
      if (tasks.length === 0) {
        return `Planning failed: no valid task list returned. Raw output:\n${raw.slice(0, 1000)}`;
      }
      saveTeamPlan(projectId, task, tasks);
      return `Plan created (${tasks.length} steps), persisted to database:\n\n${tasks
        .map((t) => `${t.step}. [${t.role}] ${t.title}${t.files.length ? ` (${t.files.join(', ')})` : ''}`)
        .join('\n')}\n\nUse team_execute to implement (step number or auto-pick next), then team_test and team_review.`;
    }

    case 'team_execute': {
      const { apiKey, baseUrl, model } = getAiConfig();
      if (!apiKey) return 'Error: DeepSeek API Key not configured (Settings → AI 模型)';
      const plan = loadTeamPlan(projectId);
      if (!plan) return 'No team plan found. Run team_plan first.';

      const stepArg = toolCall.query ? parseInt(toolCall.query, 10) : NaN;
      const stepIndex = Number.isNaN(stepArg)
        ? plan.tasks.findIndex((t) => t.status !== 'done')
        : stepArg - 1;
      if (stepIndex < 0 || stepIndex >= plan.tasks.length) {
        return `Invalid step: ${toolCall.query || 'none'}. Plan has ${plan.tasks.length} steps.`;
      }
      const task = plan.tasks[stepIndex];

      const cwd = resolveProjectPath(projectId, '');
      const context = buildProjectContext(cwd, task.files);
      const system =
        'You are the CODE ENGINEER on a software engineering team. Implement the given step. ' +
        'Output ONLY a JSON object (no markdown fences) with this shape: ' +
        '{"files":[{"path":"relative/path","content":"complete file content"}],"note":"简短说明做了什么"}. ' +
        'Only include files you create or modify. Content must be complete files, never diffs.';
      const user = `Step ${task.step}: ${task.title}${task.files.length ? `\nTarget files: ${task.files.join(', ')}` : ''}\n\n${context}`;
      let raw: string;
      try {
        raw = await aiComplete(apiKey, baseUrl, model, system, user);
      } catch (err: any) {
        grantSchedulerTempPerms(projectId, sessionId, SCHEDULER_TEMP_TOOLS, `子 Agent 执行步骤 ${task.step} 失败（LLM 错误）`, 'auto');
        return `Execute failed for step ${task.step}: ${err?.message || String(err)}\n\n[调度员] 已自动获得临时执行权限（write_file / run_command，10 分钟有效）。请直接修复该步骤，修复后运行 team_test 验证，通过后权限自动回收。`;
      }
      const result = parseEngineerOutput(raw);
      if (result.files.length === 0) {
        task.status = 'failed';
        task.detail = result.note || 'No file changes produced';
        updateTeamPlan(plan);
        grantSchedulerTempPerms(projectId, sessionId, SCHEDULER_TEMP_TOOLS, `子 Agent 执行步骤 ${task.step} 未产出文件`, 'auto');
        return `Step ${task.step} produced no files.\n\n${result.note || raw.slice(0, 500)}\n\n[调度员] 已自动获得临时执行权限（write_file / run_command，10 分钟有效）。请直接修复该步骤，修复后运行 team_test 验证，通过后权限自动回收。`;
      }

      const written: string[] = [];
      for (const f of result.files.slice(0, 10)) {
        const abs = path.join(cwd, f.path);
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        try {
          createSnapshot(projectId, `team_execute 步骤${task.step} 前快照`, [
            { path: f.path, content: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '' },
          ]);
        } catch {
          // best-effort
        }
        fs.writeFileSync(abs, f.content, 'utf-8');
        written.push(f.path);
      }
      task.status = 'done';
      task.detail = result.note || '';
      updateTeamPlan(plan);
      return `Step ${task.step} done: ${task.title}\n\n${result.note || ''}\n\nWrote ${written.length} file(s):\n${written.join('\n')}`;
    }

    case 'team_test': {
      const cwd = resolveProjectPath(projectId, '');
      const cmd = detectTestCommand(cwd);
      if (!cmd) return 'No test configuration detected.';
      const r = await execInProject(cwd, cmd, 300000);
      const output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
      if (r.exitCode === 0) {
        revokeSchedulerTempPerms(projectId, sessionId, 'team_test 通过，调度员修复完成，回收临时权限');
        return `Tests PASSED (exit 0, ${r.duration}ms)\n\n${truncateText(output, 3000)}`;
      }
      const { apiKey, baseUrl, model } = getAiConfig();
      if (apiKey) {
        try {
          const analysis = await aiComplete(
            apiKey,
            baseUrl,
            model,
            'You are the QA TESTER on a software engineering team. Analyze the failing test output and list likely root causes and concrete fixes concisely, in the same language as the user.',
            `Test output (tail):\n${output.slice(-4000)}`
          );
          return `Tests FAILED (exit ${r.exitCode})\n\n${truncateText(output.slice(-3000), 3000)}\n\nTester analysis:\n${analysis}`;
        } catch {
          // fall through to raw output
        }
      }
      return `Tests FAILED (exit ${r.exitCode})\n\n${truncateText(output, 4000)}`;
    }

    case 'team_review': {
      const cwd = resolveProjectPath(projectId, '');
      const diff = await execInProject(cwd, 'git diff --stat && echo "---" && git diff | head -300');
      const issues = scanProject(cwd);
      const checks = [
        `Security scan: ${issues.length > 0 ? issues.length + ' issue(s)' : 'clean'}`,
      ];
      if (issues.length > 0) checks.push(formatIssues(issues.slice(0, 10)));

      const { apiKey, baseUrl, model } = getAiConfig();
      if (!apiKey) {
        return `Review (no AI):\n\n${checks.join('\n')}\n\n${truncateText(diff.stdout, 3000)}`;
      }
      const system =
        'You are the REVIEWER on a software engineering team. Review the changes and decide PASS or FAIL. ' +
        "Output a concise review in the user language: verdict (PASS/FAIL), issues found (severity + file/line), and suggestions. " +
        'Do not rubber-stamp: look for correctness bugs, security risks, and missing tests.';
      const user = `Code changes:\n${truncateText(diff.stdout || '(no diff in working tree)', 5000)}\n\nChecks:\n${checks.join('\n')}`;
      let review: string;
      try {
        review = await aiComplete(apiKey, baseUrl, model, system, user);
      } catch (err: any) {
        return `Review failed: ${err?.message || String(err)}`;
      }
      return `Review report:\n\n${review}`;
    }

    case 'team_status': {
      const plan = loadTeamPlan(projectId);
      if (!plan) return 'No team plan found. Run team_plan to create one.';
      const done = plan.tasks.filter((t) => t.status === 'done').length;
      const failed = plan.tasks.filter((t) => t.status === 'failed').length;
      return `Task: ${plan.title} (${done}/${plan.tasks.length} done${failed ? `, ${failed} failed` : ''})\n\n${plan.tasks
        .map((t) => `${t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : '⬜'} ${t.step}. [${t.role}] ${t.title}${t.detail ? ` — ${t.detail}` : ''}`)
        .join('\n')}`;
    }

    case 'skill_deps': {
      const skillName = toolCall.query;
      if (!skillName) return 'Error: query (skill name) is required';
      const row = queryOne('SELECT name, description, metadata FROM skills WHERE name = ?', [skillName]) as Record<string, string> | null;
      if (!row) return `Skill "${skillName}" not found. Use list_skills to see available skills.`;
      let metadata: Record<string, any> = {};
      try {
        metadata = JSON.parse(row.metadata || '{}');
      } catch {
        // treat as empty
      }

      const report: string[] = [`Skill: ${skillName}`, ''];
      let missing = 0;

      const dependsOn = Array.isArray(metadata.dependsOn) ? metadata.dependsOn.filter((d: unknown) => typeof d === 'string') : [];
      if (dependsOn.length > 0) {
        report.push(`Dependency skills (${dependsOn.length}):`);
        for (const dep of dependsOn) {
          const depRow = queryOne('SELECT enabled FROM skills WHERE name = ?', [dep]) as Record<string, number> | null;
          if (depRow && depRow.enabled === 1) {
            report.push(`  ✅ ${dep}`);
          } else {
            report.push(`  ❌ ${dep} (missing or disabled)`);
            missing++;
          }
        }
      }

      const mcp = Array.isArray(metadata.mcp) ? metadata.mcp : [];
      if (mcp.length > 0) {
        report.push(`MCP servers (${mcp.length}):`);
        const servers = getMcpServers();
        for (const cfg of mcp) {
          const name = cfg && typeof cfg === 'object' && typeof (cfg as any).name === 'string' ? (cfg as any).name : '?';
          if (servers.some((sv) => sv.name === name)) {
            report.push(`  ✅ ${name}`);
          } else {
            report.push(`  ❌ ${name} (not configured)`);
            missing++;
          }
        }
      }

      const packages = Array.isArray(metadata.packages) ? metadata.packages.filter((p: unknown) => typeof p === 'string') : [];
      if (packages.length > 0) {
        report.push(`Packages (${packages.length}):`);
        const toolsRow = queryOne('SELECT value FROM settings WHERE key = ?', ['installed_tools']);
        let installed: string[] = [];
        try {
          const parsed = JSON.parse(toolsRow && typeof toolsRow.value === 'string' ? toolsRow.value : '[]');
          if (Array.isArray(parsed)) installed = parsed.filter((x: unknown) => typeof x === 'string');
        } catch {
          // empty
        }
        for (const pkg of packages) {
          if (installed.includes(pkg)) {
            report.push(`  ✅ ${pkg}`);
          } else {
            report.push(`  ❌ ${pkg} (not installed)`);
            missing++;
          }
        }
      }

      const envKeys = Array.isArray(metadata.env) ? metadata.env.filter((e: unknown) => typeof e === 'string') : [];
      if (envKeys.length > 0) {
        report.push(`Env/settings (${envKeys.length}):`);
        for (const key of envKeys) {
          const val = queryOne('SELECT value FROM settings WHERE key = ?', [key]) as Record<string, string> | null;
          if (val && typeof val.value === 'string' && val.value) {
            report.push(`  ✅ ${key}`);
          } else {
            report.push(`  ❌ ${key} (not configured)`);
            missing++;
          }
        }
      }

      if (missing === 0) {
        report.push('', 'All dependencies satisfied.');
      } else {
        report.push('', `${missing} missing dependency(ies). Use install_tool / mcp_add_server / Settings to resolve them.`);
      }
      return report.join('\n');
    }

    case 'project_export': {
      const project = queryOne('SELECT id, name, path FROM projects WHERE id = ?', [projectId]) as Record<string, string> | null;
      const settings: Record<string, string> = {};
      const keys = ['ai_model', 'ai_base_url', 'ai_model_base_url', 'github_token', 'github_auto_push', 'termux_path', 'build_method', 'snapshot_enabled', 'diff_review_enabled', 'trusted_projects', 'mcp_servers', 'installed_tools'];
      for (const key of keys) {
        const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]) as Record<string, string> | null;
        if (row && typeof row.value === 'string') settings[key] = row.value;
      }
      const skills = queryAll('SELECT name, description, content, metadata, source, enabled FROM skills ORDER BY name') as Record<string, unknown>[];

      const pack = {
        format: 'synaps-agentpack',
        version: 1,
        exportedAt: new Date().toISOString(),
        project: project ? { id: project.id, name: project.name, path: project.path } : null,
        settings,
        skills,
      };
      return `AgentPack export (${JSON.stringify(pack).length} bytes):\n\n\`\`\`json\n${JSON.stringify(pack, null, 2).slice(0, 20000)}\n\`\`\``;
    }

    case 'project_import': {
      const rawConfig = typeof toolCall.params?.config === 'string' ? toolCall.params.config : '';
      if (!rawConfig.trim()) return 'Error: params.config (AgentPack JSON string) is required';
      let pack: any;
      try {
        pack = JSON.parse(rawConfig);
      } catch {
        return 'Error: params.config is not valid JSON';
      }
      if (pack.format !== 'synaps-agentpack') {
        return `Error: not a Synaps AgentPack (format: ${pack.format || 'unknown'})`;
      }

      const applied: string[] = [];
      if (pack.settings && typeof pack.settings === 'object') {
        for (const [key, value] of Object.entries(pack.settings)) {
          if (typeof value !== 'string') continue;
          runSql(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
            [key, value]
          );
        }
        applied.push(`settings: ${Object.keys(pack.settings).length} keys`);
      }
      if (Array.isArray(pack.skills)) {
        let imported = 0;
        for (const item of pack.skills) {
          if (!item || typeof item.name !== 'string' || typeof item.content !== 'string') continue;
          const id = `import_${crypto.randomUUID()}`;
          runSql(
            `INSERT INTO skills (id, name, description, content, metadata, source, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               description = excluded.description,
               content = excluded.content,
               metadata = excluded.metadata,
               source = excluded.source,
               enabled = excluded.enabled,
               updated_at = datetime('now')`,
            [id, item.name, item.description || '', item.content, JSON.stringify(item.metadata || {}), item.source || '', item.enabled === 1 || item.enabled === true ? 1 : 1]
          );
          imported++;
        }
        applied.push(`skills: ${imported}`);
      }
      saveDb();
      return `AgentPack imported successfully.\n\nApplied: ${applied.join(', ')}.`;
    }

    case 'harness_status': {
      return JSON.stringify(harnessStatus(), null, 2);
    }

    case 'codex_status': {
      return JSON.stringify({ ...codexStatus(), bridge: await checkCodexBridge() }, null, 2);
    }

    case 'codex_exec': {
      const task = toolCall.task || toolCall.query;
      if (!task) return 'Error: codex_exec requires a task argument (use task field)';
      let projectPath: string | undefined;
      try {
        projectPath = resolveProjectPath(projectId, '');
      } catch {
        projectPath = undefined;
      }
      try {
        const result = await runCodexTask(task, projectPath);
        return `[Codex result]\n${result}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    }

    case 'brain_status': {
      return JSON.stringify({ ...codexStatus(), bridge: await checkCodexBridge() }, null, 2);
    }

    case 'brain_exec': {
      const brain = String(toolCall.brain || '');
      const task = toolCall.task || toolCall.query;
      if (!task) return 'Error: brain_exec requires a task argument (use task field)';
      if (!brain) return `Error: brain_exec requires a brain argument. 可用大脑：${BRAIN_IDS.join(', ')}`;
      let projectPath: string | undefined;
      try {
        projectPath = resolveProjectPath(projectId, '');
      } catch {
        projectPath = undefined;
      }
      try {
        const result = await runBrainTask(brain, task, projectPath);
        return `[Brain ${brain} result]\n${result}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    }

    case 'harness_run': {
      const task = toolCall.task || toolCall.query;
      if (!task) return 'Error: harness_run requires a task argument (use task field)';
      let projectPath: string | undefined;
      try {
        projectPath = resolveProjectPath(projectId, '');
      } catch {
        projectPath = undefined;
      }
      try {
        const result = await runHarnessTask(task, projectPath);
        return `[DeepSeek Harness result]\n${truncateText(result, 4000)}`;
      } catch (err) {
        return `[DeepSeek Harness error]\n${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'generate_diagram': {
      const type = String(toolCall.type || 'flowchart');
      const title = String(toolCall.title || '');
      const nodes = Array.isArray(toolCall.nodes) ? (toolCall.nodes as DiagramNode[]) : [];
      const edges = Array.isArray(toolCall.edges) ? (toolCall.edges as DiagramEdge[]) : [];
      if (nodes.length === 0) return 'Error: generate_diagram 需要 nodes（至少一个节点）';
      if (nodes.length > 20) return 'Error: 节点过多（>20），请拆分或精简（diagram-design：密度 4/10）';
      const svg = generateDiagramSVG({ type, title, nodes, edges });
      return `__SYNAPS_DIAGRAM__\n${svg}`;
    }

    case 'spec_kit': {
      const action = String(toolCall.action || 'spec');
      const requirement = String(toolCall.requirement || toolCall.task || toolCall.query || '');
      const title = String(toolCall.title || '');
      let projectPath: string | undefined;
      try {
        projectPath = resolveProjectPath(projectId, '');
      } catch {
        projectPath = undefined;
      }
      if (!projectPath) return 'Error: spec_kit 需要先绑定项目';
      try {
        const result = await runSpecKit(projectPath, action, { title, requirement });
        return `[spec-kit ${action}]\n${truncateText(result, 4000)}`;
      } catch (err) {
        return `[spec-kit error] ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'spec_kit_status': {
      return JSON.stringify(await specKitStatus(), null, 2);
    }

    case 'device_status': {
      return deviceStatusSummary();
    }

    case 'system_diagnostics': {
      try {
        await getDb();
        return diagnosticsToText(runDiagnostics());
      } catch (err) {
        return 'Error: diagnostics failed: ' + String(err);
      }
    }

    case 'device_action': {
      const type = toolCall.type as DeviceActionType | undefined;
      const valid: DeviceActionType[] = ['tap', 'swipe', 'screenshot', 'ui_dump', 'back', 'home', 'launch_app'];
      if (!type || !valid.includes(type)) {
        return `Error: device_action type must be one of: ${valid.join(', ')}`;
      }
      if (!deviceControlEnabled()) {
        return '设备控制未启用。请先在 设置 → 设备控制 中启用，并在系统无障碍设置里开启 Synaps 服务（设置 → 设备控制 → 打开无障碍设置）。';
      }
      const action = enqueueDeviceAction(type, toolCall.params || {});
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const done = getDeviceAction(action.id);
        if (done && done.status !== 'pending') {
          if (done.status === 'done') {
            return `[device_action ${type} 完成]\n${done.result || '(无输出)'}`;
          }
          return `[device_action ${type} 失败]\n${done.error || '未知错误'}`;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return '[device_action 执行超时（20s）] 请确认已在系统设置中开启 Synaps 无障碍服务（设置 → 设备控制 → 打开无障碍设置）。';
    }

    case 'agent_list': {
      const instances = listAgentInstances();
      if (instances.length === 0) return '暂无 Agent 实例。使用 agent_create 创建，或在聊天时指定 agentType 自动创建。';
      return instances.map((inst) => {
        const msgCount = listAgentMessages(inst.id).length;
        return `- [${inst.type}] ${inst.name} (id: ${inst.id})\n  状态: ${inst.status} | 上下文: ${msgCount} 条消息 | 模型: ${inst.model}`;
      }).join('\n');
    }

    case 'agent_create': {
      const type = (toolCall.type || toolCall.query) as AgentType | undefined;
      if (!type || !AGENT_TYPES.includes(type)) {
        return `Error: agent_create type must be one of: ${AGENT_TYPES.join(', ')}`;
      }
      const inst = createAgentInstance(sessionId, type, { name: toolCall.message });
      return `已创建 ${inst.name} (${inst.type})，id: ${inst.id}\n可用工具: ${inst.tools.join(', ') || '(无，纯对话)'}`;
    }

    case 'agent_delegate': {
      const type = (toolCall.type || toolCall.query) as AgentType | undefined;
      const task = toolCall.task || toolCall.content || toolCall.query;
      if (!type || !AGENT_TYPES.includes(type)) {
        return `Error: agent_delegate type must be one of: ${AGENT_TYPES.join(', ')}`;
      }
      if (!task) return 'Error: agent_delegate requires a task (use task or content field)';
      const tpl = getAgentTemplate(type);
      const apiKeyRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_api_key']);
      const apiKey = apiKeyRow && typeof apiKeyRow.value === 'string' ? apiKeyRow.value : '';
      if (!apiKey) return 'Error: DeepSeek API Key not configured (Settings → AI 模型)';
      const baseUrlRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_base_url']);
      const modelBaseUrlRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_model_base_url']);
      const modelRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_model']);
      const baseUrl = baseUrlRow && typeof baseUrlRow.value === 'string' && baseUrlRow.value ? baseUrlRow.value : 'https://api.deepseek.com';
      const modelBaseUrl = modelBaseUrlRow && typeof modelBaseUrlRow.value === 'string' && modelBaseUrlRow.value ? modelBaseUrlRow.value : 'https://api.deepseek.com';
      const model = modelRow && typeof modelRow.value === 'string' && modelRow.value ? modelRow.value : 'deepseek-v4-flash';
      const client = new LLMClient(new Config({ apiKey, baseUrl, modelBaseUrl }));
      let out = '';
      try {
        const stream = client.stream(
          [
            { role: 'system' as const, content: tpl.systemPrompt + `\n\n可执行工具白名单：${tpl.tools.join(', ') || '(无)'}` },
            { role: 'user' as const, content: `任务：${task}\n\n请以 ${tpl.name} 的角色给出分析/方案/执行意见（纯文本回答，如需要操作请明确说明要用哪个工具）。` },
          ],
          { temperature: tpl.temperature, model }
        );
        for await (const chunk of stream) {
          if (chunk.content) out += chunk.content.toString();
        }
      } catch (err: any) {
        return `[agent_delegate ${type} 失败] ${err?.message || String(err)}`;
      }
      return `[${tpl.name} 回复]\n${truncateText(out, 3000)}`;
    }

    case 'agent_status': {
      const instances = listAgentInstances();
      if (instances.length === 0) return '暂无 Agent 实例';
      return instances.map((inst) => {
        const summary = getAgentContextSummary(inst.id);
        return `[${inst.name} (${inst.type})] ${inst.status}\n${summary}`;
      }).join('\n\n');
    }

    case 'agent_clear': {
      const id = toolCall.query || (toolCall.params && typeof toolCall.params.id === 'string' ? toolCall.params.id : '');
      if (!id || !getAgentInstance(id)) return 'Error: agent_clear requires a valid agent id';
      clearAgentContext(id);
      return `已清空 Agent ${id} 的独立上下文`;
    }

    case 'agent_delete': {
      const id = toolCall.query || (toolCall.params && typeof toolCall.params.id === 'string' ? toolCall.params.id : '');
      if (!id || !getAgentInstance(id)) return 'Error: agent_delete requires a valid agent id';
      deleteAgentInstance(id);
      return `已删除 Agent ${id} 及其上下文`;
    }

    default:
      return `Error: Unknown tool "${toolCall.tool}"`;
  }
}

/**
 * POST /api/v1/chat
 * SSE streaming chat with AI Agent
 * Body: {
 *   messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }>,
 *   projectId?: string
 * }
 */
router.post('/', async (req: express.Request, res: express.Response) => {
  let taskId = '';
  let taskStartedAt = 0;
  const taskSteps: TaskStepRecord[] = [];
  const taskTools: TaskToolRecord[] = [];
  let taskFiles: string[] = [];
  try {
    await getDb();
    
    const { messages, projectId: projectIdRaw, requestId, agentType, agentInstanceId } = req.body as {
      messages: Array<{ role: string; content: string }>;
      projectId?: string;
      requestId?: string;
      agentType?: string;
      agentInstanceId?: string;
    };
    const projectId: string | null = typeof projectIdRaw === 'string' && projectIdRaw ? projectIdRaw : null;
    taskId = requestId || `task-${Date.now()}`;
    abortRegistry.set(taskId, false);

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }

    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (!hasUserMessage) {
      res.status(400).json({ error: 'At least one user message is required' });
      return;
    }

    // 持久化会话与用户消息（历史对话）
    const sessionId = ensureSession(projectId);
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMessage) {
      saveChatMessage(sessionId, 'user', lastUserMessage.content);
    }

    // 独立 Agent：解析实例（模板角色 + 工具白名单 + 温度/模型 + 独立上下文）
    let agentInstance = null as null | ReturnType<typeof getAgentInstance>;
    const requestedType = agentType && AGENT_TYPES.includes(agentType as AgentType) ? (agentType as AgentType) : null;
    if (requestedType) {
      agentInstance = agentInstanceId
        ? getAgentInstance(agentInstanceId)
        : getOrCreateInstance(sessionId, requestedType);
      if (agentInstance) {
        updateAgentInstance(agentInstance.id, { status: 'running' });
      }
    }

    // 跨 Agent 共享上下文命令：更新上下文 / 查看上下文
    let contextCommandReply: string | null = null;
    const lastUserContent = lastUserMessage?.content ?? '';
    if (/^(更新上下文|记住[：:])/m.test(lastUserContent) || lastUserContent.includes('更新上下文：')) {
      const content = lastUserContent
        .replace(/^.*?(更新上下文|记住)[：:]?/m, '')
        .trim();
      if (content) {
        const ctx = mergeSharedContext(content);
        contextCommandReply = `[系统] 已更新共享上下文，记住以下信息（跨会话/跨 Agent 生效）：\n${sharedContextToText(ctx)}\n后续对话将自动遵循。`;
      } else {
        contextCommandReply = '[系统] 更新上下文命令缺少内容，示例：更新上下文：技术栈 TypeScript + React Native，偏好 4 空格缩进';
      }
    } else if (/查看上下文/.test(lastUserContent)) {
      const ctx = getSharedContext();
      const text = sharedContextToText(ctx);
      contextCommandReply = text
        ? `[系统] 当前共享上下文：\n${text}`
        : '[系统] 当前没有共享上下文。可用“更新上下文：xxx”记录项目背景、技术栈与偏好。';
    }

    // 调度员临时执行权限：用户要求亲自执行 / 主动回收
    let tempPermReply: string | null = null;
    if (agentInstance && agentInstance.type === 'scheduler' && projectId) {
      if (/你亲自来|亲自来|你直接改|你自己改|你亲手/.test(lastUserContent)) {
        grantSchedulerTempPerms(projectId, sessionId, SCHEDULER_TEMP_TOOLS_FULL, '用户要求调度员亲自执行当前任务', 'user_request');
        tempPermReply = '[系统] 已授予调度员临时执行权限（write_file / run_command / install_tool），10 分钟内或任务修复完成后自动回收，所有操作记录到审计日志。';
      } else if (/回收权限|撤销权限|收回权限|取消权限/.test(lastUserContent)) {
        revokeSchedulerTempPerms(projectId, sessionId, '用户主动回收');
        tempPermReply = '[系统] 已回收调度员的全部临时执行权限。';
      }
    }

    const customHeaders = HeaderUtils.extractForwardHeaders(
      req.headers as unknown as Record<string, string>
    );

    const getSetting = (key: string): string | null => {
      const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]) as Record<string, string> | null;
      return row?.value ?? null;
    };

    // 默认使用 DeepSeek（OpenAI 兼容），设置页可覆盖地址与模型
    const apiKey = getSetting('ai_api_key');
    const baseUrl = getSetting('ai_base_url') || 'https://api.deepseek.com';
    const modelBaseUrl = getSetting('ai_model_base_url') || 'https://api.deepseek.com';
    const model = getSetting('ai_model') || 'deepseek-v4-flash';

    if (!apiKey) {
      res.status(400).json({ error: '未配置 DeepSeek API Key，请到 设置 → AI 模型 中填写' });
      return;
    }

    const config = new Config({ apiKey, baseUrl, modelBaseUrl });
    const client = new LLMClient(config, customHeaders);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 上下文命令：直接返回结果，不进入 agent 循环
    if (contextCommandReply) {
      res.write(`data: ${JSON.stringify({ content: contextCommandReply })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }

    // 任务开始事件
    const taskName = (lastUserMessage?.content || '任务').replace(/^>.*\n?/s, '').slice(0, 60);
    taskStartedAt = Date.now();
    res.write(`data: ${JSON.stringify({
      task_start: {
        id: taskId,
        name: taskName,
        startedAt: taskStartedAt,
        agent: agentInstance ? { id: agentInstance.id, type: agentInstance.type, name: agentInstance.name } : null,
      },
    })}\n\n`);
    createTask(taskId, projectId || null, sessionId, taskName, taskStartedAt);
    res.write(`data: ${JSON.stringify({ executor: { label: currentExecutorLabel() } })}\n\n`);

    // Build system message with project context
    let systemPrompt = AGENT_SYSTEM_PROMPT;
    if (agentInstance) {
      systemPrompt += `\n\n## Agent 角色\n${agentInstance.systemPrompt}`;
      if (agentInstance.tools.length > 0) {
        systemPrompt += `\n本 Agent 仅允许使用以下工具：${agentInstance.tools.join(', ')}（白名单之外的工具会被拒绝）。`;
      }
      if (agentInstance.type === 'scheduler') {
        systemPrompt +=
          '\n临时执行权限说明：子 Agent 执行失败、用户说“你亲自来”或遇到紧急小问题时，你会获得 write_file / run_command（必要时含 install_tool）的临时权限，可直接修复；临时权限会自动回收（10 分钟或修复完成），其授予与使用均记录审计日志。';
      }
    }

    // 注入用户设置的默认执行大脑
    const defaultBrainRow = queryOne('SELECT value FROM settings WHERE key = ?', ['default_exec_brain']);
    const rawBrain = String((defaultBrainRow?.value as string | null) || 'auto');
    const defaultBrain = ['auto', 'codex', 'local'].includes(rawBrain) ? rawBrain : 'auto';
    systemPrompt += `\n\n## 执行大脑\n默认执行大脑（用户设置）：${defaultBrain}（auto=自动路由；codex=优先 Codex CLI；local=本地内置能力）。涉及复杂任务的执行时优先遵循该设置路由到对应执行大脑。`;

    // 调度员临时权限系统通知（写入对话流，不结束请求）
    if (tempPermReply) {
      systemPrompt += `\n\n[系统通知] ${tempPermReply}`;
      res.write(`data: ${JSON.stringify({ content: `${tempPermReply}\n\n` })}\n\n`);
    }

    // 注入跨会话共享上下文
    const sharedCtx = getSharedContext();
    // ★ 小说写作上下文：自动检测项目是否为小说项目，注入六层记忆
    const novelBible = projectId ? getStoryBible(projectId) : null;
    if (novelBible) {
      const nextChapter = novelBible.totalChapters + 1;
      const novelCtx = novelContextToSystemPrompt(projectId!, novelBible.id, nextChapter, novelBible.currentVolume);
      if (novelCtx) {
        systemPrompt += novelCtx;
      }
    }

    const sharedCtxText = sharedContextToText(sharedCtx);
    if (sharedCtxText) {
      systemPrompt += `\n\n## Shared Context (跨会话记忆)\n用户之前告知的上下文，默认遵循，无需重复询问：\n${sharedCtxText}\n当用户说“更新上下文：xxx”时，记住新信息；说“查看上下文”时展示当前记忆。`;
    }

    // 自动检索跨会话经验记忆（BM25，按当前用户消息匹配）
    try {
      const memoryText = recallMemories(projectId || null, (lastUserMessage?.content || '').slice(0, 300), 5);
      if (memoryText) {
        systemPrompt += `\n\n## 经验记忆（自动检索）\n过去遇到类似问题时的做法，默认遵循；与当前任务冲突时以当前任务为准：\n${memoryText}`;
      }
    } catch {
      // 记忆检索失败不影响主流程
    }

    if (projectId) {
      const project = queryOne(`SELECT name, path FROM projects WHERE id = ?`, [projectId]) as Record<string, string> | null;
      if (project) {
        systemPrompt += `\n\n## Current Project Context
Project Name: ${project.name}
Project Path: ${project.path}

All file operations should use paths relative to the project root.`;
        
        // Auto-analyze project structure for context
        try {
          const projectRoot = project.path;
          if (fs.existsSync(projectRoot)) {
            const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
            const structure = entries
              .filter(e => !e.name.startsWith('.'))
              .slice(0, 20)
              .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`)
              .join('\n');
            systemPrompt += `\n\nProject Structure (root level):\n${structure}`;
          }
        } catch {
          // Ignore errors in context analysis
        }
      }
    }

    const conversationMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
    ];

    // Agent loop: execute tools and continue conversation
    const maxIterations = 10;
    let iteration = 0;
    let lastFullResponse = '';

    while (iteration < maxIterations) {
      iteration++;

      if (abortRegistry.get(taskId)) {
        break;
      }

      // Collect full response（带看门狗，避免模型无响应时无限等待）
      let fullResponse: string;
      try {
        // 每一轮都实时转发思考片段（第 1 轮起，用户第一时间看到进展）；心跳保活
        fullResponse = await streamWithWatchdog(
          client,
          conversationMessages,
          {
            temperature: agentInstance?.temperature ?? 0.3,
            ...(model ? { model: agentInstance?.model || model } : {}),
          },
          res,
          undefined,
          undefined,
          taskId,
          (text: string) => res.write(`data: ${JSON.stringify({ thinking_chunk: text })}\n\n`)
        );
      } catch (err: any) {
        const errMsg = `\n\n[系统提示] ${err?.message || String(err)}`;
        res.write(`data: ${JSON.stringify({ content: errMsg })}\n\n`);
        res.write(`data: ${JSON.stringify({ task_end: { id: taskId, status: 'error', durationMs: Date.now() - taskStartedAt } })}\n\n`);
        res.write('data: [DONE]\n\n');
        finishTask(taskId, 'error', Date.now());
        if (agentInstance) updateAgentInstance(agentInstance.id, { status: 'idle' });
        abortRegistry.delete(taskId);
        res.end();
        return;
      }

      lastFullResponse = fullResponse;

      // Check for tool call（支持一条回复里多个工具调用，逐个执行）
      const toolCalls = parseToolCalls(fullResponse);

      if (toolCalls.length === 0) {
        // No tool call - stream final response to client
        // 思考草稿已在面板实时显示，这里清掉，避免与最终回答重复
        res.write(`data: ${JSON.stringify({ thinking_clear: true })}\n\n`);
        // 逐块转发，前端实现打字机效果
        let finalText = '';
        try {
          finalText = await streamWithForwarding(client, conversationMessages, {
            temperature: 0.3,
            ...(model ? { model } : {}),
          }, res, undefined, undefined, taskId);
        } catch (err: any) {
          finalText = `\n\n[系统提示] ${err?.message || String(err)}`;
          res.write(`data: ${JSON.stringify({ content: finalText })}\n\n`);
        }

        saveChatMessage(sessionId, 'assistant', fullResponse);
        if (agentInstance) {
          if (lastUserMessage) appendAgentMessage(agentInstance.id, 'user', lastUserMessage.content);
          appendAgentMessage(agentInstance.id, 'assistant', fullResponse);
          updateAgentInstance(agentInstance.id, { status: 'idle' });
        }
        finishTask(taskId, 'done', Date.now());
        res.write(`data: ${JSON.stringify({ task_end: { id: taskId, status: 'done', durationMs: Date.now() - taskStartedAt } })}\n\n`);
        res.write('data: [DONE]\n\n');
        abortRegistry.delete(taskId);
        res.end();
        return;
      }

      // 工具轮次：思考片段已实时转发，这里收尾，去掉残留的工具 JSON 块
      res.write(`data: ${JSON.stringify({ thinking_end: true })}\n\n`);

      // 提取模型推理文本（排除工具调用块），作为 content 事件发送给客户端
      const reasoningText = extractPlainText(fullResponse);
      if (reasoningText) {
        res.write(`data: ${JSON.stringify({ content: reasoningText })}\n\n`);
      }

      // 逐个执行本轮的全部工具调用
      for (const toolCall of toolCalls) {
      // 工具白名单检查（独立 Agent 只允许模板内工具；调度员临时执行权限除外）
      let tempGrant = agentInstance ? hasTempPermission(agentInstance.sessionId, toolCall.tool) : null;
      if (
        agentInstance &&
        agentInstance.type === 'scheduler' &&
        !tempGrant &&
        SCHEDULER_TEMP_TOOLS.includes(toolCall.tool) &&
        isUrgentFixRequest(lastUserContent)
      ) {
        // 紧急小问题（如改一行代码）：调度员直接执行，不走 team_execute
        grantSchedulerTempPerms(projectId, sessionId, SCHEDULER_TEMP_TOOLS, '用户提出紧急小问题，调度员直接修复', 'auto');
        tempGrant = hasTempPermission(sessionId, toolCall.tool);
      }
      if (agentInstance && agentInstance.tools.length > 0 && !agentInstance.tools.includes(toolCall.tool) && !tempGrant) {
        const whitelistMsg = `[Permission denied] 当前 Agent（${agentInstance.name}）未授权使用工具 ${toolCall.tool}。可用工具：${agentInstance.tools.join(', ')}`;
        res.write(`data: ${JSON.stringify({
          tool_call: {
            name: toolCall.tool,
            args: { command: toolCall.command, path: toolCall.path, query: toolCall.query },
            result: whitelistMsg,
            ok: false,
            durationMs: 0,
          },
        })}\n\n`);
        taskSteps.push({ name: toolCall.tool, status: 'error' });
        taskTools.push({ name: toolCall.tool, args: { command: toolCall.command, path: toolCall.path, query: toolCall.query }, result: whitelistMsg, ok: false, durationMs: 0, ts: Date.now() });
        taskFiles = taskFilesFromTools(taskTools);
        saveTaskProgress(taskId, taskSteps, taskTools, taskFiles);
        conversationMessages.push({ role: 'assistant', content: fullResponse });
        conversationMessages.push({
          role: 'user',
          content: `[Tool blocked by agent whitelist]: ${whitelistMsg}\n\n向用户说明，或建议切换到合适的 Agent。`,
        });
        continue;
      }
      if (tempGrant && agentInstance) {
        logAudit(projectId, 'temp_permission_use', `${agentInstance.name}（${agentInstance.type}）使用临时权限执行 ${toolCall.tool}（${tempGrant.reason}）`, 'medium', 'auto');
      }

      // Permission gate
      const assessment = evaluateToolRisk(toolCall);
      const trusted = isProjectTrusted(projectId);

      if (assessment.level === 'critical') {
        logAudit(projectId, toolCall.tool, describeDetail(toolCall), assessment.level, 'blocked');
        const blockedResult = `[Permission denied] ${assessment.impact}`;
        res.write(`data: ${JSON.stringify({
          tool_call: {
            name: toolCall.tool,
            args: {
              command: toolCall.command,
              path: toolCall.path,
              query: toolCall.query,
              message: toolCall.message,
              repo: toolCall.repo,
              url: toolCall.url,
              server: toolCall.server,
              method: toolCall.method,
            },
            result: blockedResult,
            ok: false,
            durationMs: 0,
          },
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ task_step: { id: taskId, step: toolCall.tool, status: 'error' } })}\n\n`);
        taskSteps.push({ name: toolCall.tool, status: 'error' });
        taskTools.push({ name: toolCall.tool, args: { command: toolCall.command, path: toolCall.path, query: toolCall.query, message: toolCall.message, repo: toolCall.repo, url: toolCall.url, server: toolCall.server, method: toolCall.method }, result: blockedResult, ok: false, durationMs: 0, ts: Date.now() });
        taskFiles = taskFilesFromTools(taskTools);
        saveTaskProgress(taskId, taskSteps, taskTools, taskFiles);
        conversationMessages.push({ role: 'assistant', content: fullResponse });
        conversationMessages.push({
          role: 'user',
          content: `[Tool blocked by permission policy]: ${assessment.impact}\n\nExplain this to the user and suggest a safer alternative.`,
        });
        continue;
      }

      if (assessment.level !== 'none' && !trusted) {
        const approved = await requestApproval(res, toolCall, assessment, projectId);
        logAudit(projectId, toolCall.tool, describeDetail(toolCall), assessment.level, approved ? 'approved' : 'denied');
        if (!approved) {
          const deniedResult = '[Permission denied] 用户拒绝了此操作';
          res.write(`data: ${JSON.stringify({
            tool_call: {
              name: toolCall.tool,
              args: {
                command: toolCall.command,
                path: toolCall.path,
                query: toolCall.query,
                message: toolCall.message,
                repo: toolCall.repo,
                url: toolCall.url,
                server: toolCall.server,
                method: toolCall.method,
              },
              result: deniedResult,
              ok: false,
              durationMs: 0,
            },
          })}\n\n`);
          res.write(`data: ${JSON.stringify({ task_step: { id: taskId, step: toolCall.tool, status: 'error' } })}\n\n`);
          taskSteps.push({ name: toolCall.tool, status: 'error' });
          taskTools.push({ name: toolCall.tool, args: { command: toolCall.command, path: toolCall.path, query: toolCall.query, message: toolCall.message, repo: toolCall.repo, url: toolCall.url, server: toolCall.server, method: toolCall.method }, result: deniedResult, ok: false, durationMs: 0, ts: Date.now() });
          taskFiles = taskFilesFromTools(taskTools);
          saveTaskProgress(taskId, taskSteps, taskTools, taskFiles);
          conversationMessages.push({ role: 'assistant', content: fullResponse });
          conversationMessages.push({
            role: 'user',
            content: `[Tool denied by user] 用户拒绝了 ${toolCall.tool} 操作（${describeDetail(toolCall)}）。请停止该操作，向用户说明，并等待新的指令。`,
          });
          continue;
        }
      } else {
        logAudit(projectId, toolCall.tool, describeDetail(toolCall), assessment.level, trusted ? 'trusted' : 'auto');
      }

      // 任务步骤开始
      res.write(`data: ${JSON.stringify({ task_step: { id: taskId, step: toolCall.tool, status: 'running' } })}\n\n`);
      if (!taskSteps.some((s) => s.name === toolCall.tool)) {
        taskSteps.push({ name: toolCall.tool, status: 'running' });
        saveTaskProgress(taskId, taskSteps, taskTools, taskFiles);
      }

      // Execute tool（先发 tool_start，前端立即显示「正在执行」，执行期间持续心跳）
      const toolStartedAt = Date.now();
      res.write(`data: ${JSON.stringify({
        tool_start: {
          name: toolCall.tool,
          args: {
            path: toolCall.path,
            query: toolCall.query,
            command: toolCall.command,
            message: toolCall.message,
          },
        },
      })}\n\n`);
      let toolResult = '';
      try {
        toolResult = await withToolHeartbeat(res, taskId, () => executeTool(projectId, toolCall, sessionId));
      } catch (err: any) {
        toolResult =
          err?.message === 'Project not found'
            ? 'Error: 当前未绑定项目，无法执行该工具。请在聊天页顶部选择或创建一个项目后再试。'
            : `Error: 工具执行失败：${err?.message || String(err)}`;
      }
      const toolDurationMs = Date.now() - toolStartedAt;

      // 失败智能分析：工具失败时自动调用 DeepSeek 诊断（未配置 Key 时静默跳过）
      if (isFailureResult(toolCall.tool, toolResult)) {
        const analysis = await withToolHeartbeat(res, taskId, () => analyzeFailure(toolCall.tool, toolResult));
        if (analysis) {
          toolResult += `\n\n${analysis}`;
        }
      }
      const toolOk = !isFailureResult(toolCall.tool, toolResult);
      if (!toolOk) {
        noteTurnSkillFailures(sessionId);
      }

      // Send tool execution info to client
      res.write(`data: ${JSON.stringify({
        tool_call: {
          name: toolCall.tool,
          args: {
            path: toolCall.path,
            query: toolCall.query,
            content: toolCall.content,
            command: toolCall.command,
            message: toolCall.message,
            repo: toolCall.repo,
            url: toolCall.url,
            server: toolCall.server,
            method: toolCall.method,
          },
          result: toolResult,
          ok: toolOk,
          durationMs: toolDurationMs,
        },
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ task_step: { id: taskId, step: toolCall.tool, status: toolOk ? 'done' : 'error' } })}\n\n`);

      // 持久化任务进度
      const stepIdx = taskSteps.findIndex((s) => s.name === toolCall.tool);
      if (stepIdx >= 0) taskSteps[stepIdx].status = toolOk ? 'done' : 'error';
      taskTools.push({
        name: toolCall.tool,
        args: {
          path: toolCall.path,
          query: toolCall.query,
          content: toolCall.content,
          command: toolCall.command,
          message: toolCall.message,
          repo: toolCall.repo,
          url: toolCall.url,
          server: toolCall.server,
          method: toolCall.method,
        },
        result: toolResult,
        ok: toolOk,
        durationMs: toolDurationMs,
        ts: Date.now(),
      });
      taskFiles = taskFilesFromTools(taskTools);
      saveTaskProgress(taskId, taskSteps, taskTools, taskFiles);

      // Add assistant response and tool result to conversation
      conversationMessages.push({
        role: 'assistant',
        content: fullResponse,
      });
      conversationMessages.push({
        role: 'user',
        content: `[Tool Result for ${toolCall.tool}]:\n${toolResult}\n\nContinue with your task or provide a summary.`,
      });
      } // end for: 本轮全部工具调用执行完毕
    }

    // Max iterations reached（或用户取消）
    const cancelled = abortRegistry.get(taskId) === true;
    if (agentInstance) {
      if (lastUserMessage) appendAgentMessage(agentInstance.id, 'user', lastUserMessage.content);
      appendAgentMessage(agentInstance.id, 'assistant', lastFullResponse || '(任务中止)');
      updateAgentInstance(agentInstance.id, { status: 'idle' });
    }
    res.write(`data: ${JSON.stringify({
      task_end: { id: taskId, status: cancelled ? 'cancelled' : 'done', durationMs: Date.now() - taskStartedAt },
    })}\n\n`);
    finishTask(taskId, cancelled ? 'cancelled' : 'done', Date.now());
    // 在结束前转发最后一轮的推理文本（如果有）
    const lastReasoning = extractPlainText(lastFullResponse || '');
    if (lastReasoning) {
      res.write(`data: ${JSON.stringify({ content: lastReasoning })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      content: cancelled
        ? '\n\n[任务已取消]'
        : '\n\n[Agent reached maximum iterations. Please continue the conversation if more work is needed.]',
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    abortRegistry.delete(taskId);
    res.end();
  } catch (error) {
    console.error('Chat API error:', error);
    abortRegistry.delete(taskId);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.write(`data: ${JSON.stringify({ task_end: { id: taskId, status: 'error', durationMs: Date.now() - taskStartedAt } })}\n\n`);
      finishTask(taskId, 'error', Date.now());
      res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

/**
 * POST /api/v1/chat/cancel
 * Body: { requestId: string }
 * 请求取消正在运行的任务（agent 循环在步骤间检查并停止）。
 */
router.post('/cancel', (req: express.Request, res: express.Response) => {
  const { requestId } = req.body as { requestId?: string };
  if (!requestId) {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (!abortRegistry.has(requestId)) {
    res.status(404).json({ error: 'Task not found or already finished' });
    return;
  }
  abortRegistry.set(requestId, true);
  res.json({ ok: true });
});

/**
 * GET /api/v1/chat/history
 * 返回最近会话的历史消息
 */
router.get('/history', async (req: express.Request, res: express.Response) => {
  try {
    await getDb();
    const projectId =
      typeof req.query.project_id === 'string' && req.query.project_id
        ? req.query.project_id
        : undefined;

    const session = projectId
      ? queryOne(`SELECT id FROM chat_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`, [projectId])
      : queryOne(`SELECT id FROM chat_sessions WHERE project_id IS NULL ORDER BY updated_at DESC LIMIT 1`);

    if (!session) {
      res.json({ sessionId: null, messages: [] });
      return;
    }

    const rows = queryAll(
      `SELECT id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
      [session.id as string]
    );
    res.json({ sessionId: session.id, messages: rows });
  } catch (error) {
    console.error('Chat history API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/chat/agents
 * 返回当前项目会话的所有 Agent 实例（客户端用于恢复独立历史）
 * Query: projectId?: string
 */
router.get('/agents', async (req: express.Request, res: express.Response) => {
  try {
    await getDb();
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const sessionId = ensureSession(projectId);
    const instances = listAgentInstances(sessionId).map((inst) => ({
      id: inst.id,
      type: inst.type,
      name: inst.name,
      status: inst.status,
      model: inst.model,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    }));
    res.json({ sessionId, agents: instances });
  } catch (error) {
    console.error('Agents list API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/chat/agent-history
 * 返回指定 Agent 实例的独立对话历史
 * Query: agentInstanceId: string
 */
router.get('/agent-history', async (req: express.Request, res: express.Response) => {
  try {
    await getDb();
    const id = typeof req.query.agentInstanceId === 'string' ? req.query.agentInstanceId : '';
    if (!id) {
      res.status(400).json({ error: 'agentInstanceId is required' });
      return;
    }
    const inst = getAgentInstance(id);
    if (!inst) {
      res.status(404).json({ error: 'Agent instance not found' });
      return;
    }
    const messages = listAgentMessages(id, 200).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.createdAt,
    }));
    res.json({ agent: inst, messages });
  } catch (error) {
    console.error('Agent history API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/chat/analyze-project/:projectId
 * Analyze project structure and return context summary
 */
router.get('/analyze-project/:projectId', async (req: express.Request, res: express.Response) => {
  try {
    await getDb();
    const { projectId } = req.params;
    const project = queryOne(`SELECT name, path FROM projects WHERE id = ?`, [projectId]) as Record<string, string> | null;
    
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const projectRoot = project.path;
    if (!fs.existsSync(projectRoot)) {
      res.status(404).json({ error: 'Project path does not exist' });
      return;
    }

    // Analyze project structure
    const analysis: {
      name: string;
      path: string;
      type: string;
      structure: string[];
      keyFiles: Record<string, boolean>;
      stats: { files: number; directories: number };
    } = {
      name: project.name,
      path: projectRoot,
      type: 'Unknown',
      structure: [],
      keyFiles: {},
      stats: { files: 0, directories: 0 }
    };

    // Detect project type
    const checks = [
      { file: 'AndroidManifest.xml', type: 'Android' },
      { file: 'build.gradle', type: 'Gradle' },
      { file: 'package.json', type: 'Node.js' },
      { file: 'Cargo.toml', type: 'Rust' },
      { file: 'go.mod', type: 'Go' },
      { file: 'requirements.txt', type: 'Python' },
      { file: 'pom.xml', type: 'Maven' },
    ];

    for (const check of checks) {
      if (fs.existsSync(path.join(projectRoot, check.file))) {
        analysis.type = check.type;
        break;
      }
    }

    // Scan project structure (limited depth)
    function scanDir(dir: string, relPath: string = '', depth: number = 0) {
      if (depth > 3) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries.slice(0, 30)) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue;
        
        const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
        const icon = entry.isDirectory() ? '📁' : '📄';
        analysis.structure.push(`${'  '.repeat(depth)}${icon} ${entry.name}`);
        
        if (entry.isDirectory()) {
          analysis.stats.directories++;
          scanDir(path.join(dir, entry.name), rel, depth + 1);
        } else {
          analysis.stats.files++;
          analysis.keyFiles[entry.name] = true;
        }
      }
    }

    scanDir(projectRoot);

    res.json(analysis);
  } catch (error) {
    console.error('Analyze project error:', error);
    res.status(500).json({ error: 'Failed to analyze project' });
  }
});

/**
 * POST /api/v1/chat/approval
 * Body: { requestId: string, approved: boolean }
 * 客户端在权限确认弹窗中回传用户决定，agent 循环据此继续或中止。
 */
router.post('/approval', (req: express.Request, res: express.Response) => {
  const { requestId, approved, trustProject } = req.body as {
    requestId?: string;
    approved?: boolean;
    trustProject?: boolean;
  };
  if (!requestId) {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    res.status(404).json({ error: 'Approval request not found or expired' });
    return;
  }
  pendingApprovals.delete(requestId);
  clearTimeout(pending.timer);
  // 用户勾选「信任该项目」且通过：把当前项目加入可信列表，后续中/高风险操作自动放行
  if (approved === true && trustProject === true && pending.projectId) {
    try {
      const current = getTrustedProjects();
      if (!current.includes(pending.projectId)) {
        setTrustedProjects([...current, pending.projectId]);
        logAudit(pending.projectId, 'trust_project', '用户通过审批时选择信任该项目，后续中/高风险操作自动放行', 'medium', 'approved');
      }
    } catch (err) {
      console.error('Failed to trust project on approval:', err);
    }
  }
  pending.resolve(approved === true);
  res.json({ success: true });
});

/**
 * 调度员主动巡检：每 5 分钟检查一次各项目的状态（git 改动/构建/设备），
 * 发现问题写入审计日志，减少信息滞后。仅在有调度员 Agent 的项目上执行。
 */
ensureNovelTables();

export function startProactiveMonitor(): void {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      await getDb();
      const sessions = queryAll(
        'SELECT id, project_id FROM chat_sessions WHERE project_id IS NOT NULL ORDER BY updated_at DESC'
      ) as Array<{ id: string; project_id: string }>;
      for (const s of sessions) {
        const scheduler = listAgentInstances(s.id).find((i) => i.type === 'scheduler');
        if (!scheduler || scheduler.status !== 'idle') continue;
        const project = queryOne('SELECT name, path FROM projects WHERE id = ?', [s.project_id]) as Record<string, string> | null;
        if (!project || !fs.existsSync(project.path)) continue;

        const findings: string[] = [];

        // 1) 项目状态：未提交改动 / 最近提交（日志）
        try {
          const st = await execInProject(project.path, 'git status --short', 15000);
          const lines = st.stdout.trim().split('\n').filter(Boolean);
          if (lines.length > 0) findings.push(`工作区有 ${lines.length} 处未提交改动`);
          const lg = await execInProject(project.path, 'git log -1 --format="%h %s"', 15000);
          if (lg.stdout.trim()) findings.push(`最近提交：${lg.stdout.trim()}`);
        } catch {
          // 非 git 项目，跳过
        }

        // 2) 构建状态：GitHub Actions 最近运行
        try {
          const token = getGithubTokenFromSettings();
          if (token) {
            const repo = await inferRepo(project.path);
            if (repo) {
              const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=3`, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/vnd.github.v3+json',
                  'User-Agent': 'Synaps-App',
                },
              });
              if (res.ok) {
                const data = (await res.json()) as {
                  workflow_runs?: Array<{ status?: string; conclusion?: string | null; name?: string; run_number?: number }>;
                };
                const failed = (data.workflow_runs || []).find((r) => r.status === 'completed' && r.conclusion === 'failure');
                const running = (data.workflow_runs || []).find((r) => r.status !== 'completed');
                if (failed) findings.push(`最近构建失败：${failed.name || 'workflow'} #${failed.run_number}`);
                else if (running) findings.push(`有构建进行中：${running.name || 'workflow'} #${running.run_number}`);
              }
            }
          }
        } catch {
          // 构建检查失败，跳过
        }

        // 3) 设备控制状态
        try {
          if (/未启用/.test(deviceStatusSummary())) findings.push('设备控制未启用');
        } catch {
          // ignore
        }

        if (findings.length > 0) {
          logAudit(s.project_id, 'proactive_status_check', `调度员主动巡检（${project.name}）：${findings.join('；')}`, 'medium', 'auto');
        }
      }
    } catch (err) {
      console.error('Proactive monitor error:', err);
    }
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export default router;
