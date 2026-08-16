import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

/**
 * 原生进程执行（Android 专用）
 *
 * nodejs-mobile 在 Android 上不支持 child_process.spawn/exec（官方 FAQ：会触发权限问题），
 * 所以真实设备上改为走 Kotlin NativeProcRunner（ProcessBuilder）：
 *   1. 写入请求文件 <SYNAPS_DATA_DIR>/proc-req/<id>.json
 *   2. Kotlin 守护线程执行命令，输出到 proc-out/<id>.out/.err
 *   3. 执行完写 proc-out/<id>.json 结果
 *   4. 本模块轮询结果文件并返回
 * 非 Android（开发机/CI）回退到 Node child_process 以便本地调试。
 */

export function isAndroidRuntime(): boolean {
  // nodejs-mobile 在 Android 上 process.platform === 'android'；
  // ANDROID_ROOT 仅在 App 数据目录脚本（nodejs-mobile 入口）下才作为兜底，
  // 避免 Linux chroot/开发机上误判。
  return (
    process.platform === 'android' ||
    (!!process.env.ANDROID_ROOT && /^\/data\/user\/0\//.test(process.argv[1] || ''))
  );
}

const DATA_DIR = process.env.SYNAPS_DATA_DIR
  ? process.env.SYNAPS_DATA_DIR
  : path.join(__dirname, '../../data');

const REQ_DIR = path.join(DATA_DIR, 'proc-req');
const OUT_DIR = path.join(DATA_DIR, 'proc-out');

export interface NativeRunOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface NativeRunResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Android：通过 Kotlin NativeProcRunner 执行 */
export async function runNativeProcess(opts: NativeRunOptions): Promise<NativeRunResult> {
  const id = crypto.randomUUID();
  const reqFile = path.join(REQ_DIR, `${id}.json`);
  const outFile = path.join(OUT_DIR, `${id}.out`);
  const errFile = path.join(OUT_DIR, `${id}.err`);
  const resultFile = path.join(OUT_DIR, `${id}.json`);
  const timeoutMs = Math.max(5000, opts.timeoutMs || 600000);

  fs.mkdirSync(REQ_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const env = { PATH: '/system/bin:/system/xbin:/vendor/bin:/sbin', ...(opts.env || {}) };
  fs.writeFileSync(
    reqFile,
    JSON.stringify({
      id,
      cmd: opts.cmd,
      args: opts.args || [],
      cwd: opts.cwd || '',
      env,
      timeoutMs,
    })
  );

  const deadline = Date.now() + timeoutMs + 8000;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(resultFile)) {
        const data = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
        const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
        fs.rmSync(reqFile, { force: true });
        fs.rmSync(outFile, { force: true });
        fs.rmSync(errFile, { force: true });
        fs.rmSync(resultFile, { force: true });
        if (data.error) {
          return { exitCode: -1, timedOut: false, stdout: '', stderr: '', error: String(data.error) };
        }
        return {
          exitCode: Number(data.exitCode ?? -1),
          timedOut: Boolean(data.timedOut),
          stdout,
          stderr,
        };
      }
      await sleep(200);
    }
    return { exitCode: -1, timedOut: true, stdout: '', stderr: '', error: '原生进程执行超时（无响应）' };
  } finally {
    fs.rmSync(reqFile, { force: true });
  }
}

/** 非 Android：Node child_process 回退（本地开发/CI） */
export function runProcessFallback(opts: NativeRunOptions): Promise<NativeRunResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.cmd, opts.args || [], {
      cwd: opts.cwd || undefined,
      env: { ...process.env, ...(opts.env || {}) },
      // stdin 置为 ignore：codex exec --json 会等待 stdin EOF，保持管道打开会导致引擎假死
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        resolve({ exitCode: -1, timedOut: true, stdout, stderr });
      }
    }, opts.timeoutMs || 600000);
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -1, timedOut: false, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, timedOut: false, stdout, stderr });
    });
  });
}

/** 统一入口：Android 走原生执行器，其它平台走 child_process */
export function runProcess(opts: NativeRunOptions): Promise<NativeRunResult> {
  if (isAndroidRuntime()) return runNativeProcess(opts);
  return runProcessFallback(opts);
}
