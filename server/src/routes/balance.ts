import { Router } from 'express';

const router = Router();

/**
 * GET /api/v1/balance
 * Get DeepSeek API balance
 * Response: { balance: number, available: boolean }
 */
router.get('/', async (_req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    return res.json({ balance: 0, available: false, message: 'API key not configured' });
  }

  try {
    // DeepSeek doesn't have a public balance API, so we return a mock
    // In production, you would integrate with DeepSeek's billing API
    // For now, we just indicate the API is available
    return res.json({
      balance: -1, // -1 means unlimited/unknown
      available: true,
      message: 'API available',
    });
  } catch {
    return res.json({ balance: 0, available: false, message: 'Failed to fetch balance' });
  }
});

export default router;
