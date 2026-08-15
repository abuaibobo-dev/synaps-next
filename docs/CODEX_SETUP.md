# Synaps × Codex CLI（Termux 桥接）安装说明

Codex CLI 作为 Synaps 的「外部执行大脑」：App 里的 Agent 遇到需要真正动手的任务时，
通过 `codex_exec` 工具把任务交给本机运行的 Codex CLI 完成（写代码、跑命令、改文件、自测修复闭环）。

Android 不允许 App 直接执行 Termux 里的二进制，所以采用 **HTTP 桥接**：
Termux 里跑一个小服务（`tools/codex-bridge/server.js`），Synaps 通过 `127.0.0.1:19290` 调用它。

## 一、在 Termux 里安装（只需一次）

```bash
# 1. 安装 Node.js 与 Git
pkg install nodejs git -y

# 2. 安装 Codex CLI（官方）
npm i -g @openai/codex

# 3. 下载桥接服务脚本
curl -L -o ~/codex-bridge.js \
  https://raw.githubusercontent.com/abuaibobo-dev/synaps-next/master/tools/codex-bridge/server.js

# 4. 启动桥接服务（保持 Termux 在前台或后台运行）
node ~/codex-bridge.js &
```

看到 `Synaps Codex 桥接已启动：http://127.0.0.1:19290` 即成功。

## 二、Synaps App 里配置

1. 打开 App → 设置 → **Codex CLI**
2. 打开「启用 Codex CLI」
3. 桥接服务地址保持默认 `http://127.0.0.1:19290`
4. 访问令牌：可选。如果启动桥接时设置了 `CODEX_BRIDGE_TOKEN`，这里填一样的值
5. API Key：留空则使用「AI 模型」里的 DeepSeek Key
6. 模型默认 `deepseek-v4-flash`；接口协议默认 `responses`（Codex 0.137+ 已不支持 `chat`）

## 三、验证

回到 Agent 对话页，发：

> 检查一下 Codex 桥接状态

Agent 会调用 `codex_status` / `checkCodexBridge`，返回桥接版本号说明已连通。
再发一个真实任务（如「在当前项目里新建一个 hello.txt 并写入 hi」），Agent 会调用 `codex_exec` 让 Codex 实际动手。

## 四、开机自启（可选）

```bash
pkg install termux-boot -y
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-codex-bridge.sh <<'BOOTEOF'
#!/data/data/com.termux/files/usr/bin/sh
node ~/codex-bridge.js > ~/codex-bridge.log 2>&1 &
BOOTEOF
chmod +x ~/.termux/boot/start-codex-bridge.sh
```

重启后桥接自动运行；日志在 `~/codex-bridge.log`。

## 五、安全说明

- 桥接只监听 `127.0.0.1`（本机回环），不对外网开放
- 强烈建议设置令牌：`CODEX_BRIDGE_TOKEN=你的随机密码 node ~/codex-bridge.js &`
- `codex exec` 使用 `--sandbox danger-full-access` 才能在 Termux 里真正读写你的项目目录
- 任何 `codex_exec` 调用都属于高风险操作，Synaps 会在执行前要求你确认（可信项目除外）

## 六、故障排查

| 现象 | 处理 |
| --- | --- |
| 状态条显示「桥接不可达」 | Termux 里重新 `node ~/codex-bridge.js &`，确认端口 19290 |
| 报错 `wire_api = "chat" is no longer supported` | 设置 → Codex CLI → 接口协议改为 `responses` |
| 报错 `Missing environment variable DEEPSEEK_API_KEY` | 设置 → Codex CLI → API Key 填写（或确认 AI 模型 Key 已填） |
| 执行超时 | 桥接默认 600s 超时；任务过大可让 Agent 拆小任务 |
| `codex: command not found` | 检查 `npm i -g @openai/codex` 是否成功，重开 Termux 会话 |
