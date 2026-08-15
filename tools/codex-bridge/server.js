#!/usr/bin/env node
/**
 * Synaps × Codex CLI 桥接服务（Termux）
 *
 * 为什么需要它：
 * Android SELinux/uid 隔离不允许 Synaps App 进程直接执行 Termux 里的二进制，
 * 但两者都能访问 127.0.0.1 回环网络。所以在 Termux 里跑这个 HTTP 桥接，
 * Synaps 通过 127.0.0.1:19290 调用 codex exec，把它当作外部执行大脑。
 *
 * 用法（Termux 内）：
 *   pkg install nodejs -y
 *   npm i -g @openai/codex
 *   curl -L -o ~/codex-bridge.js \
 *     https://raw.githubusercontent.com/abuaibobo-dev/synaps-next/master/tools/codex-bridge/server.js
 *   node ~/codex-bridge.js &          # 建议搭配 termux-boot 开机自启
 *
 * 可选环境变量：
 *   CODEX_BRIDGE_PORT  监听端口（默认 19290）
 *   CODEX_BRIDGE_TOKEN 访问令牌，与 App「Codex CLI → 访问令牌」保持一致
 *   CODEX_BIN          codex 可执行文件路径（默认 PATH 里的 codex）
 */
'use strict';

const http = require('http');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.CODEX_BRIDGE_PORT || 19290);
const TOKEN = process.env.CODEX_BRIDGE_TOKEN || '';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const MAX_BODY = 5 * 1024 * 1024;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function binVersion(name) {
  return new Promise((resolve) => {
    execFile(name, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim().split('\n')[0]);
    });
  });
}

function codexVersion() {
  return binVersion(CODEX_BIN);
}

function parseCodexOutput(raw) {
  const lines = String(raw || '').trim().split('\n').filter(Boolean);
  const out = [];
  let lastMessage = '';
  let failed = false;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'item.completed') {
      const item = ev.item || {};
      if (item.type === 'command_execution') {
        const cmd = String(item.command || '').replace(/\s+/g, ' ').slice(0, 300);
        const body = String(item.aggregated_output || '').trim();
        out.push(`$ ${cmd}`);
        if (body) out.push(body);
        if (item.exit_code !== 0 && item.exit_code !== null) {
          out.push(`[exit ${item.exit_code}]`);
        }
      } else if (item.type === 'agent_message') {
        const text = String(item.text || '').trim();
        if (text) {
          lastMessage = text;
          out.push(text);
        }
      }
    } else if (ev.type === 'error' || ev.type === 'turn.failed') {
      failed = true;
      const msg = ev.error?.message || ev.message || JSON.stringify(ev);
      out.push(`[错误] ${msg}`);
    }
  }
  return { text: out.join('\n').trim(), lastMessage, failed };
}

function runTask(payload) {
  return new Promise((resolve) => {
    const task = String(payload.task || '').trim();
    const cwd = String(payload.cwd || os.homedir()).trim();
    const model = String(payload.model || process.env.CODEX_MODEL || 'deepseek-v4-flash').trim();
    const apiKey = String(payload.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
    const baseUrl = String(payload.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim();
    const wireApi = String(payload.wireApi || process.env.CODEX_WIRE_API || 'responses').trim();
    const timeoutMs = Math.max(10000, Number(payload.timeoutMs) || 600000);

    const workDir = fs.existsSync(cwd) ? cwd : os.homedir();

    const q = (s) => JSON.stringify(String(s));
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'danger-full-access',
      '-C', workDir,
      '-c', `model_provider=${q('deepseek')}`,
      '-c', `model=${q(model)}`,
      '-c', `model_providers.deepseek.base_url=${q(baseUrl)}`,
      '-c', `model_providers.deepseek.env_key=${q('DEEPSEEK_API_KEY')}`,
      '-c', `model_providers.deepseek.wire_api=${q(wireApi)}`,
      task,
    ];

    const child = spawn(CODEX_BIN, args, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey || process.env.DEEPSEEK_API_KEY || '',
      },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        exitCode: -1,
        timedOut: true,
        output: `[超时] codex 执行超过 ${Math.round(timeoutMs / 1000)}s 已被终止`,
        lastMessage: '',
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        output: `[无法启动 codex] ${err.message}。请确认已在 Termux 执行：npm i -g @openai/codex`,
        lastMessage: '',
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseCodexOutput(stdout);
      const errTail = String(stderr || '')
        .split('\n')
        .filter((l) => !l.includes('Reading additional input from stdin'))
        .join('\n')
        .trim()
        .slice(-2000);
      let output = parsed.text || errTail;
      if (!output) output = '(无输出)';
      if (errTail && !parsed.text.includes(errTail)) output += `\n[stderr] ${errTail}`;
      resolve({
        exitCode: code,
        timedOut: false,
        output,
        lastMessage: parsed.lastMessage,
        failed: parsed.failed || code !== 0,
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const respond = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  // 令牌校验（仅当设置了 CODEX_BRIDGE_TOKEN）
  if (TOKEN && !safeEqual(req.headers['x-codex-token'], TOKEN)) {
    return respond(401, { error: 'x-codex-token 不匹配，请在 Synaps 设置里配置相同的访问令牌' });
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/status') {
    const ver = await codexVersion();
    const claudeVer = await binVersion('claude');
    return respond(200, {
      ok: true,
      service: 'synaps-codex-bridge',
      codexVersion: ver || '(codex 未安装)',
      claudeVersion: claudeVer || null,
      nodeVersion: process.version,
      pid: process.pid,
      cwd: process.cwd(),
      uptime: Math.round(process.uptime()),
    });
  }

  if (req.method === 'POST' && url.pathname === '/run') {
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return respond(400, { error: e.message });
    }
    if (!String(payload.task || '').trim()) {
      return respond(400, { error: 'task 不能为空' });
    }
    log(`run: task=${String(payload.task).slice(0, 80)} cwd=${payload.cwd || '(home)'}`);
    const result = await runTask(payload);
    log(`done: exit=${result.exitCode} timedOut=${result.timedOut}`);
    return respond(200, result);
  }

  return respond(404, { error: 'not found（仅支持 GET /status 与 POST /run）' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Synaps Codex 桥接已启动：http://127.0.0.1:${PORT}`);
  log(`codex 可执行文件：${CODEX_BIN}`);
  log(TOKEN ? '已启用令牌校验（x-codex-token）' : '警告：未设置 CODEX_BRIDGE_TOKEN，仅监听本机回环，风险可控但建议设置');
});
