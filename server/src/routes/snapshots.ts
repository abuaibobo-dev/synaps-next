import { Router } from 'express';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getDb } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Get all snapshots for a project
// GET /api/v1/snapshots/list?projectId=xxx
router.get('/list', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const db = await getDb();
    const results = db.exec(
      `SELECT id, project_id, label, file_count, created_at FROM snapshots WHERE project_id = '${projectId}' ORDER BY created_at DESC`
    );

    if (results.length === 0 || results[0].values.length === 0) {
      return res.json({ snapshots: [] });
    }

    const snapshots = results[0].values.map((row) => ({
      id: row[0] as string,
      project_id: row[1] as string,
      label: row[2] as string,
      file_count: row[3] as number,
      created_at: row[4] as string,
    }));

    res.json({ snapshots });
  } catch (error) {
    console.error('Error listing snapshots:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get snapshot details (files in snapshot)
// GET /api/v1/snapshots/detail?snapshotId=xxx
router.get('/detail', async (req: Request, res: Response) => {
  try {
    const { snapshotId } = req.query;
    if (!snapshotId || typeof snapshotId !== 'string') {
      return res.status(400).json({ error: 'snapshotId is required' });
    }

    const db = await getDb();
    const results = db.exec(
      `SELECT id, file_path, original_content, modified_content, status FROM snapshot_files WHERE snapshot_id = '${snapshotId}'`
    );

    if (results.length === 0) {
      return res.json({ files: [] });
    }

    const files = results[0].values.map((row) => ({
      id: row[0] as string,
      file_path: row[1] as string,
      original_content: row[2] as string,
      modified_content: row[3] as string,
      status: row[4] as string,
    }));

    res.json({ files });
  } catch (error) {
    console.error('Error getting snapshot detail:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a snapshot before Agent modifies files
// POST /api/v1/snapshots/create
// Body: { projectId: string, label: string, files: Array<{ path: string, content: string }> }
router.post('/create', async (req: Request, res: Response) => {
  try {
    const { projectId, label, files } = req.body;
    if (!projectId || !files || !Array.isArray(files)) {
      return res.status(400).json({ error: 'projectId and files are required' });
    }

    const db = await getDb();
    const snapshotId = uuidv4();
    const snapshotLabel = label || `Snapshot ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;

    // Insert snapshot record
    db.run(
      `INSERT INTO snapshots (id, project_id, label, file_count, created_at) VALUES ('${snapshotId}', '${projectId}', '${snapshotLabel}', ${files.length}, datetime('now'))`
    );

    // Insert file records
    for (const file of files) {
      const fileId = uuidv4();
      const escapedPath = file.path.replace(/'/g, "''");
      const escapedContent = (file.content || '').replace(/'/g, "''");
      db.run(
        `INSERT INTO snapshot_files (id, snapshot_id, file_path, original_content, modified_content, status) VALUES ('${fileId}', '${snapshotId}', '${escapedPath}', '${escapedContent}', '', 'pending')`
      );
    }

    res.json({
      id: snapshotId,
      label: snapshotLabel,
      file_count: files.length,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error creating snapshot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update snapshot file with modified content (after Agent modifies)
// POST /api/v1/snapshots/update-file
// Body: { snapshotId: string, filePath: string, modifiedContent: string }
router.post('/update-file', async (req: Request, res: Response) => {
  try {
    const { snapshotId, filePath, modifiedContent } = req.body;
    if (!snapshotId || !filePath) {
      return res.status(400).json({ error: 'snapshotId and filePath are required' });
    }

    const db = await getDb();
    const escapedPath = filePath.replace(/'/g, "''");
    const escapedContent = (modifiedContent || '').replace(/'/g, "''");

    db.run(
      `UPDATE snapshot_files SET modified_content = '${escapedContent}', status = 'modified' WHERE snapshot_id = '${snapshotId}' AND file_path = '${escapedPath}'`
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating snapshot file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept changes (apply modified content to actual files)
// POST /api/v1/snapshots/accept
// Body: { snapshotId: string }
router.post('/accept', async (req: Request, res: Response) => {
  try {
    const { snapshotId } = req.body;
    if (!snapshotId) {
      return res.status(400).json({ error: 'snapshotId is required' });
    }

    const db = await getDb();

    // Get snapshot files
    const results = db.exec(
      `SELECT sf.file_path, sf.modified_content, p.path as project_path FROM snapshot_files sf JOIN snapshots s ON sf.snapshot_id = s.id JOIN projects p ON s.project_id = p.id WHERE sf.snapshot_id = '${snapshotId}'`
    );

    if (results.length === 0 || results[0].values.length === 0) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    const appliedFiles: string[] = [];

    for (const row of results[0].values) {
      const filePath = row[0] as string;
      const modifiedContent = row[1] as string;
      const projectPath = row[2] as string;

      const fullPath = path.join(projectPath, filePath);
      const dir = path.dirname(fullPath);

      // Ensure directory exists
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write modified content
      fs.writeFileSync(fullPath, modifiedContent, 'utf-8');
      appliedFiles.push(filePath);
    }

    // Update snapshot status
    db.run(`UPDATE snapshot_files SET status = 'accepted' WHERE snapshot_id = '${snapshotId}'`);

    res.json({ success: true, applied_files: appliedFiles });
  } catch (error) {
    console.error('Error accepting snapshot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject changes (restore original content)
// POST /api/v1/snapshots/reject
// Body: { snapshotId: string }
router.post('/reject', async (req: Request, res: Response) => {
  try {
    const { snapshotId } = req.body;
    if (!snapshotId) {
      return res.status(400).json({ error: 'snapshotId is required' });
    }

    const db = await getDb();

    // Get snapshot files
    const results = db.exec(
      `SELECT sf.file_path, sf.original_content, p.path as project_path FROM snapshot_files sf JOIN snapshots s ON sf.snapshot_id = s.id JOIN projects p ON s.project_id = p.id WHERE sf.snapshot_id = '${snapshotId}'`
    );

    if (results.length === 0 || results[0].values.length === 0) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    const restoredFiles: string[] = [];

    for (const row of results[0].values) {
      const filePath = row[0] as string;
      const originalContent = row[1] as string;
      const projectPath = row[2] as string;

      const fullPath = path.join(projectPath, filePath);

      // Restore original content
      if (originalContent) {
        fs.writeFileSync(fullPath, originalContent, 'utf-8');
      } else {
        // If original was empty, delete the file
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
      restoredFiles.push(filePath);
    }

    // Update snapshot status
    db.run(`UPDATE snapshot_files SET status = 'rejected' WHERE snapshot_id = '${snapshotId}'`);

    res.json({ success: true, restored_files: restoredFiles });
  } catch (error) {
    console.error('Error rejecting snapshot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a snapshot
// DELETE /api/v1/snapshots/delete?snapshotId=xxx
router.delete('/delete', async (req: Request, res: Response) => {
  try {
    const { snapshotId } = req.query;
    if (!snapshotId || typeof snapshotId !== 'string') {
      return res.status(400).json({ error: 'snapshotId is required' });
    }

    const db = await getDb();
    db.run(`DELETE FROM snapshot_files WHERE snapshot_id = '${snapshotId}'`);
    db.run(`DELETE FROM snapshots WHERE id = '${snapshotId}'`);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting snapshot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
