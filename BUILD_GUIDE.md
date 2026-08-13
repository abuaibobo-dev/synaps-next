# Synaps - 构建指南（GitHub Actions）

## 架构简述
- `client/`：Expo / React Native 应用（TypeScript），8 个模块页面（项目/Agent/代码/终端/APK/日志/GitHub/设置）
- `server/`：Express 后端，esbuild 打包为**自包含单文件** `dist/index.cjs`（含 sql.js，仅 wasm 外置）
- **嵌入式 Node**：APK 内嵌 nodejs-mobile 运行时（libnode.so），首次启动把 `assets/nodejs-project/`（server bundle + wasm）复制到应用私有目录，在独立线程运行 Express，前端走 `http://127.0.0.1:9091`

## 嵌入式 Node 集成（nodejs-mobile）
- `client/android/app/build.gradle`
  - `downloadNodejs`（preBuild）：从 nodejs-mobile v18.20.4 release 下载预编译包（MD5 校验），解压到 `app/libnode/`（.gitignore 忽略）
  - `copyNodeProject`（preBuild）：`node server/build.js` 重新打包 server → 复制 `dist/index.cjs` + `sql-wasm.wasm` 到 `app/src/main/assets/nodejs-project/`，并生成入口 `main.cjs`（先设 `SYNAPS_DATA_DIR` 再加载 server）
- `client/android/app/src/main/cpp/`：CMake + native-lib.cpp（JNI 桥，`node::Start`，stdout/stderr 重定向 logcat）
- `client/android/app/src/main/java/com/aibox/app/node/NodeBridge.kt`：assets 复制 + 单线程启动
- `MainActivity.onCreate` 调用 `NodeBridge.start(applicationContext)`；该调用由 `client/plugins/withNodeBridge.js` config plugin 在 prebuild 时自动注入
- 只构建 `arm64-v8a`（APK 增加约 62MB）

## 本地构建（仅验证用；正式构建走 CI）
```bash
pnpm install --frozen-lockfile
cd client/android
./gradlew assembleRelease --max-workers=1 -Xmx1024m
```
> ARM 机器上 Android SDK 二进制为 x86_64（qemu 转换），易 OOM，务必限制 worker/内存；正式构建请用 GitHub Actions。

## CI 构建（正式路径）
1. 修改代码 → `git push origin master`
2. 打 tag（如 `v3.2.0-node-embedded`）→ `git push origin <tag>`
3. 等待 `Build Android APK` workflow 完成（约 10-15 分钟）
4. release 自动创建，APK 直链：`https://github.com/abuaibobo-dev/synaps-next/releases/download/<tag>/Synaps-<tag>.apk`

## 注意事项
- `npx expo prebuild` 会重新生成 android 目录：包名来自 `app.config.ts`（`com.aibox.app`），MainActivity 的 Node 启动调用由 `plugins/withNodeBridge.js` 自动注入
- server 改动后无需手动提交 assets 产物（Gradle 自动重建）
- sql.js wasm 必须与 `index.cjs` 同目录（`locateFile` 用 `__filename` 定位）
