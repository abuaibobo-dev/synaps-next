# Synaps 设备控制（Device Control）设计文档

> 目标：让 Agent 跳出对话框，真正能“看”（截图/读界面）和“操作”（点击/滑动/返回/打开应用）手机屏幕。
> 采用方案：**原生无障碍服务 + 动作队列桥**，不依赖任何第三方 MCP 服务器，完全内置。

## 一、开源项目调研结论（2026-08，GitHub 实时核验）

六轮 AI 推荐清单交叉验证后的结论：**“RN 智能体框架”类项目绝大多数是编造或不成熟的小仓库；真实存活的项目集中在“MCP / ADB / 无障碍设备控制”这条线上。**

### 真实且值得参考（全部已核验星数与活跃度）
| 项目 | 星数 | 参考价值 |
|---|---|---|
| `firerpa/lamda` | 8174 | Android 设备控制平台（WebRTC 远程桌面） |
| `mobile-next/mobile-mcp` | 5918 | 手机自动化/抓取 MCP 服务器 |
| `unitedbyai/droidclaw` | 1561 | 旧手机变 Agent：感知→推理→行动闭环 |
| `agents-io/PokeClaw` | 1005 | 设备端 AI 控制 Android |
| `CursorTouch/Android-MCP` / `minhalvp/android-mcp-server` | 811 / 801 | ADB 控制型 MCP 服务器 |
| `iamr0s/Ruto-GLM` | 702 | 后台虚拟屏自动化（概念参考，工程量大） |
| `margelo/react-native-runtimes` | 555 | 隔离 Hermes 运行时 |
| `eggbrid2/mobileClaw` | 390 | 开源手机控制 agent runtime |
| `opencyvis/opencyvis-phone` | 386 | 开源 AI 手机（虚拟显示屏） |
| `danielealbano/android-remote-control-mcp` | 259 | **跑在手机上的** MCP 服务器 |
| `babelcloud/gbox` | 177 | Android/浏览器/桌面 MCP 网关 |
| `callstack/repack` | 1927 | RN 模块联邦（瘦身/动态加载时再评估） |

### 编造/不成熟（明确不采用）
`react-native-agent`、`@vectalon-dev/rn`、`react-native-agentkit`、`erne-universal`、
`react-native-expo-ai-agent-system-workflow`、`Ghost in the Droid`、`@anode177/mcp-client`、
`AIOPE`、`Operit`、`Open Minis`、`ZeroAI`、`tawc`、`Mercury`、`Panda`、`PhoneCode`、
`Neuro`、`Shelly`、`LianYu`、`Project AIRI`、`AI Agent Studio Mobile`、`Pollinator`、
`Google AppFunctions`、`Google Android CLI 1.0`、`Antigravity SDK`、`GemOfGemma`(14★)、
`AI-Live-Overflow`(46★ 蓝图)、`PocketStrike-AI`(56★)、`react-native-leap`(1★)、
`react-native-device-agent`(0★)、`react-native-gemma-agent`(5★ 个人实验)。

### 为什么不直接集成第三方 MCP 控制服务器
- 候选（`android-remote-control-mcp` 等）多数依赖 ADB 或需要在 Termux 安装 Node 环境，
  对“APK 内置、零配置”的 Synaps 不友好。
- 无障碍服务是系统原生能力，自研桥实现同样的四件套（截图/点击/滑动/读 UI），
  无外部依赖、无网络要求、APK 不膨胀。

## 二、架构

```
┌──────────────────────── 手机 ────────────────────────┐
│  Node agent-server (嵌入式 nodejs-mobile, :19091)     │
│    device_status / device_action 工具                  │
│    └─ 动作队列 (server/src/device.ts, 内存 + TTL)      │
│              ▲ 投递/等待            ▲ 轮询 /pending     │
│              │                      │ 回传 /result      │
│  RN 层 (deviceBridge.ts 轮询 500ms)                     │
│    └─ NativeModules.DeviceControl                       │
│         └─ DeviceAccessibilityService (无障碍服务)       │
│              ├─ 点击/滑动  dispatchGesture              │
│              ├─ 截图      takeScreenshot (API 30+)      │
│              ├─ 读 UI     rootInActiveWindow 树导出      │
│              └─ 返回/主页/打开应用 globalAction/Intent   │
└───────────────────────────────────────────────────────┘
```

关键设计：
- **动作队列**：Agent 工具投递动作 → RN 轮询取走执行 → 回传结果；Agent 侧同步等待（20s 超时）。
- **启停偏好**：`device_control_enabled` 存 SQLite；真正执行依赖用户手动开启系统无障碍服务。
- **安全**：`device_action` 为中等风险，需用户确认（可信项目自动批准），操作写入审计日志（走既有 permission 流程）。

## 三、实现清单

### 服务端
- `server/src/device.ts` — 动作队列/启停状态/摘要
- `server/src/routes/device.ts` — REST 端点
  - `GET /api/v1/device/status`（设置页与 agent 状态）
  - `POST /api/v1/device/enable`（启停偏好）
  - `GET /api/v1/device/pending`（RN 桥轮询）
  - `POST /api/v1/device/result`（RN 桥回传）
  - `POST /api/v1/device/action`（agent 投递并等待，20s 超时）
- `server/src/routes/chat.ts` — 注册 `device_status`（只读）/ `device_action`（中风险）
- `server/src/permissions.ts` — 风险分级补充

### 原生层（Android）
- `DeviceAccessibilityService.kt` — 无障碍服务本体
- `DeviceControlModule.kt` / `DeviceControlPackage.kt` — RN 原生桥
- `MainApplication.kt` — 注册 package
- `plugins/withDeviceControl.js` — manifest 注入服务声明 + accessibility 配置资源
- 需要用户操作：系统设置 → 无障碍 → 开启 “Synaps 设备控制”

### 客户端
- `client/utils/deviceControl.ts` — 状态查询 + 轮询桥（500ms）
- Agent 页 — 挂载桥 + 头部“设备控制/未开启”指示
- 设置页 — “设备控制”分组：启用开关、服务连接状态、跳转无障碍设置

## 四、Agent 使用方式

用户（或 Agent）说：
- “看看现在手机屏幕有什么” → `device_action type=screenshot`（返回保存路径+尺寸）或 `ui_dump`（返回界面树）
- “点一下屏幕 (x,y)” → `device_action type=tap params.x/y`
- “从 (x1,y1) 滑到 (x2,y2)” → `device_action type=swipe`
- “打开微信” → `device_action type=launch_app params.package=com.tencent.mm`
- “返回/回桌面” → `device_action type=back|home`

前置条件：设置 → 设备控制 → 启用开关 + 系统无障碍里打开服务。

## 五、后续演进（Roadmap）
1. **截图视觉理解**：把截图发给多模态模型，让 Agent“看懂”界面后再操作（闭环：截图→理解→点击→再截图）。
2. **MCP 反向暴露**：将设备控制能力封装成 MCP 服务器，供外部 AI 工具（Codex/Claude）调用。
3. **虚拟显示屏**：参考 Ruto-GLM/openCyvis 的虚拟屏机制，后台自动化不打扰主屏（工程量最大，最后做）。
