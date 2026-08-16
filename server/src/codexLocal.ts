import fs from 'fs';
import path from 'path';
import https from 'https';
import type { IncomingMessage } from 'http';
import zlib from 'zlib';
import { runProcess } from './nativeProc.js';

/**
 * 内置 Codex 引擎（无需 Termux）
 *
 * Codex CLI 的 arm64 二进制是静态链接（musl），可以直接在 App 内嵌 Node 进程中执行。
 * App 从 GitHub Release 下载压缩包（codex.gz）→ 解压到 App 数据目录 → chmod +x → 直接 spawn。
 * 完全绕开 Termux 桥接，也绕开 Android 跨应用 SELinux 限制（进程是 App 自己的）。
 */

export const ENGINE_VERSION = '0.147.0';
const ENGINE_URL =
  'https://github.com/abuaibobo-dev/synaps-next/releases/download/codex-engine-0.147.0/codex.gz';

const DATA_DIR = process.env.SYNAPS_DATA_DIR
  ? process.env.SYNAPS_DATA_DIR
  : path.join(__dirname, '../../data');
const BIN_DIR = path.join(DATA_DIR, 'codex-bin');
export const BIN_PATH = path.join(BIN_DIR, 'codex');

export interface CodexLocalState {
  downloading: boolean;
  bytesDone: number;
  bytesTotal: number;
  version: string | null;
  error: string | null;
  binPath: string;
  arch: string;
}

const state: CodexLocalState = {
  downloading: false,
  bytesDone: 0,
  bytesTotal: 0,
  version: null,
  error: null,
  binPath: BIN_PATH,
  arch: process.arch,
};

export function codexLocalInstalled(): boolean {
  try {
    fs.accessSync(BIN_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CodexLocalProbe {
  version: string | null;
  error: string | null;
}

/** 探测内置引擎：执行 --version，失败时返回具体原因（错误码/退出码/stderr） */
export async function probeCodexLocal(): Promise<CodexLocalProbe> {
  if (!codexLocalInstalled()) {
    return { version: null, error: `二进制不可执行（${BIN_PATH}），请重新下载` };
  }
  const r = await runProcess({ cmd: BIN_PATH, args: ['--version'], timeoutMs: 30000 });
  if (r.error) return { version: null, error: `执行失败：${r.error}` };
  if (r.timedOut) return { version: null, error: '执行超时（30s）' };
  const version = String(r.stdout || '').trim().split('\n')[0] || null;
  if (!version) {
    return { version: null, error: `执行失败（exit ${r.exitCode}）：${String(r.stderr || '').trim().slice(0, 300)}` };
  }
  return { version, error: null };
}

export function codexLocalVersion(): Promise<string | null> {
  return probeCodexLocal().then((r) => r.version);
}

export async function refreshCodexLocalVersion(): Promise<string | null> {
  state.version = await codexLocalVersion();
  return state.version;
}

export function getCodexLocalState(): CodexLocalState {
  return { ...state };
}

export async function installCodexLocal(): Promise<void> {
  if (state.downloading) throw new Error('引擎下载中，请稍候');
  state.downloading = true;
  state.error = null;
  state.bytesDone = 0;
  state.bytesTotal = 0;
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const tmp = BIN_PATH + '.tmp';
    await downloadAndGunzip(ENGINE_URL, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, BIN_PATH);
    const probe = await probeCodexLocal();
    state.version = probe.version;
    if (!probe.version) {
      // 保留二进制便于重试与诊断，错误信息带架构与具体原因
      state.error = `引擎下载完成但无法执行（设备 ${process.arch}）：${probe.error || '版本检测失败'}`;
    }
  } catch (e) {
    state.error = String((e as Error).message || e);
    try {
      fs.rmSync(BIN_PATH + '.tmp', { force: true });
      fs.rmSync(BIN_PATH + '.tmp.gz', { force: true });
    } catch {
      // ignore
    }
  } finally {
    state.downloading = false;
  }
}

function downloadAndGunzip(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (res: IncomingMessage) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        return downloadAndGunzip(res.headers.location, outPath).then(resolve, reject);
      }
      if (!res.statusCode || res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败（HTTP ${res.statusCode || 'unknown'}）`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      res.on('data', (chunk: Buffer) => {
        done += chunk.length;
        state.bytesDone = done;
        state.bytesTotal = total;
      });
      const gunzip = zlib.createGunzip();
      const writer = fs.createWriteStream(outPath);
      res.pipe(gunzip).pipe(writer);
      writer.on('finish', () => resolve());
      writer.on('error', reject);
      gunzip.on('error', reject);
      res.on('error', reject);
    };
    https.get(url, { headers: { 'User-Agent': 'Synaps/1.0', Accept: '*/*' } }, finish).on('error', reject);
  });
}

export interface CodexLocalRunResult {
  exitCode: number;
  timedOut: boolean;
  output: string;
  lastMessage: string;
  failed: boolean;
}

function parseCodexOutput(raw: string): { text: string; lastMessage: string; failed: boolean } {
  const lines = String(raw || '').trim().split('\n').filter(Boolean);
  const out: string[] = [];
  let lastMessage = '';
  let failed = false;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'item.completed') {
      const item = (ev.item || {}) as Record<string, unknown>;
      if (item.type === 'command_execution') {
        const cmd = String(item.command || '').replace(/\s+/g, ' ').slice(0, 300);
        const body = String(item.aggregated_output || '').trim();
        out.push(`$ ${cmd}`);
        if (body) out.push(body);
        if (item.exit_code !== 0 && item.exit_code !== null) {
          out.push(`[exit ${item.exit_code}]`);
        }
      } else if (item.type === 'agent_message') {
        const text = String(item.text || '').trim();
        if (text) {
          lastMessage = text;
          out.push(text);
        }
      }
    } else if (ev.type === 'error' || ev.type === 'turn.failed') {
      failed = true;
      const msg = String((ev.error as Record<string, unknown>)?.message || ev.message || JSON.stringify(ev));
      out.push(`[错误] ${msg}`);
    }
  }
  return { text: out.join('\n').trim(), lastMessage, failed };
}

export interface CodexLocalRunOptions {
  task: string;
  cwd?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: string;
  timeoutMs?: number;
}

export async function runCodexLocal(opts: CodexLocalRunOptions): Promise<CodexLocalRunResult> {
  if (!codexLocalInstalled()) {
    return {
      exitCode: -1,
      timedOut: false,
      output: '[内置 Codex 引擎未安装] 请到 设置 → Codex CLI → 下载内置引擎（无需 Termux）',
      lastMessage: '',
      failed: true,
    };
  }
  const task = String(opts.task || '').trim();
  const workDir = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : DATA_DIR;
  const model = String(opts.model || 'deepseek-v4-flash').trim();
  const apiKey = String(opts.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  const baseUrl = String(opts.baseUrl || 'https://api.deepseek.com').trim();
  const wireApi = String(opts.wireApi || 'responses').trim();
  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || 600000);

  const q = (s: string) => JSON.stringify(String(s));
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox', 'danger-full-access',
    '-C', workDir,
    '-c', `model_provider=${q('deepseek')}`,
    '-c', `model=${q(model)}`,
    '-c', `model_providers.deepseek.base_url=${q(baseUrl)}`,
    '-c', `model_providers.deepseek.env_key=${q('DEEPSEEK_API_KEY')}`,
    '-c', `model_providers.deepseek.wire_api=${q(wireApi)}`,
    task,
  ];

  const r = await runProcess({
    cmd: BIN_PATH,
    args,
    cwd: workDir,
    env: { HOME: DATA_DIR, DEEPSEEK_API_KEY: apiKey },
    timeoutMs,
  });

  if (r.error && !r.stdout && !r.stderr) {
    return {
      exitCode: -1,
      timedOut: false,
      output: `[无法启动内置 Codex] ${r.error}`,
      lastMessage: '',
      failed: true,
    };
  }
  const parsed = parseCodexOutput(r.stdout);
  const errTail = String(r.stderr || '')
    .split('\n')
    .filter((l) => !l.includes('Reading additional input from stdin'))
    .join('\n')
    .trim()
    .slice(-2000);
  let output = parsed.text || errTail;
  if (!output) output = '(无输出)';
  if (r.timedOut) output = `[超时] codex 执行超过 ${Math.round(timeoutMs / 1000)}s 已被终止` + (output ? `\n${output}` : '');
  if (errTail && !parsed.text.includes(errTail)) output += `\n[stderr] ${errTail}`;
  return {
    exitCode: r.timedOut ? -1 : r.exitCode,
    timedOut: r.timedOut,
    output,
    lastMessage: parsed.lastMessage,
    failed: parsed.failed || r.timedOut || (!r.error && r.exitCode !== 0),
  };
}
