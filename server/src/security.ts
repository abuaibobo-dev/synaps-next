import * as fs from 'fs';
import * as path from 'path';

export interface SecurityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  rule: string;
  file: string;
  line: number;
  message: string;
  snippet: string;
}

interface SecurityRule {
  id: string;
  severity: SecurityIssue['severity'];
  pattern: RegExp;
  message: string;
}

const RULES: SecurityRule[] = [
  {
    id: 'hardcoded_secret',
    severity: 'critical',
    pattern: /(?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key)\s*[:=]\s*['"`][A-Za-z0-9_\-.]{12,}['"`]/i,
    message: '硬编码的密钥/口令，应移入环境变量或密钥管理服务',
  },
  {
    id: 'eval_exec',
    severity: 'high',
    pattern: /\b(?:eval|exec|system|shell_exec|popen|child_process)\s*\(/,
    message: '动态执行代码/命令，可能被注入攻击利用',
  },
  {
    id: 'sql_injection',
    severity: 'high',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+[\s\S]{0,120}?\+\s*[^;'"\n]*/i,
    message: '字符串拼接 SQL，存在注入风险（应使用参数化查询）',
  },
  {
    id: 'command_injection',
    severity: 'high',
    pattern: /(?:exec|spawn|system|execSync)\([^)]*(?:req\.|query\.|body\.|params\.)/,
    message: '命令执行拼接了外部输入，存在命令注入风险',
  },
  {
    id: 'path_traversal',
    severity: 'high',
    pattern: /(?:readFile|readFileSync|writeFile|writeFileSync|join|resolve)\([^)]*(?:req\.|query\.|body\.|params\.)/,
    message: '文件路径来自外部输入，存在路径穿越风险',
  },
  {
    id: 'unsafe_deserialize',
    severity: 'high',
    pattern: /pickle\.loads|eval\s*\(\s*(?:request|body|input|data)/,
    message: '反序列化/解析不可信数据，可能导致远程代码执行',
  },
  {
    id: 'weak_crypto',
    severity: 'medium',
    pattern: /\b(?:md5|sha1|md4|des|rc4)\s*\(/i,
    message: '使用弱加密算法，建议使用 SHA-256+ 或 bcrypt/Argon2',
  },
  {
    id: 'debug_backdoor',
    severity: 'medium',
    pattern: /console\.(?:log|debug)\([^)]*(?:password|token|secret|api[_-]?key)/i,
    message: '日志中输出敏感信息',
  },
  {
    id: 'fixed_random',
    severity: 'medium',
    pattern: /Math\.random\(\).{0,60}(?:password|token|secret|salt|nonce)/i,
    message: '用 Math.random 生成安全相关随机值，应使用 crypto 安全随机源',
  },
  {
    id: 'insecure_http',
    severity: 'low',
    pattern: /(?:fetch|axios|XMLHttpRequest)\s*\(\s*['"`]http:\/\/(?!localhost|127\.0\.0\.1)/,
    message: '使用不加密的 HTTP 明文传输',
  },
];

const SOURCE_EXT = /\.(ts|tsx|js|jsx|py|go|rb|php|java|kt|sql)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.git', 'assets', '.expo', 'android', 'ios']);

function scanText(content: string, relFile: string, issues: SecurityIssue[], maxIssues: number): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        issues.push({
          severity: rule.severity,
          rule: rule.id,
          file: relFile,
          line: i + 1,
          message: rule.message,
          snippet: line.trim().slice(0, 120),
        });
        if (issues.length >= maxIssues) return;
      }
    }
  }
}

export function scanFile(filePath: string, maxIssues = 50): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 500 * 1024) return issues;
    const content = fs.readFileSync(filePath, 'utf-8');
    scanText(content, path.basename(filePath), issues, maxIssues);
  } catch {
    // unreadable file
  }
  return issues;
}

export function scanProject(root: string, maxFiles = 80, maxIssues = 50): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  let scanned = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 5 || scanned >= maxFiles || issues.length >= maxIssues) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (issues.length >= maxIssues) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (SOURCE_EXT.test(entry.name)) {
        if (scanned >= maxFiles) return;
        scanned++;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 500 * 1024) continue;
          const content = fs.readFileSync(full, 'utf-8');
          scanText(content, path.relative(root, full), issues, maxIssues);
        } catch {
          // skip unreadable
        }
      }
    }
  };

  walk(root, 0);
  return issues;
}

export function formatIssues(issues: SecurityIssue[]): string {
  if (issues.length === 0) return 'No security issues found.';
  const lines = [`Found ${issues.length} security issue(s):`, ''];
  for (const issue of issues.slice(0, 50)) {
    lines.push(`[${issue.severity.toUpperCase()}] ${issue.rule} at ${issue.file}:${issue.line}`);
    lines.push(`  ${issue.message}`);
    if (issue.snippet) lines.push(`  > ${issue.snippet}`);
    lines.push('');
  }
  return lines.join('\n');
}
