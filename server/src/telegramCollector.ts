import { randomUUID } from 'crypto';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';
import { NewMessage } from 'telegram/events';
import { getDb, queryOne, queryAll, runSql, saveDb } from './db.js';
import { logAudit } from './permissions.js';

// ============================================================
// Telegram 频道采集转发器 — 无痕转发 + 限速反检测 + 全自动
// ============================================================

// ==================== Settings ====================
function getSetting(key: string): string | null {
  try { const r = queryOne('SELECT value FROM settings WHERE key = ?', [key]); return (r?.value as string | null) ?? null; } catch { return null; }
}
function setSetting(key: string, value: string): void {
  runSql(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, [key, value]);
  saveDb();
}

// ==================== Rate Limiter ====================
const DAILY_LIMIT_NEW = 50;   // <30 天账号
const DAILY_LIMIT_OLD = 200;  // >90 天账号
const HOURLY_LIMIT = 30;
const BURST_LIMIT = 10;       // 每批最多处理 10 条

let dailyCount = 0;
let hourlyCount = 0;
let burstCount = 0;
let hourResetAt = Date.now();
let dayResetAt = Date.now();
let burstResetAt = Date.now();

function exponentialRandom(meanMs: number): number {
  return -meanMs * Math.log(1 - Math.random());
}

function canSend(): { ok: boolean; waitMs: number; reason: string } {
  const now = Date.now();
  if (now - dayResetAt > 86400000) { dailyCount = 0; dayResetAt = now; }
  if (now - hourResetAt > 3600000) { hourlyCount = 0; hourResetAt = now; }
  if (now - burstResetAt > 300000) { burstCount = 0; burstResetAt = now; }
  if (dailyCount >= DAILY_LIMIT_OLD) return { ok: false, waitMs: 3600000, reason: 'daily_limit' };
  if (hourlyCount >= HOURLY_LIMIT) {
    const wait = 3600000 - (now - hourResetAt);
    return { ok: false, waitMs: Math.min(wait, 3600000), reason: 'hourly_limit' };
  }
  if (burstCount >= BURST_LIMIT) {
    burstCount = 0; burstResetAt = now;
    return { ok: false, waitMs: exponentialRandom(30000), reason: 'burst_limit' };
  }
  return { ok: true, waitMs: 0, reason: '' };
}

function recordSend(): void { dailyCount++; hourlyCount++; burstCount++; }

function getRateStatus(): { daily: number; hourly: number; burst: number } {
  return { daily: dailyCount, hourly: hourlyCount, burst: burstCount };
}

// ==================== Client ====================
let client: TelegramClient | null = null;

function getProxy(): any {
  const raw = getSetting('telegram_proxy');
  if (!raw) return undefined;
  try { const p = JSON.parse(raw); return { ip: p.ip, port: p.port, MTProxy: p.MTProxy, secret: p.secret, socksType: p.socksType, username: p.username, password: p.password }; } catch { return undefined; }
}

async function ensureClient(): Promise<TelegramClient> {
  if (client) return client;
  const sessionStr = getSetting('telegram_session') || '';
  const apiIdStr = getSetting('telegram_api_id');
  const apiHash = getSetting('telegram_api_hash');
  if (!apiIdStr || !apiHash) throw new Error('未配置 Telegram API 凭证');
  const session = new StringSession(sessionStr);
  const proxy = getProxy();
  client = new TelegramClient(session, Number(apiIdStr), apiHash, {
    connectionRetries: 3, retryDelay: 2000, autoReconnect: true, proxy: proxy as any,
  });
  if (sessionStr) {
    try { if (!client.connected) await client.connect(); } catch (err) { client = null; throw new Error(`连接失败：${(err as Error).message}`); }
  }
  return client;
}

function persistSession(c: TelegramClient): void {
  const saved = (c.session as any).save() || '';
  if (saved) setSetting('telegram_session', saved);
}

// ==================== Exponential Backoff Retry ====================
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err: any) {
      lastErr = err;
      if (err.message?.includes('FLOOD_WAIT')) {
        const waitSec = parseInt(err.message.match(/FLOOD_WAIT_(\d+)/)?.[1] || '30');
        const waitMs = waitSec * 1000;
        console.log(`[TG] FloodWait: waiting ${waitSec}s`);
        await sleep(waitMs);
        continue;
      }
      if (i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i) + exponentialRandom(500);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ==================== Login ====================
interface PendingLogin { apiId: number; apiHash: string; phone: string; phoneCodeHash?: string; client: TelegramClient; }
let pendingLogin: PendingLogin | null = null;

export async function startLogin(apiId: number, apiHash: string, phone: string): Promise<{ step: 'code' }> {
  const session = new StringSession('');
  const proxy = getProxy();
  const c = new TelegramClient(session, apiId, apiHash, { connectionRetries: 2, autoReconnect: false, proxy: proxy as any });
  await c.connect();
  try {
    const result = await c.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId, apiHash, settings: new Api.CodeSettings({}),
    }));
    pendingLogin = { apiId, apiHash, phone, phoneCodeHash: (result as any).phoneCodeHash, client: c };
    setSetting('telegram_api_id', String(apiId));
    setSetting('telegram_api_hash', apiHash);
    setSetting('telegram_phone', phone);
    return { step: 'code' };
  } catch (err) { await c.disconnect().catch(() => {}); throw new Error(`发送验证码失败：${(err as Error).message}`); }
}

export async function submitCode(code: string): Promise<{ step: 'done' } | { step: 'password'; message: string }> {
  if (!pendingLogin) throw new Error('没有正在进行的登录流程');
  const { client: c, phone, phoneCodeHash } = pendingLogin;
  try {
    await c.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: phoneCodeHash!, phoneCode: code }));
    finishLogin(c);
    return { step: 'done' };
  } catch (err: any) {
    if (err.message?.includes('SESSION_PASSWORD')) return { step: 'password', message: '需要两步验证密码' };
    await c.disconnect().catch(() => {}); pendingLogin = null;
    throw new Error(`验证失败：${(err as Error).message}`);
  }
}

export async function submitPassword(password: string): Promise<{ step: 'done' }> {
  if (!pendingLogin) throw new Error('没有正在进行的登录流程');
  const { client: c } = pendingLogin;
  try {
    await (c as any).invoke({ _: 'auth.checkPassword', password });
    finishLogin(c);
    return { step: 'done' };
  } catch (err) { await c.disconnect().catch(() => {}); pendingLogin = null; throw new Error(`密码验证失败：${(err as Error).message}`); }
}

function finishLogin(c: TelegramClient): void { persistSession(c); client = c; pendingLogin = null; logAudit(null, 'telegram_login', 'Telegram 登录成功', 'none', 'auto'); }

export async function logout(): Promise<void> {
  try { if (client) { await client.invoke(new Api.auth.LogOut()); await client.disconnect().catch(() => {}); } } catch {}
  client = null; pendingLogin = null;
  runSql("DELETE FROM settings WHERE key = 'telegram_session'", []); saveDb();
}

// ==================== Status ====================
export async function getStatus() {
  const phone = getSetting('telegram_phone');
  const apiIdStr = getSetting('telegram_api_id');
  if (pendingLogin) return { loggedIn: false, connected: true, pendingLogin: true, phone: pendingLogin.phone, apiId: pendingLogin.apiId };
  try {
    const c = await ensureClient();
    const me = await c.getMe();
    return { loggedIn: !!me, phone: phone || undefined, apiId: apiIdStr ? Number(apiIdStr) : undefined, connected: Boolean(c.connected), rate: getRateStatus() };
  } catch { return { loggedIn: false, phone: phone || undefined, apiId: apiIdStr ? Number(apiIdStr) : undefined, connected: false }; }
}

// ==================== Channels ====================
export interface ChannelInfo { id: string; title: string; username?: string; isCreator: boolean; participantsCount?: number; }

export async function listChannels(): Promise<{ sources: ChannelInfo[]; targets: ChannelInfo[] }> {
  const c = await ensureClient();
  if (!c.connected) await c.connect();
  const dialogs = await c.getDialogs({ limit: 200 });
  const sources: ChannelInfo[] = []; const targets: ChannelInfo[] = [];
  for (const d of dialogs) {
    if (!d.entity || (d.entity as any).className !== 'Channel') continue;
    const ch = d.entity as any;
    const info: ChannelInfo = { id: String(ch.id), title: ch.title || 'Unknown', username: ch.username, isCreator: Boolean((ch as any).creator), participantsCount: ch.participantsCount };
    if ((ch as any).creator) targets.push(info); else sources.push(info);
  }
  return { sources, targets };
}

// ==================== Rules ====================
export interface TelegramRule { id: string; name: string; sourceChannels: Array<{ id: string; title: string }>; targetChannels: Array<{ id: string; title: string }>; msgType: string; whitelist: string; blacklist: string; dedupe: boolean; captionMode: string; stripLinks: boolean; stripMentions: boolean; watermark: boolean; forwardMode: string; intervalSec: number; retries: number; enabled: boolean; status: string; lastRunAt?: string; createdAt?: string; }

function rowToRule(row: any): TelegramRule {
  return { id: row.id, name: row.name, sourceChannels: JSON.parse(row.source_channels || '[]'), targetChannels: JSON.parse(row.target_channels || '[]'), msgType: row.msg_type, whitelist: row.whitelist, blacklist: row.blacklist, dedupe: row.dedupe === 1, captionMode: row.caption_mode, stripLinks: row.strip_links === 1, stripMentions: row.strip_mentions === 1, watermark: row.watermark === 1, forwardMode: row.forward_mode, intervalSec: row.interval_sec, retries: row.retries, enabled: row.enabled === 1, status: row.status, lastRunAt: row.last_run_at, createdAt: row.created_at };
}

export function listRules(): TelegramRule[] { return queryAll('SELECT * FROM telegram_rules ORDER BY created_at DESC').map(rowToRule); }
export function getRule(id: string): TelegramRule | null { const r = queryOne('SELECT * FROM telegram_rules WHERE id = ?', [id]); return r ? rowToRule(r) : null; }

export function createRule(data: Partial<TelegramRule>): TelegramRule {
  const id = `rule_${randomUUID().slice(0, 8)}`;
  runSql(`INSERT INTO telegram_rules (id, name, source_channels, target_channels, msg_type, whitelist, blacklist, dedupe, caption_mode, strip_links, strip_mentions, watermark, forward_mode, interval_sec, retries, enabled, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'stopped')`,
    [id, data.name || '未命名', JSON.stringify(data.sourceChannels || []), JSON.stringify(data.targetChannels || []), data.msgType || 'all', data.whitelist || '', data.blacklist || '', data.dedupe ? 1 : 0, data.captionMode || 'keep', data.stripLinks ? 1 : 0, data.stripMentions ? 1 : 0, data.watermark ? 1 : 0, data.forwardMode || 'auto', data.intervalSec || 30, data.retries || 3]);
  saveDb(); return getRule(id)!;
}

export function updateRule(id: string, data: Partial<TelegramRule>): TelegramRule | null {
  const existing = getRule(id); if (!existing) return null;
  const fields: string[] = []; const values: any[] = [];
  const mapping: [keyof TelegramRule, string][] = [['name','name'],['sourceChannels','source_channels'],['targetChannels','target_channels'],['msgType','msg_type'],['whitelist','whitelist'],['blacklist','blacklist'],['dedupe','dedupe'],['captionMode','caption_mode'],['stripLinks','strip_links'],['stripMentions','strip_mentions'],['watermark','watermark'],['forwardMode','forward_mode'],['intervalSec','interval_sec'],['retries','retries'],['enabled','enabled'],['status','status']];
  for (const [key, col] of mapping) {
    if (data[key] !== undefined) {
      fields.push(`${col} = ?`);
      const v = data[key];
      if (typeof v === 'boolean') values.push(v ? 1 : 0);
      else if (Array.isArray(v)) values.push(JSON.stringify(v));
      else values.push(v);
    }
  }
  if (fields.length === 0) return existing;
  runSql(`UPDATE telegram_rules SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
  saveDb(); return getRule(id)!;
}

export function deleteRule(id: string): boolean {
  runSql('DELETE FROM telegram_rules WHERE id = ?', [id]);
  runSql('DELETE FROM telegram_cursors WHERE rule_id = ?', [id]); saveDb(); return true;
}

// ==================== Message Processing ====================
function getMsgType(msg: any): string {
  if (msg.photo) return 'photo'; if (msg.video) return 'video'; if (msg.document) return 'document'; if (msg.message) return 'text'; return 'other';
}

function msgMatchesTypeFilter(msg: any, filter: string): boolean {
  if (filter === 'all') return true;
  const type = getMsgType(msg);
  if (filter === 'photo') return type === 'photo';
  if (filter === 'video') return type === 'video';
  if (filter === 'text') return type === 'text';
  if (filter === 'link') return !!(msg.message?.match(/https?:/));
  return true;
}

function processCaption(rawCaption: string, rule: TelegramRule, channelTitle: string): string {
  let caption = rawCaption.trim();
  if (rule.captionMode === 'strip') caption = '';
  if (rule.stripLinks && caption) caption = caption.replace(/https?:\S+/g, '').replace(/\s+/g, ' ').trim();
  if (rule.stripMentions && caption) caption = caption.replace(/@[\w]+/g, '').replace(/\s+/g, ' ').trim();
  if (rule.watermark && caption) caption += `\n\n来源：@${channelTitle}`;
  return caption;
}

function checkDedupe(msgId: string, sourceChannel: string): boolean {
  const row = queryOne('SELECT 1 FROM telegram_items WHERE source_channel = ? AND message_id = ?', [sourceChannel, msgId]);
  return !!row;
}

function checkKeywordFilter(caption: string, rule: TelegramRule): boolean {
  if (rule.whitelist && caption) {
    const kws = rule.whitelist.split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean);
    if (kws.length > 0 && !kws.some(k => caption.toLowerCase().includes(k))) return false;
  }
  if (rule.blacklist && caption) {
    const kws = rule.blacklist.split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean);
    if (kws.some(k => caption.toLowerCase().includes(k))) return false;
  }
  return true;
}

async function sendWithoutForwardTag(c: TelegramClient, targetEntity: any, msg: any, caption: string): Promise<void> {
  // 无痕转发：用 sendFile/sendMessage 重新发送，不使用 forwardMessages（避免"转自"标记）
  if (msg.photo || msg.video || msg.document) {
    try {
      // 尝试直接使用 media 对象发送（gramjs 内部会处理 file_reference 转换）
      await retryWithBackoff(() => (c as any).sendFile(targetEntity, msg.media, { caption, forceDocument: !!msg.document }));
      recordSend();
    } catch {
      // 降级：下载后重发
      const buf = await c.downloadMedia(msg);
      if (buf) {
        await retryWithBackoff(() => (c as any).sendFile(targetEntity, buf, { caption, forceDocument: !!msg.document }));
        recordSend();
      }
    }
  } else if (msg.message) {
    await retryWithBackoff(() => (c as any).sendMessage(targetEntity, caption || msg.message, { parseMode: 'html' }));
    recordSend();
  }
}

async function processMessage(msg: any, rule: TelegramRule, targetChannel: { id: string; title: string }, sourceChannel: { id: string; title: string }, sourceEntity: any, c: TelegramClient): Promise<{ success: boolean; status: string; durationMs: number }> {
  const start = Date.now();
  const msgId = String(msg.id);

  // 限速检查
  const rateCheck = canSend();
  if (!rateCheck.ok) {
    console.log(`[TG] Rate limited: ${rateCheck.reason}, waiting ${Math.round(rateCheck.waitMs / 1000)}s`);
    await sleep(rateCheck.waitMs);
    if (!canSend().ok) return { success: true, status: 'rate_limited', durationMs: Date.now() - start };
  }

  // 去重
  if (rule.dedupe && checkDedupe(msgId, sourceChannel.id)) {
    return { success: true, status: 'skipped', durationMs: 0 };
  }

  // 类型过滤
  if (!msgMatchesTypeFilter(msg, rule.msgType)) {
    return { success: true, status: 'skipped', durationMs: Date.now() - start };
  }

  // 关键词过滤
  const rawCaption = (msg.message || '').trim();
  if (!checkKeywordFilter(rawCaption, rule)) {
    return { success: true, status: 'skipped', durationMs: Date.now() - start };
  }

  // Caption 处理
  const caption = processCaption(rawCaption, rule, sourceChannel.title);

  // 发送
  try {
    const targetEntity = await c.getEntity(String(targetChannel.id));
    if (!targetEntity) throw new Error('目标频道不存在');

    await sendWithoutForwardTag(c, targetEntity, msg, caption);
    const durationMs = Date.now() - start;

    // 写日志
    const itemId = `item_${randomUUID().slice(0, 8)}`;
    runSql(`INSERT INTO telegram_items (id, rule_id, source_channel, target_channel, message_id, msg_type, media_hash, text_hash, raw_text, rewritten_text, tags, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
      [itemId, rule.id, sourceChannel.id, targetChannel.id, msgId, getMsgType(msg), '', '', rawCaption.slice(0, 5000), caption.slice(0, 5000), '', durationMs]);
    saveDb();

    // 记忆点
    try {
      const chunkId = `tg_mem_${randomUUID().slice(0, 8)}`;
      const title = `[TG] ${sourceChannel.title} - ${getMsgType(msg)} - ${rawCaption.slice(0, 100)}`;
      const chunk = `[Telegram] ${sourceChannel.title} | ${msg.date ? new Date(msg.date * 1000).toISOString().slice(0, 10) : ''}\n${caption || '(无文字)'}`;
      runSql(`INSERT INTO knowledge_chunks (id, project_id, doc_type, source, title, chunk, created_at) VALUES (?, NULL, 'telegram', ?, ?, ?, ${Date.now()})`, [chunkId, sourceChannel.title, title, chunk]);
      saveDb();
    } catch {}

    return { success: true, status: 'success', durationMs };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const errMsg = err.message || String(err);

    // 权限检测 → 自动暂停规则
    if (errMsg.includes('CHANNEL_PRIVATE') || errMsg.includes('CHANNEL_FORBIDDEN')) {
      updateRule(rule.id, { status: 'paused', enabled: false });
      logAudit(null, 'tg_rule_paused', `规则「${rule.name}」源频道不可访问，已自动暂停`, 'medium', 'auto');
    } else if (errMsg.includes('CHAT_WRITE_FORBIDDEN') || errMsg.includes('FORBID_WRITE')) {
      updateRule(rule.id, { status: 'paused', enabled: false });
      logAudit(null, 'tg_rule_paused', `规则「${rule.name}」目标频道无写入权限，已自动暂停`, 'medium', 'auto');
    }

    const itemId = `item_${randomUUID().slice(0, 8)}`;
    runSql(`INSERT INTO telegram_items (id, rule_id, source_channel, target_channel, message_id, msg_type, media_hash, text_hash, raw_text, rewritten_text, tags, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)`,
      [itemId, rule.id, sourceChannel.id, targetChannel.id, msgId, getMsgType(msg), '', '', rawCaption.slice(0, 5000), caption.slice(0, 5000), '', durationMs]);
    saveDb();
    return { success: false, status: 'failed', durationMs };
  }
}

// ==================== Backfill Engine ====================
const activeJobs = new Map<string, AbortController>();

export async function startBackfill(ruleId: string): Promise<{ started: boolean; message: string }> {
  const rule = getRule(ruleId);
  if (!rule) throw new Error('规则不存在');
  if (activeJobs.has(ruleId)) return { started: false, message: '任务已在运行中' };
  if (rule.sourceChannels.length === 0 || rule.targetChannels.length === 0) throw new Error('请先配置来源和目标频道');
  const c = await ensureClient();
  if (!c.connected) await c.connect();
  const abort = new AbortController();
  activeJobs.set(ruleId, abort);
  updateRule(ruleId, { enabled: true, status: 'backfilling' });
  // 后台执行
  runBackfillLoop(ruleId, rule, c, abort.signal).catch(err => {
    console.error(`[TG] rule ${ruleId} error:`, err);
    updateRule(ruleId, { status: 'error' }); activeJobs.delete(ruleId);
  });
  return { started: true, message: `开始回采 ${rule.sourceChannels.length} 个来源频道` };
}

export function stopRule(ruleId: string): { stopped: boolean } {
  const ctrl = activeJobs.get(ruleId);
  if (ctrl) { ctrl.abort(); activeJobs.delete(ruleId); }
  updateRule(ruleId, { enabled: false, status: 'stopped' });
  return { stopped: true };
}

async function runBackfillLoop(ruleId: string, rule: TelegramRule, c: TelegramClient, signal: AbortSignal): Promise<void> {
  for (const source of rule.sourceChannels) {
    if (signal.aborted) break;
    let sourceEntity: any;
    try { sourceEntity = await c.getEntity(String(source.id)); } catch (err: any) {
      if (err.message?.includes('CHANNEL_PRIVATE') || err.message?.includes('CHANNEL_FORBIDDEN')) {
        updateRule(ruleId, { status: 'paused', enabled: false });
        logAudit(null, 'tg_rule_paused', `源频道 ${source.title} 不可访问，规则已暂停`, 'medium', 'auto');
        return;
      }
      continue;
    }
    if (!sourceEntity) continue;

    for (const target of rule.targetChannels) {
      if (signal.aborted) break;
      // 游标：从 DB 读取或初始化
      let cursor = queryOne('SELECT * FROM telegram_cursors WHERE rule_id = ? AND channel_id = ?', [ruleId, source.id]);
      let lastId = cursor ? (cursor.last_message_id as number) : 0;
      if (!cursor) {
        runSql("INSERT INTO telegram_cursors (rule_id, channel_id, last_message_id, phase, updated_at) VALUES (?, ?, 0, 'backfill', datetime('now'))", [ruleId, source.id]);
        saveDb();
      }

      // 从最旧消息开始：用 reverse: true 获取历史，分批处理
      let processed = 0;
      let batchNum = 0;
      while (!signal.aborted) {
        const msgs: any[] = await c.getMessages(sourceEntity, { limit: 100, reverse: true });
        if (msgs.length === 0) break;
        batchNum++;

        // 按消息 ID 排序（保持源频道发布顺序）
        const sorted = msgs.filter(m => m.id > lastId).sort((a: any, b: any) => a.id - b.id);

        for (const msg of sorted) {
          if (signal.aborted) break;
          // 消息顺序随机延迟（泊松分布）
          const delay = Math.max(1000, exponentialRandom(rule.intervalSec * 1000));
          await sleep(delay);

          const result = await processMessage(msg, rule, target, source, sourceEntity, c);
          processed++;

          if (!result.success && result.status !== 'skipped' && result.status !== 'rate_limited') {
            console.log(`[TG] msg ${msg.id} failed: ${result.status}`);
          }
        }

        const lastMsg = sorted[sorted.length - 1];
        if (lastMsg) lastId = lastMsg.id;
        runSql("UPDATE telegram_cursors SET last_message_id = ?, phase = 'backfill', updated_at = datetime('now') WHERE rule_id = ? AND channel_id = ?", [lastId, ruleId, source.id]);
        saveDb();
      }
    }
  }
  updateRule(ruleId, { status: 'monitoring', enabled: true });
  activeJobs.delete(ruleId);
  logAudit(null, 'tg_backfill_done', `规则「${rule.name}」回采完成`, 'none', 'auto');
}

// ==================== Live Monitor ====================
let liveHandler: any = null;

export async function startLiveMonitor(): Promise<void> {
  const c = await ensureClient();
  if (!c.connected) await c.connect();
  if (liveHandler) return;
  const rules = listRules().filter(r => r.status === 'monitoring' || r.enabled);
  const channelIds = new Set<string>();
  rules.forEach(r => r.sourceChannels.forEach(s => channelIds.add(s.id)));
  if (channelIds.size === 0) return;

  liveHandler = async (event: any) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const channelId = String(msg.peerId?.channelId || '');
      if (!channelId || !channelIds.has(channelId)) return;
      for (const rule of rules) {
        const source = rule.sourceChannels.find(s => s.id === channelId);
        if (!source) continue;
        for (const target of rule.targetChannels) {
          const delay = Math.max(1000, exponentialRandom(rule.intervalSec * 1000));
          await sleep(delay);
          const sourceEntity = await c.getEntity(String(channelId)).catch(() => null);
          if (sourceEntity) await processMessage(msg, rule, target, source, sourceEntity, c);
        }
      }
    } catch (err) { console.error('[TG live] error:', err); }
  };
  c.addEventHandler(liveHandler, new NewMessage({ chats: [...channelIds] as any }));
}

// ==================== Logs ====================
export function getLogs(opts: { ruleId?: string; channel?: string; limit?: number }): any[] {
  let sql = 'SELECT * FROM telegram_items WHERE 1=1';
  const params: any[] = [];
  if (opts.ruleId) { sql += ' AND rule_id = ?'; params.push(opts.ruleId); }
  if (opts.channel) { sql += ' AND source_channel = ?'; params.push(opts.channel); }
  sql += ' ORDER BY created_at DESC LIMIT ?'; params.push(opts.limit || 50);
  return queryAll(sql, params);
}

export function skipItem(id: string): boolean {
  runSql("UPDATE telegram_items SET status = 'skipped' WHERE id = ?", [id]); saveDb(); return true;
}

export function getOverview(): { total: number; today: number; success: number; failed: number; rules: number; rate: ReturnType<typeof getRateStatus> } {
  const total = (queryOne('SELECT COUNT(*) as c FROM telegram_items') as any)?.c || 0;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const today = (queryOne('SELECT COUNT(*) as c FROM telegram_items WHERE created_at > ?', [todayStart.toISOString()]) as any)?.c || 0;
  const success = (queryOne("SELECT COUNT(*) as c FROM telegram_items WHERE status = 'success'") as any)?.c || 0;
  const failed = (queryOne("SELECT COUNT(*) as c FROM telegram_items WHERE status = 'failed'") as any)?.c || 0;
  const rules = (queryOne('SELECT COUNT(*) as c FROM telegram_rules') as any)?.c || 0;
  return { total, today, success, failed, rules, rate: getRateStatus() };
}

// ==================== Memory Search ====================
export function searchMemory(query: string, limit = 10): any[] {
  return queryAll("SELECT id, title, chunk, created_at FROM knowledge_chunks WHERE doc_type = 'telegram' AND chunk LIKE ? ORDER BY created_at DESC LIMIT ?", [`%${query}%`, limit]);
}

// ==================== DB Init ====================
export async function initTelegramTables(): Promise<void> {
  await getDb();
  runSql(`CREATE TABLE IF NOT EXISTS telegram_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_channels TEXT DEFAULT '[]', target_channels TEXT DEFAULT '[]', msg_type TEXT DEFAULT 'all', whitelist TEXT DEFAULT '', blacklist TEXT DEFAULT '', dedupe INTEGER DEFAULT 1, caption_mode TEXT DEFAULT 'keep', strip_links INTEGER DEFAULT 0, strip_mentions INTEGER DEFAULT 0, watermark INTEGER DEFAULT 1, forward_mode TEXT DEFAULT 'auto', interval_sec INTEGER DEFAULT 30, retries INTEGER DEFAULT 3, enabled INTEGER DEFAULT 0, status TEXT DEFAULT 'stopped', last_run_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  runSql(`CREATE TABLE IF NOT EXISTS telegram_cursors (rule_id TEXT NOT NULL, channel_id TEXT NOT NULL, last_message_id INTEGER DEFAULT 0, phase TEXT DEFAULT 'idle', updated_at TEXT, PRIMARY KEY (rule_id, channel_id))`);
  runSql(`CREATE TABLE IF NOT EXISTS telegram_items (id TEXT PRIMARY KEY, rule_id TEXT, source_channel TEXT, target_channel TEXT, message_id TEXT, msg_type TEXT, media_hash TEXT, text_hash TEXT, raw_text TEXT, rewritten_text TEXT, tags TEXT, status TEXT, duration_ms INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
  saveDb();
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
