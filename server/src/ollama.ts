/**
 * Ollama 本地模型路由
 * - 优先调用本地 Ollama
 * - 失败时自动降级到 DeepSeek 云端
 */

const OLLAMA_BASE = 'http://127.0.0.1:11434';

// 本地模型配置
export const OLLAMA_MODELS = {
  CHAT: 'qwen2.5:1.5b',
  REASONING: 'deepseek-r1:1.5b',
  EMBEDDING: 'nomic-embed-text',
} as const;

// 意图检测
export function detectIntent(text: string): 'reasoning' | 'chat' {
  const reasoningKeywords = ['分析', '推理', '判断', '比较', '为什么', '解释', '评估', '总结', '规划', '设计'];
  if (reasoningKeywords.some(kw => text.includes(kw))) return 'reasoning';
  return 'chat';
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
  messages: Array<{ role: string; content: string }>,
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
    const data = await res.json();
    return { content: data.message?.content || '' };
  } catch (e: any) {
    return { content: '', error: `Ollama 连接失败: ${e.message}` };
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
    const intent = detectIntent(user);
    const model = intent === 'reasoning' ? OLLAMA_MODELS.REASONING : OLLAMA_MODELS.CHAT;
    
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
