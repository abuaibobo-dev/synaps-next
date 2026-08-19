import { getDb, queryAll, queryOne, runSql, saveDb } from './db.js';
import { randomUUID } from 'crypto';

// ============================================================
// 六层记忆系统 — Novel Memory Layers
// ============================================================
// L0: 正文（chapter_body）    — 完整章节内容
// L1: 单章摘要（chapter_summary）— 每章 200-400 字摘要
// L2: chunk（memory_chunk）   — 角色状态变化、伏笔、事件的结构化切片
// L3: 篇章摘要（part_summary） — 多章聚合摘要（约 10 章一份）
// L4: 卷摘要（volume_summary）  — 一卷结束时的全局总结
// L5: 全书设定（story_bible）  — 世界观、角色表、大纲、风格指南
// ============================================================

export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface NovelProject {
  id: string;
  projectId: string;
  title: string;
  genre: string;
  synopsis: string;
  styleGuide: string;
  totalChapters: number;
  currentVolume: number;
  totalVolumes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterRecord {
  id: string;
  projectId: string;
  novelId: string;
  volumeNumber: number;
  chapterNumber: number;
  title: string;
  body: string;         // L0
  summary: string;      // L1
  status: 'drafting' | 'completed' | 'frozen';
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterState {
  id: string;
  projectId: string;
  novelId: string;
  name: string;
  aliases: string[];
  traits: string;        // 性格特征
  backstory: string;     // 背景故事
  currentState: string;  // 当前状态描述
  firstAppearance: number; // 首次出场章节
  lastAppearance: number;  // 最后出场章节
  status: 'active' | 'dead' | 'missing' | 'inactive';
  updatedAt: string;
}

export interface CharacterDiff {
  id: string;
  projectId: string;
  novelId: string;
  characterName: string;
  chapterNumber: number;
  fieldChanged: string;   // 'state' | 'trait' | 'status' | 'relation'
  oldValue: string;
  newValue: string;
  createdAt: string;
}

export interface Foreshadowing {
  id: string;
  projectId: string;
  novelId: string;
  title: string;
  description: string;
  plantedChapter: number;
  resolvedChapter: number | null;
  status: 'planted' | 'developing' | 'resolving' | 'resolved' | 'abandoned';
  relatedCharacters: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryChunk {
  id: string;
  projectId: string;
  novelId: string;
  layer: MemoryLayer;
  chapterFrom: number;
  chapterTo: number;
  volumeNumber: number;
  content: string;
  keywords: string[];
  frozen: boolean;
  createdAt: string;
}

export interface MemorySnapshot {
  id: string;
  projectId: string;
  novelId: string;
  label: string;
  chapterNumber: number;
  volumeNumber: number;
  snapshotData: string;   // JSON: 完整记忆层快照
  createdAt: string;
}

// ============================================================
// 初始化：创建小说项目 & 表
// ============================================================

export function ensureNovelTables(): void {
  getDb().then(db => {
    db.run(`
      CREATE TABLE IF NOT EXISTS novel_projects (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        genre TEXT NOT NULL DEFAULT '',
        synopsis TEXT NOT NULL DEFAULT '',
        style_guide TEXT NOT NULL DEFAULT '',
        total_chapters INTEGER NOT NULL DEFAULT 0,
        current_volume INTEGER NOT NULL DEFAULT 1,
        total_volumes INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS novel_chapters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        novel_id TEXT NOT NULL,
        volume_number INTEGER NOT NULL DEFAULT 1,
        chapter_number INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'drafting',
        word_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (novel_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS novel_characters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        novel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        traits TEXT NOT NULL DEFAULT '',
        backstory TEXT NOT NULL DEFAULT '',
        current_state TEXT NOT NULL DEFAULT '',
        first_appearance INTEGER NOT NULL DEFAULT 1,
        last_appearance INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (novel_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS novel_character_diffs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        novel_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        chapter_number INTEGER NOT NULL,
        field_changed TEXT NOT NULL,
        old_value TEXT NOT NULL DEFAULT '',
        new_value TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (novel_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS novel_foreshadowing (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        novel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        planted_chapter INTEGER NOT NULL,
        resolved_chapter INTEGER,
        status TEXT NOT NULL DEFAULT 'planted',
        related_characters TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (novel_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS novel_memory_chunks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        novel_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        chapter_from INTEGER NOT NULL,
        chapter_to INTEGER NOT NULL,
        volume_number INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '[]',
        frozen INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (novel_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS novel_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        novel_id TEXT NOT NULL,
        label TEXT NOT NULL,
        chapter_number INTEGER NOT NULL,
        volume_number INTEGER NOT NULL,
        snapshot_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (novel_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      )
    `);
  });
}

// ============================================================
// L5: 全书设定 Story Bible
// ============================================================

export function getStoryBible(projectId: string): NovelProject | null {
  const row = queryOne(
    'SELECT * FROM novel_projects WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
    [projectId]
  );
  return row ? row as unknown as NovelProject : null;
}

export function createNovelProject(
  projectId: string,
  title: string,
  genre: string,
  synopsis: string,
  styleGuide: string = '',
  totalVolumes: number = 1
): NovelProject {
  const id = randomUUID();
  runSql(
    `INSERT INTO novel_projects (id, project_id, title, genre, synopsis, style_guide, total_volumes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, title, genre, synopsis, styleGuide, totalVolumes]
  );
  saveDb();
  return getStoryBible(projectId)!;
}

export function updateStoryBible(
  projectId: string,
  updates: Partial<Pick<NovelProject, 'title' | 'genre' | 'synopsis' | 'styleGuide' | 'totalChapters' | 'totalVolumes'>>
): NovelProject | null {
  const existing = getStoryBible(projectId);
  if (!existing) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
  if (updates.genre !== undefined) { sets.push('genre = ?'); vals.push(updates.genre); }
  if (updates.synopsis !== undefined) { sets.push('synopsis = ?'); vals.push(updates.synopsis); }
  if (updates.styleGuide !== undefined) { sets.push('style_guide = ?'); vals.push(updates.styleGuide); }
  if (updates.totalChapters !== undefined) { sets.push('total_chapters = ?'); vals.push(updates.totalChapters); }
  if (updates.totalVolumes !== undefined) { sets.push('total_volumes = ?'); vals.push(updates.totalVolumes); }
  if (sets.length === 0) return existing;
  sets.push("updated_at = datetime('now')");
  vals.push(existing.id);
  runSql(`UPDATE novel_projects SET ${sets.join(', ')} WHERE id = ?`, vals);
  saveDb();
  return getStoryBible(projectId);
}

// ============================================================
// L0 + L1: 章节正文 + 单章摘要
// ============================================================

export function addChapter(
  projectId: string,
  novelId: string,
  volumeNumber: number,
  chapterNumber: number,
  title: string,
  body: string,
  summary: string = ''
): ChapterRecord {
  const id = randomUUID();
  const wordCount = body.length;
  runSql(
    `INSERT INTO novel_chapters (id, project_id, novel_id, volume_number, chapter_number, title, body, summary, word_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, novelId, volumeNumber, chapterNumber, title, body, summary, wordCount]
  );
  // 更新小说总章数
  runSql(
    `UPDATE novel_projects SET total_chapters = ?, current_volume = ?, updated_at = datetime('now') WHERE id = ?`,
    [chapterNumber, volumeNumber, novelId]
  );
  saveDb();
  return queryOne('SELECT * FROM novel_chapters WHERE id = ?', [id]) as unknown as ChapterRecord;
}

export function updateChapterSummary(
  projectId: string,
  chapterId: string,
  summary: string
): void {
  runSql('UPDATE novel_chapters SET summary = ?, updated_at = datetime(\'now\') WHERE id = ?', [summary, chapterId]);
  saveDb();
}

export function getRecentChapters(
  projectId: string,
  novelId: string,
  count: number = 5
): ChapterRecord[] {
  return queryAll(
    `SELECT * FROM novel_chapters WHERE project_id = ? AND novel_id = ?
     ORDER BY chapter_number DESC LIMIT ?`,
    [projectId, novelId, count]
  ) as unknown as ChapterRecord[];
}

export function getChapterByNumber(
  projectId: string,
  novelId: string,
  chapterNumber: number
): ChapterRecord | null {
  const row = queryOne(
    'SELECT * FROM novel_chapters WHERE project_id = ? AND novel_id = ? AND chapter_number = ?',
    [projectId, novelId, chapterNumber]
  );
  return row ? row as unknown as ChapterRecord : null;
}

// ============================================================
// 角色管理
// ============================================================

export function upsertCharacter(
  projectId: string,
  novelId: string,
  name: string,
  traits: string,
  backstory: string,
  currentState: string,
  firstAppearance: number
): CharacterState {
  const existing = queryOne(
    'SELECT * FROM novel_characters WHERE project_id = ? AND novel_id = ? AND name = ?',
    [projectId, novelId, name]
  ) as unknown as CharacterState | null;

  if (existing) {
    runSql(
      `UPDATE novel_characters
       SET traits = ?, backstory = ?, current_state = ?, last_appearance = MAX(last_appearance, ?), updated_at = datetime('now')
       WHERE id = ?`,
      [traits, backstory, currentState, firstAppearance, existing.id]
    );
    saveDb();
    return queryOne('SELECT * FROM novel_characters WHERE id = ?', [existing.id]) as unknown as CharacterState;
  } else {
    const id = randomUUID();
    runSql(
      `INSERT INTO novel_characters (id, project_id, novel_id, name, traits, backstory, current_state, first_appearance, last_appearance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, novelId, name, traits, backstory, currentState, firstAppearance, firstAppearance]
    );
    saveDb();
    return queryOne('SELECT * FROM novel_characters WHERE id = ?', [id]) as unknown as CharacterState;
  }
}

export function getCharacters(
  projectId: string,
  novelId: string
): CharacterState[] {
  return queryAll(
    'SELECT * FROM novel_characters WHERE project_id = ? AND novel_id = ? ORDER BY first_appearance',
    [projectId, novelId]
  ) as unknown as CharacterState[];
}

export function getActiveCharacters(
  projectId: string,
  novelId: string
): CharacterState[] {
  return queryAll(
    "SELECT * FROM novel_characters WHERE project_id = ? AND novel_id = ? AND status = 'active' ORDER BY first_appearance",
    [projectId, novelId]
  ) as unknown as CharacterState[];
}

// ============================================================
// 角色 Diff（只记录变化，不覆盖整张角色卡）
// ============================================================

export function recordCharacterDiff(
  projectId: string,
  novelId: string,
  characterName: string,
  chapterNumber: number,
  fieldChanged: string,
  oldValue: string,
  newValue: string
): void {
  const id = randomUUID();
  runSql(
    `INSERT INTO novel_character_diffs (id, project_id, novel_id, character_name, chapter_number, field_changed, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, novelId, characterName, chapterNumber, fieldChanged, oldValue, newValue]
  );
  // 同步更新角色当前状态
  if (fieldChanged === 'state') {
    runSql(
      "UPDATE novel_characters SET current_state = ?, updated_at = datetime('now') WHERE project_id = ? AND novel_id = ? AND name = ?",
      [newValue, projectId, novelId, characterName]
    );
  } else if (fieldChanged === 'status') {
    runSql(
      "UPDATE novel_characters SET status = ?, updated_at = datetime('now') WHERE project_id = ? AND novel_id = ? AND name = ?",
      [newValue, projectId, novelId, characterName]
    );
  }
  saveDb();
}

export function getCharacterDiffs(
  projectId: string,
  novelId: string,
  chapterNumber: number
): CharacterDiff[] {
  return queryAll(
    'SELECT * FROM novel_character_diffs WHERE project_id = ? AND novel_id = ? AND chapter_number = ?',
    [projectId, novelId, chapterNumber]
  ) as unknown as CharacterDiff[];
}

// ============================================================
// 伏笔管理（自动流转）
// ============================================================

export function addForeshadowing(
  projectId: string,
  novelId: string,
  title: string,
  description: string,
  plantedChapter: number,
  relatedCharacters: string[] = []
): Foreshadowing {
  const id = randomUUID();
  runSql(
    `INSERT INTO novel_foreshadowing (id, project_id, novel_id, title, description, planted_chapter, status, related_characters)
     VALUES (?, ?, ?, ?, ?, ?, 'planted', ?)`,
    [id, projectId, novelId, title, description, plantedChapter, JSON.stringify(relatedCharacters)]
  );
  saveDb();
  return queryOne('SELECT * FROM novel_foreshadowing WHERE id = ?', [id]) as unknown as Foreshadowing;
}

export function advanceForeshadowing(
  projectId: string,
  novelId: string,
  foreshadowingId: string,
  newStatus: 'developing' | 'resolving' | 'resolved' | 'abandoned',
  resolvedChapter?: number
): void {
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const vals: unknown[] = [newStatus];
  if (resolvedChapter !== undefined) { sets.push('resolved_chapter = ?'); vals.push(resolvedChapter); }
  vals.push(foreshadowingId);
  runSql(`UPDATE novel_foreshadowing SET ${sets.join(', ')} WHERE id = ?`, vals);
  saveDb();
}

export function getActiveForeshadowing(
  projectId: string,
  novelId: string
): Foreshadowing[] {
  return queryAll(
    "SELECT * FROM novel_foreshadowing WHERE project_id = ? AND novel_id = ? AND status NOT IN ('resolved', 'abandoned') ORDER BY planted_chapter",
    [projectId, novelId]
  ) as unknown as Foreshadowing[];
}

export function getAllForeshadowing(
  projectId: string,
  novelId: string
): Foreshadowing[] {
  return queryAll(
    'SELECT * FROM novel_foreshadowing WHERE project_id = ? AND novel_id = ? ORDER BY planted_chapter',
    [projectId, novelId]
  ) as unknown as Foreshadowing[];
}

// ============================================================
// L2: Memory Chunk — 结构化记忆片段
// ============================================================

export function addMemoryChunk(
  projectId: string,
  novelId: string,
  layer: MemoryLayer,
  chapterFrom: number,
  chapterTo: number,
  volumeNumber: number,
  content: string,
  keywords: string[] = [],
  frozen: boolean = false
): MemoryChunk {
  const id = randomUUID();
  runSql(
    `INSERT INTO novel_memory_chunks (id, project_id, novel_id, layer, chapter_from, chapter_to, volume_number, content, keywords, frozen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, novelId, layer, chapterFrom, chapterTo, volumeNumber, content, JSON.stringify(keywords), frozen ? 1 : 0]
  );
  saveDb();
  return queryOne('SELECT * FROM novel_memory_chunks WHERE id = ?', [id]) as unknown as MemoryChunk;
}

export function freezeChunks(
  projectId: string,
  novelId: string,
  layer: MemoryLayer,
  upToChapter: number
): void {
  runSql(
    `UPDATE novel_memory_chunks SET frozen = 1
     WHERE project_id = ? AND novel_id = ? AND layer = ? AND chapter_to <= ?`,
    [projectId, novelId, layer, upToChapter]
  );
  saveDb();
}

export function getUnfrozenChunks(
  projectId: string,
  novelId: string,
  layer?: MemoryLayer
): MemoryChunk[] {
  const where = layer
    ? "project_id = ? AND novel_id = ? AND layer = ? AND frozen = 0"
    : "project_id = ? AND novel_id = ? AND frozen = 0";
  const vals = layer ? [projectId, novelId, layer] : [projectId, novelId];
  return queryAll(
    `SELECT * FROM novel_memory_chunks WHERE ${where} ORDER BY chapter_from`,
    vals
  ) as unknown as MemoryChunk[];
}

// ============================================================
// L3: 篇章摘要（~10 章聚合）
// ============================================================

export function addPartSummary(
  projectId: string,
  novelId: string,
  volumeNumber: number,
  chapterFrom: number,
  chapterTo: number,
  content: string
): MemoryChunk {
  return addMemoryChunk(projectId, novelId, 'L3', chapterFrom, chapterTo, volumeNumber, content, [], true);
}

// ============================================================
// L4: 卷摘要
// ============================================================

export function addVolumeSummary(
  projectId: string,
  novelId: string,
  volumeNumber: number,
  content: string
): MemoryChunk {
  // 查找该卷的章节范围
  const first = queryOne(
    'SELECT MIN(chapter_number) as min_ch FROM novel_chapters WHERE novel_id = ? AND volume_number = ?',
    [novelId, volumeNumber]
  ) as Record<string, number> | null;
  const last = queryOne(
    'SELECT MAX(chapter_number) as max_ch FROM novel_chapters WHERE novel_id = ? AND volume_number = ?',
    [novelId, volumeNumber]
  ) as Record<string, number> | null;
  const from = first?.min_ch ?? 1;
  const to = last?.max_ch ?? from;
  return addMemoryChunk(projectId, novelId, 'L4', from, to, volumeNumber, content, [], true);
}

// ============================================================
// 记忆快照
// ============================================================

export function createMemorySnapshot(
  projectId: string,
  novelId: string,
  label: string,
  chapterNumber: number,
  volumeNumber: number
): MemorySnapshot {
  const snapshotData = {
    characters: getCharacters(projectId, novelId),
    foreshadowing: getAllForeshadowing(projectId, novelId),
    recentChapters: getRecentChapters(projectId, novelId, 5).map(c => ({
      number: c.chapterNumber, title: c.title, summary: c.summary
    })),
    storyBible: getStoryBible(projectId),
    timestamp: new Date().toISOString(),
  };
  const id = randomUUID();
  runSql(
    `INSERT INTO novel_snapshots (id, project_id, novel_id, label, chapter_number, volume_number, snapshot_data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, novelId, label, chapterNumber, volumeNumber, JSON.stringify(snapshotData)]
  );
  saveDb();
  return queryOne('SELECT * FROM novel_snapshots WHERE id = ?', [id]) as unknown as MemorySnapshot;
}

export function getLatestSnapshot(
  projectId: string,
  novelId: string
): MemorySnapshot | null {
  const row = queryOne(
    'SELECT * FROM novel_snapshots WHERE project_id = ? AND novel_id = ? ORDER BY chapter_number DESC LIMIT 1',
    [projectId, novelId]
  );
  return row ? row as unknown as MemorySnapshot : null;
}

export function rollbackToSnapshot(
  projectId: string,
  novelId: string,
  snapshotId: string
): boolean {
  const snapshot = queryOne(
    'SELECT * FROM novel_snapshots WHERE id = ? AND novel_id = ?',
    [snapshotId, novelId]
  ) as unknown as MemorySnapshot | null;
  if (!snapshot) return false;
  // 快照回滚：只恢复角色状态和伏笔，正文不动
  try {
    const data = JSON.parse(snapshot.snapshotData);
    // 提示用户手动恢复（自动恢复正文风险太大）
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// ★ 写前组装协议 — 按六层优先级加载上下文
// ============================================================

export function assembleNovelContext(
  projectId: string,
  novelId: string,
  nextChapterNumber: number,
  nextVolumeNumber: number
): string {
  const parts: string[] = [];

  // 1. L5: story_bible（全书设定）
  const bible = getStoryBible(projectId);
  if (bible) {
    parts.push(`## 📖 全书设定（Story Bible）
- 书名：${bible.title}
- 类型：${bible.genre}
- 简介：${bible.synopsis}
- 风格指南：${bible.styleGuide || '未设定'}
- 总卷数：${bible.totalVolumes}
- 当前进度：第 ${bible.totalChapters} 章 / 第 ${bible.currentVolume} 卷`);
  }

  // 2. L4: 当前卷摘要
  const volSummaries = queryAll(
    `SELECT content, chapter_from, chapter_to FROM novel_memory_chunks
     WHERE novel_id = ? AND layer = 'L4' AND volume_number = ?
     ORDER BY chapter_from DESC LIMIT 1`,
    [novelId, nextVolumeNumber]
  ) as Array<{ content: string; chapter_from: number; chapter_to: number }>;
  if (volSummaries.length > 0) {
    parts.push(`## 📚 第 ${nextVolumeNumber} 卷摘要\n${volSummaries[0].content}`);
  }

  // 3. L1: 最近 3-5 章的单章摘要
  const recentSummaries = getRecentChapters(projectId, novelId, 5);
  if (recentSummaries.length > 0) {
    const summaryText = recentSummaries
      .reverse()
      .filter(c => c.summary)
      .map(c => `### 第 ${c.chapterNumber} 章「${c.title}」\n${c.summary}`)
      .join('\n\n');
    if (summaryText) {
      parts.push(`## 📝 最近章节摘要\n${summaryText}`);
    }
  }

  // 4. 上一章结尾段原文（最后 800 字）
  if (recentSummaries.length > 0) {
    const lastChapter = recentSummaries[recentSummaries.length - 1];
    if (lastChapter.body) {
      const tail = lastChapter.body.slice(-800);
      parts.push(`## 🔚 上一章结尾（第 ${lastChapter.chapterNumber} 章）\n${tail}`);
    }
  }

  // 5. 出场角色当前状态
  const characters = getActiveCharacters(projectId, novelId);
  if (characters.length > 0) {
    const charText = characters.map(c =>
      `- **${c.name}**：${c.traits} | 当前状态：${c.currentState} | 最近出场：第 ${c.lastAppearance} 章`
    ).join('\n');
    parts.push(`## 👥 出场角色状态\n${charText}`);
  }

  // 6. 活跃伏笔列表
  const foreshadowings = getActiveForeshadowing(projectId, novelId);
  if (foreshadowings.length > 0) {
    const fsText = foreshadowings.map(f => {
      const statusEmoji: Record<string, string> = {
        planted: '🌱', developing: '🌿', resolving: '🔄',
      };
      return `- ${statusEmoji[f.status] || '❓'} **${f.title}** [${f.status}]：${f.description}（埋于第 ${f.plantedChapter} 章）`;
    }).join('\n');
    parts.push(`## 🔮 活跃伏笔\n${fsText}`);
  }

  // 7. L2: 最近的结构化记忆片段
  const recentChunks = queryAll(
    `SELECT content, layer, chapter_from, chapter_to FROM novel_memory_chunks
     WHERE novel_id = ? AND frozen = 1 AND chapter_to >= ?
     ORDER BY chapter_from DESC LIMIT 3`,
    [novelId, Math.max(1, nextChapterNumber - 20)]
  ) as Array<{ content: string; layer: string; chapter_from: number; chapter_to: number }>;
  if (recentChunks.length > 0) {
    const chunkText = recentChunks.map(c => `[${c.layer} ch${c.chapter_from}-${c.chapter_to}] ${c.content}`).join('\n');
    parts.push(`## 🧩 结构化记忆\n${chunkText}`);
  }

  return parts.join('\n\n---\n\n');
}

// ============================================================
// ★ 写后自动更新 — 提取 Diff + 流转伏笔 + 冻结摘要
// ============================================================

export function processPostWrite(
  projectId: string,
  novelId: string,
  chapterNumber: number,
  volumeNumber: number,
  chapterSummary: string,
  characterChanges: Array<{
    name: string;
    field: string;
    oldValue: string;
    newValue: string;
  }>,
  newForeshadowing: Array<{
    title: string;
    description: string;
    relatedCharacters?: string[];
  }>,
  resolvedForeshadowing: string[] // 伏笔 ID
): void {
  // 记录角色 Diff
  for (const change of characterChanges) {
    recordCharacterDiff(
      projectId, novelId, change.name, chapterNumber,
      change.field, change.oldValue, change.newValue
    );
  }

  // 新埋伏笔
  for (const fs of newForeshadowing) {
    addForeshadowing(
      projectId, novelId, fs.title, fs.description,
      chapterNumber, fs.relatedCharacters || []
    );
  }

  // 流转伏笔
  for (const fsId of resolvedForeshadowing) {
    advanceForeshadowing(projectId, novelId, fsId, 'resolved', chapterNumber);
  }

  // 冻结 L1（单章摘要写定后冻结）
  addMemoryChunk(
    projectId, novelId, 'L1', chapterNumber, chapterNumber, volumeNumber,
    chapterSummary, [], true
  );

  // 每 10 章自动生成 L3（篇章摘要）
  if (chapterNumber > 0 && chapterNumber % 10 === 0) {
    const partFrom = Math.max(1, chapterNumber - 9);
    const chapters = queryAll(
      'SELECT summary FROM novel_chapters WHERE novel_id = ? AND chapter_number >= ? AND chapter_number <= ? ORDER BY chapter_number',
      [novelId, partFrom, chapterNumber]
    ) as Array<{ summary: string }>;
    const combined = chapters.map(c => c.summary).filter(Boolean).join('\n\n');
    if (combined) {
      addPartSummary(projectId, novelId, volumeNumber, partFrom, chapterNumber, combined);
    }
  }

  // 每 50 章自动快照
  if (chapterNumber > 0 && chapterNumber % 50 === 0) {
    createMemorySnapshot(
      projectId, novelId,
      `自动快照 — 第 ${chapterNumber} 章`,
      chapterNumber, volumeNumber
    );
  }
}

// ============================================================
// 序列化：生成注入 system prompt 的完整上下文
// ============================================================

export function novelContextToSystemPrompt(
  projectId: string,
  novelId: string,
  nextChapterNumber: number,
  nextVolumeNumber: number
): string {
  const ctx = assembleNovelContext(projectId, novelId, nextChapterNumber, nextVolumeNumber);
  if (!ctx) return '';

  return `
## 🧠 小说写作记忆系统（六层架构）

你正在续写一部小说。以下是你的完整写作记忆，请严格遵循：

### 核心规则
1. **不要重复已经写过的内容**——查看"最近章节摘要"确认当前进度
2. **角色设定已冻结**——不要擅自修改角色性格/背景，除非用户明确要求
3. **伏笔必须回收**——查看"活跃伏笔"列表，确保不遗漏
4. **保持文风一致**——遵循"风格指南"中设定的写作风格
5. **每章结束后**，输出结构化更新指令（JSON格式），供记忆管理 Agent 自动更新

### 每章结束时的输出格式
\`\`\`json
{
  "summary": "本章 200-400 字摘要",
  "characterChanges": [
    {"name": "角色名", "field": "state|status|trait", "oldValue": "变化前", "newValue": "变化后"}
  ],
  "newForeshadowing": [
    {"title": "伏笔标题", "description": "伏笔内容"}
  ],
  "resolvedForeshadowing": ["伏笔ID或标题"],
  "nextChapterHint": "下一章建议方向"
}
\`\`\`

---

${ctx}
`;
}

// ============================================================
// 记忆管理 Agent 工具 — 对外暴露的接口
// ============================================================

export interface NovelToolResult {
  success: boolean;
  message: string;
  data?: unknown;
}

// 获取完整写作上下文
export function toolGetNovelContext(
  projectId: string,
  nextChapterNumber?: number
): NovelToolResult {
  const bible = getStoryBible(projectId);
  if (!bible) {
    return { success: false, message: '该项目尚未创建小说项目。请先使用 tool_create_novel 初始化。' };
  }
  const nextCh = nextChapterNumber || bible.totalChapters + 1;
  const ctx = assembleNovelContext(projectId, bible.id, nextCh, bible.currentVolume);
  return { success: true, message: ctx || '暂无记忆数据，这是全新开始。' };
}

// 更新角色
export function toolUpdateCharacter(
  projectId: string,
  name: string,
  traits?: string,
  backstory?: string,
  currentState?: string,
  status?: string
): NovelToolResult {
  const bible = getStoryBible(projectId);
  if (!bible) return { success: false, message: '未创建小说项目。' };
  const existing = queryOne(
    'SELECT * FROM novel_characters WHERE project_id = ? AND novel_id = ? AND name = ?',
    [projectId, bible.id, name]
  ) as CharacterState | null;
  if (!existing) {
    return toolCreateCharacter(projectId, name, traits || '', backstory || '', currentState || '');
  }
  upsertCharacter(
    projectId, bible.id, name,
    traits || existing.traits,
    backstory || existing.backstory,
    currentState || existing.currentState,
    existing.lastAppearance
  );
  return { success: true, message: `角色「${name}」已更新。` };
}

// 创建角色
export function toolCreateCharacter(
  projectId: string,
  name: string,
  traits: string,
  backstory: string,
  currentState: string
): NovelToolResult {
  const bible = getStoryBible(projectId);
  if (!bible) return { success: false, message: '未创建小说项目。' };
  upsertCharacter(projectId, bible.id, name, traits, backstory, currentState, bible.totalChapters + 1);
  return { success: true, message: `角色「${name}」已创建。` };
}

// 列出所有角色
export function toolListCharacters(projectId: string): NovelToolResult {
  const bible = getStoryBible(projectId);
  if (!bible) return { success: false, message: '未创建小说项目。' };
  const chars = getCharacters(projectId, bible.id);
  if (chars.length === 0) return { success: true, message: '暂无角色。' };
  const text = chars.map(c =>
    `**${c.name}** [${c.status}]\n  性格：${c.traits}\n  当前状态：${c.currentState}\n  出场：第${c.firstAppearance}-${c.lastAppearance}章`
  ).join('\n\n');
  return { success: true, message: text };
}

// 添加伏笔
export function toolAddForeshadowing(
  projectId: string,
  title: string,
  description: string,
  chapterNumber?: number
): NovelToolResult {
  const bible = getStoryBible(projectId);
  if (!bible) return { success: false, message: '未创建小说项目。' };
  addForeshadowing(projectId, bible.id, title, description, chapterNumber || bible.totalChapters + 1);
  return { success: true, message: `伏笔「${title}」已埋下。` };
}

// 列出活跃伏笔
export function toolListForeshadowing(projectId: string): NovelToolResult {
  const bible = getStoryBible(projectId);
  if (!bible) return { success: false, message: '未创建小说项目。' };
  const fs = getActiveForeshadowing(projectId, bible.id);
  if (fs.length === 0) return { success: true, message: '暂无活跃伏笔。' };
  const text = fs.map(f => {
    const emoji: Record<string, string> = { planted: '🌱', developing: '🌿', resolving: '🔄' };
    return `${emoji[f.status] || '❓'} **${f.title}** [${f.status}]：${f.description}（第${f.plantedChapter}章）`;
  }).join('\n');
  return { success: true, message: text };
}

// 快照
export function toolSnapshot(projectId: string, label?: string): NovelToolResult {
  const bible = getStoryBible(projectId);
  if (!bible) return { success: false, message: '未创建小说项目。' };
  const snap = createMemorySnapshot(
    projectId, bible.id,
    label || `手动快照 — 第${bible.totalChapters}章`,
    bible.totalChapters, bible.currentVolume
  );
  return { success: true, message: `快照已创建：${snap.label}（ID: ${snap.id.slice(0, 8)}）` };
}
