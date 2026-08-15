import { getDb, runSql, saveDb } from './db.js';

interface ImpeccableSkill {
  name: string;
  description: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
}

// 集成自 github.com/pbakaus/impeccable（Apache 2.0，v4.1.1）
// 视觉审判：Agent 生成/修改 UI 时加载的质量底线与禁用清单
// 逻辑审判：审查员（team_review / 界面审计）使用的 5 维度打分标准
export const IMPECCABLE_SKILLS: ImpeccableSkill[] = [
  {
    name: 'impeccable-ui',
    description: '视觉审判：界面生成质量底线、绝对禁用模板、检测器规则清单与 React Native/Android 专项规范。生成或修改 UI 前必读。',
    content: `# impeccable-ui（视觉审判）
来源：github.com/pbakaus/impeccable（Apache 2.0，v4.1.1，已按 Synaps / React Native 场景适配）
用途：Agent 生成或修改任何界面（Web、React Native、App 页面）前先读本技能；改完后对照「检查清单」自检一遍。

## 质量底线（生成的界面必须满足）
1. 对比度：正文/占位文字 >= 4.5:1，大字号 >= 3:1；彩色底上的次级文字用该色相或前景色衍生，绝不用灰色。
2. 层次：阴影必须有偏移 + 柔和模糊；零偏移彩色光晕只是装饰。
3. 间距：紧密分组、组间留白、标题上方空间大于下方；用间距刻度（4 或 8 基数），不要逐处手写零散数值。
4. 字体：正文行宽 45-75ch，行高 >= 1.3；标题层级阶梯明显（相邻字号级差 >= 1.25 倍）；正文不小于 16px（移动端可用 sp 但必须可缩放）。
5. 动效：只做一个有意图的动效，指数缓出，从可见状态出发；禁止弹跳缓动（bounce）。
6. 状态：hover/按下、禁用、加载、错误、空态都要有；真实内容 + 可用控件 + 键盘/焦点可达。
7. 平台细节：安全区（状态栏/刘海/手势条/键盘）不能遮挡内容；触摸目标 >= 44dp（Android 48dp）；文本用可缩放单位。
8. 文案：控件命名动作（「保存」不是「确定」）；错误信息说明问题 + 恢复方法。

## 绝对禁止（默认模板，除非需求明确指定）
- 页面骨架模板：等大「图标 + 标题 + 正文」卡片铺满页面；卡片套卡片；hero 大数字指标模板（大数字 + 小标签 + 统计 + 强调色）。
- 标题上方加 kicker/eyebrow 小标签（硬禁令）。
- 章节编号（01/02/03）除非序号本身承载信息。
- 渐变文字（强调用字重或字号，不用背景裁剪渐变）。
- 装饰性玻璃拟态/模糊；1px 以上的彩色左侧/右侧边框。
- 硬偏移阴影（如 box-shadow: 4px 4px 0）除非整体是 neubrutalism 风格。
- emoji/Unicode 字符充当图标系统（图标要统一线性风格、同一笔画粗细）。
- 等宽字体用来装「技术感」（只有代码/数据/度量才用）。
- 紫色→蓝色渐变、青色霓虹、暗底霓虹文本（AI 模板配色）。
- 用几何遮罩代替真实照片轮廓。
- 明暗模式按类别随便选：根据使用场景决定。

## 检测器规则摘要（改完逐项对照，命中即修复）
颜色：low-contrast（对比度不足）、gray-on-color（彩色底灰字）、ai-color-palette（紫/青渐变与霓虹）、gradient-text（渐变文字）、dark-glow（零偏移暗底光晕）、cream-palette（米白背景模板）、codex-grid-background（网格背景模板）。
字体：overused-font（全站同一个默认字体）、flat-type-hierarchy（字号阶梯不明显）、italic-serif-display（衬线斜体标题）、tiny-text / undersized-ui-text（文本过小）、all-caps-body（正文全大写）、wide-tracking / extreme-negative-tracking（字距异常）、tight-leading（行高 < 1.3）、justified-text（两端对齐无连字符）、line-length（行宽超 75ch）、oversized-h1（H1 超大）、em-dash-overuse（破折号滥用）。
布局：nested-cards（卡片套卡片）、icon-tile-stack（图标块+标题+文字模板）、kicker-above-heading（标题上小标签）、side-tab（彩色侧边条）、monotonous-spacing（间距全等）、cramped-padding（内边距不足）、text-overflow / clipped-overflow-container（文本溢出/裁剪）、body-text-viewport-edge（正文贴屏边）、repeated-container-text（重复容器文本）。
动效：bounce-easing（弹跳缓动）、layout-transition（布局属性动画）、marquee（无限横滚）、pulsing-dot / blinking-cursor（脉动点/闪烁光标滥用）、image-hover-transform（图片 hover 位移）。
内容：theater-slop-phrase（AI 味套话）、shape-assembled-illustration（拼凑图形插画）、gpt-thin-border-wide-shadow（细边框+大阴影模板）。

## React Native / Android 专项
- 遵循平台规范：Android 用 Material 3 结构，品牌只通过主题色/字阶/圆角/动效表达。
- 图标用一套线性图标库（@expo/vector-icons、Lucide 等），统一线宽，禁止混用多套图标。
- 长列表用 FlatList/SectionList 虚拟化；动效用 Animated/reanimated 保持 60fps，禁止用 setState 驱动动画。
- 颜色全部走主题 token（深/浅两套），禁止散落硬编码 hex。
- 键盘弹出、安全区、文本缩放（放大 2 倍不破版）都要验证；对比度在深色/浅色两种外观下都达标。`,
    metadata: { dependsOn: [], category: 'design', version: '1.0.0' },
    source: 'impeccable (github.com/pbakaus/impeccable, Apache-2.0)',
  },
  {
    name: 'impeccable-review',
    description: '逻辑审判：界面/前端代码审查标准，5 维度打分（无障碍/性能/主题化/响应式/一致性）与认知负荷检查，输出 P0-P3 分级报告。',
    content: `# impeccable-review（逻辑审判）
来源：github.com/pbakaus/impeccable 的 audit/critique 体系（Apache 2.0，已适配 Synaps）
用途：team_review 审查员、用户要求「检查代码 / 审查 / 界面审计」时加载；输出结构化审查报告，只记录不修复。

## 审查流程
1. 先读目标代码/界面源码（不要只看文件名，要读真实实现）。
2. 按 5 个维度逐项打分（0-4），每项必须给出证据（文件/选择器/计算值），不许空口说「是」。
3. 汇总报告：总分 /20 + 评级 + P0-P3 问题清单 + 修复建议。

评级：18-20 优秀；14-17 良好；10-13 及格；6-9 差；0-5 严重。

## 维度（Web/前端）
1. 无障碍：对比度 < 4.5:1；交互元素缺 aria-label/role/状态；键盘不可达或焦点丢失；标题层级跳跃；表单无 label；图片无 alt。
2. 性能：布局抖动（循环读写布局属性）；动画开销大；图片未懒加载/未优化；will-change 滥用；无谓重渲染（缺 memo/key）。
3. 主题化：硬编码颜色；深色模式缺失或对比差；token 混用；主题切换不生效。
4. 响应式：固定宽度；触摸目标 < 44px；窄屏横向滚动；字号放大破版；无移动端断点。
5. 实现一致性：重复实现捷径；设计系统漂移；内容与产品无关可互换（换 logo 就变成别的产品）；检测器命中项未处理。

## 维度（Native：Android / React Native）
1. 无障碍：缺 accessibilityLabel/role/state；TalkBack 遍历顺序乱；固定字号导致缩放破版；触摸目标 < 48dp；忽略减少动效。
2. 性能：启动慢；长列表未虚拟化（FlatList/LazyColumn）；主线程 jank；无谓重渲染；缩略图直接解码原图。
3. 外观与主题：硬编码 hex；深色外观缺失；Android 12+ 动态取色无兜底；手搓系统材料。
4. 平台一致性（关键）：返回手势/预测性返回被劫持；内容进状态栏/刘海/键盘；iOS 模式搬到 Android（或反之）；web 式控件；图标混用；hover 依赖。
5. 适配性：平板拉伸手机布局；横屏破版；键盘遮挡输入；多窗口/分屏不支持。

## 认知负荷检查（UX 层面）
- 内在负荷：任务本身复杂度是否被拆解成可消化步骤？
- 无关负荷：是否有装饰、重复信息、无关选项分散注意力？
- 相关负荷：关键路径是否清晰，工作记忆（约 4 个信息块）是否被尊重？
- 常见违规：同一屏信息过载、流程缺进度感、按钮层级混乱、破坏性操作无确认、空态/错误态缺引导。

## 输出格式
审查报告
- 对象：[文件/页面]
- 总分：X/20（评级）
- P0（阻塞）：...
- P1（严重）：...
- P2（一般）：...
- P3（建议）：...
- 首要修复建议：...`,
    metadata: { dependsOn: [], category: 'review', version: '1.0.0' },
    source: 'impeccable (github.com/pbakaus/impeccable, Apache-2.0)',
  },
];

// 启动时把两个技能写入 skills 表（幂等：按 name upsert）
export async function seedImpeccableSkills(): Promise<void> {
  try {
    await getDb();
    for (const skill of IMPECCABLE_SKILLS) {
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
          `impeccable_${skill.name}`,
          skill.name,
          skill.description,
          skill.content,
          JSON.stringify(skill.metadata),
          skill.source,
        ]
      );
    }
    saveDb();
    console.log(`Seeded ${IMPECCABLE_SKILLS.length} impeccable skills`);
  } catch (err) {
    console.error('Failed to seed impeccable skills:', err);
  }
}
