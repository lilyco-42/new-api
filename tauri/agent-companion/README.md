# Lain42 Agent Companion（Radxa / Linux ARM64）

这是无桌面连接器。它不提供 HTTP shell，也不运行模型；浏览器、手机和
`api.lain42.top` 负责聊天、模型和计费，Radxa 只通过出站 WSS 接收已授权的
只读工具调用，并在自己的 GitHub CLI 档案中执行。

## 构建与运行

在 Radxa A7A 的 Debian/Ubuntu 或 Radxa OS 上：

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev
gh auth login
cargo build --release --manifest-path tauri/agent-companion/Cargo.toml
```

必须设置以下环境变量；凭证不要提交到仓库：

```bash
export LAIN42_AGENT_DEVICE_ID="123"
export LAIN42_AGENT_CREDENTIAL="<redeemed-device-credential>"
export LAIN42_AGENT_PROFILE="radxa-a7a"
export LAIN42_GH_CONFIG_DIR="$HOME/.config/lain42/gh/radxa-a7a"
./target/release/lain42-agent-companion
```

连接器默认使用
`wss://api.lain42.top/api/agent/bridge/desktop`，断线会指数退避重连。
`LAIN42_AGENT_BRIDGE_URL` 可用于私有化部署，但程序拒绝 `ws://`，避免把长期
设备凭证发到明文连接。

## 一次性配对流程

配对票据只在短时间内有效，长期设备凭证只存 Radxa 的受限环境文件或系统
密钥服务中：

1. 登录 Lain42 网页，在 Agent 的设备配对入口创建 pairing ticket，保存返回的
   `id` 和 `pairing_ticket`。
2. 在 Radxa 上调用 `POST /api/agent/pairings/claim`，提交票据、设备名称和
   一个公开设备标识；保存返回的 `confirmation_ticket`、`redeem_ticket`。
3. 把 `confirmation_ticket` 填回网页的确认入口。
4. 确认成功后在 Radxa 调用 `POST /api/agent/pairings/redeem`，把返回的
   `credential` 写入仅 root/当前用户可读的环境文件，然后启动 companion。

服务器只保存票据摘要；网页和模型永远不会拿到 Radxa 的 `GH_TOKEN`。撤销设备
后，现有连接会被服务端拒绝，不能靠重连恢复。

## systemd

把环境变量放在 `/etc/lain42-agent-companion.env`，权限设为 `0600`，再使用
仓库中的 service 模板。不要把凭证写入命令行参数或日志。

当前共享执行器开放登录状态、仓库搜索、Issue 列表和 Pull Request 列表，仍有
30 秒超时、64 KiB 输出上限和固定操作参数校验；写操作和任意 shell 尚未开放。
