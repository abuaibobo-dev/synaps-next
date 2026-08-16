import { getDb, runSql, saveDb } from './db.js';

/**
 * diagram-design 技能种子
 * 来源：github.com/cathrynlavery/diagram-design（MIT，v2.4）
 * 提取其编辑级设计取向，注入 Synaps Agent：生成图表时用 generate_diagram 工具，
 * 遵循「克制、编辑级排版、中性配色」的规范，输出 SVG 而非 Mermaid。
 */
const DIAGRAM_SKILL = {
  name: 'diagram-design',
  description:
    '图表设计审判：Agent 生成架构图/流程图/依赖图/时序图/ER图/路线图等可视化时的编辑级规范。用户要求画图时先读本技能，并使用 generate_diagram 工具产出 SVG。',
  content: `# diagram-design（图表设计审判）
来源：github.com/cathrynlavery/diagram-design（MIT v2.4，已按 Synaps 场景适配）
用途：用户要求「画架构图/流程图/依赖图/时序图/ER图/路线图/项目规划」时，先读本技能，再用 generate_diagram 工具。

## 铁律
1. 每张图只讲一件事。密度 4/10：节点克制，超过 9 个节点就拆成两张图。
2. 两个总是一起出现的节点 → 合并成一个。
3. 线条必须有信息量：关系显而易见时删掉连线。
4. 优先选择 generate_diagram 输出 SVG，禁止退回 Mermaid 或 ASCII 草图（除非用户明确要求）。
5. 风格：灰白中性（深色 #0D0D0D/#1A1A1A/#2A2A2A，浅色 #F5F5F5/#FFFFFF），无彩色干扰、无阴影堆叠。

## 场景 → 类型
- 「架构图/系统架构」→ architecture（节点带 layer 分层）
- 「流程图/流程」→ flowchart（start/process/decision/end）
- 「依赖关系/代码依赖」→ dependency
- 「时序/调用链/交互」→ sequence
- 「ER图/数据模型」→ erd（节点带 fields 字段列表）
- 「路线图/规划」→ roadmap（里程碑）
- 「时间线/里程碑」→ timeline
- 「泳道图/角色流程」→ swimlane（节点带 lane 泳道）

## 调用约定
- generate_diagram 参数：type、title、nodes（[{id,label,kind?,layer?,lane?,fields?}]）、edges（[{from,to,label?}]）。
- 返回 __SYNAPS_DIAGRAM__ 开头的 SVG：必须在最终回复中原样输出该标记与整段 SVG（不要改写、不要转义），聊天页会自动渲染成图。
- 图表生成后附一句话说明图里最关键的一条信息即可，不要长篇解说。

## 自检清单
- [ ] 类型选对了吗？信息密度克制吗？
- [ ] 节点标签短而准（<= 16 字符/行，最多 3 行）？
- [ ] 连线带方向与必要标注吗？
- [ ] 输出是 SVG 且带 __SYNAPS_DIAGRAM__ 标记吗？
`,
  metadata: { version: '2.4', source: 'github.com/cathrynlavery/diagram-design' },
  source: 'github.com/cathrynlavery/diagram-design (MIT)',
};

export async function seedDiagramSkill(): Promise<void> {
  try {
    await getDb();
    runSql(
      `INSERT INTO skills (id, name, description, content, metadata, source, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         content = excluded.content,
         metadata = excluded.metadata,
         source = excluded.source,
         enabled = 1,
         updated_at = datetime('now')`,
      [
        `diagram-${cryptoRandomId()}`,
        DIAGRAM_SKILL.name,
        DIAGRAM_SKILL.description,
        DIAGRAM_SKILL.content,
        JSON.stringify(DIAGRAM_SKILL.metadata),
        DIAGRAM_SKILL.source,
      ]
    );
    saveDb();
  } catch {
    // 技能表不可用时静默跳过
  }
}

function cryptoRandomId(): string {
  // 轻量随机后缀，避免与历史导入冲突
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
