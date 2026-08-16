import { Router } from 'express';
import type { Request, Response } from 'express';
import { searchStoreSkills, getStoreSkillDetail, installStoreSkill, checkStoreUpdates, runSkillStoreMaintenance } from '../skillStore.js';

const router = Router();

// GET /api/v1/skill-store/search?keyword=&page=&page_size=&sort=&category=
router.get('/search', async (req: Request, res: Response) => {
  try {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size) || 20));
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'downloads';
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const data = await searchStoreSkills({ keyword: keyword || undefined, page, pageSize, sort: sort || undefined, category: category || undefined });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: `技能商店暂时不可用：${(error as Error).message}` });
  }
});

// GET /api/v1/skill-store/featured?page=&page_size=
router.get('/featured', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size) || 20));
    const data = await searchStoreSkills({ page, pageSize, sort: 'downloads' });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: `技能商店暂时不可用：${(error as Error).message}` });
  }
});

// POST /api/v1/skill-store/install  { id: number|string }
router.post('/install', async (req: Request, res: Response) => {
  try {
    const id = req.body?.id;
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const result = await installStoreSkill(id);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(502).json({ error: `安装失败：${(error as Error).message}` });
  }
});

// POST /api/v1/skill-store/maintenance  （立即执行一次自动更新 + 测试通道检查）
router.post('/maintenance', async (_req: Request, res: Response) => {
  try {
    const summary = await runSkillStoreMaintenance();
    res.json({ success: true, ...summary });
  } catch (error) {
    res.status(500).json({ error: `维护任务失败：${(error as Error).message}` });
  }
});

// GET /api/v1/skill-store/updates
router.get('/updates', async (_req: Request, res: Response) => {
  try {
    const updates = await checkStoreUpdates();
    res.json({ updates });
  } catch (error) {
    res.status(500).json({ error: `检查更新失败：${(error as Error).message}` });
  }
});

export default router;

// GET /api/v1/skill-store/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const data = await getStoreSkillDetail(String(req.params.id));
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: `获取技能详情失败：${(error as Error).message}` });
  }
});

