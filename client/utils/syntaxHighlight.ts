// 轻量语法高亮：按扩展名识别语言，逐行做注释/字符串/关键字/数字/类型着色。
// 不依赖 highlight.js，保证 Metro bundle 体积与渲染性能。

export type HighlightToken = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'type' | 'function';

export interface HighlightSegment {
  text: string;
  token: HighlightToken;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  py: 'py',
  kt: 'kt', java: 'kt', gradle: 'kt',
  json: 'json', xml: 'xml', html: 'xml', yml: 'yaml', yaml: 'yaml', css: 'css',
  sql: 'sql', sh: 'bash', bash: 'bash', md: 'md', txt: 'plaintext', c: 'c', cpp: 'c', h: 'c',
};

export function getLanguageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_LANG[ext] || 'plaintext';
}

const KEYWORDS: Record<string, string[]> = {
  ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'yield', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'static', 'get', 'set', 'null', 'undefined', 'true', 'false', 'void', 'never', 'unknown', 'any', 'string', 'number', 'boolean', 'object', 'array', 'Record', 'keyof', 'as', 'is', 'satisfies', 'namespace', 'declare', 'abstract', 'override'],
  py: ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass', 'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'global', 'nonlocal', 'assert', 'del', 'not', 'and', 'or', 'is', 'in', 'None', 'True', 'False', 'async', 'await'],
  kt: ['fun', 'val', 'var', 'return', 'if', 'else', 'when', 'for', 'while', 'do', 'break', 'continue', 'class', 'object', 'interface', 'extends', 'super', 'this', 'import', 'package', 'private', 'public', 'protected', 'internal', 'override', 'open', 'abstract', 'sealed', 'data', 'enum', 'null', 'true', 'false', 'is', 'as', 'in', 'try', 'catch', 'finally', 'throw', 'companion', 'init', 'constructor', 'suspend', 'fun', 'lateinit', 'by'],
  json: ['true', 'false', 'null'],
  sql: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'CREATE', 'TABLE', 'INDEX', 'ALTER', 'ADD', 'DROP', 'VALUES', 'SET', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT', 'UNIQUE', 'IF', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'TRUE', 'FALSE'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'local', 'export', 'echo', 'exit', 'cd', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'sudo', 'apt', 'pkg', 'npm', 'pnpm', 'git', 'true', 'false'],
  md: [],
  c: ['int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'struct', 'union', 'enum', 'typedef', 'const', 'static', 'extern', 'volatile', 'register', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'goto', 'sizeof', 'NULL', 'true', 'false', 'include', 'define'],
  css: ['@media', '@import', '@keyframes', 'important'],
};

const TYPE_TOKENS: Record<string, string[]> = {
  ts: ['string', 'number', 'boolean', 'void', 'never', 'unknown', 'any', 'object', 'Promise', 'Record', 'Map', 'Set', 'Array', 'Readonly'],
  kt: ['Int', 'Long', 'Float', 'Double', 'String', 'Boolean', 'Unit', 'Any', 'List', 'Map', 'Set', 'Array', 'Byte', 'Short'],
  c: ['int', 'char', 'float', 'double', 'long', 'short', 'void', 'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t'],
};

export function getKeywords(lang: string): string[] {
  return KEYWORDS[lang] || [];
}

export function getTypeTokens(lang: string): string[] {
  return TYPE_TOKENS[lang] || [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 高亮一行代码，返回分段。
 */
export function highlightLine(line: string, lang: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const rest = line;

  const isLineComment = (l: string) => {
    if (lang === 'py' || lang === 'bash' || lang === 'yaml') return l.trim().startsWith('#');
    if (lang === 'sql' || lang === 'c') return l.trim().startsWith('//') || l.trim().startsWith('--') || l.trim().startsWith('/*');
    return l.trim().startsWith('//') || l.trim().startsWith('/*');
  };

  const consumeComment = (l: string): string => {
    const idx = l.indexOf('*/');
    const end = idx === -1 ? l.length : idx + 2;
    segments.push({ text: l.slice(0, end), token: 'comment' });
    return l.slice(end);
  };

  if (isLineComment(rest)) {
    segments.push({ text: rest, token: 'comment' });
    return segments;
  }

  const keywords = new Set(getKeywords(lang));
  const types = new Set(getTypeTokens(lang));
  const tokenRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\b\d+(?:\.\d+)?\b|[a-z_$][\w$]*/gi;

  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = tokenRe.exec(rest)) !== null) {
    if (m.index > last) {
      segments.push({ text: rest.slice(last, m.index), token: 'plain' });
    }
    const raw = m[0];
    if (raw.startsWith('/*')) {
      segments.push({ text: raw, token: 'comment' });
    } else if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith('`')) {
      segments.push({ text: raw, token: 'string' });
    } else if (/^\d/.test(raw)) {
      segments.push({ text: raw, token: 'number' });
    } else if (keywords.has(raw)) {
      segments.push({ text: raw, token: 'keyword' });
    } else if (types.has(raw)) {
      segments.push({ text: raw, token: 'type' });
    } else if (/^[A-Z]/.test(raw) && /^\w+$/.test(raw) && !keywords.has(raw) && !types.has(raw)) {
      segments.push({ text: raw, token: 'function' });
    } else {
      segments.push({ text: raw, token: 'plain' });
    }
    last = m.index + raw.length;
  }
  if (last < rest.length) {
    segments.push({ text: rest.slice(last), token: 'plain' });
  }

  // 处理行内 /* ... */ 多行注释（简化：整行剩余都当注释）
  if (segments.some((s) => s.token === 'comment')) {
    return segments;
  }

  return segments.length === 0 ? [{ text: line, token: 'plain' }] : segments;
}
