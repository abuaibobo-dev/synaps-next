import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(__filename);
const DB_PATH = process.env.SYNAPS_DATA_DIR
  ? path.join(process.env.SYNAPS_DATA_DIR, 'synaps.db')
  : path.join(__dirname, '../../data/synaps.db');

function locateWasm(file: string): string {
  const candidates = [
    path.join(path.dirname(__filename), file),
    path.join(path.dirname(__filename), '..', '..', 'node_modules', 'sql.js', 'dist', file),
    path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db: SqlJsDatabase;

export async function getDb(): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await initSqlJs({
    locateFile: locateWasm,
  });

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Initialize tables
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT DEFAULT 'New Chat',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS snapshot_files (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_content TEXT DEFAULT '',
      modified_content TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS command_history (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      command TEXT NOT NULL,
      output TEXT DEFAULT '',
      error TEXT DEFAULT '',
      exit_code INTEGER DEFAULT 0,
      executed_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      source TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      doc_type TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT DEFAULT '',
      chunk TEXT NOT NULL,
      embedding TEXT NOT NULL DEFAULT '',
      embedding_model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  const knowledgeColumns = db.exec('PRAGMA table_info(knowledge_chunks)');
  const knowledgeColumnNames = knowledgeColumns[0]?.values.map((row) => String(row[1])) || [];
  if (!knowledgeColumnNames.includes('embedding')) {
    db.run("ALTER TABLE knowledge_chunks ADD COLUMN embedding TEXT NOT NULL DEFAULT ''");
  }
  if (!knowledgeColumnNames.includes('embedding_model')) {
    db.run("ALTER TABLE knowledge_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT ''");
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      current_step INTEGER DEFAULT 0,
      total_steps INTEGER DEFAULT 0,
      steps_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      namespace TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL DEFAULT '',
      embedding_text TEXT NOT NULL DEFAULT '',
      pattern TEXT NOT NULL DEFAULT '',
      solution TEXT NOT NULL DEFAULT '',
      context TEXT DEFAULT '',
      confidence REAL DEFAULT 0.5,
      use_count INTEGER DEFAULT 0,
      embedding TEXT NOT NULL DEFAULT '',
      embedding_model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  const memoryColumns = db.exec('PRAGMA table_info(agent_memory)');
  const memoryColumnNames = memoryColumns[0]?.values.map((row) => String(row[1])) || [];
  const memoryMigrations: Array<[string, string]> = [
    ['namespace', "TEXT NOT NULL DEFAULT ''"],
    ['key', "TEXT NOT NULL DEFAULT ''"],
    ['value', "TEXT NOT NULL DEFAULT ''"],
    ['embedding_text', "TEXT NOT NULL DEFAULT ''"],
    ['pattern', "TEXT NOT NULL DEFAULT ''"],
    ['solution', "TEXT NOT NULL DEFAULT ''"],
    ['embedding', "TEXT NOT NULL DEFAULT ''"],
    ['embedding_model', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [columnName, definition] of memoryMigrations) {
    if (!memoryColumnNames.includes(columnName)) {
      db.run(`ALTER TABLE agent_memory ADD COLUMN ${columnName} ${definition}`);
    }
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS team_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      tasks_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_step INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_instances (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      system_prompt TEXT DEFAULT '',
      tools TEXT DEFAULT '[]',
      model TEXT DEFAULT 'deepseek-v4-flash',
      temperature REAL DEFAULT 0.7,
      current_project TEXT,
      working_directory TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_contexts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agent_instances(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      risk_level TEXT NOT NULL DEFAULT 'none',
      decision TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      session_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      steps_json TEXT NOT NULL DEFAULT '[]',
      tools_json TEXT NOT NULL DEFAULT '[]',
      files_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  // v3.12.0 removes the Telegram collector completely, including credentials,
  // sessions and historical relay data left by earlier installations.
  db.run("DELETE FROM settings WHERE key LIKE 'telegram_%'");
  db.run('DROP TABLE IF EXISTS telegram_items');
  db.run('DROP TABLE IF EXISTS telegram_cursors');
  db.run('DROP TABLE IF EXISTS telegram_rules');

  saveDb();
  return db;
}

export function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Helper to run a query and return all rows
export function queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params as any);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>);
  }
  stmt.free();
  return rows;
}

// Helper to run a query and return the first row
export function queryOne(sql: string, params: unknown[] = []): Record<string, unknown> | null {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params as any);
  let row: Record<string, unknown> | null = null;
  if (stmt.step()) {
    row = stmt.getAsObject() as Record<string, unknown>;
  }
  stmt.free();
  return row;
}

// Helper to run a statement (INSERT, UPDATE, DELETE)
export function runSql(sql: string, params: unknown[] = []): void {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params as any);
  saveDb();
}
