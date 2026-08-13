# Synaps - GitHub Actions APK 构建指南

## 前置条件

1. **Expo 账号**
   - 注册账号：https://expo.dev/signup
   - 免费账号即可使用 EAS Build

2. **获取 Expo Token**
   - 登录 https://expo.dev/settings/access-tokens
   - 点击 "Create a token"
   - 名称填写 "github-actions"
   - 复制生成的 token

3. **GitHub 仓库**
   - 将项目推送到 GitHub

## 配置步骤

### 1. 添加 GitHub Secrets

在 GitHub 仓库中：
- 进入 Settings → Secrets and variables → Actions
- 点击 "New repository secret"
- Name: `EXPO_TOKEN`
- Value: 粘贴你的 Expo Token

### 2. 推送代码到 GitHub

```bash
cd /workspace/projects
git init
git add .
git commit -m "Initial commit: Synaps AI Development Agent"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/synaps.git
git push -u origin main
```

### 3. 触发构建

推送代码后，GitHub Actions 会自动开始构建：
- 进入仓库的 Actions 标签页
- 查看 "Build Android APK" workflow
- 等待构建完成（约 10-20 分钟）

### 4. 下载 APK

构建完成后：
- 点击成功的 workflow run
- 在 "Artifacts" 部分下载 `synaps-apk.zip`
- 解压后得到 `synaps.apk`
- 传输到手机安装

## 手动触发构建

如果需要手动触发构建：
- 进入 Actions 标签页
- 选择 "Build Android APK"
- 点击 "Run workflow"
- 选择分支，点击 "Run workflow"

## 构建配置说明

### eas.json 配置

- **preview**: 生成 APK 文件，用于内部测试
- **production**: 生成 AAB 文件，用于 Google Play 发布

### 修改应用名称/图标

编辑 `client/app.json`:
```json
{
  "expo": {
    "name": "Synaps",
    "slug": "synaps",
    "icon": "./assets/icon.png",
    "android": {
      "package": "com.yourname.synaps"
    }
  }
}
```

## 常见问题

### Q: 构建失败怎么办？
A: 查看 Actions 日志，常见原因：
- Expo Token 过期或无效
- 依赖安装失败
- 配置错误

### Q: 构建需要多长时间？
A: 首次构建约 15-30 分钟，后续构建约 10-15 分钟

### Q: 可以在本地构建吗？
A: 可以，需要安装 Android Studio 和 Expo CLI：
```bash
cd client
npx eas build --platform android --profile preview
```

## 更新应用

修改代码后：
```bash
git add .
git commit -m "Update features"
git push
```

GitHub Actions 会自动重新构建 APK。
