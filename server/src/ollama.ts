/**
 * Ollama 本地模型路由
 * - 优先调用本地 Ollama
 * - 失败时自动降级到 DeepSeek 云端
 */

import * as crypto from 'crypto';
import { queryOne } from './db.js';

const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';

export function getOllamaBase(): string {
  try {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', ['ollama_base_url']) as Record<string, unknown> | null;
    const value = String(row?.value || '').trim().replace(/\/+$/, '');
    if (value && /^https?:\/\//i.test(value)) return value;
  } catch {
  }
  const host = String(process.env.OLLAMA_HOST || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return host ? `http://${host}` : DEFAULT_OLLAMA_BASE;
}

// 本地模型配置
export const OLLAMA_MODELS = {
  WRITING: 'qwen3:1.7b',
  VISION: 'moondream',
  CHAT: 'qwen2.5:1.5b',
  REASONING: 'deepseek-r1:1.7b',
  EMBEDDING: 'nomic-embed-text',
} as const;

export const OLLAMA_MODEL_CANDIDATES = {
  WRITING: ['qwen3:1.7b', 'dqnwrite', 'gemma3:1b'],
  VISION: ['moondream', 'llava'],
  CHAT: ['qwen2.5:1.5b', 'qwen3:1.7b', 'gemma3:1b'],
  REASONING: ['deepseek-r1:1.7b', 'deepseek-r1:1.5b', 'qwen3:1.7b'],
} as const;

export interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
}

export type OllamaIntent = 'writing' | 'vision' | 'reasoning' | 'chat';

// 意图检测：识图优先，其次写作，再按推理关键词路由
export function detectIntent(text: string, hasImage = false): OllamaIntent {
  if (hasImage) return 'vision';

  const writingKeywords = [
    '小说', '章节', '大纲', '剧情', '角色', '续写', '润色', '改写',
    '故事', '描写', '对话', '伏笔', '世界观', '写作', '写一篇', '写个',
  ];
  if (writingKeywords.some((keyword) => text.includes(keyword))) return 'writing';

  const reasoningKeywords = ['分析', '推理', '判断', '比较', '为什么', '解释', '评估', '总结', '规划', '设计'];
  if (reasoningKeywords.some(kw => text.includes(kw))) return 'reasoning';
  return 'chat';
}

export function selectOllamaModel(text: string, hasImage = false): string {
  const intent = detectIntent(text, hasImage);
  if (intent === 'writing') return OLLAMA_MODELS.WRITING;
  if (intent === 'vision') return OLLAMA_MODELS.VISION;
  if (intent === 'reasoning') return OLLAMA_MODELS.REASONING;
  return OLLAMA_MODELS.CHAT;
}

export async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${getOllamaBase()}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name?: string }> };
    return (data.models || []).map((model) => String(model.name || '')).filter(Boolean);
  } catch {
    return [];
  }
}

export async function selectAvailableOllamaModel(text: string, hasImage = false): Promise<string | null> {
  const installed = await listOllamaModels();
  if (!installed.length) return null;
  const normalize = (value: string) => value.toLowerCase().split(':')[0];
  const intent = detectIntent(text, hasImage);
  const preferred = intent === 'writing'
    ? OLLAMA_MODEL_CANDIDATES.WRITING
    : intent === 'vision'
      ? OLLAMA_MODEL_CANDIDATES.VISION
      : intent === 'reasoning'
        ? OLLAMA_MODEL_CANDIDATES.REASONING
        : OLLAMA_MODEL_CANDIDATES.CHAT;

  for (const candidate of preferred) {
    if (installed.includes(candidate)) return candidate;
    const baseName = normalize(candidate);
    const sameBase = installed.find((model) => normalize(model) === baseName);
    if (sameBase) return sameBase;
  }
  const visionModel = installed.find((model) => /moondream|llava|vision/i.test(model));
  if (hasImage && visionModel) return visionModel;
  return installed[0];
}

export function extractImagePaths(text: string): string[] {
  const matches = [...text.matchAll(/(?:已保存到|saved to)\s+([^\s，）,]+)/gi)];
  return matches
    .map((match) => match[1])
    .filter((filePath) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(filePath));
}

// 检查 Ollama 是否可用
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${getOllamaBase()}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function ollamaRuntimeOptions(temperature: number, maxTokens: number) {
  return {
    temperature,
    num_predict: Math.min(maxTokens, 1536),
    num_ctx: 2048,
    num_batch: 128,
  };
}

// 调用 Ollama 本地模型
export async function callOllama(
  model: string,
  messages: OllamaMessage[],
  temperature: number = 0.7,
  maxTokens: number = 4096
): Promise<{ content: string; error?: string }> {
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const err = await res.text();
      return { content: '', error: `Ollama ${res.status}: ${err}` };
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return { content: data.message?.content || '' };
  } catch (e: any) {
    return { content: '', error: `Ollama 连接失败: ${e.message}` };
  }
}

export interface OllamaStreamHandlers {
  onContent?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

export async function callOllamaStream(
  model: string,
  messages: OllamaMessage[],
  handlers: OllamaStreamHandlers,
  temperature: number = 0.7,
  maxTokens: number = 4096
): Promise<{ content: string; error?: string }> {
  let fullContent = '';
  let visibleContent = '';
  let thinkingBuffer = '';
  let insideThink = false;

  const emitVisible = (rawDelta: string): void => {
    let pending = rawDelta;
    while (pending) {
      if (!insideThink) {
        const start = pending.indexOf('<think>');
        if (start === -1) {
          if (pending) {
            visibleContent += pending;
            handlers.onContent?.(pending);
          }
          break;
        }
        const before = pending.slice(0, start);
        if (before) {
          visibleContent += before;
          handlers.onContent?.(before);
        }
        pending = pending.slice(start + '<think>'.length);
        insideThink = true;
      } else {
        const end = pending.indexOf('</think>');
        if (end === -1) {
          thinkingBuffer += pending;
          handlers.onThinking?.(pending);
          break;
        }
        const thought = pending.slice(0, end);
        if (thought) {
          thinkingBuffer += thought;
          handlers.onThinking?.(thought);
        }
        pending = pending.slice(end + '</think>'.length);
        insideThink = false;
      }
    }
  };

  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: '10m',
        options: ollamaRuntimeOptions(temperature, maxTokens),
      }),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok || !res.body) {
      const error = await res.text().catch(() => '');
      return { content: '', error: `Ollama ${res.status}: ${error || 'stream unavailable'}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line) as {
            message?: { content?: string; thinking?: string };
            response?: string;
          };
          const nativeThinking = payload.message?.thinking;
          if (nativeThinking) handlers.onThinking?.(nativeThinking);
          const delta = payload.message?.content ?? payload.response ?? '';
          if (delta) {
            fullContent += delta;
            emitVisible(delta);
          }
        } catch {
        }
      }
    }
    if (buffer.trim()) {
      try {
        const payload = JSON.parse(buffer) as { message?: { content?: string; thinking?: string } };
        const nativeThinking = payload.message?.thinking;
        if (nativeThinking) handlers.onThinking?.(nativeThinking);
        const delta = payload.message?.content || '';
        if (delta) {
          fullContent += delta;
          emitVisible(delta);
        }
      } catch {
      }
    }
    return { content: fullContent };
  } catch (e: any) {
    return {
      content: fullContent,
      error: `Ollama 连接失败: ${e?.message || e}`,
    };
  } finally {
    if (visibleContent) handlers.onContent?.('');
  }
}

export async function getOllamaStatus() {
  const configured = [
    { role: '写作', name: OLLAMA_MODELS.WRITING },
    { role: '识图', name: OLLAMA_MODELS.VISION },
    { role: '聊天', name: OLLAMA_MODELS.CHAT },
    { role: '推理', name: OLLAMA_MODELS.REASONING },
    { role: '向量', name: OLLAMA_MODELS.EMBEDDING },
  ];

  try {
    const res = await fetch(`${getOllamaBase()}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return { available: false, base: getOllamaBase(), installed: [], configured };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string; size?: number; modified_at?: string }> };
    const models = (data.models || []).map((model) => ({
      name: model.name || '',
      size: Number(model.size || 0),
      modifiedAt: model.modified_at || null,
    })).filter((model) => model.name);
    const installed = models.map((model) => model.name);
    return {
      available: true,
      base: getOllamaBase(),
      models,
      installed,
      configured: configured.map((item) => ({ ...item, installed: installed.includes(item.name) })),
    };
  } catch {
      return { available: false, base: getOllamaBase(), installed: [], configured };
  }
}

export interface OllamaModelInfo {
  name: string;
  size: number;
  modifiedAt?: string | null;
}

export interface OllamaPullJob {
  id: string;
  model: string;
  status: 'pulling' | 'success' | 'error' | 'cancelled';
  statusText: string;
  percent: number;
  bytesDone: number;
  bytesTotal: number;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

const pullJobs = new Map<string, { job: OllamaPullJob; abort: AbortController }>();

function normalizeOllamaModel(model: string): string {
  return model.trim().replace(/\s+/g, '');
}

export function getOllamaPullJobs(): OllamaPullJob[] {
  return [...pullJobs.values()].map((entry) => ({ ...entry.job }));
}

export function cancelOllamaPullJob(id: string): boolean {
  const entry = pullJobs.get(id);
  if (!entry || entry.job.status !== 'pulling') return false;
  entry.job.status = 'cancelled';
  entry.job.statusText = '已取消';
  entry.job.updatedAt = Date.now();
  entry.abort.abort();
  return true;
}

function explainOllamaPullError(error: Error): string {
  const raw = error.message || String(error);
  if (/file does not exist|manifest unknown|not found|\b404\b/i.test(raw)) {
    return `模型名不存在或当前 Ollama 版本不支持该来源：${raw}`;
  }
  if (/Failed to fetch|ECONNREFUSED|connect/i.test(raw)) {
    return `无法连接 Ollama（${getOllamaBase()}）。请确认服务已启动：${raw}`;
  }
  return raw;
}

export async function pullOllamaModel(rawModel: string): Promise<OllamaPullJob> {
  const model = normalizeOllamaModel(rawModel);
  if (!model) throw new Error('模型名称不能为空');
  if ([...pullJobs.values()].some((entry) => entry.job.model === model && entry.job.status === 'pulling')) {
    throw new Error(`模型 ${model} 正在下载`);
  }
  if (!(await isOllamaAvailable())) {
    throw new Error(`无法连接 Ollama（${getOllamaBase()}）。请先启动 Ollama 服务`);
  }

  const id = crypto.randomUUID();
  const abort = new AbortController();
  const job: OllamaPullJob = {
    id,
    model,
    status: 'pulling',
    statusText: '连接 Ollama...',
    percent: 0,
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  pullJobs.set(id, { job, abort });

  void (async () => {
    try {
      const res = await fetch(`${getOllamaBase()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${text || '下载请求失败'}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines.filter(Boolean)) {
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.error) throw new Error(String(event.error));
          const total = Number(event.total || 0);
          const completed = Number(event.completed || 0);
          job.statusText = String(event.status || job.statusText);
          if (total > 0) {
            job.bytesTotal = total;
            job.bytesDone = completed;
            job.percent = Math.max(job.percent, Math.min(100, Math.round((completed / total) * 100)));
          }
          job.updatedAt = Date.now();
        }
      }

      if (job.status === 'pulling') {
        job.status = 'success';
        job.statusText = '下载完成';
        job.percent = 100;
        job.updatedAt = Date.now();
      }
    } catch (error) {
      if (job.status !== 'cancelled') {
        job.status = 'error';
        job.error = explainOllamaPullError(error as Error);
        job.statusText = '下载失败';
      }
      job.updatedAt = Date.now();
    } finally {
      setTimeout(() => pullJobs.delete(id), 10 * 60 * 1000).unref?.();
    }
  })();

  return { ...job };
}

export async function deleteOllamaModel(rawModel: string): Promise<void> {
  const model = normalizeOllamaModel(rawModel);
  if (!model) throw new Error('模型名称不能为空');
  const res = await fetch(`${getOllamaBase()}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`删除失败（${res.status}）：${text || '未知错误'}`);
  }
}

// 智能路由：Ollama 优先 → DeepSeek 兜底
export async function smartComplete(
  system: string,
  user: string,
  deepseekFn: (system: string, user: string) => Promise<string>,
  temperature: number = 0.7
): Promise<{ content: string; provider: string }> {
  const ollamaOk = await isOllamaAvailable();
  
  if (ollamaOk) {
    const model = selectOllamaModel(user);
    
    const result = await callOllama(
      model,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature
    );
    
    if (!result.error && result.content) {
      return { content: result.content, provider: `ollama/${model}` };
    }
  }
  
  // 降级到 DeepSeek
  const content = await deepseekFn(system, user);
  return { content, provider: 'deepseek' };
}
