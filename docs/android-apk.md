# 用 GitHub Actions 构建并发布 Android APK

发布入口只有一个：`.github/workflows/android-apk.yml`。

| 触发方式 | 产物 | 是否创建 Release |
| --- | --- | --- |
| 推送 `v*` tag | 已签名 APK，资产名固定为 `opencode-mobile.apk` | 是 |
| `workflow_dispatch` 手动触发 | workflow artifact，`opencode-mobile-relay-<运行号>.apk` | 否 |

`.github/workflows/build.yml` 只调用 `validate.yml` 做发布前校验，不构建 APK、不写 Release、不上传 Play。这样同一个 tag 不会触发两次构建。

## 一次性准备：签名密钥

Android 要求同一个包名的更新必须用同一把密钥签名。**密钥丢了就无法覆盖安装**，请备份。

```bash
mkdir -p ~/.android-keys
keytool -genkeypair \
  -keystore ~/.android-keys/opencode-mobile-release.keystore \
  -alias opencode-mobile \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=OpenCode Mobile Personal, O=Personal, C=CN"
```

把密钥与口令写进仓库 Secrets（本仓库已配置好这四项）：

```bash
base64 -w0 ~/.android-keys/opencode-mobile-release.keystore | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS        # 例如 opencode-mobile
gh secret set ANDROID_KEY_PASSWORD
```

## 发布新版本

1. 升版本：同时修改 `app.config.ts` 的 `version` 与 `android.versionCode`、`package.json` 的 `version`，并新增 `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`。
2. 提交并推送 `main`，确认 `Build` 工作流（只跑 validate）为绿色。
3. 打 tag 并推送。tag 必须与 `app.config.ts` 的 `version` 完全一致（去掉 `v` 前缀），否则工作流在 `Validate tag matches app version` 步骤失败：

   ```bash
   git tag v1.0.86
   git push origin v1.0.86
   ```

4. 等待 `Android APK` 工作流完成：

   ```bash
   gh run list --workflow android-apk.yml --limit 1
   gh run watch
   ```

5. 校验 Release：

   ```bash
   gh release view v1.0.86 --json assets --jq '.assets[].name'
   # opencode-mobile.apk
   ```

## 手动构建（不发布）

用于在正式打 tag 前验证构建链路：

```bash
# 默认：app.getopencode.relay，仅 arm64-v8a
gh workflow run android-apk.yml

# 自定义包名 / ABI / 同时出 AAB
gh workflow run android-apk.yml \
  -f package_id=app.getopencode.relay \
  -f abis=arm64-v8a,x86_64 \
  -f build_aab=true

gh run watch
gh run download <run-id>          # 得到 opencode-mobile-relay-<n>.apk
```

手动触发不会创建或修改 Release；产物只保留在 Actions → Android APK → 该次运行 → Artifacts。

## 下载

固定下载地址（始终指向最新 Release）：

<https://github.com/zhangjinglei137/opencode-mobile/releases/latest/download/opencode-mobile.apk>

或用命令行：

```bash
gh release download v1.0.86 --pattern opencode-mobile.apk
```

## 包名

官方应用占用 `app.getopencode`。用同名不同签名的 APK 安装会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，也无法与官方版共存。本仓库默认使用 `app.getopencode.relay`；如需改动，改 `package_id` 输入即可（改了包名等于换一个应用，旧数据不会迁移）。

## 常见失败

| 现象 | 原因 |
| --- | --- |
| `缺少 secret ANDROID_KEYSTORE_BASE64` | Secrets 未配置，按上面四条设置 |
| `解出的 keystore 过小` | base64 被截断；用 `base64 -w0` 重新生成 |
| `apksigner verify` 失败 | 口令或 alias 与密钥不匹配 |
| `Tag vX does not match app version Y` | tag 与 `app.config.ts` 的 `version` 不一致，先升版本再打 tag |
| Release 里没有资产 | 工作流在构建或签名步骤失败；看该次运行的日志 |
| Gradle 卡在下载 NDK/CMake | 重跑一次；工作流已带 CMake 重试 |
| 构建超时 | 默认 90 分钟；首次含 NDK 下载通常 15–30 分钟 |
