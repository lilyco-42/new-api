# Agent Tool Protocol v1

The desktop shell exposes one versioned tool boundary instead of one Tauri
command per executable.

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

MCP entries stay in the catalog until an MCP session adapter is enabled. They
must never be passed to `cli_exec`; an MCP adapter will get its own transport,
session lifetime, permission prompt, and server allowlist.

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
The current desktop credential is held in process memory and must be paired
again after the shell exits until OS keychain storage lands.

## Adding a tool

1. Add one manifest entry with a stable id and protocol.
2. Add one allowlist entry in `tool_runtime.rs` with the executable name and
   profile policy.
3. Do not add a new Tauri command or a tool-specific React component.
4. Add an adapter only when a future protocol needs different transport, such
   as an MCP session or a remote worker.

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
