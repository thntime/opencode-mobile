# OpenCode Mobile

<p align="center">
  <strong>Your OpenCode workflow, in your pocket.</strong>
</p>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="https://github.com/zhangjinglei137/opencode-mobile/releases/latest/download/opencode-mobile.apk">
    <img src="https://img.shields.io/badge/Download-APK-18A748?style=for-the-badge&logo=android&logoColor=white" alt="Download APK">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge" alt="License: Apache 2.0">
  </a>
</p>

<p align="center">
  <img src="fastlane/metadata/android/en-US/images/phoneScreenshots/1.png" width="220" alt="Session list">
  <img src="fastlane/metadata/android/en-US/images/phoneScreenshots/2.png" width="220" alt="Conversation">
  <img src="fastlane/metadata/android/en-US/images/phoneScreenshots/3.png" width="220" alt="Terminal">
</p>

---

## What this is

OpenCode Mobile is an independent, community-built mobile client for the [OpenCode](https://opencode.ai/) server you already run. Start tasks, check progress, approve permissions, use the terminal, and continue sessions you left on your desk.

This repository is a personal fork of [alvarolorentedev/opencode-mobile](https://github.com/alvarolorentedev/opencode-mobile), maintained by [@zhangjinglei137](https://github.com/zhangjinglei137) for self-hosted use.

It is not an attempt to squeeze a desktop IDE onto a smaller screen. It is designed around the things that matter on mobile.

## Differences from upstream

- **Relay remote access**: sign in to a self-hosted Relay server, pick a remote host, unlock its key with an end-to-end passphrase, and connect through a tunnel without exposing each machine to the public internet.
- **Separate Android package** `app.getopencode.relay`, so it can be installed alongside the official `app.getopencode` build.
- **APKs are distributed only through GitHub Releases**, not Google Play or TestFlight.
- Everything else tracks upstream.

## Features

- **Start and continue sessions**  
  Pick an agent and model, send instructions, and keep working with the same OpenCode sessions from your phone.

- **Watch agent progress**  
  See what OpenCode is doing instead of waiting for a generic completion notification.

- **Review and approve actions**  
  Respond to permission requests and inspect the work before accepting changes.

- **Manage workspaces and sessions**  
  Switch between multiple OpenCode servers, projects, sessions, and models.

- **Use the terminal**  
  Run focused commands without reopening your laptop.

- **Browse and patch files**  
  Inspect project files and make targeted changes from mobile.

- **Use voice input**  
  Dictate prompts or continue a conversation when typing is inconvenient.

- **Understand model usage**  
  Inspect context utilization, token activity, model usage, steps, and estimated cost.

- **Stay connected to multiple servers**  
  Save OpenCode connections with their own sessions and model selection.

- **Relay remote access**  
  Enter a Relay URL and account, choose a host, unlock its key with the end-to-end passphrase, then use it like a direct connection.

## How it works

Your code stays on the machine running OpenCode. The phone only provides remote control.

Direct connection:

```text
Your phone
    │
    │ HTTPS / secure tunnel
    ▼
OpenCode server
    │
    ▼
Your workspace + models
```

Through a Relay:

```text
Your phone
    │
    │ HTTPS
    ▼
Relay server
    │
    │ tunnel
    ▼
OpenCode on your host
    │
    ▼
Your workspace + models
```

### 1. Start OpenCode

```bash
opencode serve --port 4096
```

### 2. Expose it securely

Protect the server with authentication and a secure HTTPS tunnel, VPN, or reverse proxy, for example:

```bash
cloudflared tunnel --url localhost:4096
```

Tailscale, Cloudflare Tunnel, and other secure networking options work well. You can also run a self-hosted Relay so hosts dial out instead of opening inbound ports.

### 3. Connect from the app

Enter the protected server URL (or the Relay URL and account), authenticate, choose your workspace, and continue your sessions.

See the [development guide](docs/development.md) for the full setup flow.

### 4. Connect an AI provider

Open **Settings → AI & providers → Add provider**, choose your provider, select **API key** if multiple login methods are offered, paste the key, and save. You can then enable its models and select one in Chat. Tap an already configured provider to reopen login or replace its key.

Provider keys are saved on the connected OpenCode server. On OpenCode 2, the server's integration catalog determines which providers support API-key or OAuth login; environment-only providers must be configured on the server.

## Install

### Android

Download the latest APK from GitHub Releases:

[**Download latest APK →**](https://github.com/zhangjinglei137/opencode-mobile/releases/latest/download/opencode-mobile.apk)

- Package name is `app.getopencode.relay`, so it can coexist with the official app.
- Later versions must be signed with the same key to install over an existing copy; do not uninstall before upgrading.
- Allow installing from unknown sources the first time.

### iOS

This repository does not publish prebuilt iOS builds. Build it yourself with macOS and Xcode:

[**Read the development guide →**](docs/development.md)

## Privacy and control

OpenCode Mobile is designed around self-hosted OpenCode environments:

- Your source code remains on your OpenCode host.
- The app connects to infrastructure you control.
- Server credentials are stored using secure device storage.
- You choose how your OpenCode instance is exposed.
- No hosted OpenCode server is required.

For remote access, prefer authenticated HTTPS, a VPN, or a secure tunnel rather than exposing an unauthenticated OpenCode port directly to the internet.

## Development

Built with:

- React Native
- Expo
- TypeScript
- Expo Router
- `@opencode/client` for native OpenCode 2; `@opencode-ai/sdk` isolated to OpenCode 1 compatibility

Local development:

```bash
npm install
npm run android      # or npm run ios
npm run lint
npm run typecheck
```

Full pre-release checks: `npm run test:ci:static` (static checks and unit tests), plus `npm run test:fake-server:self` and `npm run test:e2e:web`.

For architecture, testing, and release instructions:

[**Read the development guide →**](docs/development.md)

## Releases

Pushing a `v*` version tag triggers GitHub Actions to build a signed APK and attach it to the matching GitHub Release as `opencode-mobile.apk`. Manually triggered runs only produce a workflow artifact and never create a Release.

Signing setup, release steps, and troubleshooting:

[**Android APK build and release →**](docs/android-apk.md)

## Contributing

Contributions are welcome through the [issue tracker](https://github.com/zhangjinglei137/opencode-mobile/issues) and pull requests:

- opening bug reports
- proposing features
- improving documentation
- testing Android builds
- submitting pull requests
- helping reproduce compatibility issues with new OpenCode releases

## Upstream and license

This project is a fork of [alvarolorentedev/opencode-mobile](https://github.com/alvarolorentedev/opencode-mobile) (Apache-2.0) and is released under the same license. See [LICENSE](LICENSE). Upstream authors and contributors retain their copyright and attribution.

OpenCode Mobile is not an official OpenCode product. It is not built by the OpenCode team, is not endorsed by them, and is not affiliated with them in any way. OpenCode and its trademarks belong to their respective owners.

---

<p align="center">
  <strong>Take your next OpenCode session with you.</strong>
</p>
