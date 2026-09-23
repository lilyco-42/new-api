# Lain42 Agent Companion（Radxa A7A / Linux ARM64）

Radxa A7A 是 headless 执行节点。此二进制不链接 Tauri、WebView、KDE、GTK、X11、Wayland 或浏览器，也不启动 HTTP 服务或监听端口。网页和手机负责 UI、会话及默认的 lain42 网关模型；节点只通过一条认证后的**出站** WSS 连接执行受限的 `gh`、CLI 和可选 MCP 工具请求。

节点不会接受任意 shell 文本。GitHub 操作使用共享的固定操作协议；MCP 必须由节点管理员在本地配置文件中逐项允许。设备凭证、GitHub 登录态和 MCP token 都留在节点上，错误、工具目录和日志不会回传这些值。

jj 历史、ast-grep 搜索、CodeGraph 查询和工作区文件浏览只在显式配置的
`LAIN42_AGENT_WORKSPACE` 子目录内运行；这些操作只读。文件预览最多 16 KiB，
常见密钥/凭据文件会被拒绝，并且网页会先向用户确认是否把文件内容发送给所选模型。

## 构建和直接启动

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

## 一次性配对

1. 在 Lain42 网页的 Agent 卡片创建 pairing ticket，并记录网页显示的 pairing ID。
2. 在 Radxa 上读取票据（不会进入 history），领取确认票据。以下示例需要 `jq`，它只会输出需要贴回网页的确认票据，绝不打印完整响应或兑换票据：

   ```bash
   sudo apt install -y jq
   export LAIN42_API_URL="https://api.lain42.top"
   read -r -s -p 'Pairing ticket: ' PAIRING_TICKET; printf '\n'
   CLAIM_JSON=$(curl --fail-with-body --silent --show-error \
     -X POST "$LAIN42_API_URL/api/agent/pairings/claim" \
     -H 'Content-Type: application/json' \
     --data "{\"pairing_ticket\":\"$PAIRING_TICKET\",\"device_name\":\"radxa-a7a\",\"device_public_key\":\"radxa-a7a-$(hostname)\"}")
   export PAIRING_ID=$(printf '%s' "$CLAIM_JSON" | jq -er '.data.id // .id')
   export REDEEM_TICKET=$(printf '%s' "$CLAIM_JSON" | jq -er '.data.redeem_ticket // .redeem_ticket')
   printf '%s\n' "$(printf '%s' "$CLAIM_JSON" | jq -er '.data.confirmation_ticket // .confirmation_ticket')"
   unset PAIRING_TICKET CLAIM_JSON
   ```

3. 将上一步输出的 `confirmation_ticket` 填回网页确认入口。确认完成后，在同一终端兑换一次性设备凭证。命令把结果写入权限为 `0600` 的文件，避免凭证出现在终端、history 或 systemd 单元中：

   ```bash
   CREDENTIAL_JSON=$(curl --fail-with-body --silent --show-error \
     -X POST "$LAIN42_API_URL/api/agent/pairings/redeem" \
     -H 'Content-Type: application/json' \
     --data "{\"pairing_id\":$PAIRING_ID,\"redeem_ticket\":\"$REDEEM_TICKET\"}")
   umask 077
   printf 'LAIN42_AGENT_DEVICE_ID=%s\nLAIN42_AGENT_CREDENTIAL=%s\nLAIN42_AGENT_PROFILE=radxa-a7a\nLAIN42_GH_CONFIG_DIR=%s/.config/lain42/gh/radxa-a7a\n' \
     "$(printf '%s' "$CREDENTIAL_JSON" | jq -er '.data.device.id // .device.id')" \
     "$(printf '%s' "$CREDENTIAL_JSON" | jq -er '.data.credential // .credential')" "$HOME" \
     > "$HOME/.config/lain42-agent-companion.env"
   unset REDEEM_TICKET PAIRING_ID CREDENTIAL_JSON
   ```

撤销设备后，服务端会拒绝该节点的连接；重连不会重新授权它。

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

## systemd 常驻运行

将二进制安装到 `/opt/lain42-agent-companion/lain42-agent-companion`，把上面生成的环境文件复制为 `/etc/lain42-agent-companion.env` 并限制权限，再启用仓库提供的 unit：

```bash
sudo install -m 0755 tauri/agent-companion/target/release/lain42-agent-companion /opt/lain42-agent-companion/lain42-agent-companion
sudo install -m 0600 "$HOME/.config/lain42-agent-companion.env" /etc/lain42-agent-companion.env
sudo install -m 0644 tauri/agent-companion/lain42-agent-companion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lain42-agent-companion
sudo systemctl status lain42-agent-companion
```

在 `/etc/lain42-agent-companion.env` 中另行设置 `LAIN42_AGENT_WORKSPACE=/srv/workspace`（替换为你授权的实际目录）。`lain42-agent` 必须拥有该目录的只读遍历/读取权限；不要把整个用户 home 或含凭据的目录作为工作区。若以 `lain42-agent` 用户运行，环境文件中的 `LAIN42_GH_CONFIG_DIR` 和 `LAIN42_MCP_CONFIG_FILE` 应在该用户 home 下，并归该用户所有。服务模板使用 `UMask=0077`、受限写目录和 `wss://` 出站模式；不需要也不会启动任何桌面服务。
