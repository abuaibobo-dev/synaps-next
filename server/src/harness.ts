import { runProcess } from './nativeProc.js';
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
    model: getSetting('harness_model') || 'deepseek-v4-flash',
    apiKey: getSetting('harness_api_key') || getSetting('ai_api_key') || '',
    baseUrl: getSetting('harness_base_url') || getSetting('ai_base_url') || 'https://api.deepseek.com',
    workDir: projectPath || process.cwd(),
    timeoutMs: 600000,
  };
}

export function harnessStatus(): Record<string, unknown> {
  const cfg = getHarnessConfig();
  const nodeVersion = process.version;
  const nodeParts = nodeVersion.replace('v', '').split('.');
  const nodeMajor = parseInt(nodeParts[0] || '0', 10);
  const nodeMinor = parseInt(nodeParts[1] || '0', 10);
  const nodeSatisfied = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
  return {
    enabled: cfg.enabled,
    nodeVersion,
    nodeSatisfied,
    dshConfigured: !!cfg.dshPath,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKeyConfigured: !!cfg.apiKey,
    workDir: cfg.workDir,
    note: !nodeSatisfied
      ? `当前 Node ${nodeVersion}，Harness 需要 Node 22.19+。请升级 Node`
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
  if (nodeBin === process.execPath) {
    const parts = process.version.replace('v', '').split('.');
    const maj = parseInt(parts[0] || '0', 10);
    const min = parseInt(parts[1] || '0', 10);
    if (maj < 22 || (maj === 22 && min < 19)) {
      throw new Error(`内置 Node ${process.version}，Harness 需要 Node 22.19+。请升级 Node`);
    }
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

  const r = await runProcess({
    cmd: nodeBin,
    args,
    cwd: cfg.workDir,
    env: env as Record<string, string>,
    timeoutMs: cfg.timeoutMs,
  });

  if (r.error && !r.stdout && !r.stderr) {
    throw new Error(`Harness 启动失败：${r.error}`);
  }
  if (r.timedOut) {
    throw new Error(`Harness 执行超时（${cfg.timeoutMs / 1000}s）`);
  }
  if (r.exitCode === 0) {
    return r.stdout.trim() || '(empty response)';
  }
  const tail = (r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n');
  throw new Error(`Harness 执行失败（exit ${r.exitCode}）\n${tail}`);
}
