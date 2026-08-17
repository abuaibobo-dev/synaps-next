import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getDb, queryOne } from '../db.js';

const router = Router();

// Resolve and validate file path within project
function resolveProjectPath(projectId: string, relativePath: string): string {
  const db = getDb();
  if (!db) throw new Error('Database not initialized');

  const project = queryOne(`SELECT * FROM projects WHERE id = ?`, [projectId]);
  if (!project) throw new Error('Project not found');

  const projectPath = (project as Record<string, string>).path;
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, relativePath);

  // Security: ensure resolved path is within project directory
  const lexical = path.relative(root, resolved);
  if (lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
    throw new Error('Path traversal not allowed');
  }

  // Existing files and parents must also remain inside the real project root;
  // this blocks project-local symlinks that point outside the workspace.
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  let existing = resolved;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const realExisting = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  const physical = path.relative(realRoot, realExisting);
  if (physical === '..' || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) {
    throw new Error('Symlink traversal not allowed');
  }

  return resolved;
}

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

/**
 * GET /api/v1/files/list
 * Query 参数：projectId: string, path?: string (relative to project root)
 */
router.get('/list', async (req, res) => {
  try {
    const { projectId, path: relativePath = '' } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }

    await getDb();
    const fullPath = resolveProjectPath(projectId, relativePath as string);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const entries = fs.readdirSync(fullPath);
    const files: FileEntry[] = entries
      .filter(name => !name.startsWith('.')) // Hide hidden files
      .map(name => {
        const filePath = path.join(fullPath, name);
        try {
          const fileStat = fs.statSync(filePath);
          return {
            name,
            path: path.relative(
              path.resolve((queryOne(`SELECT path FROM projects WHERE id = ?`, [projectId]) as Record<string, string>).path),
              filePath
            ),
            type: fileStat.isDirectory() ? 'directory' as const : 'file' as const,
            size: fileStat.size,
            modifiedAt: fileStat.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is FileEntry => f !== null)
      .sort((a, b) => {
        // Directories first, then files
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ files, currentPath: relativePath || '' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

/**
 * GET /api/v1/files/read
 * Query 参数：projectId: string, path: string (relative to project root)
 */
router.get('/read', async (req, res) => {
  try {
    const { projectId, path: relativePath } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!relativePath || typeof relativePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    await getDb();
    const fullPath = resolveProjectPath(projectId, relativePath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory, not a file' });
    }

    // Limit file size to 500KB for reading
    if (stat.size > 500 * 1024) {
      return res.status(400).json({ error: 'File too large (max 500KB)' });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const ext = path.extname(fullPath).toLowerCase();

    res.json({
      content,
      path: relativePath,
      size: stat.size,
      language: getLanguageFromExt(ext),
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/v1/files/write
 * Body 参数：projectId: string, path: string, content: string
 */
router.post('/write', async (req, res) => {
  try {
    const { projectId, path: relativePath, content } = req.body;

    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!relativePath || typeof relativePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }

    await getDb();
    const fullPath = resolveProjectPath(projectId, relativePath);

    // Create parent directories if needed
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf-8');
    const stat = fs.statSync(fullPath);

    res.json({
      success: true,
      path: relativePath,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

/**
 * GET /api/v1/files/search
 * Query 参数：projectId: string, query: string, path?: string, searchIn?: 'name' | 'content' | 'both'
 */
router.get('/search', async (req, res) => {
  try {
    const {
      projectId,
      query: searchQuery,
      path: relativePath = '',
      searchIn = 'name',
    } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!searchQuery || typeof searchQuery !== 'string') {
      return res.status(400).json({ error: 'query is required' });
    }

    await getDb();
    const basePath = resolveProjectPath(projectId, relativePath as string);

    if (!fs.existsSync(basePath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const project = queryOne(`SELECT path FROM projects WHERE id = ?`, [projectId]) as Record<string, string>;
    const projectRoot = path.resolve(project.path);
    const results: Array<{ path: string; name: string; type: string; match?: string }> = [];
    const maxResults = 100;

    const searchInContent = searchIn === 'content' || searchIn === 'both';
    const searchInName = searchIn === 'name' || searchIn === 'both';
    const queryLower = (searchQuery as string).toLowerCase();

    function walkDir(dir: string, depth: number) {
      if (depth > 10 || results.length >= maxResults) return;

      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'build') continue;
        if (results.length >= maxResults) break;

        const fullPath = path.join(dir, name);
        const relPath = path.relative(projectRoot, fullPath);

        try {
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            if (searchInName && name.toLowerCase().includes(queryLower)) {
              results.push({ path: relPath, name, type: 'directory' });
            }
            walkDir(fullPath, depth + 1);
          } else {
            let matched = false;

            // Search in filename
            if (searchInName && name.toLowerCase().includes(queryLower)) {
              results.push({ path: relPath, name, type: 'file' });
              matched = true;
            }

            // Search in file content
            if (!matched && searchInContent && stat.size < 100 * 1024) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(queryLower)) {
                    results.push({
                      path: relPath,
                      name,
                      type: 'file',
                      match: `L${i + 1}: ${lines[i].trim().substring(0, 100)}`,
                    });
                    break;
                  }
                }
              } catch {
                // Skip binary/unreadable files
              }
            }
          }
        } catch {
          // Skip inaccessible files
        }
      }
    }

    walkDir(basePath, 0);
    res.json({ results, total: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

function getLanguageFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.json': 'json',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.md': 'markdown',
    '.py': 'python',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.xml': 'xml',
    '.gradle': 'groovy',
    '.sh': 'shell',
    '.bash': 'shell',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sql': 'sql',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.swift': 'swift',
    '.dart': 'dart',
    '.php': 'php',
    '.txt': 'plaintext',
  };
  return map[ext] || 'plaintext';
}

export default router;
