import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb, queryAll, queryOne, runSql, saveDb } from './db.js';

// 纯 JS 检索（sql.js 无法加载 sqlite-vss 原生扩展，故用 BM25 + 中文字形分词实现）
// 把项目文档/历史对话/用户备注切块入库，rag_search 检索后带出处引用。

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
const MAX_FILES = 200;
const MAX_FILE_KB = 300;
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

// 索引项目文件
export function indexProjectFiles(projectId: string, rootDir: string): number {
  const files: string[] = [];
  walkFiles(rootDir, files, 0);
  let inserted = 0;
  runSql('DELETE FROM knowledge_chunks WHERE project_id = ? AND doc_type = ?', [projectId, 'file']);
  for (const full of files) {
    try {
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      const content = fs.readFileSync(full, 'utf-8');
      const chunks = chunkText(content, rel, 'file', rel);
      for (const c of chunks) {
        runSql(
          'INSERT INTO knowledge_chunks (id, project_id, doc_type, source, title, chunk, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), projectId, c.docType, c.source, c.title, c.chunk, Date.now()]
        );
        inserted++;
      }
    } catch {
      // skip binary/unreadable
    }
  }
  saveDb();
  return inserted;
}

// 索引历史对话
export function indexChatHistory(projectId: string, limit = 200): number {
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
    const source = `chat:${String(row.id).slice(0, 8)}:${String(row.created_at || '')}`;
    const title = `${row.role === 'user' ? '用户' : 'Agent'} ${String(row.created_at || '')}`;
    const chunks = chunkText(String(row.content || ''), source, 'chat', title);
    for (const c of chunks) {
      runSql(
        'INSERT INTO knowledge_chunks (id, project_id, doc_type, source, title, chunk, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), projectId, c.docType, c.source, c.title, c.chunk, Date.now()]
      );
      inserted++;
    }
  }
  saveDb();
  return inserted;
}

// 用户备注入库
export function rememberNote(projectId: string | null, title: string, content: string): number {
  const chunks = chunkText(content, `note:${Date.now()}`, 'note', title);
  for (const c of chunks) {
    runSql(
      'INSERT INTO knowledge_chunks (id, project_id, doc_type, source, title, chunk, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), projectId || null, c.docType, c.source, c.title, c.chunk, Date.now()]
    );
  }
  saveDb();
  return chunks.length;
}

// 检索
export function searchKnowledge(projectId: string | null, query: string, topK = 5): string {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 'No searchable tokens in query.';
  const rows = queryAll(
    'SELECT id, chunk FROM knowledge_chunks WHERE project_id = ? ORDER BY created_at DESC LIMIT 3000',
    [projectId || null]
  ) as Array<Record<string, unknown>>;
  if (rows.length === 0) return 'Knowledge base is empty. Run rag_index first (scope: project/chat/all).';
  const docs = rows.map((r) => ({ id: String(r.id), chunk: String(r.chunk || '') }));
  const top = bm25(qTokens, docs, topK);
  if (top.length === 0) return 'No relevant results found. Try rag_index to rebuild the index.';
  const meta = new Map<string, { source: string; docType: string; title: string }>();
  for (const r of queryAll('SELECT id, source, doc_type, title FROM knowledge_chunks WHERE id IN (SELECT id FROM knowledge_chunks WHERE project_id = ? LIMIT 3000)', [projectId || null]) as Array<Record<string, unknown>>) {
    meta.set(String(r.id), { source: String(r.source || ''), docType: String(r.doc_type || ''), title: String(r.title || '') });
  }
  return top
    .map((r, i) => {
      const m = meta.get(r.id);
      const cite = m ? `【来源：${m.docType === 'chat' ? '历史对话' : m.docType === 'note' ? '用户备注' : '文件'} ${m.source}】` : '';
      const snippet = r.snippet.replace(/\s+/g, ' ').slice(0, 180);
      return `[${i + 1}] (相关度 ${r.score.toFixed(3)}) ${snippet}...\n${cite}`;
    })
    .join('\n\n');
}

export async function ensureKnowledgeTable(): Promise<void> {
  await getDb();
}

// ---- 经验记忆（agent_memory）：BM25 检索，自动注入对话开头 ----
export function rememberMemory(projectId: string | null, pattern: string, solution: string, context = ''): void {
  if (!pattern.trim() || !solution.trim()) return;
  const existing = queryOne(
    'SELECT id, use_count FROM agent_memory WHERE project_id = ? AND pattern = ? LIMIT 1',
    [projectId || null, pattern]
  ) as Record<string, unknown> | null;
  if (existing) {
    runSql('UPDATE agent_memory SET solution = ?, context = ?, use_count = use_count + 1, last_used_at = ? WHERE id = ?', [
      solution,
      context,
      new Date().toISOString(),
      existing.id,
    ]);
  } else {
    runSql(
      'INSERT INTO agent_memory (id, project_id, pattern, solution, context, confidence, use_count, created_at) VALUES (?, ?, ?, ?, ?, 0.5, 0, ?)',
      [crypto.randomUUID(), projectId || null, pattern, solution, context, new Date().toISOString()]
    );
  }
  saveDb();
}

export function recallMemories(projectId: string | null, query: string, topK = 5): string {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return '';
  const rows = queryAll(
    'SELECT id, pattern, solution, context, confidence, use_count FROM agent_memory WHERE project_id = ? OR project_id IS NULL',
    [projectId || null]
  ) as Array<Record<string, unknown>>;
  if (rows.length === 0) return '';
  const docs = rows.map((r) => ({ id: String(r.id), chunk: `${String(r.pattern || '')} ${String(r.solution || '')}` }));
  const top = bm25(qTokens, docs, topK);
  if (top.length === 0) return '';
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return top
    .map((r, i) => {
      const m = byId.get(r.id) || {};
      const confidence = Number(m.confidence || 0.5);
      const uses = Number(m.use_count || 0);
      return `[${i + 1}] 情境：${String(m.pattern || '').slice(0, 120)}
做法：${String(m.solution || '').slice(0, 400)}${m.context ? `\n上下文：${String(m.context).slice(0, 150)}` : ''}（置信 ${Math.round(confidence * 100)}%，用过 ${uses} 次）`;
    })
    .join('\n\n');
}
