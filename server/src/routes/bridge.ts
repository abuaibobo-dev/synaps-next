import { Router } from 'express';
import type { Request, Response } from 'express';
import { BRIDGE_SCRIPT } from '../bridgeScript.generated.js';

const router = Router();

const BACKEND_PORT = process.env.PORT || 19091;

/**
 * GET /api/v1/bridge/script
 * 返回内嵌的 Termux 桥接脚本（text/plain），供 Termux 离线一键安装：
 *   curl -o ~/codex-bridge.js http://127.0.0.1:19091/api/v1/bridge/script
 */
router.get('/script', (_req: Request, res: Response) => {
  res.type('text/plain').send(BRIDGE_SCRIPT);
});

/**
 * GET /api/v1/bridge/command
 * 返回可在 Termux 里直接粘贴的一键安装命令
 */
router.get('/command', (_req: Request, res: Response) => {
  const command = `curl -o ~/codex-bridge.js http://127.0.0.1:${BACKEND_PORT}/api/v1/bridge/script && node ~/codex-bridge.js &`;
  res.json({
    command,
    port: BACKEND_PORT,
    sizeBytes: Buffer.byteLength(BRIDGE_SCRIPT, 'utf8'),
  });
});

export default router;
