# Synaps 免费执行大脑安装说明（Termux）

Synaps 的 10 个 Agent 各有专属执行大脑。外部 CLI 大脑与 Codex CLI 一样，
通过 Termux 桥接服务（`tools/codex-bridge/server.js`）被 Synaps 调用。
设置页 → 执行大脑 可查看每个大脑的安装状态（✅/⚠️），装好即可路由使用。

## 0. 前置：Codex CLI 桥接（必装）

所有外部大脑都依赖桥接服务：

```bash
pkg install nodejs git -y
npm i -g @openai/codex
curl -L -o ~/codex-bridge.js \
  https://raw.githubusercontent.com/abuaibobo-dev/synaps-next/master/tools/codex-bridge/server.js
node ~/codex-bridge.js &
```

App 设置 → Codex CLI：打开「启用 Codex CLI」，API Key 留空（自动用 AI 模型 Key）。
随后打开设置 → 执行大脑，点刷新，能看到各大脑状态。

## 1. 各 Agent 专属大脑安装

```bash
# 代码工程师 → Aider（推荐，AI 结对编程，支持 DeepSeek API）
pkg install python -y
pip install aider-installer
aider-install

# 代码工程师备选 → Sage（本地优先，免费开源模型）
pip install sage-ai-cli

# 文件管家 → Lydia（本地 Ollama 驱动，数据不出本地）
# 安装方式见 https://github.com/levimackay/lydia-cli

# 自动化助手 → aix（40 家提供商，含免费渠道）
npm i -g aix-ai

# 记忆管理员 → miii（100% 本地离线）
npm i -g miii-agent

# 翻译官备选 → my-ai（本地优先）
npm i -g @gh3ttoniga/my-ai
```

## 2. 本地模型底座 Ollama（Lydia / miii / my-ai 需要）

```bash
pkg install ollama -y
ollama serve &          # 后台启动
ollama pull qwen2.5:1.5b   # 小内存手机选 1.5b；内存大的可换 qwen2.5:7b
```

手机内存不足时，Lydia/miii/my-ai 会连不上本地模型；可配置远程 Ollama 地址。

## 3. 内置能力（无需安装）

- 搜索助手：内置 `web_search`（DuckDuckGo，免 Key）+ DuckDuckGo MCP
- UI 操作员：内置无障碍 `device_action`（无需外部大脑）
- 通用对话 / 翻译 / 推理研究员：DeepSeek 主模型（`deepseek-reasoner` 做深度推理）

## 4. 使用

在 Agent 对话里发：

> 看看我的执行大脑状态

Agent 会调用 `brain_status` 返回全部大脑安装状态。
发复杂任务时，代码工程师会自动调用 Aider（`brain_exec brain=aider`），
不可用时降级到 Codex CLI 或自带工具，并给出安装指引。

## 5. 安全说明

- 桥接只监听 `127.0.0.1`，建议设置 `CODEX_BRIDGE_TOKEN`（见 CODEX_SETUP.md）
- 所有 `brain_exec` 调用属高风险操作，Synaps 执行前会要求确认（可信项目除外）
- 第三方 CLI 大脑均为社区项目，安装前可先看 npm/PyPI 页面；不需要的可以不装，不影响其他功能

## 6. 故障排查

| 现象 | 处理 |
| --- | --- |
| 某个大脑一直「未安装」 | 确认已装并重开桥接；设置 → 执行大脑 → 刷新 |
| `command not found` | 重新打开 Termux 会话让 PATH 生效 |
| 本地大脑连不上模型 | `ollama serve &` 后再 `ollama pull qwen2.5:1.5b` |
| 报错 wire_api | 设置 → Codex CLI → 接口协议填 `responses` |
