import { Router } from 'express';
import type { Request, Response } from 'express';
import { getCapabilityRegistry } from '../capabilityKernel.js';
import { listEvolutionRuns, runEvolutionStep } from '../evolutionRunner.js';
import { getBenchmarkReport } from '../benchmark.js';

const router = Router();

router.get('/capabilities', async (_req: Request, res: Response) => {
  try {
    res.json(await getCapabilityRegistry());
  } catch (error) {
    res.status(500).json({ error: 'Failed to build capability registry: ' + String(error) });
  }
});

router.get('/benchmark', async (_req: Request, res: Response) => {
  try {
    res.json(await getBenchmarkReport());
  } catch (error) {
    res.status(500).json({ error: 'Failed to build benchmark: ' + String(error) });
  }
});

router.get('/upgrade-runs', (_req: Request, res: Response) => {
  try {
    res.json({ runs: listEvolutionRuns(60) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load upgrades: ' + String(error) });
  }
});

router.post('/upgrades/:stepId/run', async (req: Request, res: Response) => {
  try {
    const result = await runEvolutionStep(String(req.params.stepId || ""), req.body?.approved === true);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to run upgrade: ' + String(error) });
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
