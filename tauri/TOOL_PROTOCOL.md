# Agent Tool Protocol v1

The desktop shell exposes one versioned tool boundary instead of one Tauri
command per executable.

The paired WebSocket handshake carries `protocol_version: 1` and a bounded
capability list (`github.read`, `mcp.list`, `mcp.call`). Version 1 peers may
omit these fields for backwards compatibility. A future incompatible wire
change must use a new version; additive fields and capabilities are ignored by
older peers. The server advertises the negotiated version in `hello_ack`, so a
desktop or headless node can fail closed with a useful upgrade message instead
of attempting a partially compatible execution.

The language-neutral envelope is documented in
[`docs/lain42-agent-bridge-v1.schema.json`](../docs/lain42-agent-bridge-v1.schema.json).
It is intentionally additive and can be consumed by Rust, TypeScript, Go,
Kotlin, Swift, or a Lilyco framework adapter without importing this Go service.

## Manifest

The web Agent owns presentation metadata in
`web/src/features/agent/tool-manifest.ts`:

- `AGENT_TOOL_MANIFEST_VERSION` versions the catalog contract.
- `id` is a stable identifier, never a path or shell fragment.
- `protocol` is `cli` or `mcp`.
- `capabilities` describes what an integration provides without coupling the
  workspace to a specific executable.
- `command`, `installCommand`, and `url` are display-only instructions.
- capabilities can be added to the manifest without changing the workspace UI.

The Tauri shell owns the execution allowlist and operation schemas in
`tauri/src/tool_runtime.rs`. It maps a stable operation id to an executable
and refuses unknown ids. The webview cannot supply an arbitrary executable,
shell fragment, or argument vector. `main.rs` only owns Tauri commands and
profile wiring; it does not contain tool-specific process policy.

## CLI adapter

`tool_status` probes a list of registered ids with `--version`.
`cli_exec` accepts a Tauri request payload such as
`{ request: { operation: "github.issues.list", params: { repo: "owner/name" } } }`.
The runtime validates the operation's typed parameters, constructs the fixed
argv without a shell, enforces a 30-second deadline and a 64 KiB streaming
output limit, and returns the operation, status, bounded output, and truncation
flag. The accepted operations are deliberately read-only in v1:
`github.auth.status`, `github.issues.list`, `github.repositories.search`, and
`github.pull_requests.list`.

`gh` uses the same adapter and automatically receives the current desktop
profile's `GH_CONFIG_DIR` after inherited token environment variables are
cleared, so each desktop user keeps an isolated GitHub login.
The existing structured GitHub commands remain as compatibility helpers and
delegate to the same adapter.

## MCP adapter

The desktop shell now has a separate `rmcp` adapter in
`tauri/src/mcp_client.rs`; MCP calls never pass through `cli_exec`. The web
workspace exposes explicit Connect/Disconnect controls and supports:

- `mcp_connect({ request: { server_id, name, transport, command, args, url, bearer_token } })`
  for user-selected `stdio` or HTTPS Streamable HTTP servers;
- `mcp_list()` for bounded, schema-bearing tool descriptors;
- `mcp_call({ request: { server_id, tool_name, arguments, timeout_ms } })`;
- `mcp_disconnect({ server_id })` for session cleanup.

The adapter does not accept shell fragments; it starts the selected executable
with separate argv arguments. It accepts no URL credentials or HTTP redirects,
limits server/tool/schema/argument/result sizes, bounds connection and call
deadlines, and keeps bearer tokens in the transport session rather than any
response. Tauri desktop MCP calls require an exact-parameter confirmation in
the webview; paired browser calls are confirmed again by the paired desktop.
The headless Radxa companion has no webview and instead requires an owner-only
local configuration with an explicit tool allowlist. Connections are
process-memory sessions and must be recreated after the desktop exits; the
headless companion recreates its configured MCP session for each request.

The paired WebSocket bridge also accepts only `mcp.list` and `mcp.call` in
addition to the four read-only GitHub operations. A browser receives the
already-connected tool descriptors but never receives the stdio command or
bearer token. The desktop remains the execution and approval boundary.

## Paired browser bridge

The Go service exposes a separate WebSocket bridge for a paired desktop and an
authenticated browser. The desktop authenticates its one-time-redeemed device
credential in the first `hello` message; the browser authenticates with its
normal platform session and names a device it owns. The service forwards only
bounded structured `tool_request` / `tool_result` envelopes and never executes
the user's CLI on the server. The bridge does not grant a browser access to a
credential, and it rejects requests after the device is offline or the request
deadline expires. The Agent workspace exposes the pairing action in the desktop
shell and automatically connects an authenticated browser to its first active
device. Durable task recovery and MCP transport remain separate follow-up work.
The desktop credential is persisted under the active desktop profile and is
never sent to the browser after the pairing call. MCP sessions remain process
memory only and must be recreated after the desktop exits. The profile-scoped
file is an interim storage boundary; a system-keychain backend is required
before this is described as an enterprise durable-device-login contract.

## Adding a tool

1. Add one manifest entry with a stable id and protocol.
2. Add one allowlist entry in `tool_runtime.rs` with the executable name and
   profile policy.
3. Do not add a new Tauri command or a tool-specific React component.
4. Add an adapter only when a future protocol needs different transport, such
   as a new MCP transport or a remote worker; do not grow `cli_exec` into an
   arbitrary command runner.

This keeps the UI and transport stable as the tool catalog grows over time.

## Long-lived compatibility rules

- Treat tool ids, protocol values, and capability names as public API. Add new
  values instead of renaming existing ones; deprecate before removal.
- Keep request and response payloads additive. Unknown response fields must be
  ignored by clients, and a future protocol gets a new adapter rather than
  changing `cli_exec` semantics.
- Keep all profile-scoped credentials behind the desktop profile boundary. A
  command must fail closed when the profile directory is unavailable.
- Prefer capability checks (`issues.read`, `code.graph`, `mcp.tools`) over
  executable-name checks in the web UI so tools can be replaced later.
- Keep the bridge handshake and tool catalog independently versioned. The
  stable bridge envelope is the compatibility layer for Tauri, Radxa and
  future Lilyco clients; do not expose Go service internals or desktop-specific
  command names as the public contract.
- A Lilyco framework integration should implement the same `AgentBridgeClient`
  handshake and `LocalToolProvider`/MCP adapter boundary. That permits a new
  Rust, Android, iOS, WebView or server-side shell to reuse the model loop
  without copying credential handling or tool policy.
