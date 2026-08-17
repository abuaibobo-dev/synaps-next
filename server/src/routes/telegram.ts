import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  startLogin, submitCode, submitPassword, logout, getStatus,
  listChannels, listRules, getRule, createRule, updateRule, deleteRule,
  startBackfill, stopRule, getLogs, getOverview, searchMemory, initTelegramTables, skipItem
} from '../telegramCollector.js';

const router = Router();

// 初始化表
router.use(async (_req, _res, next) => {
  try { await initTelegramTables(); } catch { /* ignore */ }
  next();
});

// ====== 登录 ======

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const s = await getStatus();
    res.json(s);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/login/start', async (req: Request, res: Response) => {
  try {
    const { apiId, apiHash, phone } = req.body || {};
    if (!apiId || !apiHash || !phone) {
      res.status(400).json({ error: 'apiId, apiHash, phone 必填' });
      return;
    }
    const result = await startLogin(Number(apiId), apiHash, phone);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/login/code', async (req: Request, res: Response) => {
  try {
    const { code } = req.body || {};
    if (!code) { res.status(400).json({ error: 'code 必填' }); return; }
    const result = await submitCode(code);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/login/password', async (req: Request, res: Response) => {
  try {
    const { password } = req.body || {};
    if (!password) { res.status(400).json({ error: 'password 必填' }); return; }
    const result = await submitPassword(password);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/logout', async (_req: Request, res: Response) => {
  try {
    await logout();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ====== 频道 ======

router.get('/channels', async (_req: Request, res: Response) => {
  try {
    const ch = await listChannels();
    res.json(ch);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ====== 规则 CRUD ======

router.get('/rules', (_req: Request, res: Response) => {
  try { res.json(listRules()); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get('/rules/:id', (req: Request, res: Response) => {
  const r = getRule(String(req.params.id));
  if (!r) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(r);
});

router.post('/rules', (req: Request, res: Response) => {
  try {
    const r = createRule(req.body);
    res.json(r);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put('/rules/:id', (req: Request, res: Response) => {
  try {
    const r = updateRule(String(req.params.id), req.body);
    if (!r) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(r);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.delete('/rules/:id', (req: Request, res: Response) => {
  try {
    deleteRule(String(req.params.id));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ====== 采集控制 ======

router.post('/rules/:id/start', async (req: Request, res: Response) => {
  try {
    const result = await startBackfill(String(req.params.id));
    res.json(result);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post('/rules/:id/stop', (req: Request, res: Response) => {
  try {
    const result = stopRule(String(req.params.id));
    res.json(result);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ====== 日志与总览 ======

router.post('/logs/:id/skip', (req: Request, res: Response) => {
  try { skipItem(String(req.params.id)); res.json({ success: true }); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get('/logs', (req: Request, res: Response) => {
  try {
    const { ruleId, channel, limit } = req.query as any;
    res.json(getLogs({ ruleId, channel, limit: limit ? Number(limit) : undefined }));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get('/overview', (_req: Request, res: Response) => {
  try { res.json(getOverview()); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ====== 记忆检索 ======

router.get('/memory', (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '');
    const limit = Number(req.query.limit) || 10;
    res.json(searchMemory(q, limit));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
