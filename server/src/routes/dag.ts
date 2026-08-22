import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentType } from '../agentInstance.js';
import { createDagPlan, getDagPlan, listDagPlans, reportDagNode, tickDagPlan } from '../dag.js';

const router = Router();

router.get('/plans', async (req: Request, res: Response) => {
  try {
    res.json({ plans: listDagPlans(req.query.projectId ? String(req.query.projectId) : null) });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get('/plans/:id', async (req: Request, res: Response) => {
  try {
    const plan = getDagPlan(String(req.params.id || ""));
    if (!plan) { res.status(404).json({ error: 'plan not found' }); return; }
    res.json({ plan });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post('/plans', async (req: Request, res: Response) => {
  try {
    const plan = createDagPlan({
      projectId: req.body?.projectId || null,
      objective: String(req.body?.objective || ''),
      maxParallel: Number(req.body?.maxParallel || 3),
      nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : [],
    });
    res.json({ ...tickDagPlan(plan.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/plans/:id/tick', async (req: Request, res: Response) => {
  try {
    res.json(tickDagPlan(String(req.params.id || "")));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/plans/:id/report', async (req: Request, res: Response) => {
  try {
    res.json(reportDagNode(
      String(req.params.id || ""),
      String(req.body?.nodeId || ''),
      req.body?.success === true,
      String(req.body?.result || '')
    ));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
