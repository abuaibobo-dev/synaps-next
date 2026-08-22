import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, queryAll, queryOne, runSql } from '../db.js';
import {
  ensureKnowledgeTable,
  indexChatHistory,
  indexProjectFiles,
  searchKnowledge,
} from '../rag.js';

const router = Router();

interface MemoryStats {
  totalChunks: number;
  embeddedChunks: number;
  embeddingCoverage: number;
  byType: Array<{ type: string; count: number; embedded: number }>;
  agentMemories: number;
  projects: number;
}

async function buildStats(projectId?: string): Promise<MemoryStats> {
  await getDb();
  await ensureKnowledgeTable();
  const where = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const rows = queryAll(
    `SELECT doc_type,
            COUNT(*) AS total,
            SUM(CASE WHEN embedding != '' THEN 1 ELSE 0 END) AS embedded
     FROM knowledge_chunks ${where}
     GROUP BY doc_type
     ORDER BY doc_type`,
    params
  );
  const byType = rows.map((row) => ({
    type: String(row.doc_type || 'unknown'),
    count: Number(row.total || 0),
    embedded: Number(row.embedded || 0),
  }));
  const totalChunks = byType.reduce((sum, row) => sum + row.count, 0);
  const embeddedChunks = byType.reduce((sum, row) => sum + row.embedded, 0);
  const memoryRow = queryOne(
    `SELECT
       (SELECT COUNT(*) FROM agent_memory${projectId ? ' WHERE project_id = ?' : ''}) AS memories,
       (SELECT COUNT(*) FROM projects${projectId ? ' WHERE id = ?' : ''}) AS projects`,
    projectId ? [projectId, projectId] : []
  );

  return {
    totalChunks,
    embeddedChunks,
    embeddingCoverage: totalChunks ? Math.round((embeddedChunks / totalChunks) * 100) : 0,
    byType,
    agentMemories: Number(memoryRow?.memories || 0),
    projects: Number(memoryRow?.projects || 0),
  };
}

router.get('/stats/:projectId', async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId || '');
    const project = queryOne('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ projectId, stats: await buildStats(projectId) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    res.json({ stats: await buildStats() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/index', async (req: Request, res: Response) => {
  const projectId = String(req.body?.projectId || '');
  const includeChat = req.body?.includeChat !== false;
  const chatLimit = Math.min(Math.max(Number(req.body?.chatLimit || 200), 1), 1000);
  try {
    await getDb();
    const project = queryOne('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    let fileChunks = 0;
    let chatChunks = 0;
    const errors: string[] = [];
    try {
      fileChunks = await indexProjectFiles(projectId, String(project.path));
    } catch (error) {
      errors.push(`file-index: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (includeChat) {
      try {
        chatChunks = await indexChatHistory(projectId, chatLimit);
      } catch (error) {
        errors.push(`chat-index: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    runSql("UPDATE projects SET updated_at = datetime('now') WHERE id = ?", [projectId]);
    res.json({
      projectId,
      indexed: { files: fileChunks, chats: chatChunks },
      warnings: errors,
      stats: await buildStats(projectId),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/search', async (req: Request, res: Response) => {
  const projectId = req.body?.projectId ? String(req.body.projectId) : null;
  const query = String(req.body?.query || '').trim();
  const topK = Math.min(Math.max(Number(req.body?.topK || 8), 1), 50);
  if (!query) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  try {
    const result = await searchKnowledge(projectId, query, topK);
    res.json({ query, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
