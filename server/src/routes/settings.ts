import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';

const router = Router();

// GET /api/v1/settings - Get all settings
router.get('/', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const result = db.exec('SELECT key, value FROM settings');
    
    if (result.length === 0) {
      res.json({});
      return;
    }
    
    const settings: Record<string, string> = {};
    for (const row of result[0].values) {
      settings[row[0] as string] = row[1] as string;
    }
    
    res.json(settings);
  } catch (error) {
    console.error('Failed to get settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT /api/v1/settings - Update settings
router.put('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const settings = req.body as Record<string, string>;
    
    // Ensure settings table exists
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    
    for (const [key, value] of Object.entries(settings)) {
      db.run(
        `INSERT INTO settings (key, value, updated_at) 
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [key, value]
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// GET /api/v1/settings/:key - Get specific setting
router.get('/:key', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { key } = req.params;
    const result = db.exec('SELECT value FROM settings WHERE key = ?', [key as string]);
    
    if (result.length === 0 || result[0].values.length === 0) {
      res.status(404).json({ error: 'Setting not found' });
      return;
    }
    
    res.json({ key, value: result[0].values[0][0] });
  } catch (error) {
    console.error('Failed to get setting:', error);
    res.status(500).json({ error: 'Failed to get setting' });
  }
});

export default router;
