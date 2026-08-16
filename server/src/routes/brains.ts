import { Router } from 'express';
import type { Request, Response } from 'express';
import { queryOne } from '../db.js';
import { getCodexConfig, checkCodexBridge, bridgeFetch } from '../codex.js';
import { codexLocalInstalled, codexLocalVersion, ENGINE_VERSION } from '../codexLocal.js';

/**
 * 执行大脑注册表（与 Termux 桥接 tools/codex-bridge/server.js 的 BRAINS 保持一致）。
 * 内置能力（搜索/设备控制/主模型）不需要外部 CLI，单独列出。
 */
export interface BrainDef {
  id: string;
  agentType: string;
  name: string;
  cli: string;
  install: string;
  desc: string;
}

export const BRAIN_DEFS: BrainDef[] = [
  { id: 'codex', agentType: 'scheduler', name: 'Codex CLI', cli: 'codex', install: 'npm i -g @openai/codex', desc: '复杂开发、多文件重构（调度员）' },
  { id: 'aider', agentType: 'code_engineer', name: 'Aider', cli: 'aider', install: 'pip install aider-installer && aider-install', desc: 'AI 结对编程（代码工程师 / 推理研究员）' },
  { id: 'sage', agentType: 'code_engineer', name: 'Sage', cli: 'sage', install: 'pip install sage-ai-cli', desc: '本地优先编码 CLI（代码工程师备选）' },
  { id: 'lydia', agentType: 'file_manager', name: 'Lydia', cli: 'lydia', install: '参考 https://github.com/levimackay/lydia-cli', desc: '本地 Ollama 文件管家' },
  { id: 'aix', agentType: 'automator', name: 'aix', cli: 'aix', install: 'npm i -g aix-ai', desc: '40 家提供商自动化（自动化助手）' },
  { id: 'miii', agentType: 'memory_admin', name: 'miii', cli: 'miii', install: 'npm i -g miii-agent', desc: '100% 本地离线（记忆管理员）' },
  { id: 'myai', agentType: 'translator', name: 'my-ai', cli: 'my-ai', install: 'npm i -g @gh3ttoniga/my-ai', desc: '本地优先翻译（翻译官备选）' },
];

export const BUILTIN_BRAINS = [
  { id: 'web_search', name: '内置搜索', desc: 'web_search + DuckDuckGo MCP（搜索助手）' },
  { id: 'device_action', name: '设备控制', desc: '无障碍 device_action（UI 操作员）' },
  { id: 'deepseek_main', name: 'DeepSeek 主模型', desc: '通用对话 / 翻译 / 推理（deepseek-reasoner）' },
];

const router = Router();

function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return (row?.value as string | null) ?? null;
}

// 通过桥接检测各 CLI 大脑是否已安装（返回 {id: version|null}）
async function detectFromBridge(): Promise<Record<string, string | null>> {
  const cfg = getCodexConfig();
  if (!cfg.enabled) return {};
  const r = await bridgeFetch(cfg, '/status');
  if (!r.ok || !r.data || typeof r.data !== 'object') return {};
  const data = r.data as Record<string, unknown>;
  const brains = (data.brains || {}) as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(brains)) {
    out[key] = brains[key] ? String(brains[key]) : null;
  }
  return out;
}

// GET /api/v1/brains/status - 全部执行大脑状态
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const cfg = getCodexConfig();
    const codex: Record<string, unknown> = {
      enabled: cfg.enabled,
      bridgeUrl: cfg.bridgeUrl,
      reachable: false,
      version: null,
      note: '',
    };
    let detected: Record<string, string | null> = {};
    if (cfg.enabled && cfg.builtin && codexLocalInstalled()) {
      codex.reachable = true;
      codex.version = (await codexLocalVersion()) || ENGINE_VERSION;
      codex.note = '内置引擎（无需 Termux）';
    } else if (cfg.enabled) {
      try {
        const raw = await checkCodexBridge();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        if (parsed && parsed.bridge === 'ok') {
          codex.reachable = true;
          codex.version = parsed.codexVersion || null;
          codex.note = '已连接';
          detected = await detectFromBridge();
        } else {
          codex.note = parsed && parsed.note ? String(parsed.note) : raw;
        }
      } catch (err) {
        codex.note = String((err as Error).message || err);
      }
    } else {
      codex.note = '未启用（设置 → Codex CLI 打开开关）';
    }

    const brains = BRAIN_DEFS.map((b) => ({
      id: b.id,
      agentType: b.agentType,
      name: b.name,
      cli: b.cli,
      install: b.install,
      desc: b.desc,
      installed: b.id === 'codex' ? codex.reachable : detected[b.id] != null,
      version: b.id === 'codex' ? codex.version : detected[b.id] || null,
      note: b.id === 'codex' ? codex.note : (detected[b.id] != null ? '已安装' : '未安装（桥接连通后自动检测）'),
    }));

    res.json({
      codex,
      brains,
      builtins: BUILTIN_BRAINS,
      harness: { enabled: getSetting('harness_enabled') === 'true', ready: true, note: '已内置' },
      defaultBrain: getSetting('default_exec_brain') || 'auto',
    });
  } catch (error) {
    console.error('Failed to get brain status:', error);
    res.status(500).json({ error: 'Failed to get brain status' });
  }
});

export default router;
