import { Router } from 'express';
import { getOllamaStatus } from '../ollama.js';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    res.json(await getOllamaStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
