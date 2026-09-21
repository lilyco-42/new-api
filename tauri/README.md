# Lain42 Agent desktop app

这是云枢智创 Agent 的 Tauri 2 桌面壳。它默认打开 `https://api.lain42.top/agent`，登录、模型、额度和历史记录继续由网站统一管理，Windows、macOS 和 Linux 使用同一套入口。

## 本地开发

在 `tauri/` 目录安装 Rust 版 Tauri CLI（不依赖 npm）：

```bash
cargo binstall tauri-cli@2.11.5 --no-confirm
```

默认启动线上 Agent：

```bash
cargo tauri dev
```

调试本地前端时，可以把窗口指向 Rsbuild 开发地址：

```powershell
$env:LAIN42_DESKTOP_URL = "http://localhost:5173/agent"
cargo tauri dev
```

如果同一台系统由不同人使用，为每个人设置不同的桌面档案名。WebView 会话 Cookie、localStorage 和本机 GitHub CLI 配置会分别落在该档案目录。未设置变量时，应用会使用当前操作系统用户名生成默认档案名：

```powershell
$env:LAIN42_DESKTOP_PROFILE = "alice"
bun run dev
```

另一个人使用 `bob` 即可得到独立会话和独立 `GH_CONFIG_DIR`。生产启动器也应把这个变量作为每个用户的启动参数；不同操作系统账号本身已经天然隔离应用数据。

桌面进程在启动时固定档案名，网页不能通过 `invoke` 参数切换到其他人的目录。所有 GitHub 操作都会由该固定档案设置 `GH_CONFIG_DIR` 后再调用 `gh`，因此登录一个人的账号不会写入另一个人的配置。

## 打包

```bash
cargo tauri build
```

安装包会写入 `tauri/target/release/bundle/`。Tauri 会根据当前平台生成 Windows 安装包、macOS 应用包和 Linux AppImage/deb；跨平台发布应在对应平台或 CI runner 上分别构建。

桌面壳只保存 WebView 的会话数据，不复制服务端密钥，也不会读取浏览器 Cookie。GitHub 能力只调用本机已安装的 `gh` CLI，当前仅开放登录状态、仓库搜索、Issue 列表和 Pull Request 列表四类命令；不会把 GitHub token 回传给网页。远端地址可以通过 `LAIN42_DESKTOP_URL` 覆盖，便于内测和私有化部署。

## GitHub Actions 远端构建

`.github/workflows/lain42-agent-desktop.yml` 是首选构建入口：手动运行 workflow 会并行生成 Windows x64、Linux x64 和 macOS 安装包；推送 `agent-v*` 标签时会自动构建并把产物附加到对应的 GitHub Release。远端 runner 使用固定版本 `tauri-cli 2.11.5`，本地只用于调试和复现。

## Radxa A7A / ARM64

Radxa A7A 使用 `aarch64` Linux 时可以直接运行同一套 Agent。推荐使用 Debian/Ubuntu 或 Radxa OS 的桌面镜像，并确认 WebKitGTK 能正常工作；Agent 的 CLI 执行仍然在板端完成，`gh` 的登录目录、工具输出上限和超时策略与 x64 相同。

```bash
sudo apt update
sudo apt install -y build-essential curl pkg-config \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev patchelf
gh auth login
cd tauri
cargo binstall tauri-cli@2.11.5 --no-confirm
cargo tauri build --bundles deb
```

在板端执行 `uname -m` 应看到 `aarch64`；产物位于
`tauri/target/release/bundle/deb/`。如果该架构的 `cargo-binstall` 没有对应
预编译 CLI，改用 `cargo install tauri-cli --version 2.11.5 --locked`，只影响
构建时间，不影响运行时。没有图形桌面时，使用浏览器/PWA 访问 Agent，并让一台
已配对的 Tauri 桌面或 `lain42-agent-companion` 执行本机 CLI。无头连接器只接受
出站 WSS，不开放公网 shell 端口；它与网页共用同一配对协议和受控操作边界。

### Radxa 无头连接器

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev
gh auth login
cargo build --release --manifest-path tauri/agent-companion/Cargo.toml --locked
```

在网页 Agent 的「CLI desktop bridge」卡片创建短时票据。Radxa 调用
`POST /api/agent/pairings/claim` 领取票据，把返回的 `confirmation_ticket`
粘回网页；网页确认后，Radxa 调用 `POST /api/agent/pairings/redeem`，仅将返回
的设备编号和一次性凭证写入权限为 `0600` 的环境文件，再启动
`tauri/agent-companion/target/release/lain42-agent-companion`。完整环境变量和
systemd 模板见 [`tauri/agent-companion/README.md`](agent-companion/README.md)。
