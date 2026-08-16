import { Router, type Request, type Response } from 'express';
import path from 'path';
import fs from 'fs';
import * as crypto from 'crypto';
import { getDb, saveDb, queryAll, queryOne, runSql } from '../db.js';
import { runProcess, isAndroidRuntime } from '../nativeProc.js';

const router = Router();

// Execute a command
router.post('/exec', async (req: Request, res: Response) => {
  try {
    const { command, projectId, cwd } = req.body;

    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }

    // Determine working directory
    let workingDir = cwd || process.cwd();

    // If projectId is provided, use project path
    if (projectId) {
      const db = await getDb();
      const project = queryOne('SELECT path FROM projects WHERE id = ?', [projectId]);
      if (project && project.path) {
        workingDir = project.path as string;
      }
    }

    // Security: prevent dangerous commands
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /mkfs\./,
      /dd\s+if=/,
      /:\(\)\s*\{/,  // Fork bomb
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return res.status(403).json({ error: 'Dangerous command blocked' });
      }
    }

    // Execute command
    const startTime = Date.now();
    let output = '';
    let error = '';
    let exitCode = 0;

    try {
      // Android 上 child_process 不可用，走原生执行器（Kotlin ProcessBuilder）
      const shell = isAndroidRuntime() ? '/system/bin/sh' : '/bin/sh';
      const result = await runProcess({
        cmd: shell,
        args: ['-c', command],
        cwd: workingDir,
        timeoutMs: 30000, // 30 秒超时
      });
      output = result.stdout;
      error = result.stderr || (result.error ? `[启动失败] ${result.error}` : '');
      exitCode = result.timedOut ? -1 : result.exitCode;
    } catch (execError: any) {
      output = '';
      error = execError?.message || String(execError);
      exitCode = 1;
    }

    const duration = Date.now() - startTime;

    // Save to history
    const db = await getDb();
    const id = crypto.randomUUID();
    const now = Date.now();
    runSql(
      'INSERT INTO command_history (id, project_id, command, output, error, exit_code, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, projectId || null, command, output, error, exitCode, now]
    );
    saveDb();

    res.json({
      id,
      command,
      output,
      error,
      exitCode,
      duration,
      cwd: workingDir,
      timestamp: now,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get command history
router.get('/history', async (req: Request, res: Response) => {
  try {
    const { projectId, limit = 50 } = req.query;

    let history;
    if (projectId) {
      history = queryAll(
        'SELECT * FROM command_history WHERE project_id = ? ORDER BY executed_at DESC LIMIT ?',
        [projectId, Number(limit)]
      );
    } else {
      history = queryAll(
        'SELECT * FROM command_history ORDER BY executed_at DESC LIMIT ?',
        [Number(limit)]
      );
    }

    res.json({ history });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Clear command history
router.delete('/history', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query;

    const db = await getDb();
    if (projectId) {
      runSql('DELETE FROM command_history WHERE project_id = ?', [projectId as string]);
    } else {
      runSql('DELETE FROM command_history', []);
    }
    saveDb();

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get available shells/environments
router.get('/info', async (req: Request, res: Response) => {
  try {
    const info = {
      shell: process.env.SHELL || '/bin/sh',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
      },
    };

    res.json(info);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
