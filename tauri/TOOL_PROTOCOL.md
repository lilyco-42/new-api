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

The Tauri shell owns the execution allowlist in `tauri/src/tool_runtime.rs`.
It maps a stable id to an executable and refuses unknown ids. The webview
cannot supply an arbitrary executable path. `main.rs` only owns Tauri commands
and profile wiring; it does not contain tool-specific process policy.

## CLI adapter

`tool_status` probes a list of registered ids with `--version`.
`cli_exec` accepts a Tauri request payload `{ request: { tool_id, args } }`,
executes the registered binary without a shell, caps argument and output sizes,
and returns `{ tool_id, exit_code, stdout, stderr }`.

`gh` uses the same adapter and automatically receives the current desktop
profile's `GH_CONFIG_DIR`, so each desktop user keeps an isolated GitHub login.
The existing structured GitHub commands remain as compatibility helpers and
delegate to the same adapter.

MCP entries stay in the catalog until an MCP session adapter is enabled. They
must never be passed to `cli_exec`; an MCP adapter will get its own transport,
session lifetime, permission prompt, and server allowlist.

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
