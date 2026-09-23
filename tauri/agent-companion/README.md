# Lain42 Agent Companion（Radxa A7A / Linux ARM64）

Radxa A7A 是 headless 执行节点。此二进制不链接 Tauri、WebView、KDE、GTK、X11、Wayland 或浏览器，也不启动 HTTP 服务或监听端口。网页和手机负责 UI、会话及默认的 lain42 网关模型；节点只通过一条认证后的**出站** WSS 连接执行受限的 `gh`、CLI 和可选 MCP 工具请求。

节点不会接受任意 shell 文本。GitHub 操作使用共享的固定操作协议；MCP 必须由节点管理员在本地配置文件中逐项允许。设备凭证、GitHub 登录态和 MCP token 都留在节点上，错误、工具目录和日志不会回传这些值。

jj 历史、ast-grep 搜索、CodeGraph 查询和工作区文件浏览只在显式配置的
`LAIN42_AGENT_WORKSPACE` 子目录内运行；这些操作只读。文件预览最多 16 KiB，
常见密钥/凭据文件会被拒绝，并且网页会先向用户确认是否把文件内容发送给所选模型。

## 推荐安装：网页引导，一条命令接入

正常使用不需要在 Radxa 上安装 Rust 或编译。二进制由 GitHub Actions 针对
ARM64 构建，并随 `lain42-agent-v*` 标签发布。网页上的“复制 Radxa 安装命令”
会固定到当前发布版本，并传入当前网站地址。

1. 登录 Lain42，在 Agent 工作区创建短时配对票据，然后复制安装命令。
2. 通过 SSH 或本地终端登录 Radxa 的日常用户账号，粘贴命令。安装器下载预构建包、
   校验 SHA-256，并在终端中隐藏输入配对票据；安装系统服务时可能会要求输入 sudo 密码。
3. 将终端显示的确认票据填回网页并点击“确认”；回到 Radxa 终端按 Enter。
4. 安装器把凭证写到 `~/.config/lain42/agent-companion.env`（仅当前用户可读），
   安装 systemd 服务并设置开机启动。设备以主动出站 WSS 连接网站，不开放公网 SSH，
   也不会加入共享算力市场。

安装后可在 Radxa 上用隔离目录登录自己的 GitHub CLI。此令牌只留在这台设备上：

```bash
GH_CONFIG_DIR="$HOME/.config/lain42/gh/radxa-a7a" gh auth login
```

服务以当前 Linux 用户运行。工作区工具默认关闭；确认只读目录后，可在配对凭证文件中
添加 `LAIN42_AGENT_WORKSPACE="/path/to/your/workspace"`，再重启
`sudo systemctl restart "lain42-agent-companion@$(id -un).service"`。

若需更新或恢复已配对设备，在网页复制重启命令即可；无需再次创建配对票据。

## 开发者构建和直接启动

此节仅供修改 companion 的开发者使用。普通用户应使用上方 GitHub Actions 预构建安装器。

在 Radxa A7A 的 Debian/Ubuntu/Radxa OS 上安装 Rust 后，只需要常规 Rust/TLS 构建依赖；不需要桌面环境或 Tauri CLI：

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev
cargo build --release --manifest-path tauri/agent-companion/Cargo.toml
```

从仓库根目录运行时，二进制路径是：

```bash
tauri/agent-companion/target/release/lain42-agent-companion
```

GitHub 功能需要在为 companion 隔离的配置目录中完成一次 CLI 登录；未使用 GitHub 功能时可省略 `gh auth login`：

```bash
export LAIN42_AGENT_PROFILE="radxa-a7a"
export LAIN42_GH_CONFIG_DIR="$HOME/.config/lain42/gh/radxa-a7a"
mkdir -p "$LAIN42_GH_CONFIG_DIR"
GH_CONFIG_DIR="$LAIN42_GH_CONFIG_DIR" gh auth login
```

设置配对后得到的设备 ID 和凭证后启动：

```bash
export LAIN42_AGENT_DEVICE_ID="123"
export LAIN42_AGENT_CREDENTIAL="<redeemed-device-credential>"
export LAIN42_AGENT_PROFILE="radxa-a7a"
export LAIN42_GH_CONFIG_DIR="$HOME/.config/lain42/gh/radxa-a7a"
export LAIN42_AGENT_WORKSPACE="/srv/workspace"
exec tauri/agent-companion/target/release/lain42-agent-companion
```

默认桥接地址为 `wss://api.lain42.top/api/agent/bridge/desktop`。私有部署可设置 `LAIN42_AGENT_BRIDGE_URL`，但必须是 `wss://`；程序拒绝 `ws://`，避免设备凭证落入明文网络。断线从 2 秒开始指数退避，最高 60 秒。

## 可选 MCP 节点配置

没有 `LAIN42_MCP_CONFIG_FILE` 时，`mcp.list` 返回空目录，`mcp.call` 被拒绝。设置该变量后，文件必须是 owner-only 的常规 JSON 文件（Unix 权限 `0600` 或更严格），最多 64 KiB、4 个 server；每个工具都必须在 `allowed_tools` 中显式列出。token 只可引用环境变量名，不能写在 JSON 中。

```bash
install -d -m 0700 "$HOME/.config/lain42"
cat > "$HOME/.config/lain42/mcp.json" <<'JSON'
{
  "servers": [
    {
      "server_id": "workspace",
      "name": "Read-only workspace",
      "transport": "stdio",
      "command": "/usr/local/bin/mcp-workspace",
      "args": ["--root", "/srv/workspace", "--read-only"],
      "allowed_tools": ["list_files", "read_file"]
    },
    {
      "server_id": "docs",
      "name": "Documentation",
      "transport": "streamable_http",
      "url": "https://mcp.example.invalid/mcp",
      "bearer_token_env": "RADXA_DOCS_MCP_TOKEN",
      "allowed_tools": ["search"]
    }
  ]
}
JSON
chmod 0600 "$HOME/.config/lain42/mcp.json"
export LAIN42_MCP_CONFIG_FILE="$HOME/.config/lain42/mcp.json"
```

`stdio` 以可执行文件和 argv 启动，不经 shell。Streamable HTTP 只接受公开 `https://` 地址：拒绝用户名、密码、fragment、localhost、私网/IP literal，并在连接前解析 DNS；请求不使用代理或重定向。每次 MCP list/call 使用独立会话，最多 64 个工具/服务、128 个工具总数、32 KiB 参数、64 KiB 结果、10 秒连接和目录超时、30 秒调用超时。超时会取消并关闭会话。

### Lilyco 兼容

Lilyco 的 `lilyco-core` schema 可通过其 `lilyco --mcp` 入口接入，不需要为
CLI、TUI、Web 和 Agent 分别写一套工具。把它作为本地 stdio server 加入
上面的配置即可：

```json
{
  "server_id": "lilyco",
  "name": "Lilyco tools",
  "transport": "stdio",
  "command": "/usr/local/bin/lilyco",
  "args": ["--mcp"],
  "allowed_tools": ["read_file"]
}
```

实际工具名仍以 `tools/list` 返回值为准；示例中的 `read_file` 必须替换成
Lilyco 实际暴露且经过核验的工具名，不能使用通配符。Lain42 只依赖 MCP 的稳定边界和 Agent bridge v1，不依赖
Lilyco 的内部 Rust 模块，因此未来可替换 Lilyco 版本或接入另一种 MCP
实现而不改网页模型循环。

撤销网页中的设备授权后，服务端会立即拒绝该节点的新桥接连接；重连不会重新授权它。
