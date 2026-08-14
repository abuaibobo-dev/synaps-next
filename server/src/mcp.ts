import { queryOne, runSql, saveDb } from './db.js';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
}

export function getMcpServers(): McpServerConfig[] {
  try {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', ['mcp_servers']);
    if (!row || typeof row.value !== 'string' || !row.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x) =>
        x &&
        typeof x === 'object' &&
        typeof x.name === 'string' &&
        (x.transport === 'stdio' || x.transport === 'sse')
    ) as McpServerConfig[];
  } catch {
    return [];
  }
}

export function setMcpServers(servers: McpServerConfig[]): void {
  runSql(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('mcp_servers', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [JSON.stringify(servers)]
  );
  saveDb();
}

type SdkModule = typeof import('@modelcontextprotocol/sdk/client/index.js');
type StdioTransportModule = typeof import('@modelcontextprotocol/sdk/client/stdio.js');
type SseTransportModule = typeof import('@modelcontextprotocol/sdk/client/sse.js');

let sdkCache: {
  sdk: SdkModule;
  stdio: StdioTransportModule;
  sse: SseTransportModule;
} | null = null;

async function loadSdk() {
  if (sdkCache) return sdkCache;
  const [sdk, stdio, sse] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ]);
  sdkCache = { sdk, stdio, sse };
  return sdkCache;
}

async function connectServer(server: McpServerConfig) {
  const { sdk, stdio, sse } = await loadSdk();
  const client = new sdk.Client({ name: 'synaps-mcp', version: '1.0.0' });
  let transport;
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('stdio server requires a command');
    transport = new stdio.StdioClientTransport({
      command: server.command,
      args: server.args || [],
      cwd: process.cwd(),
    });
  } else if (server.transport === 'sse') {
    if (!server.url) throw new Error('sse server requires a url');
    transport = new sse.SSEClientTransport(new URL(server.url));
  } else {
    throw new Error(`Unsupported MCP transport: ${server.transport as string}`);
  }
  await client.connect(transport);
  return client;
}

export async function mcpListTools(serverName: string): Promise<string> {
  const server = getMcpServers().find((s) => s.name === serverName);
  if (!server) {
    return `Error: MCP server "${serverName}" not configured. Use mcp_add_server to add it first.`;
  }
  let client;
  try {
    client = await connectServer(server);
    const tools = await client.listTools();
    await client.close();
    const items = (tools.tools || []).map(
      (t) => `- ${t.name}: ${(t.description || '').split('\n')[0]}`
    );
    return items.length > 0
      ? `MCP server "${serverName}" tools (${items.length}):\n${items.join('\n')}`
      : `MCP server "${serverName}" exposes no tools.`;
  } catch (err: any) {
    try {
      await client?.close();
    } catch {
      // ignore
    }
    return `Error connecting to MCP server "${serverName}": ${err?.message || String(err)}`;
  }
}

export async function mcpCallTool(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<string> {
  const server = getMcpServers().find((s) => s.name === serverName);
  if (!server) {
    return `Error: MCP server "${serverName}" not configured. Use mcp_add_server to add it first.`;
  }
  let client;
  try {
    client = await connectServer(server);
    const result = await client.callTool({ name: toolName, arguments: params });
    await client.close();
    const content = Array.isArray(result.content)
      ? result.content
          .map((c: any) => (c && c.type === 'text' ? c.text : JSON.stringify(c)))
          .filter(Boolean)
          .join('\n')
      : String((result as any).content ?? '');
    const isError = (result as any).isError ? '[Tool returned error]\n' : '';
    return `${isError}${content || '(no output)'}`;
  } catch (err: any) {
    try {
      await client?.close();
    } catch {
      // ignore
    }
    return `Error calling MCP tool "${toolName}" on "${serverName}": ${err?.message || String(err)}`;
  }
}
