import { Router } from 'express';
import { ZipArchive } from 'archiver';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db.js';

const router = Router();

/**
 * GET /api/v1/export/zip?projectId=xxx
 * Export project as ZIP file
 * Response: ZIP file download
 */
router.get('/zip', async (req, res) => {
  const { projectId } = req.query;

  if (!projectId || typeof projectId !== 'string') {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const db = await getDb();
  const project = db.exec(`SELECT * FROM projects WHERE id = '${projectId}'`);

  if (!project[0] || project[0].values.length === 0) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const columns = project[0].columns;
  const values = project[0].values[0];
  const projectData: Record<string, string> = {};
  columns.forEach((col, idx) => {
    projectData[col] = values[idx] as string;
  });

  const projectPath = projectData.path;

  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project path does not exist' });
  }

  // Set headers for file download
  const fileName = `${projectData.name || 'project'}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  // Create ZIP archive
  const archive = new ZipArchive({ zlib: { level: 9 } });

  archive.on('error', (err: Error) => {
    res.status(500).json({ error: err.message });
  });

  archive.pipe(res);

  // Add project directory to archive
  archive.directory(projectPath, projectData.name || 'project');

  await archive.finalize();
});

/**
 * GET /api/v1/export/list?projectId=xxx
 * List all files in project for export preview
 * Response: { files: Array<{ path: string, size: number }> }
 */
router.get('/list', async (req, res) => {
  const { projectId } = req.query;

  if (!projectId || typeof projectId !== 'string') {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const db = await getDb();
  const project = db.exec(`SELECT * FROM projects WHERE id = '${projectId}'`);

  if (!project[0] || project[0].values.length === 0) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const columns = project[0].columns;
  const values = project[0].values[0];
  const projectData: Record<string, string> = {};
  columns.forEach((col, idx) => {
    projectData[col] = values[idx] as string;
  });

  const projectPath = projectData.path;

  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project path does not exist' });
  }

  // Recursively list all files
  const files: Array<{ path: string; size: number }> = [];
  const listDir = (dir: string, base: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(base, entry.name);

      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      if (entry.isDirectory()) {
        listDir(fullPath, relativePath);
      } else {
        const stats = fs.statSync(fullPath);
        files.push({ path: relativePath, size: stats.size });
      }
    }
  };

  listDir(projectPath, '');

  res.json({ files, totalSize: files.reduce((sum, f) => sum + f.size, 0) });
});

export default router;
