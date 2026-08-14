import { spawn } from 'child_process';
import path from 'path';
import { queryOne } from './db.js';

export interface HarnessConfig {
  enabled: boolean;
  nodePath: string | null;
  dshPath: string | null;
  model: string;
  apiKey: string;
  baseUrl: string;
  workDir: string;
  timeoutMs: number;
}

function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return (row?.value as string | null) ?? null;
}

export function getHarnessConfig(projectPath?: string): HarnessConfig {
  return {
    enabled: getSetting('harness_enabled') === 'true',
    nodePath: getSetting('harness_node_path') || null,
    dshPath: getSetting('harness_dsh_path') || null,
    model: getSetting('harness_model') || 'deepseek-chat',
    apiKey: getSetting('harness_api_key') || getSetting('ai_api_key') || '',
    baseUrl: getSetting('harness_base_url') || getSetting('ai_base_url') || 'https://api.deepseek.com',
    workDir: projectPath || process.cwd(),
    timeoutMs: 600000,
  };
}

export function harnessStatus(): Record<string, unknown> {
  const cfg = getHarnessConfig();
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.replace('v', '').split('.')[0] || '0', 10);
  return {
    enabled: cfg.enabled,
    nodeVersion,
    nodeSatisfied: nodeMajor >= 22,
    dshConfigured: !!cfg.dshPath,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKeyConfigured: !!cfg.apiKey,
    workDir: cfg.workDir,
    note: nodeMajor < 22
      ? '当前 Node 版本过低，Harness 需要 Node 22.19+。请在 Termux 安装新版 Node 并配置 harness_node_path'
      : 'OK',
  };
}

export async function runHarnessTask(task: string, projectPath?: string): Promise<string> {
  if (!task.trim()) throw new Error('harness_run 需要 task 参数');

  const cfg = getHarnessConfig(projectPath);
  if (!cfg.enabled) {
    throw new Error('DeepSeek Harness 未启用，请到 设置 → DeepSeek Harness 启用');
  }
  if (!cfg.apiKey) {
    throw new Error('Harness 缺少 DeepSeek API Key，请在 设置 中填写');
  }

  const nodeBin = cfg.nodePath || process.execPath;
  const nodeMajor = parseInt(nodeBin === process.execPath ? process.version.replace('v', '').split('.')[0] || '0' : '0', 10);
  if (nodeBin === process.execPath && nodeMajor < 22) {
    throw new Error(`内置 Node 为 ${process.version}，Harness 需要 Node 22.19+。请在 Termux 安装新版 Node 并配置路径`);
  }

  let args: string[];
  if (cfg.dshPath) {
    args = [cfg.dshPath, '--profile', 'headless', task];
  } else {
    const npxBin = path.join(path.dirname(nodeBin), 'npx');
    args = [npxBin, '--yes', '@deepseek-ai/dsh', '--profile', 'headless', task];
  }

  const env = {
    ...process.env,
    DEEPSEEK_API_KEY: cfg.apiKey,
    DEEPSEEK_BASE_URL: cfg.baseUrl,
    DSH_MODEL: cfg.model,
    DSH_CWD: cfg.workDir,
  };

  return new Promise<string>((resolve, reject) => {
    const child = spawn(nodeBin, args, {
      cwd: cfg.workDir,
      env,
      timeout: cfg.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Harness 执行超时（${cfg.timeoutMs / 1000}s）`));
    }, cfg.timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Harness 启动失败：${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim() || '(empty response)');
      } else {
        const tail = (stderr || stdout).trim().split('\n').slice(-8).join('\n');
        reject(new Error(`Harness 执行失败（exit ${code}）\n${tail}`));
      }
    });
  });
}
