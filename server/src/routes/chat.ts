import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { getDb, queryOne } from '../db.js';

const router = express.Router();

// Enhanced Agent system prompt with better intelligence
const AGENT_SYSTEM_PROMPT = `You are Synaps, an AI software development agent running on a mobile phone.
You help users develop, debug, build, and publish software through natural language.

## Your Capabilities
You have access to tools that let you interact with the project files:
- list_dir: List files in a directory
- read_file: Read file contents
- write_file: Create or modify files
- search_file: Search for files by name

## Working Style
1. **Understand First**: Always analyze the project structure before making changes
2. **Plan**: Break complex tasks into steps
3. **Execute**: Use tools to implement changes
4. **Verify**: Read back modified files to confirm changes

## Rules
- ALWAYS read files before modifying them
- Make minimal, focused changes
- Explain what you're doing at each step
- If you encounter an error, try to understand and fix it
- All paths are relative to the project root

## Tool Usage
When you need to use a tool, output ONLY the tool call block:
\`\`\`tool
{"tool": "tool_name", "path": "file/path"}
\`\`\`

After receiving tool results, continue your task or call more tools if needed.
When done, provide a clear summary of what you accomplished.`;

interface ToolCall {
  tool: string;
  path?: string;
  query?: string;
  content?: string;
}

function parseToolCall(response: string): ToolCall | null {
  const match = response.match(/```tool\s*\n?([\s\S]*?)\n?```/);
  if (!match) return null;

  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

function resolveProjectPath(projectId: string, relativePath: string): string {
  const project = queryOne(`SELECT path FROM projects WHERE id = ?`, [projectId]) as Record<string, string> | null;
  if (!project) throw new Error('Project not found');

  const projectPath = project.path;
  const resolved = path.resolve(projectPath, relativePath);

  if (!resolved.startsWith(path.resolve(projectPath))) {
    throw new Error('Path traversal not allowed');
  }

  return resolved;
}

async function executeTool(projectId: string, toolCall: ToolCall): Promise<string> {
  await getDb();

  switch (toolCall.tool) {
    case 'list_dir': {
      const dirPath = resolveProjectPath(projectId, toolCall.path || '');
      if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${toolCall.path}`;

      const entries = fs.readdirSync(dirPath);
      const items = entries
        .filter(name => !name.startsWith('.'))
        .map(name => {
          const fullPath = path.join(dirPath, name);
          try {
            const stat = fs.statSync(fullPath);
            return `${stat.isDirectory() ? '📁' : '📄'} ${name}${stat.isDirectory() ? '/' : ''}`;
          } catch {
            return `? ${name}`;
          }
        });

      return items.length > 0 ? items.join('\n') : '(empty directory)';
    }

    case 'read_file': {
      if (!toolCall.path) return 'Error: path is required';
      const filePath = resolveProjectPath(projectId, toolCall.path);
      if (!fs.existsSync(filePath)) return `Error: File not found: ${toolCall.path}`;

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return `Error: ${toolCall.path} is a directory`;
      if (stat.size > 500 * 1024) return `Error: File too large (${stat.size} bytes, max 500KB)`;

      const content = fs.readFileSync(filePath, 'utf-8');
      return content;
    }

    case 'write_file': {
      if (!toolCall.path) return 'Error: path is required';
      if (toolCall.content === undefined) return 'Error: content is required';

      const filePath = resolveProjectPath(projectId, toolCall.path);
      const dir = path.dirname(filePath);

      // Auto-create snapshot before modifying file
      try {
        const db = await getDb();
        const snapshotId = crypto.randomUUID();
        const now = new Date().toISOString();
        
        // Read existing file content if it exists
        let existingContent = '';
        if (fs.existsSync(filePath)) {
          existingContent = fs.readFileSync(filePath, 'utf-8');
        }
        
        // Create snapshot record
        db.run(
          `INSERT INTO snapshots (id, project_id, label, created_at) VALUES (?, ?, ?, ?)`,
          [snapshotId, projectId, `Auto-snapshot before Agent edit`, now]
        );
        
        // Save file to snapshot
        db.run(
          `INSERT INTO snapshot_files (snapshot_id, path, content) VALUES (?, ?, ?)`,
          [snapshotId, toolCall.path, existingContent]
        );
      } catch (err) {
        console.error('Failed to create auto-snapshot:', err);
        // Continue with write even if snapshot fails
      }

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, toolCall.content, 'utf-8');
      return `Successfully wrote ${toolCall.content.length} bytes to ${toolCall.path}`;
    }

    case 'search_file': {
      if (!toolCall.query) return 'Error: query is required';
      const projectRoot = resolveProjectPath(projectId, '');
      const results: string[] = [];
      const maxResults = 50;
      const queryLower = toolCall.query.toLowerCase();

      function walkDir(dir: string, depth: number) {
        if (depth > 8 || results.length >= maxResults) return;
        const entries = fs.readdirSync(dir);

        for (const name of entries) {
          if (name.startsWith('.') || name === 'node_modules' || name === 'build') continue;
          if (results.length >= maxResults) break;

          const fullPath = path.join(dir, name);
          const relPath = path.relative(projectRoot, fullPath);

          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              if (name.toLowerCase().includes(queryLower)) {
                results.push(`📁 ${relPath}/`);
              }
              walkDir(fullPath, depth + 1);
            } else {
              if (name.toLowerCase().includes(queryLower)) {
                results.push(`📄 ${relPath}`);
              }
            }
          } catch {
            // skip
          }
        }
      }

      walkDir(projectRoot, 0);
      return results.length > 0 ? results.join('\n') : `No files matching "${toolCall.query}"`;
    }

    default:
      return `Error: Unknown tool "${toolCall.tool}"`;
  }
}

/**
 * POST /api/v1/chat
 * SSE streaming chat with AI Agent
 * Body: {
 *   messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }>,
 *   projectId?: string
 * }
 */
router.post('/', async (req: express.Request, res: express.Response) => {
  try {
    await getDb();
    
    const { messages, projectId } = req.body as {
      messages: Array<{ role: string; content: string }>;
      projectId?: string;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }

    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (!hasUserMessage) {
      res.status(400).json({ error: 'At least one user message is required' });
      return;
    }

    const customHeaders = HeaderUtils.extractForwardHeaders(
      req.headers as unknown as Record<string, string>
    );

    const getSetting = (key: string): string | null => {
      const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]) as Record<string, string> | null;
      return row?.value ?? null;
    };

    // 优先使用设置页保存的配置，其次回退到环境变量
    const apiKey = getSetting('ai_api_key') || process.env.COZE_WORKLOAD_IDENTITY_API_KEY;
    const baseUrl = getSetting('ai_base_url') || process.env.COZE_INTEGRATION_BASE_URL;
    const modelBaseUrl = getSetting('ai_model_base_url') || process.env.COZE_INTEGRATION_MODEL_BASE_URL;
    const model = getSetting('ai_model') || undefined;

    if (!apiKey) {
      res.status(400).json({ error: '未配置模型 API Key，请到 设置 → AI 模型 中填写 API Key' });
      return;
    }

    const config = new Config({ apiKey, baseUrl, modelBaseUrl });
    const client = new LLMClient(config, customHeaders);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Build system message with project context
    let systemPrompt = AGENT_SYSTEM_PROMPT;
    
    if (projectId) {
      const project = queryOne(`SELECT name, path FROM projects WHERE id = ?`, [projectId]) as Record<string, string> | null;
      if (project) {
        systemPrompt += `\n\n## Current Project Context
Project Name: ${project.name}
Project Path: ${project.path}

All file operations should use paths relative to the project root.`;
        
        // Auto-analyze project structure for context
        try {
          const projectRoot = project.path;
          if (fs.existsSync(projectRoot)) {
            const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
            const structure = entries
              .filter(e => !e.name.startsWith('.'))
              .slice(0, 20)
              .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`)
              .join('\n');
            systemPrompt += `\n\nProject Structure (root level):\n${structure}`;
          }
        } catch {
          // Ignore errors in context analysis
        }
      }
    }

    const conversationMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
    ];

    // Agent loop: execute tools and continue conversation
    const maxIterations = 10;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Collect full response
      let fullResponse = '';
      const stream = client.stream(conversationMessages, {
        temperature: 0.3,
        ...(model ? { model } : {}),
      });

      for await (const chunk of stream) {
        if (chunk.content) {
          fullResponse += chunk.content.toString();
        }
      }

      // Check for tool call
      const toolCall = parseToolCall(fullResponse);

      if (!toolCall || !projectId) {
        // No tool call or no project context - stream final response to client
        // Re-stream the response
        const finalStream = client.stream(conversationMessages, {
          temperature: 0.3,
          ...(model ? { model } : {}),
        });

        for await (const chunk of finalStream) {
          if (chunk.content) {
            const data = JSON.stringify({ content: chunk.content.toString() });
            res.write(`data: ${data}\n\n`);
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Execute tool
      const toolResult = await executeTool(projectId, toolCall);

      // Send tool execution info to client
      res.write(`data: ${JSON.stringify({
        tool: toolCall.tool,
        path: toolCall.path || toolCall.query || '',
        status: 'completed',
      })}\n\n`);

      // Add assistant response and tool result to conversation
      conversationMessages.push({
        role: 'assistant',
        content: fullResponse,
      });
      conversationMessages.push({
        role: 'user',
        content: `[Tool Result for ${toolCall.tool}]:\n${toolResult}\n\nContinue with your task or provide a summary.`,
      });
    }

    // Max iterations reached
    res.write(`data: ${JSON.stringify({
      content: '\n\n[Agent reached maximum iterations. Please continue the conversation if more work is needed.]',
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Chat API error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

/**
 * GET /api/v1/chat/analyze-project/:projectId
 * Analyze project structure and return context summary
 */
router.get('/analyze-project/:projectId', async (req: express.Request, res: express.Response) => {
  try {
    await getDb();
    const { projectId } = req.params;
    const project = queryOne(`SELECT name, path FROM projects WHERE id = ?`, [projectId]) as Record<string, string> | null;
    
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const projectRoot = project.path;
    if (!fs.existsSync(projectRoot)) {
      res.status(404).json({ error: 'Project path does not exist' });
      return;
    }

    // Analyze project structure
    const analysis: {
      name: string;
      path: string;
      type: string;
      structure: string[];
      keyFiles: Record<string, boolean>;
      stats: { files: number; directories: number };
    } = {
      name: project.name,
      path: projectRoot,
      type: 'Unknown',
      structure: [],
      keyFiles: {},
      stats: { files: 0, directories: 0 }
    };

    // Detect project type
    const checks = [
      { file: 'AndroidManifest.xml', type: 'Android' },
      { file: 'build.gradle', type: 'Gradle' },
      { file: 'package.json', type: 'Node.js' },
      { file: 'Cargo.toml', type: 'Rust' },
      { file: 'go.mod', type: 'Go' },
      { file: 'requirements.txt', type: 'Python' },
      { file: 'pom.xml', type: 'Maven' },
    ];

    for (const check of checks) {
      if (fs.existsSync(path.join(projectRoot, check.file))) {
        analysis.type = check.type;
        break;
      }
    }

    // Scan project structure (limited depth)
    function scanDir(dir: string, relPath: string = '', depth: number = 0) {
      if (depth > 3) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries.slice(0, 30)) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue;
        
        const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
        const icon = entry.isDirectory() ? '📁' : '📄';
        analysis.structure.push(`${'  '.repeat(depth)}${icon} ${entry.name}`);
        
        if (entry.isDirectory()) {
          analysis.stats.directories++;
          scanDir(path.join(dir, entry.name), rel, depth + 1);
        } else {
          analysis.stats.files++;
          analysis.keyFiles[entry.name] = true;
        }
      }
    }

    scanDir(projectRoot);

    res.json(analysis);
  } catch (error) {
    console.error('Analyze project error:', error);
    res.status(500).json({ error: 'Failed to analyze project' });
  }
});

export default router;
