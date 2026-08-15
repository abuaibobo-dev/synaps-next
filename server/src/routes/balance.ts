import { Router } from 'express';
import { getDb, queryOne } from '../db.js';

const router = Router();

/**
 * GET /api/v1/balance
 * Get DeepSeek API balance (从设置读取 Key，调用 DeepSeek 官方余额接口)
 * Response: { balance: number, currency: string, available: boolean }
 */
router.get('/', async (_req, res) => {
  try {
    await getDb();
    const keyRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_api_key']);
    const apiKey = keyRow && typeof keyRow.value === 'string' && keyRow.value ? keyRow.value : '';

    if (!apiKey) {
      return res.json({ balance: 0, available: false, message: '未配置 API Key，请到 设置 → AI 模型 填写' });
    }

    const baseRow = queryOne('SELECT value FROM settings WHERE key = ?', ['ai_base_url']);
    const baseUrl = baseRow && typeof baseRow.value === 'string' && baseRow.value ? baseRow.value : 'https://api.deepseek.com';
    const url = `${baseUrl.replace(/\/+$/, '')}/user/balance`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      return res.json({ balance: 0, available: false, message: `余额查询失败（${resp.status}）：Key 无效或接口异常` });
    }
    const data = (await resp.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    const total = Math.round(infos.reduce((sum, i) => sum + (parseFloat(i.total_balance || '0') || 0), 0) * 100) / 100;
    const currency = infos[0]?.currency || 'CNY';
    if (!data.is_available && infos.length === 0) {
      return res.json({ balance: 0, available: false, message: '余额接口返回不可用' });
    }
    return res.json({ balance: total, currency, available: true, message: 'ok' });
  } catch {
    return res.json({ balance: 0, available: false, message: '余额查询失败（网络或接口异常）' });
  }
});

export default router;
