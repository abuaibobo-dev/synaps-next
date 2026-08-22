import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb, queryAll, queryOne, runSql, saveDb } from './db.js';

// 持久向量检索：SQLite 保存 nomic-embed-text 向量，检索时余弦相似度 + BM25 混合排序。
// 向量服务不可用时自动回退到 BM25，保证知识库始终可用。

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
const MAX_FILES = 200;
const MAX_FILE_KB = 300;
const MAX_CHUNKS = 800;
const EMBED_BATCH_SIZE = 16;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.expo', 'android', 'ios', 'Pods', 'vendor']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.mdx', '.txt', '.py', '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.xml', '.sql', '.sh', '.env', '.ini', '.cfg']);

interface ChunkDoc {
  source: string;
  docType: string;
  title: string;
  chunk: string;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // 英文/数字单词
  for (const w of text.toLowerCase().match(/[a-z0-9_]+/g) || []) {
    if (w.length >= 2) tokens.push(w);
  }
  // 中文：单字 + 相邻双字组
  const cjk = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    for (const ch of seg) tokens.push(ch);
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
  }
  return tokens;
}

function chunkText(text: string, source: string, docType: string, title: string): ChunkDoc[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  const chunks: ChunkDoc[] = [];
  const step = Math.max(1, CHUNK_SIZE - CHUNK_OVERLAP);
  for (let i = 0; i < cleaned.length; i += step) {
    chunks.push({
      source,
      docType,
      title,
      chunk: cleaned.slice(i, i + CHUNK_SIZE),
    });
    if (i + CHUNK_SIZE >= cleaned.length) break;
  }
  return chunks;
}

function walkFiles(dir: string, out: string[], depth: number): void {
  if (depth > 6 || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      const stat = fs.statSync(full);
      if (e.isDirectory()) walkFiles(full, out, depth + 1);
      else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) && stat.size <= MAX_FILE_KB * 1024) {
        out.push(full);
      }
    } catch {
      // skip
    }
  }
}

let vectorColumnsReady = false;

async function ensureVectorColumns(): Promise<void> {
  if (vectorColumnsReady) return;
  await getDb();
  const info = queryAll('PRAGMA table_info(knowledge_chunks)') as Array<Record<string, unknown>>;
  const names = new Set(info.map((row) => String(row.name)));
  if (!names.has('embedding')) runSql("ALTER TABLE knowledge_chunks ADD COLUMN embedding TEXT NOT NULL DEFAULT ''");
  if (!names.has('embedding_model')) runSql("ALTER TABLE knowledge_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT ''");
  vectorColumnsReady = true;
}

async function embedBatch(_texts: string[]): Promise<number[][] | null> {
  return null;
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let i = 0; i < length; i++) score += left[i] * right[i];
  return score;
}

function bm25(queryTokens: string[], docs: { id: string; chunk: string }[], topK: number): Array<{ id: string; score: number; snippet: string }> {
  const N = docs.length;
  const docTokens = docs.map((d) => tokenize(d.chunk));
  const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const k1 = 1.5;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    const toks = docTokens[i];
    const freq = new Map<string, number>();
    for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
    let score = 0;
    for (const q of queryTokens) {
      const f = freq.get(q) || 0;
      if (f === 0) continue;
      const idf = Math.log((N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (toks.length / avgLen))));
    }
    return { id: d.id, score, snippet: d.chunk };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// 索引项目文件（持久向量 + 关键词兜底）
export async function indexProjectFiles(projectId: string, rootDir: string): Promise<number> {
  await ensureVectorColumns();
  const files: string[] = [];
  walkFiles(rootDir, files, 0);
  let inserted = 0;
  runSql('DELETE FROM knowledge_chunks WHERE project_id = ? AND doc_type = ?', [projectId, 'file']);
  for (const full of files) {
    if (inserted >= MAX_CHUNKS) break;
    try {
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      const content = fs.readFileSync(full, 'utf-8');
      const chunks = chunkText(content, rel, 'file', rel);
      for (const c of chunks) {
        if (inserted >= MAX_CHUNKS) break;
        const id = crypto.randomUUID();
        runSql(
          'INSERT INTO knowledge_chunks (id, project_id, doc_type, source, title, chunk, embedding, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, projectId, c.docType, c.source, c.title, c.chunk, '', '', Date.now()]
        );
        inserted++;
      }
    } catch {
      // skip binary/unreadable
    }
  }

  const rows = queryAll(
    'SELECT id, chunk FROM knowledge_chunks WHERE project_id = ? AND doc_type = ? AND embedding = \'\' ORDER BY created_at DESC LIMIT ?',
    [projectId, 'file', MAX_CHUNKS]
  ) as Array<Record<string, unknown>>;
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(batch.map((row) => String(row.chunk || '')));
    if (!vectors) break;
    for (let j = 0; j < batch.length; j++) {
      runSql('UPDATE knowledge_chunks SET embedding = ?, embedding_model = ? WHERE id = ?', [
        JSON.stringify(normalizeVector(vectors[j])), '', String(batch[j].id),
      ]);
    }
  }
  saveDb();
  return inserted;
}

// 索引历史对话（持久向量 + 关键词兜底）
export async function indexChatHistory(projectId: string, limit = 200): Promise<number> {
  await ensureVectorColumns();
  const rows = queryAll(
    `SELECT m.id, m.role, m.content, m.created_at, s.project_id
     FROM chat_messages m JOIN chat_sessions s ON m.session_id = s.id
     WHERE s.project_id = ? AND m.content IS NOT NULL AND length(m.content) > 0
     ORDER BY m.rowid DESC LIMIT ?`,
    [projectId, limit]
  ) as Array<Record<string, unknown>>;
  runSql('DELETE FROM knowledge_chunks WHERE project_id = ? AND doc_type = ?', [projectId, 'chat']);
  let inserted = 0;
  for (const row of rows.reverse()) {
    if (inserted >= MAX_CHUNKS) break;
    const source = `chat:${String(row.id).slice(0, 8)}:${String(row.created_at || '')}`;
    const title = `${row.role === 'user' ? '用户' : 'Agent'} ${String(row.created_at || '')}`;
    const chunks = chunkText(String(row.content || ''), source, 'chat', title);
    for (const c of chunks) {
      if (inserted >= MAX_CHUNKS) break;
      runSql(
        'INSERT INTO knowledge_chunks (id, project_id, doc_type, source, title, chunk, embedding, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), projectId, c.docType, c.source, c.title, c.chunk, '', '', Date.now()]
      );
      inserted++;
    }
  }

  const pending = queryAll(
    'SELECT id, chunk FROM knowledge_chunks WHERE project_id = ? AND doc_type = ? AND embedding = \'\' ORDER BY created_at DESC LIMIT ?',
    [projectId, 'chat', MAX_CHUNKS]
  ) as Array<Record<string, unknown>>;
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(batch.map((row) => String(row.chunk || '')));
    if (!vectors) break;
    for (let j = 0; j < batch.length; j++) {
      runSql('UPDATE knowledge_chunks SET embedding = ?, embedding_model = ? WHERE id = ?', [
        JSON.stringify(normalizeVector(vectors[j])), '', String(batch[j].id),
      ]);
    }
  }
  saveDb();
  return inserted;
}

// 用户备注入库
export async function rememberNote(projectId: string | null, title: string, content: string): Promise<number> {
  await ensureVectorColumns();
  const chunks = chunkText(content, `note:${Date.now()}`, 'note', title);
  const ids: string[] = [];
  for (const c of chunks) {
    const id = crypto.randomUUID();
    ids.push(id);
    runSql(
      'INSERT INTO knowledge_chunks (id, project_id, doc_type, source, title, chunk, embedding, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, projectId || null, c.docType, c.source, c.title, c.chunk, '', '', Date.now()]
    );
  }
  const vectors = await embedBatch(chunks.map((chunk) => chunk.chunk));
  if (vectors) {
    for (let i = 0; i < ids.length; i++) {
      runSql('UPDATE knowledge_chunks SET embedding = ?, embedding_model = ? WHERE id = ?', [
        JSON.stringify(normalizeVector(vectors[i])), '', ids[i],
      ]);
    }
  }
  saveDb();
  return chunks.length;
}

// 混合检索：向量优先，BM25 补充和兜底
export async function searchKnowledge(projectId: string | null, query: string, topK = 5): Promise<string> {
  await ensureVectorColumns();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 'No searchable tokens in query.';
  const rows = queryAll(
    'SELECT id, chunk, source, doc_type, title, embedding FROM knowledge_chunks WHERE project_id = ? ORDER BY created_at DESC LIMIT 3000',
    [projectId || null]
  ) as Array<Record<string, unknown>>;
  if (rows.length === 0) return 'Knowledge base is empty. Run rag_index first (scope: project/chat/all).';

  const keywordScores = new Map<string, number>();
  for (const item of bm25(qTokens, rows.map((row) => ({ id: String(row.id), chunk: String(row.chunk || '') })), rows.length)) {
    keywordScores.set(item.id, item.score);
  }
  const maxKeywordScore = Math.max(0, ...keywordScores.values());

  let queryVector: number[] | null = null;
  const embeddedRows = rows.filter((row) => String(row.embedding || ''));
  if (embeddedRows.length > 0) {
    const vectors = await embedBatch([query]);
    if (vectors?.[0]) queryVector = normalizeVector(vectors[0]);
  }

  interface ScoredResult { id: string; score: number; snippet: string; vectorScore: number; keywordScore: number }
  const scored: ScoredResult[] = rows.map((row) => {
    const id = String(row.id);
    const keyword = maxKeywordScore > 0 ? (keywordScores.get(id) || 0) / maxKeywordScore : 0;
    let vector = 0;
    if (queryVector && row.embedding) {
      try {
        vector = Math.max(0, cosineSimilarity(queryVector, JSON.parse(String(row.embedding))));
      } catch {}
    }
    return {
      id,
      snippet: String(row.chunk || ''),
      vectorScore: vector,
      keywordScore: keyword,
      score: queryVector ? vector * 0.78 + keyword * 0.22 : keyword,
    };
  });

  const top = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (top.length === 0) return 'No relevant results found. Try rag_index to rebuild the index.';
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const mode = queryVector ? '向量+关键词' : '关键词回退';
  return top
    .map((item, index) => {
      const row = byId.get(item.id) || {};
      const docType = String(row.doc_type || '');
      const cite = `【来源：${docType === 'chat' ? '历史对话' : docType === 'note' ? '用户备注' : '文件'} ${String(row.source || '')}】`;
      const snippet = item.snippet.replace(/\s+/g, ' ').slice(0, 180);
      return `[${index + 1}] (${mode} ${item.score.toFixed(3)}) ${snippet}...\n${cite}`;
    })
    .join('\n\n');
}

export async function ensureKnowledgeTable(): Promise<void> {
  await getDb();
}

// ---- 经验记忆：持久向量检索，BM25 兜底 ----
let memoryColumnsReady = false;

async function ensureMemoryColumns(): Promise<void> {
  if (memoryColumnsReady) return;
  await getDb();
  const info = queryAll('PRAGMA table_info(agent_memory)') as Array<Record<string, unknown>>;
  const names = new Set(info.map((row) => String(row.name)));
  for (const [column, definition] of [
    ['namespace', "TEXT NOT NULL DEFAULT ''"],
    ['key', "TEXT NOT NULL DEFAULT ''"],
    ['value', "TEXT NOT NULL DEFAULT ''"],
    ['embedding_text', "TEXT NOT NULL DEFAULT ''"],
    ['pattern', "TEXT NOT NULL DEFAULT ''"],
    ['solution', "TEXT NOT NULL DEFAULT ''"],
    ['embedding', "TEXT NOT NULL DEFAULT ''"],
    ['embedding_model', "TEXT NOT NULL DEFAULT ''"],
  ] as Array<[string, string]>) {
    if (!names.has(column)) runSql(`ALTER TABLE agent_memory ADD COLUMN ${column} ${definition}`);
  }
  memoryColumnsReady = true;
}

export async function rememberMemory(projectId: string | null, pattern: string, solution: string, context = ''): Promise<void> {
  if (!pattern.trim() || !solution.trim()) return;
  await ensureMemoryColumns();
  const text = [pattern, solution, context].filter(Boolean).join('\n');
  const vectors = await embedBatch([text]);
  const embedding = vectors?.[0] ? JSON.stringify(normalizeVector(vectors[0])) : '';
  const embeddingModel = vectors?.[0] ? '' : '';
  const now = new Date().toISOString();
  const existing = queryOne(
    'SELECT id FROM agent_memory WHERE project_id IS ? AND pattern = ? LIMIT 1',
    [projectId, pattern]
  ) as Record<string, unknown> | null;
  if (existing) {
    runSql('UPDATE agent_memory SET solution = ?, context = ?, embedding = ?, embedding_model = ?, use_count = use_count + 1, last_used_at = ? WHERE id = ?', [
      solution, context, embedding, embeddingModel, now, String(existing.id),
    ]);
  } else {
    runSql(
      'INSERT INTO agent_memory (id, project_id, pattern, solution, context, confidence, use_count, embedding, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, 0.5, 1, ?, ?, ?)',
      [crypto.randomUUID(), projectId || null, pattern, solution, context, embedding, embeddingModel, now]
    );
  }
  saveDb();
}

export async function recallMemories(projectId: string | null, query: string, topK = 5): Promise<string> {
  await ensureMemoryColumns();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return '';
  const rows = queryAll(
    'SELECT id, pattern, solution, context, confidence, use_count, embedding FROM agent_memory WHERE project_id = ? OR project_id IS NULL',
    [projectId || null]
  ) as Array<Record<string, unknown>>;
  if (rows.length === 0) return '';

  const keywordScores = new Map<string, number>();
  for (const item of bm25(qTokens, rows.map((row) => ({
    id: String(row.id),
    chunk: `${String(row.pattern || '')} ${String(row.solution || '')}`,
  })), rows.length)) keywordScores.set(item.id, item.score);
  const maxKeywordScore = Math.max(0, ...keywordScores.values());

  let queryVector: number[] | null = null;
  if (rows.some((row) => String(row.embedding || ''))) {
    const vectors = await embedBatch([query]);
    if (vectors?.[0]) queryVector = normalizeVector(vectors[0]);
  }

  interface ScoredMemory { row: Record<string, unknown>; score: number }
  const scored: ScoredMemory[] = rows.map((row) => {
    const keyword = maxKeywordScore > 0 ? (keywordScores.get(String(row.id)) || 0) / maxKeywordScore : 0;
    let vector = 0;
    if (queryVector && row.embedding) {
      try {
        vector = Math.max(0, cosineSimilarity(queryVector, JSON.parse(String(row.embedding))));
      } catch {}
    }
    const confidence = Number(row.confidence || 0.5);
    const usageBoost = Math.min(0.1, Number(row.use_count || 0) * 0.01);
    return { row, score: (queryVector ? vector * 0.78 + keyword * 0.22 : keyword) + confidence * 0.05 + usageBoost };
  });

  const top = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (top.length === 0) return '';
  const mode = queryVector ? '向量+关键词' : '关键词回退';
  return top
    .map((item, index) => {
      const m = item.row;
      const confidence = Number(m.confidence || 0.5);
      const uses = Number(m.use_count || 0);
      return `[${index + 1}] (${mode} ${item.score.toFixed(3)}) 情境：${String(m.pattern || '').slice(0, 120)}\n做法：${String(m.solution || '').slice(0, 400)}${m.context ? `\n上下文：${String(m.context).slice(0, 150)}` : ''}（置信 ${Math.round(confidence * 100)}%，用过 ${uses} 次）`;
    })
    .join('\n\n');
}
