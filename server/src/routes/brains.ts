import { Router } from 'express';
import type { Request, Response } from 'express';
import { queryOne } from '../db.js';
import { getCodexConfig, checkCodexBridge } from '../codex.js';

const router = Router();

function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return (row?.value as string | null) ?? null;
}

// GET /api/v1/brains/status - 执行大脑状态总览（Codex CLI / Claude Code / Harness / 默认大脑）
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
    const claude: Record<string, unknown> = {
      installed: false,
      version: null,
      note: '未检测到（桥接连通后自动识别）',
    };

    if (cfg.enabled) {
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
          if (parsed.claudeVersion) {
            claude.installed = true;
            claude.version = parsed.claudeVersion;
            claude.note = 'Termux 已安装';
          }
        } else {
          codex.note = parsed && parsed.note ? String(parsed.note) : raw;
        }
      } catch (err) {
        codex.note = String((err as Error).message || err);
      }
    } else {
      codex.note = '未启用（设置 → Codex CLI 打开开关）';
    }

    const harness = {
      enabled: getSetting('harness_enabled') === 'true',
      ready: true,
      note: '已内置',
    };

    res.json({
      codex,
      claude,
      harness,
      defaultBrain: getSetting('default_exec_brain') || 'auto',
    });
  } catch (error) {
    console.error('Failed to get brain status:', error);
    res.status(500).json({ error: 'Failed to get brain status' });
  }
});

export default router;
