/**
 * Ollama 本地模型路由
 * - 优先调用本地 Ollama
 * - 失败时自动降级到 DeepSeek 云端
 */

const OLLAMA_BASE = 'http://127.0.0.1:11434';

// 本地模型配置
export const OLLAMA_MODELS = {
  WRITING: 'dqnwrite',
  VISION: 'moondream',
  CHAT: 'qwen2.5:1.5b',
  REASONING: 'deepseek-r1:1.5b',
  EMBEDDING: 'nomic-embed-text',
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

export function extractImagePaths(text: string): string[] {
  const matches = [...text.matchAll(/(?:已保存到|saved to)\s+([^\s，）,]+)/gi)];
  return matches
    .map((match) => match[1])
    .filter((filePath) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(filePath));
}

// 检查 Ollama 是否可用
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 调用 Ollama 本地模型
export async function callOllama(
  model: string,
  messages: OllamaMessage[],
  temperature: number = 0.7,
  maxTokens: number = 4096
): Promise<{ content: string; error?: string }> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
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

export async function getOllamaStatus() {
  const configured = [
    { role: '写作', name: OLLAMA_MODELS.WRITING },
    { role: '识图', name: OLLAMA_MODELS.VISION },
    { role: '聊天', name: OLLAMA_MODELS.CHAT },
    { role: '推理', name: OLLAMA_MODELS.REASONING },
    { role: '向量', name: OLLAMA_MODELS.EMBEDDING },
  ];

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return { available: false, base: OLLAMA_BASE, installed: [], configured };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const installed = (data.models || []).map((model) => model.name || '').filter(Boolean);
    return {
      available: true,
      base: OLLAMA_BASE,
      installed,
      configured: configured.map((item) => ({ ...item, installed: installed.includes(item.name) })),
    };
  } catch {
    return { available: false, base: OLLAMA_BASE, installed: [], configured };
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
