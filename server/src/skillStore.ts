import * as zlib from 'zlib';
import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, runSql, saveDb } from './db.js';
import { logAudit } from './permissions.js';

/**
 * CocoLoop 技能商店客户端
 * 官方 API：https://api.cocoloop.com/api/v1/store/skills（17 万+ 免费 Skills）
 * 全自动闭环：搜索 → 安装（测试通道）→ 加载执行 → 后台自动更新/转正/卸载
 */

const STORE_API = 'https://api.cocoloop.com';
const DL_BASE = 'https://dl.cocoloop.cn/bss/skills/';
const TESTING_PROMOTE_MS = 3 * 24 * 3600 * 1000; // 3 天无问题自动转正式
const MAX_SKILL_ERRORS = 3; // 连续失败 3 次自动停用

export type SkillChannel = 'testing' | 'stable';

export interface StoreSkill {
  id: number;
  icon: string;
  author: string;
  name: string;
  subtitle: string;
  brief: string;
  category: string;
  security_level: string;
  source_credibility: string;
  github_stars: string;
  downloads: string;
  favorites: string;
  download_url: string;
  version?: string;
  asset_name?: string;
  file_size?: number;
  summary?: string;
  is_featured: boolean;
}

export interface InstallResult {
  name: string;
  version?: string;
  files: string[];
  description: string;
  summary?: string;
  channel: SkillChannel;
  already: boolean;
}

/**
 * 会话内最近读取的技能集合（按 sessionId）。
 * 用于失败归因：同一回合内读取技能后工具执行失败，给测试通道技能累计错误。
 */
const turnSkillMap = new Map<string, { skills: Set<string>; ts: number }>();

function getTurnSkills(sessionId: string): Set<string> {
  const now = Date.now();
  const entry = turnSkillMap.get(sessionId);
  if (entry && now - entry.ts < 30 * 60 * 1000) return entry.skills;
  const fresh = { skills: new Set<string>(), ts: now };
  turnSkillMap.set(sessionId, fresh);
  return fresh.skills;
}

export function rememberTurnSkill(sessionId: string, name: string): void {
  getTurnSkills(sessionId).add(name);
}

export function noteTurnSkillFailures(sessionId: string): void {
  const entry = turnSkillMap.get(sessionId);
  if (!entry) return;
  turnSkillMap.delete(sessionId);
  for (const name of entry.skills) bumpSkillError(name);
}

export function markSkillUsed(name: string): void {
  try {
    const row = queryOne('SELECT name, metadata FROM skills WHERE name = ?', [name]) as { name: string; metadata: string } | null;
    if (!row) return;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      // 忽略解析失败
    }
    meta.last_used_at = new Date().toISOString();
    runSql('UPDATE skills SET metadata = ? WHERE name = ?', [JSON.stringify(meta), name]);
    saveDb();
  } catch {
    // 忽略
  }
}

/** 给测试通道技能累计一次错误；达到阈值自动停用（有问题自动卸载） */
function bumpSkillError(name: string): void {
  try {
    const row = queryOne('SELECT name, metadata FROM skills WHERE name = ? AND enabled = 1', [name]) as { name: string; metadata: string } | null;
    if (!row) return;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      // 忽略解析失败
    }
    if (meta.channel !== 'testing') return;
    const cnt = Number(meta.error_count || 0) + 1;
    meta.error_count = cnt;
    runSql('UPDATE skills SET metadata = ? WHERE name = ?', [JSON.stringify(meta), name]);
    saveDb();
    if (cnt >= MAX_SKILL_ERRORS) {
      runSql('UPDATE skills SET enabled = 0 WHERE name = ?', [name]);
      saveDb();
      logAudit(null, 'skill_auto_remove', `测试通道技能「${name}」连续失败 ${cnt} 次，已自动停用`, 'medium', 'auto');
    }
  } catch {
    // 忽略
  }
}

async function storeFetch(path: string, timeoutMs = 20000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${STORE_API}${path}`, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`CocoLoop API 返回 ${res.status}`);
    const data = (await res.json()) as { code?: number; message?: string; data?: unknown } | null;
    if (!data || data.code !== 0) throw new Error(data?.message || 'CocoLoop API 错误');
    return data.data;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBuffer(url: string, timeoutMs = 60000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('下载内容为空');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchStoreSkills(opts: {
  keyword?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  category?: string;
}): Promise<{ items: StoreSkill[]; total: number; page: number; pages: number }> {
  const params = new URLSearchParams();
  params.set('page', String(opts.page || 1));
  params.set('page_size', String(opts.pageSize || 20));
  if (opts.keyword) params.set('keyword', opts.keyword);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.category) params.set('category', opts.category);
  const data = await storeFetch(`/api/v1/store/skills?${params.toString()}`);
  return {
    items: (data.items || []) as StoreSkill[],
    total: data.total || 0,
    page: data.page || 1,
    pages: data.pages || 0,
  };
}

export async function getStoreSkillDetail(id: number | string): Promise<StoreSkill & { summary?: string; original_desc?: string; changelog_url?: string }> {
  return storeFetch(`/api/v1/store/skills/${encodeURIComponent(String(id))}`);
}

/** 极简 zip 解包：支持 store/deflate 两种压缩方式（Node 内置 zlib，无新增依赖） */
export function extractZipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const entries: Array<{ name: string; data: Buffer }> = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break; // 本地文件头
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    let data: Buffer;
    try {
      if (method === 0) {
        data = buf.slice(dataStart, dataStart + compSize);
      } else if (method === 8) {
        data = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize));
      } else {
        offset = dataStart + compSize;
        continue;
      }
    } catch {
      offset = dataStart + compSize;
      continue;
    }
    entries.push({ name, data });
    offset = dataStart + compSize;
  }
  return entries;
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const body = m[1];
  const out: { name?: string; description?: string } = {};
  const nameM = /^name:\s*(.+)$/m.exec(body);
  if (nameM) out.name = nameM[1].trim().replace(/^['"]|['"]$/g, '');
  const descM = /^description:\s*(.+)$/m.exec(body);
  if (descM) {
    let desc = descM[1].trim();
    if (desc.startsWith('>')) {
      const idx = descM.index + descM[0].length;
      const rest = body.slice(idx).split('\n');
      const folded = rest
        .filter((l) => l.trim().startsWith(' ') || l.trim() === '')
        .map((l) => l.trim())
        .join(' ')
        .trim();
      if (folded) desc = folded;
    }
    out.description = desc.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/**
 * 安装（或更新）CocoLoop 技能。
 * - 已安装同版本：直接复用，保留测试通道状态（already: true）
 * - 新安装：opts.auto=true 进入测试通道，否则正式通道
 * - 更新已有技能：保留原通道 / 错误计数 / 安装时间（测试通道 3 天倒计时不重置）
 */
export async function installStoreSkill(id: number | string, opts: { auto?: boolean } = {}): Promise<InstallResult> {
  await getDb();
  const detail = await getStoreSkillDetail(id);
  const dlUrl = detail.download_url || (detail.asset_name ? `${DL_BASE}${detail.asset_name}` : '');
  if (!dlUrl) throw new Error(`技能「${detail.name || id}」没有可用下载地址`);

  const existing = queryOne('SELECT id, name, description, metadata, enabled FROM skills WHERE source = ?', [
    `cocoloop:${detail.id}`,
  ]) as { id: string; name: string; description: string; metadata: string; enabled: number } | null;
  let existingMeta: Record<string, unknown> = {};
  if (existing) {
    try {
      existingMeta = JSON.parse(existing.metadata || '{}');
    } catch {
      // 忽略解析失败
    }
  }
  const latestVersion = detail.version || 'v1.0.0';
  const installedVersion = String(existingMeta.cocoloop_version || '');

  // 已安装且版本一致 → 直接复用
  if (existing && existing.enabled === 1 && installedVersion === latestVersion) {
    const files = Array.isArray(existingMeta.files) ? (existingMeta.files as string[]) : [];
    const channel = existingMeta.channel === 'testing' ? 'testing' : 'stable';
    return {
      name: existing.name,
      version: detail.version,
      files,
      description: existing.description || '',
      summary: detail.summary,
      channel,
      already: true,
    };
  }

  const zipBuf = await downloadBuffer(dlUrl);
  const entries = extractZipEntries(zipBuf);
  const skillEntry =
    entries.find((e) => e.name === 'SKILL.md') ||
    entries.find((e) => e.name.endsWith('/SKILL.md') || e.name.endsWith('\\SKILL.md'));
  if (!skillEntry) throw new Error('技能包缺少 SKILL.md，无法安装');

  const content = skillEntry.data.toString('utf8');
  const fm = parseFrontmatter(content);
  const name = fm.name || detail.name || `cocoloop-${detail.id}`;
  const description = fm.description || detail.subtitle || detail.brief || '';
  const files = entries
    .map((e) => e.name)
    .filter((n) => !n.endsWith('/') && !n.endsWith('\\'))
    .slice(0, 50);

  const channel: SkillChannel =
    existingMeta.channel === 'testing' || existingMeta.channel === 'stable'
      ? (existingMeta.channel as SkillChannel)
      : opts.auto
        ? 'testing'
        : 'stable';

  const metadata = {
    cocoloop_id: detail.id,
    cocoloop_version: latestVersion,
    author: detail.author || '',
    category: detail.category || '',
    security_level: detail.security_level || '',
    downloads: detail.downloads || '',
    favorites: detail.favorites || '',
    download_url: dlUrl,
    file_size: detail.file_size || zipBuf.length,
    files,
    installed_at: String(existingMeta.installed_at || new Date().toISOString()),
    channel,
    auto_installed: existing ? Number(existingMeta.auto_installed ?? 0) : opts.auto ? 1 : 0,
    error_count: Number(existingMeta.error_count || 0),
    last_used_at: String(existingMeta.last_used_at || ''),
    updated_at: new Date().toISOString(),
  };

  const newId = `skill_${randomUUID()}`;
  runSql(
    `INSERT INTO skills (id, name, description, content, metadata, source, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       content = excluded.content,
       metadata = excluded.metadata,
       source = excluded.source,
       enabled = 1,
       updated_at = datetime('now')`,
    [newId, name, description, content, JSON.stringify(metadata), `cocoloop:${detail.id}`]
  );
  saveDb();
  return { name, version: detail.version, files, description, summary: detail.summary, channel, already: false };
}

/** 检查已安装的 CocoLoop 技能是否有更新（按需调用，逐条查详情） */
export async function checkStoreUpdates(): Promise<
  Array<{ id: number; name: string; installedVersion: string; latestVersion: string; hasUpdate: boolean }>
> {
  await getDb();
  const rows = queryAll(
    `SELECT name, source, metadata FROM skills WHERE source LIKE 'cocoloop:%'`
  ) as Array<{ name: string; source: string; metadata: string }>;
  const out: Array<{ id: number; name: string; installedVersion: string; latestVersion: string; hasUpdate: boolean }> = [];
  for (const row of rows) {
    const id = Number(row.source.replace(/^cocoloop:/, ''));
    if (!id) continue;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      // 忽略解析失败
    }
    try {
      const detail = await getStoreSkillDetail(id);
      const installed = String(meta.cocoloop_version || '');
      const latest = String(detail.version || '');
      out.push({
        id,
        name: row.name,
        installedVersion: installed,
        latestVersion: latest,
        hasUpdate: !!latest && installed !== latest,
      });
    } catch {
      // 单个技能查询失败不影响其它
    }
  }
  return out;
}

/**
 * 后台维护任务（服务启动后 + 每 24h 自动执行）：
 * 1. 自动更新：已安装的 CocoLoop 技能有新版本时自动升级（保留通道）
 * 2. 测试通道：3 天无问题自动转正式；失败 ≥3 次自动停用
 */
export async function runSkillStoreMaintenance(): Promise<{
  checked: number;
  updated: number;
  promoted: number;
  removed: number;
  errors: number;
}> {
  await getDb();
  const result = { checked: 0, updated: 0, promoted: 0, removed: 0, errors: 0 };

  const rows = queryAll(
    `SELECT name, source, metadata, enabled FROM skills WHERE source LIKE 'cocoloop:%' AND enabled = 1 LIMIT 10`
  ) as Array<{ name: string; source: string; metadata: string; enabled: number }>;

  for (const row of rows) {
    const id = Number(row.source.replace(/^cocoloop:/, ''));
    if (!id) continue;
    result.checked++;
    try {
      const detail = await getStoreSkillDetail(id);
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(row.metadata || '{}');
      } catch {
        // 忽略解析失败
      }
      const installed = String(meta.cocoloop_version || '');
      const latest = String(detail.version || '');
      if (latest && installed !== latest) {
        const res = await installStoreSkill(id); // 保留原通道/错误计数
        result.updated++;
        logAudit(null, 'skill_auto_update', `技能「${res.name}」自动更新 ${installed} → ${latest}`, 'none', 'auto');
      }
    } catch {
      result.errors++;
    }
  }

  const testing = queryAll(
    `SELECT name, metadata FROM skills WHERE enabled = 1 AND source LIKE 'cocoloop:%'`
  ) as Array<{ name: string; metadata: string }>;
  for (const row of testing) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      // 忽略解析失败
    }
    if (meta.channel !== 'testing') continue;
    const errCount = Number(meta.error_count || 0);
    if (errCount >= MAX_SKILL_ERRORS) {
      runSql('UPDATE skills SET enabled = 0 WHERE name = ?', [row.name]);
      saveDb();
      result.removed++;
      logAudit(null, 'skill_testing_removed', `测试通道技能「${row.name}」出现 ${errCount} 次失败，已自动停用`, 'medium', 'auto');
      continue;
    }
    const installedAt = String(meta.installed_at || '');
    const ageMs = installedAt ? Date.now() - new Date(installedAt).getTime() : 0;
    if (ageMs >= TESTING_PROMOTE_MS && errCount === 0) {
      meta.channel = 'stable';
      runSql('UPDATE skills SET metadata = ? WHERE name = ?', [JSON.stringify(meta), row.name]);
      saveDb();
      result.promoted++;
      logAudit(null, 'skill_testing_promoted', `测试通道技能「${row.name}」连续 3 天无问题，已转正式`, 'none', 'auto');
    }
  }

  return result;
}
