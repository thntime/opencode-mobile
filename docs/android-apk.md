# 用 GitHub Actions 构建 Android APK

`.github/workflows/android-apk.yml` 只做一件事：产出一个可安装的、已签名的 release APK。

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

## 触发构建

```bash
# 默认：app.getopencode.relay，仅 arm64-v8a
gh workflow run android-apk.yml

# 自定义包名 / ABI / 同时出 AAB
gh workflow run android-apk.yml \
  -f package_id=app.getopencode.relay \
  -f abis=arm64-v8a,x86_64 \
  -f build_aab=true

gh run watch
```

推 `v*` 标签时会自动构建并把 APK 挂到对应的 GitHub Release：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## 下载产物

```bash
gh run list --workflow android-apk.yml --limit 1
gh run download <run-id>          # 得到 opencode-mobile-relay-<n>.apk
```

或打开 Actions → Android APK → 该次运行 → Artifacts。

## 为什么包名不是 `app.getopencode`

官方应用占用 `app.getopencode`。用同名不同签名的 APK 安装会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，也无法与官方版共存。默认用 `app.getopencode.relay`；如需改动，改 `package_id` 输入即可（改了包名等于换一个应用，旧数据不会迁移）。

## 常见失败

| 现象 | 原因 |
|---|---|
| `缺少 secret ANDROID_KEYSTORE_BASE64` | Secrets 未配置，按上面四条设置 |
| `解出的 keystore 过小` | base64 被截断；用 `base64 -w0` 重新生成 |
| `apksigner verify` 失败 | 口令或 alias 与密钥不匹配 |
| Gradle 卡在下载 NDK/CMake | 重跑一次；工作流已带 CMake 重试 |
| 构建超时 | 默认 90 分钟；首次含 NDK 下载通常 15–30 分钟 |
