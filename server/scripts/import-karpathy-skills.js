#!/usr/bin/env node
/**
 * Karpathy Skills 导入脚本
 * 扫描目录下的 Agent Skills 格式技能（<dir>/SKILL.md），转换为 Synaps 技能格式，
 * 通过 POST /api/v1/skills/import 写入 Synaps 技能系统。
 *
 * 用法：
 *   node scripts/import-karpathy-skills.js <skills-dir> [base-url]
 *   例： node scripts/import-karpathy-skills.js /tmp/ks1 http://127.0.0.1:9091
 */
import fs from 'fs';
import path from 'path';

const dir = process.argv[2];
const baseUrl = (process.argv[3] || 'http://127.0.0.1:9091').replace(/\/+$/, '');

if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node scripts/import-karpathy-skills.js <skills-dir> [base-url]');
  process.exit(1);
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { metadata: {}, content: raw.trim() };
  const fm = match[1];
  const metadata = {};
  let key = null;
  let value = null;
  const lines = fm.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*$/.test(line)) continue;
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem) {
      if (key && Array.isArray(metadata[key])) {
        metadata[key].push(listItem[1].replace(/^["']|["']$/g, ''));
      }
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      value = kv[2].replace(/^["']|["']$/g, '');
      if (value === '') {
        metadata[key] = [];
      } else {
        metadata[key] = value;
      }
    }
  }
  return { metadata, content: raw.slice(match[0].length).trim() };
}

const skills = [];
const entries = fs.readdirSync(dir, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const skillFile = path.join(dir, entry.name, 'SKILL.md');
  if (!fs.existsSync(skillFile)) continue;

  const raw = fs.readFileSync(skillFile, 'utf-8');
  const { metadata, content } = parseFrontmatter(raw);

  const referencesDir = path.join(dir, entry.name, 'references');
  let referencesText = '';
  if (fs.existsSync(referencesDir)) {
    for (const ref of fs.readdirSync(referencesDir)) {
      const refPath = path.join(referencesDir, ref);
      if (fs.statSync(refPath).isFile() && ref.endsWith('.md')) {
        referencesText += `\n\n### references/${ref}\n\n${fs.readFileSync(refPath, 'utf-8').trim()}`;
      }
    }
  }

  skills.push({
    name: metadata.name || entry.name,
    description: metadata.description || '',
    content: content + referencesText,
    metadata: {
      related_skills: metadata.related_skills || [],
      disable_model_invocation: metadata['disable-model-invocation'],
      user_invocable: metadata['user-invocable'],
    },
    source: 'pure-ai/andrej-karpathy-skills (LearnPrompt fork)',
  });
  console.log(`✔ ${metadata.name || entry.name} (${content.length} chars)`);
}

if (skills.length === 0) {
  console.error('未找到任何 SKILL.md');
  process.exit(1);
}

const resp = await fetch(`${baseUrl}/api/v1/skills/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ skills }),
});
const data = await resp.json();
if (!resp.ok) {
  console.error('导入失败:', JSON.stringify(data));
  process.exit(1);
}
console.log(`\n✅ 导入完成：${data.imported} 个技能 → ${baseUrl}/api/v1/skills`);
