import { queryOne } from './db.js';
import { codexLocalInstalled, runCodexLocal, refreshCodexLocalVersion, codexLocalVersion, ENGINE_VERSION } from './codexLocal.js';

/**
 * Codex CLI 集成（方案一：Termux 桥接）
 *
 * 背景：Android SELinux/uid 隔离不允许 App 进程直接执行 Termux 里的二进制，
 * 但 App 与 Termux 都能访问 127.0.0.1 回环网络。
 * 因此 Termux 里跑一个轻量桥接服务（tools/codex-bridge/server.js），
 * Synaps 通过 HTTP 调用它来执行 codex exec。
 */

export interface CodexConfig {
  enabled: boolean;
  builtin: boolean;
  apiKey: string;
  bridgeUrl: string;
  token: string;
  model: string;
  baseUrl: string;
  wireApi: string;
  timeoutMs: number;
}

function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return (row?.value as string | null) ?? null;
}

export function getCodexConfig(): CodexConfig {
  return {
    enabled: getSetting('codex_enabled') === 'true',
    builtin: getSetting('codex_builtin') === 'true',
    apiKey: getSetting('codex_api_key') || getSetting('ai_api_key') || '',
    bridgeUrl: (getSetting('codex_bridge_url') || 'http://127.0.0.1:19290').replace(/\/+$/, ''),
    token: getSetting('codex_token') || '',
    model: getSetting('codex_model') || getSetting('ai_model') || 'deepseek-v4-flash',
    baseUrl: getSetting('codex_base_url') || getSetting('ai_base_url') || 'https://api.deepseek.com',
    wireApi: getSetting('codex_wire_api') || 'responses',
    timeoutMs: 600000,
  };
}

function truncate(s: string, n: number): string {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…（已截断）` : t;
}

export async function bridgeFetch(
  cfg: CodexConfig,
  pathname: string,
  body?: unknown,
  timeoutMs = 15000
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.token) headers['x-codex-token'] = cfg.token;
    const res = await fetch(`${cfg.bridgeUrl}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: String((err as Error).message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export function codexStatus(): Record<string, unknown> {
  const cfg = getCodexConfig();
  if (!cfg.enabled) {
    return {
      enabled: false,
      note: 'Codex CLI 未启用，请到 设置 → Codex CLI 启用，并在 Termux 执行一键安装脚本（见 docs/CODEX_SETUP.md）',
    };
  }
  return {
    enabled: true,
    builtin: cfg.builtin,
    builtinInstalled: cfg.builtin ? codexLocalInstalled() : false,
    engineVersion: cfg.builtin ? ENGINE_VERSION : null,
    bridgeUrl: cfg.bridgeUrl,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    wireApi: cfg.wireApi,
    token: cfg.token ? '(已设置)' : '(未设置)',
    note: cfg.builtin
      ? (codexLocalInstalled() ? '内置引擎已就绪（无需 Termux）' : '内置引擎未安装，请到设置下载')
      : (cfg.token ? 'OK' : '建议设置 x-codex-token 令牌防止局域网内其他应用调用桥接服务'),
  };
}

export async function checkCodexBridge(): Promise<string> {
  const cfg = getCodexConfig();
  if (!cfg.enabled) return 'Codex CLI 未启用';
  const r = await bridgeFetch(cfg, '/status');
  if (!r.ok) {
    return `桥接服务不可达（${r.status === 0 ? '连接失败' : `HTTP ${r.status}`}）：请确认 Termux 已运行 tools/codex-bridge/server.js（地址 ${cfg.bridgeUrl}）。\n未安装请在 Termux 执行：pkg install nodejs git -y && npm i -g @openai/codex（完整说明见 docs/CODEX_SETUP.md）`;
  }
  const data = (r.data || {}) as Record<string, unknown>;
  return JSON.stringify(
    { bridge: 'ok', codexVersion: data.codexVersion || '?', nodeVersion: data.nodeVersion || '?', cwd: data.cwd || '?' },
    null,
    2
  );
}

export const BRAIN_IDS = ['aider', 'sage', 'lydia', 'aix', 'miii', 'myai', 'codex'];

export async function runBrainTask(brainId: string, task: string, projectPath?: string): Promise<string> {
  if (!BRAIN_IDS.includes(brainId)) {
    throw new Error(`未知执行大脑：${brainId}。可用：${BRAIN_IDS.join(', ')}`);
  }
  if (!task.trim()) throw new Error('brain_exec 需要 task 参数');

  const cfg = getCodexConfig();
  if (!cfg.enabled) {
    throw new Error('Codex CLI 桥接未启用，请到 设置 → Codex CLI 启用（Termux 安装说明见 docs/EXEC_BRAINS_SETUP.md）');
  }

  if (brainId === 'codex' && cfg.builtin && codexLocalInstalled()) {
    const result = await runCodexLocal({
      task,
      cwd: projectPath || undefined,
      model: cfg.model,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      wireApi: cfg.wireApi,
      timeoutMs: cfg.timeoutMs,
    });
    return `[codex exit ${result.exitCode}]${result.timedOut ? ' [超时]' : ''}\n${truncate(result.output || '(no output)', 4000)}`;
  }

  const r = await bridgeFetch(
    cfg,
    '/brain',
    { tool: brainId, task, cwd: projectPath || undefined, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs },
    cfg.timeoutMs + 10000
  );

  if (!r.ok) {
    const msg =
      r.data && typeof r.data === 'object' && 'error' in r.data
        ? String((r.data as Record<string, unknown>).error)
        : String(r.data || `桥接服务不可达（${r.status}）`);
    return `[${brainId} 失败] ${truncate(msg, 1500)}`;
  }

  const data = (r.data || {}) as Record<string, unknown>;
  const body = String(data.output || '(no output)').trim();
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : '?';
  const installHint = data.installHint ? `\n[未安装] 请在 Termux 执行：${data.installHint}` : '';
  return `[${brainId} exit ${exitCode}]${installHint}\n${truncate(body || '(no output)', 4000)}`;
}

export async function runCodexTask(task: string, projectPath?: string): Promise<string> {
  if (!task.trim()) throw new Error('codex_exec 需要 task 参数');

  const cfg = getCodexConfig();
  if (!cfg.enabled) throw new Error('Codex CLI 未启用，请到 设置 → Codex CLI 启用');

  // 内置引擎模式（无需 Termux）
  if (cfg.builtin && codexLocalInstalled()) {
    const result = await runCodexLocal({
      task,
      cwd: projectPath || undefined,
      model: cfg.model,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      wireApi: cfg.wireApi,
      timeoutMs: cfg.timeoutMs,
    });
    return `[Codex exit ${result.exitCode}]${result.timedOut ? ' [超时]' : ''}\n${truncate(result.output || '(no output)', 4000)}`;
  }

  const r = await bridgeFetch(
    cfg,
    '/run',
    {
      task,
      cwd: projectPath || undefined,
      model: cfg.model,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      wireApi: cfg.wireApi,
      timeoutMs: cfg.timeoutMs,
    },
    cfg.timeoutMs + 10000
  );

  if (!r.ok) {
    const msg = (r.data && typeof r.data === 'object' && 'error' in r.data)
      ? String((r.data as Record<string, unknown>).error)
      : String(r.data || `桥接服务不可达（${r.status}）`);
    return `[Codex 失败] ${truncate(msg, 1500)}`;
  }

  const data = (r.data || {}) as Record<string, unknown>;
  const body = String(data.output || '(no output)').trim();
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : '?';
  return `[Codex exit ${exitCode}]\n${truncate(body || '(no output)', 4000)}`;
}
