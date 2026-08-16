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
      if (!st.installed) {
        throw new Error('specify-cli 未安装（Termux：pip install specify-cli），无法生成技术方案；可先由 Agent 直接在 docs/specs 中补充方案');
      }
      const task = String(opts.requirement || opts.title || '');
      return runCli(cwd, task ? ['plan', task] : ['plan']);
    }

    case 'tasks':
      if (!st.installed) throw new Error('specify-cli 未安装（Termux：pip install specify-cli）');
      return runCli(cwd, ['tasks']);

    case 'implement':
      if (!st.installed) throw new Error('specify-cli 未安装（Termux：pip install specify-cli）');
      return runCli(cwd, ['implement']);

    case 'test':
      if (!st.installed) throw new Error('specify-cli 未安装（Termux：pip install specify-cli）');
      return runCli(cwd, ['test']);

    default:
      return `支持的 action：status / init / spec / plan / tasks / implement / test。当前 ${cliHint}`;
  }
}
