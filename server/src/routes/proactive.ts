import { Router } from 'express';
import type { Request, Response } from 'express';
import { generateProactiveSuggestions, listProactiveSuggestions, updateSuggestionFeedback } from '../proactive.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    await generateProactiveSuggestions();
    const suggestions = await listProactiveSuggestions();
    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate suggestions: ' + String(error) });
  }
});

router.post('/:id/feedback', async (req: Request, res: Response) => {
  const action = String(req.body?.action || '') as 'accept' | 'dismiss' | 'snooze';
  if (!['accept', 'dismiss', 'snooze'].includes(action)) {
    res.status(400).json({ error: 'action must be accept, dismiss or snooze' });
    return;
  }
  try {
    const suggestion = await updateSuggestionFeedback(String(req.params.id || ''), action);
    if (!suggestion) {
      res.status(404).json({ error: 'suggestion not found' });
      return;
    }
    res.json({ suggestion });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update suggestion: ' + String(error) });
  }
});

export default router;
