import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  CLI_TOOL_IDS,
  getCliToolStatus,
  installCliTool,
  type CliToolId,
} from '../cliTools.js';

const router = Router();

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const tools = await Promise.all(CLI_TOOL_IDS.map(async (id) => ({
      id,
      ...(await getCliToolStatus(id)),
    })));
    res.json({ tools });
  } catch (error) {
    res.status(500).json({ error: String((error as Error).message || error) });
  }
});

router.post('/:id/install', async (req: Request, res: Response) => {
  const id = req.params.id as CliToolId;
  if (!CLI_TOOL_IDS.includes(id)) {
    res.status(404).json({ error: '工具不存在或不支持免登录安装' });
    return;
  }
  try {
    installCliTool(id).catch(() => undefined);
    res.json({ started: true });
  } catch (error) {
    res.status(400).json({ error: String((error as Error).message || error) });
  }
});

export default router;
