import { Router } from 'express';
import {
  getOllamaStatus,
  getOllamaPullJobs,
  pullOllamaModel,
  cancelOllamaPullJob,
  deleteOllamaModel,
} from '../ollama.js';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    res.json(await getOllamaStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/models', async (_req, res) => {
  try {
    const status = await getOllamaStatus();
    res.json({ ...status, jobs: getOllamaPullJobs() });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/models/pull', async (req, res) => {
  try {
    const model = String(req.body?.model || '').trim();
    const job = await pullOllamaModel(model);
    res.json({ success: true, job });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.delete('/models/pull/:id', async (req, res) => {
  const ok = cancelOllamaPullJob(String(req.params.id || ''));
  if (!ok) return res.status(404).json({ error: '下载任务不存在或已结束' });
  return res.json({ success: true });
});

router.delete('/models', async (req, res) => {
  try {
    const model = String(req.body?.model || '').trim();
    await deleteOllamaModel(model);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

export default router;
