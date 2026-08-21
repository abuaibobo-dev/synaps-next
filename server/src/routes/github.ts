import { Router } from 'express';
import type { Request, Response } from 'express';

const router = Router();

const GITHUB_API = 'https://api.github.com';

// Helper to get GitHub token from settings or env
async function getGitHubToken(): Promise<string | null> {
  // First check environment variable
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  // Then check database settings
  try {
    const { getDb } = await import('../db.js');
    const db = await getDb();
    const results = db.exec("SELECT value FROM settings WHERE key = 'github_token'");
    if (results.length > 0 && results[0].values.length > 0) {
      return results[0].values[0][0] as string;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

// Helper to make GitHub API requests
async function githubFetch(endpoint: string, token: string, options: RequestInit = {}) {
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Synaps-App',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Verify token identity and API access without exposing the token.
router.get('/verify', async (_req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) return res.status(401).json({ valid: false, error: 'GitHub token not configured' });
    const user = await githubFetch('/user', token) as { login?: string };
    res.json({ valid: true, login: user.login || '' });
  } catch (error) {
    const message = (error as Error).message;
    res.status(401).json({
      valid: false,
      error: message.includes('401')
        ? 'Token 无效或已过期'
        : message.includes('403')
          ? 'Token 权限不足或触发限流'
          : message,
    });
  }
});

// List user's repositories
// GET /api/v1/github/repos?page=1&per_page=20
router.get('/repos', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const page = req.query.page || '1';
    const perPage = req.query.per_page || '20';

    const repos = await githubFetch(
      `/user/repos?page=${page}&per_page=${perPage}&sort=updated`,
      token
    ) as Array<{
      id: number; name: string; full_name: string; description: string | null;
      private: boolean; html_url: string; clone_url: string; ssh_url: string;
      default_branch: string; language: string | null; updated_at: string; size: number;
    }>;

    const simplified = repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      html_url: repo.html_url,
      clone_url: repo.clone_url,
      ssh_url: repo.ssh_url,
      default_branch: repo.default_branch,
      language: repo.language,
      updated_at: repo.updated_at,
      size: repo.size,
    }));

    res.json({ repos: simplified });
  } catch (error) {
    console.error('Error listing repos:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Search repositories
// GET /api/v1/github/search?q=xxx&page=1&per_page=20
router.get('/search', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const query = req.query.q;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }

    const page = req.query.page || '1';
    const perPage = req.query.per_page || '20';

    const data = await githubFetch(
      `/search/repositories?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`,
      token
    ) as { items: Array<{
      id: number; name: string; full_name: string; description: string | null;
      private: boolean; html_url: string; clone_url: string; default_branch: string;
      language: string | null; stargazers_count: number; forks_count: number; updated_at: string;
    }>; total_count: number };

    const simplified = data.items.map((repo) => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      html_url: repo.html_url,
      clone_url: repo.clone_url,
      default_branch: repo.default_branch,
      language: repo.language,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      updated_at: repo.updated_at,
    }));

    res.json({ repos: simplified, total_count: data.total_count });
  } catch (error) {
    console.error('Error searching repos:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get repository details
// GET /api/v1/github/repo?owner=xxx&repo=xxx
router.get('/repo', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const { owner, repo } = req.query;
    if (!owner || !repo) {
      return res.status(400).json({ error: 'owner and repo are required' });
    }

    const data = await githubFetch(`/repos/${owner}/${repo}`, token) as {
      id: number; name: string; full_name: string; description: string | null;
      private: boolean; html_url: string; clone_url: string; ssh_url: string;
      default_branch: string; language: string | null; stargazers_count: number;
      forks_count: number; open_issues_count: number; created_at: string;
      updated_at: string; size: number;
    };

    res.json({
      id: data.id,
      name: data.name,
      full_name: data.full_name,
      description: data.description,
      private: data.private,
      html_url: data.html_url,
      clone_url: data.clone_url,
      ssh_url: data.ssh_url,
      default_branch: data.default_branch,
      language: data.language,
      stars: data.stargazers_count,
      forks: data.forks_count,
      open_issues: data.open_issues_count,
      created_at: data.created_at,
      updated_at: data.updated_at,
      size: data.size,
    });
  } catch (error) {
    console.error('Error getting repo:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get repository file tree
// GET /api/v1/github/tree?owner=xxx&repo=xxx&branch=main
router.get('/tree', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const { owner, repo, branch } = req.query;
    if (!owner || !repo) {
      return res.status(400).json({ error: 'owner and repo are required' });
    }

    const ref = branch || 'main';
    const data = await githubFetch(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, token) as {
      tree: Array<{ path: string; type: string; size?: number; sha: string }>;
      truncated: boolean;
    };

    const files = data.tree
      .filter((item) => item.type === 'blob')
      .map((item) => ({
        path: item.path,
        size: item.size || 0,
        sha: item.sha,
      }));

    res.json({ files, truncated: data.truncated });
  } catch (error) {
    console.error('Error getting tree:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get file content from GitHub
// GET /api/v1/github/file?owner=xxx&repo=xxx&path=xxx&branch=main
router.get('/file', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const { owner, repo, path: filePath, branch } = req.query;
    if (!owner || !repo || !filePath) {
      return res.status(400).json({ error: 'owner, repo, and path are required' });
    }

    const ref = branch || 'main';
    const data = await githubFetch(
      `/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`,
      token
    ) as { content?: string; name: string; path: string; sha: string; size: number; encoding: string };

    // Decode base64 content
    const content = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';

    res.json({
      name: data.name,
      path: data.path,
      content,
      sha: data.sha,
      size: data.size,
      encoding: data.encoding,
    });
  } catch (error) {
    console.error('Error getting file:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Trigger GitHub Actions workflow
// POST /api/v1/github/workflow/dispatch
// Body: { owner, repo, workflowId, ref, inputs }
router.post('/workflow/dispatch', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const { owner, repo, workflowId, ref, inputs } = req.body;
    if (!owner || !repo || !workflowId) {
      return res.status(400).json({ error: 'owner, repo, and workflowId are required' });
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Synaps-App',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: ref || 'main',
          inputs: inputs || {},
        }),
      }
    );

    if (response.status === 204) {
      res.json({ success: true, message: 'Workflow dispatch triggered' });
    } else {
      const error = await response.text();
      res.status(response.status).json({ error });
    }
  } catch (error) {
    console.error('Error triggering workflow:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// List workflow runs
// GET /api/v1/github/workflows?owner=xxx&repo=xxx
router.get('/workflows', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const { owner, repo } = req.query;
    if (!owner || !repo) {
      return res.status(400).json({ error: 'owner and repo are required' });
    }

    const data = await githubFetch(
      `/repos/${owner}/${repo}/actions/runs?per_page=10`,
      token
    ) as { workflow_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at: string; head_branch: string; head_sha: string }>; total_count: number };

    const runs = data.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      created_at: run.created_at,
      updated_at: run.updated_at,
      head_branch: run.head_branch,
      head_sha: run.head_sha,
    }));

    res.json({ runs, total_count: data.total_count });
  } catch (error) {
    console.error('Error listing workflows:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Download workflow artifact
// GET /api/v1/github/artifact?owner=xxx&repo=xxx&runId=xxx
router.get('/artifact', async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const { owner, repo, runId } = req.query;
    if (!owner || !repo || !runId) {
      return res.status(400).json({ error: 'owner, repo, and runId are required' });
    }

    const data = await githubFetch(
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
      token
    ) as { artifacts: Array<{ id: number; name: string; size_in_bytes: number; archive_download_url: string; created_at: string; expired: boolean }> };

    res.json({ artifacts: data.artifacts });
  } catch (error) {
    console.error('Error getting artifact:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
