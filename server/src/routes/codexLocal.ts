import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getCodexLocalState,
  installCodexLocal,
  codexLocalInstalled,
  refreshCodexLocalVersion,
} from '../codexLocal.js';
import { getCodexConfig } from '../codex.js';

const router = Router();

/**
 * GET /api/v1/codex-local/status
 * 内置 Codex 引擎状态（安装、版本、下载进度）
 */
router.get('/status', async (_req: Request, res: Response) => {
  const cfg = getCodexConfig();
  const st = getCodexLocalState();
  const version = st.version || (await refreshCodexLocalVersion());
  res.json({
    enabled: cfg.builtin,
    installed: codexLocalInstalled(),
    version,
    downloading: st.downloading,
    bytesDone: st.bytesDone,
    bytesTotal: st.bytesTotal,
    error: st.error,
    binPath: st.binPath,
  });
});

/**
 * POST /api/v1/codex-local/install
 * 后台下载并安装内置引擎（客户端轮询 /status 看进度）
 */
router.post('/install', async (_req: Request, res: Response) => {
  try {
    installCodexLocal().catch(() => undefined);
    res.json({ started: true });
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message || e) });
  }
});

export default router;
