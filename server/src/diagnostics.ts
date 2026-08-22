import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb, queryOne, queryAll } from './db.js';
import { deviceControlEnabled } from './device.js';
import { harnessStatus } from './harness.js';
import { getMcpServers } from './mcp.js';

function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row && typeof row.value === 'string' ? row.value : null;
}

export function runDiagnostics(): Record<string, unknown> {
  const aiApiKey = getSetting('ai_api_key') || '';
  const termuxPath = getSetting('termux_path') || '/data/data/com.termux';
  const githubToken = getSetting('github_token') || '';
  const mcpServers = getMcpServers();

  const dbPath = process.env.SYNAPS_DATA_DIR
    ? path.join(process.env.SYNAPS_DATA_DIR, 'synaps.db')
    : path.join(__dirname, '../../data/synaps.db');
  let dbFileSize = 0;
  try {
    dbFileSize = fs.statSync(dbPath).size;
  } catch {
    // db file not created yet
  }

  return {
    generatedAt: new Date().toISOString(),
    backend: {
      status: 'ok',
      port: Number(process.env.PORT || 19091),
      uptimeSec: Math.round(process.uptime()),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    ai: {
      model: getSetting('ai_model') || 'deepseek-v4-flash',
      baseUrl: getSetting('ai_base_url') || 'https://api.deepseek.com',
      apiKeyConfigured: !!aiApiKey,
    },
    github: {
      tokenConfigured: !!githubToken,
      autoPush: getSetting('github_auto_push') === 'true',
    },
    termux: {
      path: termuxPath,
      exists: fs.existsSync(termuxPath),
      required: false,
      note: '仅旧版 Codex 桥接需要；内置引擎和免登录 CLI 工具不依赖 Termux',
    },
    device: {
      enabled: deviceControlEnabled(),
    },
    mcp: {
      count: mcpServers.length,
      servers: mcpServers.map((s) => s.name),
    },
    harness: harnessStatus(),
    db: {
      projects: (queryAll('SELECT COUNT(*) AS c FROM projects')[0]?.c as number) || 0,
      agents: (queryAll('SELECT COUNT(*) AS c FROM agent_instances')[0]?.c as number) || 0,
      skills: (queryAll('SELECT COUNT(*) AS c FROM skills')[0]?.c as number) || 0,
      fileSizeBytes: dbFileSize,
      freeMemory: os.freemem(),
      totalMemory: os.totalmem(),
    },
  };
}

export function diagnosticsToText(d: Record<string, unknown>): string {
  const anyD = d as {
    backend: Record<string, unknown>;
    ai: Record<string, unknown>;
    github: Record<string, unknown>;
    termux: Record<string, unknown>;
    device: Record<string, unknown>;
    mcp: Record<string, unknown>;
    harness: Record<string, unknown>;
    db: Record<string, unknown>;
  };
  const lines: string[] = [];
  lines.push('## Synaps 自检报告');
  lines.push(`- 后端：${anyD.backend.status}（端口 ${anyD.backend.port}，运行 ${anyD.backend.uptimeSec}s）`);
  lines.push(`- 运行时：Node ${anyD.backend.nodeVersion} / ${anyD.backend.platform}-${anyD.backend.arch}`);
  lines.push(`- AI 模型：${anyD.ai.model}（${anyD.ai.apiKeyConfigured ? '已配置 Key' : '未配置 Key'}）`);
  lines.push(`- GitHub：${anyD.github.tokenConfigured ? '已配置 Token' : '未配置 Token'}（自动推送 ${anyD.github.autoPush ? '开' : '关'}）`);
  lines.push(`- Termux：${anyD.termux.exists ? '检测到（可选桥接）' : '未安装（内置引擎不受影响）'}`);
  lines.push(`- 设备控制：${anyD.device.enabled ? '已启用' : '未启用'}`);
  lines.push(`- MCP 服务器：${anyD.mcp.count} 个${(anyD.mcp.servers as string[]).length ? '（' + (anyD.mcp.servers as string[]).join(', ') + '）' : ''}`);
  lines.push(`- DeepSeek Harness：${anyD.harness.enabled ? '已启用' : '未启用'}${anyD.harness.nodeSatisfied ? '（Node 版本满足）' : '（Node 版本过低）'}`);
  lines.push(`- 数据库：${anyD.db.projects} 个项目 / ${anyD.db.agents} 个 Agent / ${anyD.db.skills} 个技能（${anyD.db.fileSizeBytes} 字节）`);
  const problems: string[] = [];
  if (!anyD.ai.apiKeyConfigured) problems.push('未配置 AI API Key（设置 → AI 模型）');
  if (!anyD.device.enabled) problems.push('设备控制未启用（设置 → 设备控制）');
  if (!anyD.github.tokenConfigured) problems.push('未配置 GitHub Token（影响构建/推送）');
  if (problems.length) {
    lines.push('');
    lines.push('## 建议修复');
    problems.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  } else {
    lines.push('');
    lines.push('所有核心配置正常，可以开始开发。');
  }
  return lines.join('\n');
}
