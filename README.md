# OpenCode Mobile

<p align="center">
  <strong>把 OpenCode 工作流装进口袋。</strong>
</p>

<p align="center">
  <strong>中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/zhangjinglei137/opencode-mobile/releases/latest/download/opencode-mobile.apk">
    <img src="https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD-APK-18A748?style=for-the-badge&logo=android&logoColor=white" alt="下载 APK">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge" alt="License: Apache 2.0">
  </a>
</p>

<p align="center">
  <img src="fastlane/metadata/android/en-US/images/phoneScreenshots/1.png" width="220" alt="会话列表">
  <img src="fastlane/metadata/android/en-US/images/phoneScreenshots/2.png" width="220" alt="对话">
  <img src="fastlane/metadata/android/en-US/images/phoneScreenshots/3.png" width="220" alt="终端">
</p>

---

## 这是什么

OpenCode Mobile 是一个独立的社区移动客户端，用来连接你自己运行的 [OpenCode](https://opencode.ai/) 服务器：在手机上发起任务、查看进度、审批权限、使用终端，并继续在电脑上没做完的会话。

本仓库是 [alvarolorentedev/opencode-mobile](https://github.com/alvarolorentedev/opencode-mobile) 的个人分叉，由 [@zhangjinglei137](https://github.com/zhangjinglei137) 维护，主要面向自托管场景。

它不是把桌面 IDE 塞进小屏幕，而是围绕手机上真正需要做的事设计。

## 与上游的区别

- **新增 Relay 远程访问**：登录自建 Relay 服务器，选择远程主机，用端到端口令解锁后建立隧道，不必为每台机器单独做公网暴露。
- **独立 Android 包名** `app.getopencode.relay`，可与官方 `app.getopencode` 同时安装。
- **只通过 GitHub Releases 分发 APK**，不发布到 Google Play 或 TestFlight。
- 其余功能与上游保持一致，并跟随上游更新。

## 功能

- **发起与继续会话**  
  选择 agent 与模型，发送指令，在手机上继续同一个 OpenCode 会话。

- **观察 agent 进度**  
  直接看到 OpenCode 正在做什么，而不是等一条笼统的完成通知。

- **审批操作**  
  响应权限请求，在接受改动前检查工作内容。

- **管理工作区与会话**  
  在多个 OpenCode 服务器、项目、会话与模型之间切换。

- **使用终端**  
  不打开电脑也能执行针对性命令。

- **浏览与修改文件**  
  查看项目文件，在手机上做局部改动。

- **语音输入**  
  不方便打字时，用语音口述提示或继续对话。

- **了解模型用量**  
  查看上下文占用、token 活动、模型用量、步骤与预估成本。

- **连接多台服务器**  
  保存多个 OpenCode 连接，各自保留会话与模型选择。

- **Relay 远程访问**  
  输入 Relay 地址与账号登录，选择主机，用端到端口令解锁主机密钥，然后像直连一样使用。

## 工作原理

你的代码始终留在运行 OpenCode 的那台机器上。手机只负责远程控制。

直连方式：

```text
手机
  │
  │ HTTPS / 安全隧道
  ▼
OpenCode server
  │
  ▼
工作区 + 模型
```

通过 Relay 访问：

```text
手机
  │
  │ HTTPS
  ▼
Relay 服务器
  │
  │ 隧道
  ▼
主机上的 OpenCode
  │
  ▼
工作区 + 模型
```

### 1. 启动 OpenCode

```bash
opencode serve --port 4096
```

### 2. 安全地暴露服务

用认证、HTTPS 隧道、VPN 或反向代理保护服务器，例如：

```bash
cloudflared tunnel --url localhost:4096
```

Tailscale、Cloudflare Tunnel 以及其他安全组网方式都可以。也可以改用自建 Relay，让主机主动连出，不必开放入站端口。

### 3. 在应用中连接

在应用里填写受保护的服务器地址（或 Relay 地址与账号），完成认证，选择工作区，然后继续会话。

更完整的接入流程见 [开发与接入文档](docs/development.md)。

### 4. 连接 AI provider

打开 **设置 → AI 与提供商 → 添加提供商**，选择服务商；若提供多种登录方式，选择 **API key**，粘贴密钥并保存。配置完成后即可启用其模型，并在对话中选择。点击已配置的 provider 可以重新登录或替换密钥。

provider 密钥保存在所连接的 OpenCode 服务器上。在 OpenCode 2 上，服务端的集成目录决定哪些 provider 支持 API key 或 OAuth 登录；只支持环境变量的 provider 需要在服务器上配置。

## 安装

### Android

从 GitHub Releases 下载最新 APK：

[**下载最新 APK →**](https://github.com/zhangjinglei137/opencode-mobile/releases/latest/download/opencode-mobile.apk)

- 包名为 `app.getopencode.relay`，可与官方版共存。
- 后续版本必须使用同一签名才能覆盖安装；升级时不要卸载旧版本。
- 首次安装需要在系统设置中允许安装未知来源应用。

### iOS

本仓库不提供预编译的 iOS 包。需要自行构建，要求 macOS 与 Xcode：

[**查看开发文档 →**](docs/development.md)

## 隐私与控制

OpenCode Mobile 围绕自托管的 OpenCode 环境设计：

- 源码始终留在你的 OpenCode 主机上。
- 应用连接的是你自己控制的基础设施。
- 服务器凭据使用设备安全存储保存。
- 是否暴露 OpenCode 实例、如何暴露，由你决定。
- 不需要任何托管的 OpenCode 服务。

远程访问时，优先使用带认证的 HTTPS、VPN 或安全隧道，不要把未认证的 OpenCode 端口直接暴露到公网。

## 开发

技术栈：

- React Native
- Expo
- TypeScript
- Expo Router
- `@opencode/client` 用于 OpenCode 2；`@opencode-ai/sdk` 仅用于 OpenCode 1 兼容

本地开发：

```bash
npm install
npm run android      # 或 npm run ios
npm run lint
npm run typecheck
```

发版前跑完整检查：`npm run test:ci:static`（静态检查与单元测试），以及 `npm run test:fake-server:self`、`npm run test:e2e:web`。

架构、测试与发布说明见：

[**开发文档 →**](docs/development.md)

## 发布

推送 `v*` 形式的版本 tag 会触发 GitHub Actions 构建已签名 APK，并以固定文件名 `opencode-mobile.apk` 附加到对应的 GitHub Release。手动触发工作流只产出 workflow artifact，不会创建 Release。

发布步骤、签名密钥准备与常见失败排查见：

[**Android APK 构建与发布 →**](docs/android-apk.md)

## 贡献

欢迎通过 [issue tracker](https://github.com/zhangjinglei137/opencode-mobile/issues) 提交 issue 与 pull request：

- 报告 bug
- 提出功能建议
- 改进文档
- 测试 Android 构建
- 提交 pull request
- 帮助复现新版本 OpenCode 的兼容性问题

## 上游与许可

本项目基于 [alvarolorentedev/opencode-mobile](https://github.com/alvarolorentedev/opencode-mobile)（Apache-2.0）分叉，遵循同一许可证发布，详见 [LICENSE](LICENSE)。上游作者与贡献者保留了其版权与署名。

OpenCode Mobile 不是 OpenCode 官方产品，与 OpenCode 团队无隶属或背书关系。OpenCode 及相关商标归其各自所有者。

---

<p align="center">
  <strong>带上你的下一次 OpenCode 会话。</strong>
</p>
