import { Router } from 'express';
import multer from 'multer';
import { getDb, queryOne } from '../db.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * POST /api/v1/transcribe
 * 将音频转写为文字（OpenAI 兼容 /audio/transcriptions 接口）
 * Body: FormData with audio file
 * Response: { text: string }
 *
 * 配置项（存于 settings 表，设置页可编辑）：
 * - stt_api_key   : STT 服务 API Key（必填）
 * - stt_base_url  : OpenAI 兼容服务地址，默认 https://api.openai.com/v1
 * - stt_model     : 模型名，默认 whisper-1
 */
router.post('/', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到音频文件' });
  }

  try {
    await getDb();

    const getSetting = (key: string): string | null => {
      const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]) as Record<string, string> | null;
      return row?.value ?? null;
    };

    const apiKey = getSetting('stt_api_key') || process.env.STT_API_KEY;
    const baseUrl = (getSetting('stt_base_url') || process.env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = getSetting('stt_model') || process.env.STT_MODEL || 'whisper-1';

    if (!apiKey) {
      return res.status(400).json({
        error: '未配置语音识别 API Key，请到 设置 → 语音识别 中填写（stt_api_key）',
      });
    }

    const form = new FormData();
    const blob = new Blob([req.file.buffer as unknown as Blob], { type: req.file.mimetype || 'audio/m4a' });
    form.append('file', blob, req.file.originalname || 'recording.m4a');
    form.append('model', model);

    const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    const data = (await resp.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
    if (!resp.ok) {
      return res.status(502).json({
        error: `语音识别服务返回错误 (${resp.status}): ${data?.error?.message || JSON.stringify(data)}`,
      });
    }

    return res.json({ text: data?.text || '' });
  } catch (err) {
    console.error('Transcription failed:', err);
    return res.status(500).json({ error: 'Transcription failed' });
  }
});

export default router;
