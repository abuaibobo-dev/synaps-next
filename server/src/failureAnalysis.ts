import { LLMClient, Config } from 'coze-coding-dev-sdk';
import { queryOne } from './db.js';

function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]) as Record<string, string> | null;
  return row?.value ?? null;
}

const FAILURE_MARKERS =
  /(^Error\b|\[Tool returned error\]|exit (code )?[1-9]\d*|command not found|ENOENT|EACCES|EADDRINUSE|TS\d{3,5}:|SyntaxError|TypeError|ReferenceError|npm ERR!|npm error|Failed|failure|failed|失败|找不到|未找到|无法解析)/i;

/**
 * 判断工具结果是否为失败。
 */
export function isFailureResult(_tool: string, result: string): boolean {
  const r = (result || '').trim();
  if (!r) return false;
  if (FAILURE_MARKERS.test(r)) return true;
  return false;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n...(截断)' : s;
}

/**
 * 调用 DeepSeek 分析失败原因，返回结构化分析文本；失败/未配置 Key 时返回 null。
 */
export async function analyzeFailure(tool: string, result: string): Promise<string | null> {
  const apiKey = getSetting('ai_api_key');
  if (!apiKey) return null;
  const baseUrl = getSetting('ai_base_url') || 'https://api.deepseek.com';
  const modelBaseUrl = getSetting('ai_model_base_url') || 'https://api.deepseek.com';
  const model = getSetting('ai_model') || 'deepseek-v4-flash';

  const client = new LLMClient(new Config({ apiKey, baseUrl, modelBaseUrl }));
  const prompt = `Synaps 的工具 "${tool}" 执行失败，以下是失败输出：\n\n${truncate(result, 2000)}\n\n请用中文只输出以下四行，不要任何多余内容：\n❌ 失败原因：一句话概括\n🔍 具体分析：2-3 句详细说明\n💡 修复建议：一条具体可执行的修复步骤\n🔄 一键修复：如果需要 Agent 自动修复写"需要"，否则写"不需要"`;

  try {
    let text = '';
    const stream = client.stream(
      [
        { role: 'system' as const, content: '你是严谨的软件工程诊断助手，回答必须精炼、可直接执行。' },
        { role: 'user' as const, content: prompt },
      ],
      { temperature: 0.3, model }
    );
    // 看门狗：60s 无数据 / 120s 总时长即放弃，避免拖慢主流程
    await Promise.race([
      (async () => {
        for await (const chunk of stream) {
          if (chunk.content) text += chunk.content.toString();
        }
      })(),
      new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 120_000);
        timer.unref?.();
      }),
    ]);
    if (!text.trim()) return null;
    return `[失败分析]\n${text.trim()}`;
  } catch {
    return null;
  }
}
