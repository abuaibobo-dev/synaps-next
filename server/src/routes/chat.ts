import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { getDb, queryAll, queryOne, runSql, saveDb } from '../db.js';
import { evaluateToolRisk, isProjectTrusted, logAudit, type RiskAssessment } from '../permissions.js';
import { getMcpServers, setMcpServers, mcpListTools, mcpCallTool } from '../mcp.js';
import { scanProject, scanFile, formatIssues, type SecurityIssue } from '../security.js';

const router = express.Router();
const execAsync = promisify(exec);

// Enhanced Agent system prompt with better intelligence
const AGENT_SYSTEM_PROMPT = `You are Synaps, an AI software development agent running on a mobile phone.
You help users develop, debug, build, and publish software through natural language.

## Your Capabilities
You have access to tools that let you interact with the project files:
- list_dir: List files in a directory
- read_file: Read file contents
- write_file: Create or modify files
- search_file: Search for files by name
- list_skills: List available skills (methodologies/guides)
- read_skill: Read a skill's full content by name
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

## Quality Gate
Before calling git_commit_push, ensure all of the following pass:
1. run_lint and run_typecheck report no errors
2. security_scan reports no issues (use security_fix if it does)
3. run_tests passes (use generate_tests first if the project has no tests, and auto_test_fix if tests fail)
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
  manager?: string;
  server?: string;
  method?: string;
  params?: Record<string, unknown>;
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

function parseToolCall(response: string): ToolCall | null {
  const match = response.match(/```tool\s*\n?([\s\S]*?)\n?```/);
  if (!match) return null;

  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

function resolveProjectPath(projectId: string, relativePath: string): string {
  const project = queryOne(`SELECT path FROM projects WHERE id = ?`, [projectId]) as Record<string, string> | null;
  if (!project) throw new Error('Project not found');

  const projectPath = project.path;
  const resolved = path.resolve(projectPath, relativePath);

  if (!resolved.startsWith(path.resolve(projectPath))) {
    throw new Error('Path traversal not allowed');
  }

  return resolved;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
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
  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const result = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (execError: any) {
    stdout = execError.stdout || '';
    stderr = execError.stderr || execError.message;
    exitCode = execError.code || 1;
  }
  return { stdout, stderr, exitCode, duration: Date.now() - startTime };
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
  projectId: string,
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
  assessment: RiskAssessment
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        pendingApprovals.delete(requestId);
        resolve(false);
      }
    }, 60_000);

    pendingApprovals.set(requestId, { resolve, timer });

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
        : 'deepseek-chat',
  };
}

async function aiComplete(
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  user: string
): Promise<string> {
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
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content || '';
  const m = raw.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return m ? m[1] : raw;
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

function saveTeamPlan(projectId: string, title: string, tasks: TeamTask[]): string {
  const id = crypto.randomUUID();
  runSql(
    'INSERT INTO team_tasks (id, project_id, title, tasks_json) VALUES (?, ?, ?, ?)',
    [id, projectId, title, JSON.stringify(tasks)]
  );
  saveDb();
  return id;
}

function loadTeamPlan(projectId: string): TeamPlan | null {
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

async function executeTool(projectId: string, toolCall: ToolCall): Promise<string> {
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

    case 'list_skills': {
      const rows = queryAll('SELECT name, description FROM skills WHERE enabled = 1 ORDER BY name') as Record<string, string>[];
      if (rows.length === 0) return 'No skills available.';
      return rows.map((r) => `- ${r.name}: ${r.description}`).join('\n');
    }

    case 'read_skill': {
      if (!toolCall.query) return 'Error: query (skill name) is required';
      const skill = queryOne('SELECT name, description, content FROM skills WHERE name = ? AND enabled = 1', [toolCall.query]) as Record<string, string> | null;
      if (!skill) return `Skill "${toolCall.query}" not found. Use list_skills to see available skills.`;
      return `## ${skill.name}\n\n${skill.description}\n\n---\n\n${skill.content}`;
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
      return `Auto-fix finished (exit ${fix.exitCode}):\n${truncateText(fixOutput, 3000)}\n\nChanged files:\n${truncateText(changedList, 2000)}`;
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
        : 'deepseek-chat';

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
        return `Execute failed for step ${task.step}: ${err?.message || String(err)}`;
      }
      const result = parseEngineerOutput(raw);
      if (result.files.length === 0) {
        task.status = 'failed';
        task.detail = result.note || 'No file changes produced';
        updateTeamPlan(plan);
        return `Step ${task.step} produced no files.\n\n${result.note || raw.slice(0, 500)}`;
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
  try {
    await getDb();
    
    const { messages, projectId } = req.body as {
      messages: Array<{ role: string; content: string }>;
      projectId?: string;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }

    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (!hasUserMessage) {
      res.status(400).json({ error: 'At least one user message is required' });
      return;
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
    const model = getSetting('ai_model') || 'deepseek-chat';

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

    // Build system message with project context
    let systemPrompt = AGENT_SYSTEM_PROMPT;
    
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

    while (iteration < maxIterations) {
      iteration++;

      // Collect full response
      let fullResponse = '';
      const stream = client.stream(conversationMessages, {
        temperature: 0.3,
        ...(model ? { model } : {}),
      });

      for await (const chunk of stream) {
        if (chunk.content) {
          fullResponse += chunk.content.toString();
        }
      }

      // Check for tool call
      const toolCall = parseToolCall(fullResponse);

      if (!toolCall || !projectId) {
        // No tool call or no project context - stream final response to client
        // Re-stream the response
        const finalStream = client.stream(conversationMessages, {
          temperature: 0.3,
          ...(model ? { model } : {}),
        });

        for await (const chunk of finalStream) {
          if (chunk.content) {
            const data = JSON.stringify({ content: chunk.content.toString() });
            res.write(`data: ${data}\n\n`);
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;
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
          },
        })}\n\n`);
        conversationMessages.push({ role: 'assistant', content: fullResponse });
        conversationMessages.push({
          role: 'user',
          content: `[Tool blocked by permission policy]: ${assessment.impact}\n\nExplain this to the user and suggest a safer alternative.`,
        });
        continue;
      }

      if (assessment.level !== 'none' && !trusted) {
        const approved = await requestApproval(res, toolCall, assessment);
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
            },
          })}\n\n`);
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

      // Execute tool
      const toolResult = await executeTool(projectId, toolCall);

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
        },
      })}\n\n`);

      // Add assistant response and tool result to conversation
      conversationMessages.push({
        role: 'assistant',
        content: fullResponse,
      });
      conversationMessages.push({
        role: 'user',
        content: `[Tool Result for ${toolCall.tool}]:\n${toolResult}\n\nContinue with your task or provide a summary.`,
      });
    }

    // Max iterations reached
    res.write(`data: ${JSON.stringify({
      content: '\n\n[Agent reached maximum iterations. Please continue the conversation if more work is needed.]',
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Chat API error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
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
  const { requestId, approved } = req.body as { requestId?: string; approved?: boolean };
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
  pending.resolve(approved === true);
  res.json({ success: true });
});

export default router;
