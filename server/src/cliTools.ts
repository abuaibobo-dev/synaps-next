import fs from 'fs';
import path from 'path';
import https from 'https';
import zlib from 'zlib';
import type { IncomingMessage } from 'http';
import { runProcess } from './nativeProc.js';

export type CliToolId = 'aichat' | 'mods';

interface CliToolDef {
  id: CliToolId;
  name: string;
  description: string;
  repository: string;
  requiresLogin: false;
  assetName(tag: string, arch: string): string;
  binaryName: string;
}

const TOOL_DEFS: CliToolDef[] = [
  {
    id: 'aichat',
    name: 'AIChat',
    description: '命令行 AI 助手，支持 DeepSeek 和 OpenAI 兼容接口。',
    repository: 'sigoden/aichat',
    requiresLogin: false,
    assetName(tag, arch) {
      return `aichat-${tag}-${arch === 'x64' ? 'x86_64' : 'aarch64'}-unknown-linux-musl.tar.gz`;
    },
    binaryName: 'aichat',
  },
  {
    id: 'mods',
    name: 'Mods',
    description: '管道式 AI 命令行工具，适合处理文本流和快速改写。',
    repository: 'charmbracelet/mods',
    requiresLogin: false,
    assetName(tag, arch) {
      const version = tag.replace(/^v/, '');
      const platform = arch === 'x64' ? 'x86_64' : 'arm64';
      return `mods_${version}_Linux_${platform}.tar.gz`;
    },
    binaryName: 'mods',
  },
];

const DATA_DIR = process.env.SYNAPS_DATA_DIR
  ? process.env.SYNAPS_DATA_DIR
  : path.join(__dirname, '../../data');
const TOOLS_DIR = path.join(DATA_DIR, 'cli-tools');

interface CliToolState {
  downloading: boolean;
  bytesDone: number;
  bytesTotal: number;
  version: string | null;
  error: string | null;
}

const states = new Map<CliToolId, CliToolState>(
  TOOL_DEFS.map((definition) => [definition.id, {
    downloading: false,
    bytesDone: 0,
    bytesTotal: 0,
    version: null,
    error: null,
  }])
);

function toolDir(id: CliToolId): string {
  return path.join(TOOLS_DIR, id);
}

export function toolBinaryPath(id: CliToolId): string {
  const definition = TOOL_DEFS.find((item) => item.id === id);
  if (!definition) throw new Error(`未知 CLI 工具：${id}`);
  return path.join(toolDir(id), definition.binaryName);
}

export function cliToolInstalled(id: CliToolId): boolean {
  try {
    fs.accessSync(toolBinaryPath(id), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeCliTool(id: CliToolId): Promise<{ version: string | null; error: string | null }> {
  if (!cliToolInstalled(id)) return { version: null, error: null };
  const result = await runProcess({
    cmd: toolBinaryPath(id),
    args: ['--version'],
    timeoutMs: 15000,
  });
  if (result.error) return { version: null, error: result.error };
  if (result.timedOut) return { version: null, error: '版本检测超时' };
  if (result.exitCode !== 0) {
    return { version: null, error: `退出码 ${result.exitCode}：${result.stderr.trim().slice(0, 240)}` };
  }
  return { version: result.stdout.trim().split('\n')[0] || null, error: null };
}

export async function getCliToolStatus(id: CliToolId) {
  const definition = TOOL_DEFS.find((item) => item.id === id);
  if (!definition) throw new Error(`未知 CLI 工具：${id}`);
  const state = states.get(id)!;
  if (!state.downloading) {
    const probe = await probeCliTool(id);
    state.version = probe.version;
    state.error = cliToolInstalled(id) ? probe.error : state.error;
  }
  return {
    ...state,
    installed: cliToolInstalled(id),
    path: toolBinaryPath(id),
  };
}

export async function installCliTool(id: CliToolId): Promise<void> {
  const definition = TOOL_DEFS.find((item) => item.id === id);
  const state = states.get(id);
  if (!definition || !state) throw new Error(`未知 CLI 工具：${id}`);
  if (state.downloading) throw new Error('工具正在下载');

  state.downloading = true;
  state.error = null;
  state.bytesDone = 0;
  state.bytesTotal = 0;
  try {
    fs.mkdirSync(toolDir(id), { recursive: true });
    const release = await fetchLatestRelease(definition.repository);
    const asset = release.assets.find((item) => item.name === definition.assetName(release.tag, process.arch));
    if (!asset) throw new Error(`未找到 Android 可用包（${process.arch}）`);

    const archive = await downloadToBuffer(asset.browser_download_url, id);
    extractTarGz(archive, toolDir(id));
    const binary = findFile(toolDir(id), definition.binaryName);
    if (!binary) throw new Error('压缩包中未找到可执行文件');
    if (binary !== toolBinaryPath(id)) {
      fs.renameSync(binary, toolBinaryPath(id));
    }
    fs.chmodSync(toolBinaryPath(id), 0o755);

    const probe = await probeCliTool(id);
    state.version = probe.version;
    state.error = probe.error;
    if (!probe.version) throw new Error(probe.error || '安装后无法执行');
  } catch (error) {
    state.error = String((error as Error).message || error);
  } finally {
    state.downloading = false;
  }
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

async function fetchLatestRelease(repository: string): Promise<{ tag: string; assets: ReleaseAsset[] }> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Synaps-App' },
  });
  if (!response.ok) throw new Error(`获取版本失败（HTTP ${response.status}）`);
  const data = await response.json() as { tag_name?: string; assets?: ReleaseAsset[] };
  if (!data.tag_name) throw new Error('版本信息无效');
  return { tag: data.tag_name, assets: data.assets || [] };
}

function downloadToBuffer(url: string, id: CliToolId): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = (target: string): void => {
      https.get(target, {
        headers: { 'User-Agent': 'Synaps/1.0', Accept: '*/*' },
      }, (response: IncomingMessage) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`下载失败（HTTP ${response.statusCode || 'unknown'}）`));
          return;
        }
        const chunks: Buffer[] = [];
        const total = Number(response.headers['content-length']) || 0;
        let done = 0;
        response.on('data', (chunk: Buffer) => {
          done += chunk.length;
          chunks.push(chunk);
          const state = states.get(id)!;
          state.bytesDone = done;
          state.bytesTotal = total;
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

function extractTarGz(archive: Buffer, destination: string): void {
  let data: Buffer;
  try {
    data = zlib.gunzipSync(archive);
  } catch {
    throw new Error('压缩包解压失败');
  }

  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const mode = Number.parseInt(readTarString(header, 100, 8).trim() || '644', 8) || 0o644;
    offset += 512;
    const contentEnd = offset + size;
    const normalized = path.normalize(name).replace(/^(\.\.(\/|\\|$))+/, '');
    const target = path.resolve(destination, normalized);
    if (!target.startsWith(path.resolve(destination) + path.sep)) {
      throw new Error('压缩包包含不安全路径');
    }

    if ((type === '0' || type === '\0') && !name.endsWith('/')) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data.subarray(offset, contentEnd));
      fs.chmodSync(target, mode & 0o777);
    }
    offset = contentEnd + (512 - (contentEnd % 512)) % 512;
  }
}

function readTarString(header: Buffer, offset: number, length: number): string {
  return header.subarray(offset, offset + length).toString('utf8').split('\0')[0];
}

function findFile(directory: string, fileName: string): string | null {
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile() && entry.name === fileName) return child;
    }
  }
  return null;
}

export const CLI_TOOL_IDS = TOOL_DEFS.map((definition) => definition.id);
export type CliToolStatusResponse = Awaited<ReturnType<typeof getCliToolStatus>>;
