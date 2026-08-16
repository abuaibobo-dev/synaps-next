/**
 * 内置图表生成器（diagram-design 风格：编辑级、灰白中性、无阴影 Mermaid 感）
 *
 * 参考 cathrynlavery/diagram-design（MIT）的设计取向：
 * - 每张图只讲一件事，节点克制（密度 4/10）
 * - 编辑级排版：留白、层级、对齐
 * - 深色优先的中性配色（在聊天卡片中两种主题都清晰）
 *
 * 支持类型：flowchart / architecture / sequence / erd / dependency / roadmap / timeline / swimlane
 */

export interface DiagramNode {
  id: string;
  label: string;
  kind?: 'start' | 'end' | 'process' | 'decision' | 'data';
  layer?: string; // architecture: 层级分组
  lane?: string; // swimlane: 泳道分组
  fields?: string[]; // erd: 字段列表
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  type: string;
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const W = 860;
const INK = '#E8E8EC';
const INK_DIM = '#A0A0A4';
const CARD = '#1A1A1A';
const CARD_ALT = '#242424';
const STROKE = '#3A3A3A';
const ACCENT = '#555555';
const BAND = '#16161A';

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapLabel(s: string, max = 16): string[] {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const out: string[] = [];
  for (const part of clean.split('\n')) {
    let line = '';
    for (const ch of part) {
      if (line.length >= max) {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out.slice(0, 3);
}

function textLines(x: number, y: number, lines: string[], size = 12, fill = INK, anchor: 'middle' | 'start' = 'middle'): string {
  return lines
    .map((ln, i) => `<text x="${x}" y="${y + i * (size + 3)}" font-family="system-ui, sans-serif" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${esc(ln)}</text>`)
    .join('\n');
}

function box(x: number, y: number, w: number, h: number, label: string, opts: { kind?: string; fill?: string; stroke?: string } = {}): string {
  const fill = opts.fill || CARD;
  const stroke = opts.stroke || STROKE;
  const rx = opts.kind === 'start' || opts.kind === 'end' ? h / 2 : 6;
  const lines = wrapLabel(label, Math.max(8, Math.floor(w / 13)));
  const cy = y + h / 2 - ((lines.length - 1) * 15) / 2;
  return `<g>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>
${textLines(x + w / 2, cy, lines, 12, opts.kind === 'data' ? INK_DIM : INK)}
</g>`;
}

function diamond(x: number, y: number, w: number, h: number, label: string): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const lines = wrapLabel(label, 10);
  return `<g>
<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="${CARD}" stroke="${ACCENT}" stroke-width="1.2"/>
${textLines(cx, cy - ((lines.length - 1) * 13) / 2, lines, 11, INK)}
</g>`;
}

function arrow(x1: number, y1: number, x2: number, y2: number, label?: string): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  let labelSvg = '';
  if (label) {
    const lines = wrapLabel(label, 18);
    labelSvg = textLines(mx, my - 6, lines, 10, INK_DIM);
  }
  return `<g>
<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#8A8A8A" stroke-width="1.2" marker-end="url(#arr)"/>
${labelSvg}
</g>`;
}

function defs(): string {
  return `<defs>
<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M 0 0 L 10 5 L 0 10 z" fill="#8A8A8A"/>
</marker>
</defs>`;
}

function frame(title: string | undefined, innerW: number, innerH: number, body: string): string {
  const pad = 32;
  const titleH = title ? 56 : 24;
  const totalH = titleH + innerH + pad;
  const titleSvg = title
    ? textLines(W / 2, 30, [title], 16, INK)
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
${defs()}
<rect x="0" y="0" width="${W}" height="${totalH}" fill="#0D0D0D"/>
${titleSvg}
<g transform="translate(${(W - innerW) / 2}, ${titleH})">
${body}
</g>
</svg>`;
}

function nodeCenter(id: string, pos: Record<string, { x: number; y: number; w: number; h: number }>) {
  const p = pos[id];
  return p ? { cx: p.x + p.w / 2, cy: p.y + p.h / 2, x: p.x, y: p.y, w: p.w, h: p.h } : null;
}

export function generateDiagramSVG(spec: DiagramSpec): string {
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  const type = String(spec.type || 'flowchart').toLowerCase();
  const title = spec.title || '';

  switch (type) {
    case 'architecture':
      return layoutArchitecture(title, nodes, edges);
    case 'sequence':
      return layoutSequence(title, nodes, edges);
    case 'erd':
      return layoutErd(title, nodes, edges);
    case 'dependency':
      return layoutDependency(title, nodes, edges);
    case 'roadmap':
      return layoutRoadmap(title, nodes);
    case 'timeline':
      return layoutTimeline(title, nodes);
    case 'swimlane':
      return layoutSwimlane(title, nodes, edges);
    case 'flowchart':
    default:
      return layoutFlowchart(title, nodes, edges);
  }
}

function layoutFlowchart(title: string, nodes: DiagramNode[], edges: DiagramEdge[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '<text x="100" y="30" fill="#A0A0A4" font-size="12" font-family="system-ui">空图</text>');
  // 拓扑排序
  const indeg: Record<string, number> = {};
  for (const n of nodes) indeg[n.id] = 0;
  for (const e of edges) if (indeg[e.to] !== undefined) indeg[e.to] += 1;
  const order: string[] = [];
  const q = nodes.filter((n) => (indeg[n.id] || 0) === 0).map((n) => n.id);
  const qset = new Set(q);
  while (q.length) {
    const id = q.shift()!;
    order.push(id);
    for (const e of edges) {
      if (e.from === id && !qset.has(e.to) && !order.includes(e.to)) {
        indeg[e.to] -= 1;
        if (indeg[e.to] <= 0) { q.push(e.to); qset.add(e.to); }
      }
    }
  }
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);

  const bw = 240;
  const bh = 48;
  const gapY = 66;
  const innerH = order.length * gapY + bh;
  const pos: Record<string, { x: number; y: number; w: number; h: number }> = {};
  order.forEach((id, i) => {
    const n = nodes.find((x) => x.id === id);
    if (n?.kind === 'decision') pos[id] = { x: 0, y: i * gapY, w: 120, h: 90 };
    else pos[id] = { x: 0, y: i * gapY, w: bw, h: bh };
  });
  // 居中
  const maxW = Math.max(...order.map((id) => pos[id].w));
  for (const id of order) pos[id].x = (maxW - pos[id].w) / 2;

  const parts: string[] = [];
  for (const e of edges) {
    const a = nodeCenter(e.from, pos);
    const b = nodeCenter(e.to, pos);
    if (a && b) parts.push(arrow(a.cx, a.y + a.h, b.cx, b.y, e.label));
  }
  for (const id of order) {
    const p = pos[id];
    const n = nodes.find((x) => x.id === id);
    if (n?.kind === 'decision') parts.push(diamond(p.x, p.y, p.w, p.h, n.label));
    else parts.push(box(p.x, p.y, p.w, p.h, n?.label || id, { kind: n?.kind }));
  }
  return frame(title, maxW, innerH, parts.join('\n'));
}

function layoutArchitecture(title: string, nodes: DiagramNode[], edges: DiagramEdge[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '');
  const layers = [...new Set(nodes.map((n) => n.layer || '核心层'))];
  const bw = 200;
  const bh = 46;
  const gapX = 24;
  const bandH = 104;
  const bandGap = 26;
  const innerH = layers.length * bandH + (layers.length - 1) * bandGap + 10;
  let maxW = 0;
  const pos: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const parts: string[] = [];
  layers.forEach((layer, li) => {
    const items = nodes.filter((n) => (n.layer || '核心层') === layer);
    const rowW = items.length * bw + (items.length - 1) * gapX;
    maxW = Math.max(maxW, rowW);
    const bandY = li * (bandH + bandGap);
    parts.push(`<rect x="0" y="${bandY}" width="${rowW}" height="${bandH}" rx="8" fill="${BAND}" stroke="${STROKE}" stroke-width="1"/>`);
    parts.push(textLines(10, bandY + 16, [layer], 10, INK_DIM, 'start'));
    items.forEach((n, i) => {
      const x = i * (bw + gapX);
      const y = bandY + 26;
      pos[n.id] = { x, y, w: bw, h: bh };
      parts.push(box(x, y, bw, bh, n.label));
    });
  });
  for (const e of edges) {
    const a = nodeCenter(e.from, pos);
    const b = nodeCenter(e.to, pos);
    if (a && b) parts.push(arrow(a.cx, a.y + a.h, b.cx, b.y, e.label));
  }
  return frame(title, maxW, innerH, parts.join('\n'));
}

function layoutSequence(title: string, nodes: DiagramNode[], edges: DiagramEdge[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '');
  const lifelines = nodes;
  const bw = 150;
  const topH = 66;
  const stepH = 58;
  const parts: string[] = [];
  const pos: Record<string, { x: number; y: number; w: number; h: number }> = {};
  lifelines.forEach((n, i) => {
    pos[n.id] = { x: i * (bw + 24), y: 8, w: bw, h: 34 };
  });
  const innerH = topH + edges.length * stepH + 30;
  // 顶部参与者
  for (const n of lifelines) {
    const p = pos[n.id];
    parts.push(box(p.x, p.y, p.w, p.h, n.label, { kind: 'start' }));
    parts.push(`<line x1="${p.x + p.w / 2}" y1="${p.y + p.h}" x2="${p.x + p.w / 2}" y2="${innerH}" stroke="${STROKE}" stroke-dasharray="4 4"/>`);
  }
  edges.forEach((e, i) => {
    const a = nodeCenter(e.from, pos);
    const b = nodeCenter(e.to, pos);
    if (!a || !b) return;
    const y = topH + i * stepH + 10;
    const x1 = a.cx;
    const x2 = b.cx;
    const dir = x2 >= x1 ? 1 : -1;
    parts.push(`<line x1="${x1}" y1="${y}" x2="${x2 - dir * 6}" y2="${y}" stroke="#8A8A8A" stroke-width="1.2" marker-end="url(#arr)"/>`);
    if (e.label) {
      const lx = dir === 1 ? x1 + 8 : x2 + 8;
      const anchor = dir === 1 ? 'start' : 'end';
      parts.push(`<text x="${lx}" y="${y - 6}" font-family="system-ui" font-size="10" fill="${INK_DIM}" text-anchor="${anchor}">${esc(e.label)}</text>`);
      const num = String(i + 1).padStart(2, '0');
      parts.push(`<text x="${(x1 + x2) / 2}" y="${y - 6}" font-family="monospace" font-size="9" fill="${ACCENT}" text-anchor="middle">${num}</text>`);
    }
  });
  return frame(title, lifelines.length * (bw + 24) - 24, innerH, parts.join('\n'));
}

function layoutErd(title: string, nodes: DiagramNode[], edges: DiagramEdge[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '');
  const bw = 240;
  const headerH = 30;
  const colGap = 60;
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const rowH = (n: DiagramNode) => headerH + (n.fields?.length || 2) * 20 + 12;
  const positions: Array<{ n: DiagramNode; x: number; y: number; w: number; h: number }> = [];
  let y = 0;
  let maxRowH = 0;
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    if (col === 0 && i > 0) { y += maxRowH + 40; maxRowH = 0; }
    const h = rowH(n);
    const x = col * (bw + colGap);
    positions.push({ n, x, y, w: bw, h });
    maxRowH = Math.max(maxRowH, h);
  });
  const totalH = y + maxRowH + 40;
  const innerW = cols * (bw + colGap) - colGap;
  const pos: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const parts: string[] = [];
  for (const p of positions) {
    pos[p.n.id] = { x: p.x, y: p.y, w: p.w, h: p.h };
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6" fill="${CARD}" stroke="${STROKE}" stroke-width="1.2"/>`);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${headerH}" rx="6" fill="${CARD_ALT}"/>`);
    parts.push(textLines(p.x + 10, p.y + 19, [p.n.label], 12, INK, 'start'));
    (p.n.fields || []).forEach((f, fi) => {
      parts.push(textLines(p.x + 10, p.y + headerH + 18 + fi * 20, [f], 10, INK_DIM, 'start'));
    });
  }
  for (const e of edges) {
    const a = nodeCenter(e.from, pos);
    const b = nodeCenter(e.to, pos);
    if (a && b) parts.push(arrow(a.cx, a.y + a.h, b.cx, b.y, e.label));
  }
  return frame(title, innerW, totalH, parts.join('\n'));
}

function layoutDependency(title: string, nodes: DiagramNode[], edges: DiagramEdge[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '');
  const bw = 210;
  const bh = 44;
  const cols = 3;
  const gapX = 36;
  const gapY = 70;
  const pos: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const parts: string[] = [];
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    pos[n.id] = { x: col * (bw + gapX), y: row * gapY, w: bw, h: bh };
    parts.push(box(pos[n.id].x, pos[n.id].y, bw, bh, n.label, { kind: n.kind === 'data' ? 'data' : 'process' }));
  });
  for (const e of edges) {
    const a = nodeCenter(e.from, pos);
    const b = nodeCenter(e.to, pos);
    if (a && b) parts.push(arrow(a.cx, a.y + a.h, b.cx, b.y, e.label));
  }
  const rows = Math.ceil(nodes.length / cols);
  return frame(title, cols * (bw + gapX) - gapX, rows * gapY + bh, parts.join('\n'));
}

function layoutRoadmap(title: string, nodes: DiagramNode[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '');
  const bw = 180;
  const gapX = 40;
  const lineY = 70;
  const innerW = nodes.length * (bw + gapX) - gapX;
  const innerH = 170;
  const parts: string[] = [];
  parts.push(`<line x1="0" y1="${lineY}" x2="${innerW}" y2="${lineY}" stroke="${STROKE}" stroke-width="1.5"/>`);
  nodes.forEach((n, i) => {
    const cx = i * (bw + gapX) + bw / 2;
    parts.push(`<circle cx="${cx}" cy="${lineY}" r="6" fill="${ACCENT}" stroke="${INK}" stroke-width="1.2"/>`);
    const above = i % 2 === 0;
    const ty = above ? lineY - 16 : lineY + 26;
    const lines = wrapLabel(n.label, 18);
    parts.push(textLines(cx, ty, lines, 11, INK));
  });
  return frame(title, innerW, innerH, parts.join('\n'));
}

function layoutTimeline(title: string, nodes: DiagramNode[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '');
  const stepH = 96;
  const innerH = nodes.length * stepH + 30;
  const lineX = 30;
  const parts: string[] = [];
  parts.push(`<line x1="${lineX}" y1="10" x2="${lineX}" y2="${innerH - 20}" stroke="${STROKE}" stroke-width="1.5"/>`);
  nodes.forEach((n, i) => {
    const cy = 24 + i * stepH;
    parts.push(`<circle cx="${lineX}" cy="${cy}" r="5" fill="${ACCENT}" stroke="${INK}" stroke-width="1.2"/>`);
    const lines = wrapLabel(n.label, 42);
    parts.push(textLines(lineX + 22, cy - ((lines.length - 1) * 13) / 2, lines, 12, INK, 'start'));
    if (n.layer) {
      parts.push(`<text x="${lineX + 22}" y="${cy + 18 + ((lines.length - 1) * 13) / 2}" font-family="system-ui" font-size="10" fill="${INK_DIM}" text-anchor="start">${esc(n.layer)}</text>`);
    }
  });
  return frame(title, 520, innerH, parts.join('\n'));
}

function layoutSwimlane(title: string, nodes: DiagramNode[], edges: DiagramEdge[]): string {
  if (nodes.length === 0) return frame(title, 200, 60, '');
  const lanes = [...new Set(nodes.map((n) => n.lane || '流程'))];
  const bw = 170;
  const bh = 42;
  const gapX = 30;
  const laneH = 96;
  const laneGap = 24;
  const perLane = Math.max(...lanes.map((l) => nodes.filter((n) => (n.lane || '流程') === l).length));
  const innerW = perLane * (bw + gapX) + 140;
  const innerH = lanes.length * laneH + (lanes.length - 1) * laneGap;
  const pos: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const parts: string[] = [];
  lanes.forEach((lane, li) => {
    const laneY = li * (laneH + laneGap);
    parts.push(`<rect x="0" y="${laneY}" width="${innerW}" height="${laneH}" rx="8" fill="${BAND}" stroke="${STROKE}" stroke-width="1"/>`);
    parts.push(`<text x="14" y="${laneY + 24}" font-family="system-ui" font-size="10" fill="${INK_DIM}" text-anchor="start">${esc(lane)}</text>`);
    const items = nodes.filter((n) => (n.lane || '流程') === lane);
    items.forEach((n, i) => {
      const x = 140 + i * (bw + gapX);
      const y = laneY + 34;
      pos[n.id] = { x, y, w: bw, h: bh };
      parts.push(box(x, y, bw, bh, n.label));
    });
  });
  for (const e of edges) {
    const a = nodeCenter(e.from, pos);
    const b = nodeCenter(e.to, pos);
    if (a && b) parts.push(arrow(a.cx, a.y + a.h, b.cx, b.y, e.label));
  }
  return frame(title, innerW, innerH, parts.join('\n'));
}
