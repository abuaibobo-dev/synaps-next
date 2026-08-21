import { Router } from 'express';
import type { Request, Response } from 'express';
import { getCapabilityRegistry } from '../capabilityKernel.js';

const router = Router();

router.get('/capabilities', async (_req: Request, res: Response) => {
  try {
    res.json(await getCapabilityRegistry());
  } catch (error) {
    res.status(500).json({ error: 'Failed to build capability registry: ' + String(error) });
  }
});

router.get('/evolution-plan', async (_req: Request, res: Response) => {
  try {
    const registry = await getCapabilityRegistry();
    res.json({ generatedAt: registry.generatedAt, readiness: registry.readiness, ...registry.evolution });
  } catch (error) {
    res.status(500).json({ error: 'Failed to build evolution plan: ' + String(error) });
  }
});

export default router;
