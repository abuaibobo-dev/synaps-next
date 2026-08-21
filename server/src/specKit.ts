/**
 * Spec-Kit 集成（github.com/github/spec-kit，Spec-Driven Development）
 *
 * 真实安装方式（注意：不是 npm，是 Python CLI）：
 *   Termux:  pip install specify-cli      （或 uv tool install specify-cli）
 * 核心命令：specify init / plan / tasks / implement / test
 *
 * 本模块在 CLI 可用时调用 specify；CLI 未安装时退化为内置规格模板，
 * 保证「先写结构化规格 → 用户确认 → 再实现 → 按验收标准生成测试」的流程始终可用。
 */

import fs from 'fs';
import path from 'path';
import { runProcess } from './nativeProc.js';

export interface SpecKitStatus {
  installed: boolean;
  version: string | null;
  error: string | null;
}

export async function specKitStatus(): Promise<SpecKitStatus> {
  const r = await runProcess({ cmd: 'specify', args: ['--version'], timeoutMs: 15000 });
  if (r.error) return { installed: false, version: null, error: r.error };
  const version = String(r.stdout || r.stderr || '').trim().split('\n')[0] || null;
  return { installed: true, version, error: null };
}

export function specTemplate(title: string, requirement: string): string {
  const clean = String(requirement || '').trim();
  const firstLine = clean.split('\n')[0]?.slice(0, 40) || title || '未命名需求';
  return `# ${title || firstLine}

> 规格驱动开发（Spec-Driven Development）· 由 Synaps Agent 生成 · 参考 github.com/github/spec-kit
> 状态：待确认（用户确认后再进入实现阶段）

## 需求描述

${clean || '（待补充）'}

## 用户故事

- 作为 **用户**，我希望 **${firstLine}**，以便 **高效完成目标**

## 验收标准（Acceptance Criteria）

- [ ] 功能入口可见且可操作
- [ ] 核心流程按需求描述正常工作
- [ ] 输入校验与边界条件处理正确
- [ ] 错误场景有明确提示且可恢复
- [ ] 界面风格与 App 现有灰白设计一致（深色 #0D0D0D / #1A1A1A / #2A2A2A，浅色 #F5F5F5 / #FFFFFF）

## 边界条件与异常

- 空输入 / 超长输入 / 特殊字符
- 网络中断 / 后端不可用
- 重复提交 / 并发操作

## 约束

- 技术栈与当前项目保持一致
- 不引入不必要的依赖
- 关键操作写入审计日志

## 技术方案（待确认）

- （实现前由 Agent 给出方案，等待用户确认）

## 任务拆分

- [ ] 1. 实现
- [ ] 2. 自测
- [ ] 3. 对照验收标准生成测试用例
- [ ] 4. 用户验收
`;
}

function slugify(s: string): string {
  return String(s || 'spec')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'spec';
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

async function runCli(cwd: string, args: string[], timeoutMs = 120000): Promise<string> {
  const r = await runProcess({ cmd: 'specify', args, cwd, timeoutMs });
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  if (r.error && !r.stdout && !r.stderr) {
    throw new Error(`specify 启动失败：${r.error}`);
  }
  if (r.timedOut) {
    throw new Error(`specify 执行超时（${Math.round(timeoutMs / 1000)}s）`);
  }
  if (r.exitCode !== 0 && !out) {
    throw new Error(`specify 执行失败（exit ${r.exitCode}）`);
  }
  return out || `(specify 执行完成，exit ${r.exitCode})`;
}

function listSpecFiles(cwd: string): string[] {
  const dir = path.join(cwd, 'docs', 'specs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !name.endsWith('.tasks.md') && !name.endsWith('.tests.md'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function resolveSpecFile(cwd: string, title?: string): string {
  const files = listSpecFiles(cwd);
  if (files.length === 0) throw new Error('未找到规格文档，请先执行 spec_kit spec');
  if (title) {
    const matched = files.find((file) => path.basename(file) === `${slugify(title)}.md`);
    if (matched) return matched;
  }
  return files[0];
}

function sectionRange(content: string, heading: string): { start: number; end: number } | null {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = content.indexOf('\n', start);
  const next = content.indexOf('\n## ', bodyStart + 1);
  return { start, end: next < 0 ? content.length : next };
}

function replaceSection(content: string, heading: string, body: string): string {
  const range = sectionRange(content, heading);
  const block = `## ${heading}\n\n${body.trim()}\n\n`;
  if (!range) return `${content.trimEnd()}\n\n${block}`;
  return content.slice(0, range.start) + block + content.slice(range.end).replace(/^\n/, '');
}

function extractList(content: string, heading: string): string[] {
  const range = sectionRange(content, heading);
  if (!range) return [];
  const bodyStart = content.indexOf('\n', range.start) + 1;
  const body = content.slice(bodyStart, range.end);
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\[[ xX]\]\s*/, ''));
}

function setSpecStatus(content: string, status: string): string {
  const statusStart = content.indexOf('> 状态：');
  if (statusStart < 0) return content;
  const lineEnd = content.indexOf('\n', statusStart);
  return content.slice(0, statusStart) + `> 状态：${status}` + (lineEnd < 0 ? '' : content.slice(lineEnd));
}

export async function runSpecKit(
  cwd: string,
  action: string,
  opts: { title?: string; requirement?: string } = {}
): Promise<string> {
  const a = String(action || 'spec').toLowerCase();
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error('spec_kit 需要先绑定项目（工作目录不存在）');
  }
  const st = await specKitStatus();
  const cliHint = st.installed
    ? `specify-cli ${st.version}`
    : 'specify-cli 未安装（Termux 执行：pip install specify-cli；未安装时使用内置规格模板）';

  switch (a) {
    case 'status':
      return JSON.stringify(st, null, 2);

    case 'init': {
      if (!st.installed) {
        ensureDir(path.join(cwd, '.specify'));
        return `specify-cli 未安装，已在项目创建 .specify/ 占位目录。安装命令：pip install specify-cli（${cliHint}）`;
      }
      const out = await runCli(cwd, ['init']);
      return out;
    }

    case 'spec': {
      const title = String(opts.title || opts.requirement || '新功能').replace(/\n/g, ' ').slice(0, 40);
      const req = String(opts.requirement || '').trim();
      if (!req) throw new Error('spec_kit spec 需要 requirement 参数（用户需求描述）');
      const dir = path.join(cwd, 'docs', 'specs');
      ensureDir(dir);
      const file = path.join(dir, `${slugify(title)}.md`);
      fs.writeFileSync(file, specTemplate(title, req), 'utf8');
      let cliOut = '';
      if (st.installed) {
        try {
          cliOut = `\n\n[specify-cli] ${await runCli(cwd, ['init'])}`;
        } catch {
          cliOut = '\n\n[specify-cli] init 失败（不影响规格文档）';
        }
      }
      return `规格文档已生成：${file}\n请先向用户展示并等待确认，确认后再进入 plan/实现。${cliOut}`;
    }

    case 'plan': {
      const title = String(opts.title || opts.requirement || '');
      const specFile = resolveSpecFile(cwd, title);
      const content = fs.readFileSync(specFile, 'utf8');
      const requirement = extractList(content, '需求描述').join(' ') || String(opts.requirement || '');
      const plan = [
        '### 目标',
        requirement || '按规格文档完成功能实现。',
        '',
        '### 技术方案',
        '- 复用当前项目架构与既有组件，不引入不必要依赖。',
        '- 先实现数据/状态层，再接入界面或入口。',
        '- 每个验收标准对应至少一个可验证操作。',
        '',
        '### 实施顺序',
        '1. 补齐数据结构与核心逻辑。',
        '2. 接入界面、API 或命令入口。',
        '3. 处理边界条件与错误提示。',
        '4. 对照验收标准自测并修复。',
        '',
        '### 风险与回滚',
        '- 修改前创建快照或提交可回滚检查点。',
        '- 若阻塞，暂停实现并在任务中记录原因。',
      ].join('\n');
      const updated = setSpecStatus(replaceSection(content, '技术方案（待确认）', plan), '方案已生成（等待确认后实现）');
      fs.writeFileSync(specFile, updated, 'utf8');
      return `技术方案已写入：${specFile}\n请确认方案；确认后执行 spec_kit tasks。`;
    }

    case 'tasks': {
      const title = String(opts.title || opts.requirement || '');
      const specFile = resolveSpecFile(cwd, title);
      const content = fs.readFileSync(specFile, 'utf8');
      const criteria = extractList(content, '验收标准（Acceptance Criteria）');
      const boundaries = extractList(content, '边界条件与异常');
      const tasksFile = specFile.replace(/\.md$/, '.tasks.md');
      const lines = [
        `# 任务拆分：${path.basename(specFile).replace(/\.md$/, '')}`,
        '',
        '## 实现任务',
        '- [ ] 建立实现分支或快照',
        '- [ ] 实现核心数据与逻辑',
        '- [ ] 接入用户入口',
        '- [ ] 处理错误与空态',
        '',
        '## 验收映射',
        ...criteria.map((item, index) => `- [ ] AC${String(index + 1).padStart(2, '0')}：${item}`),
        '',
        '## 边界测试准备',
        ...boundaries.map((item) => `- [ ] 覆盖：${item}`),
      ];
      fs.writeFileSync(tasksFile, lines.join('\n') + '\n', 'utf8');
      const updated = setSpecStatus(content, '任务已拆分（等待实现）');
      fs.writeFileSync(specFile, updated, 'utf8');
      return `任务清单已生成：${tasksFile}\n共 ${criteria.length} 条验收映射。确认后开始实现。`;
    }

    case 'implement': {
      const title = String(opts.title || opts.requirement || '');
      const specFile = resolveSpecFile(cwd, title);
      const content = fs.readFileSync(specFile, 'utf8');
      const updated = setSpecStatus(content, '实现中（Agent 使用常规编码工具执行）');
      fs.writeFileSync(specFile, updated, 'utf8');
      return `规格已进入实现状态：${specFile}\n下一步由 Agent 按任务清单修改代码；完成后执行 spec_kit test 生成验收测试清单。`;
    }

    case 'test': {
      const title = String(opts.title || opts.requirement || '');
      const specFile = resolveSpecFile(cwd, title);
      const content = fs.readFileSync(specFile, 'utf8');
      const criteria = extractList(content, '验收标准（Acceptance Criteria）');
      const boundaries = extractList(content, '边界条件与异常');
      const testFile = specFile.replace(/\.md$/, '.tests.md');
      const lines = [
        `# 验收测试：${path.basename(specFile).replace(/\.md$/, '')}`,
        '',
        '## 自动生成用例',
        ...criteria.map((item, index) => `- [ ] TC${String(index + 1).padStart(2, '0')} 验证：${item}`),
        '',
        '## 边界用例',
        ...boundaries.map((item, index) => `- [ ] TB${String(index + 1).padStart(2, '0')} 覆盖：${item}`),
        '',
        '## 执行说明',
        '- 全部通过后才标记规格为已完成。',
        '- 任一失败时回到实现阶段修复，不要跳过失败项。',
      ];
      fs.writeFileSync(testFile, lines.join('\n') + '\n', 'utf8');
      const updated = setSpecStatus(content, '待验收（测试清单已生成）');
      fs.writeFileSync(specFile, updated, 'utf8');
      return `测试用例已生成：${testFile}\n共 ${criteria.length + boundaries.length} 条用例。`;
    }

    default:
      return `支持的 action：status / init / spec / plan / tasks / implement / test。当前 ${cliHint}`;
  }
}
