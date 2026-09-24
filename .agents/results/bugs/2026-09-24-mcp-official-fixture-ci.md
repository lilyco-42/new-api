# MCP official interoperability CI fixture failure

## Root cause

The official MCP interoperability workflow had two independent failures. The Linux setup requested `@modelcontextprotocol/server-everything@2.0.0`, but that npm package version does not exist. macOS and Windows compiled the new ignored test module and found that `McpClient::close_with_timeout` returns `Option<QuitReason>`, while the helper promised `Result<(), String>`.

## Fix

- Pin the official test fixture to the published `2026.8.31` package version.
- Explicitly discard the optional quit reason after a successful close so the test helper returns `Result<(), String>`.

## Verification

- GitHub Actions run `36011566861` reproduced both failures on September 24, 2026.
- `npm view @modelcontextprotocol/server-everything@2026.8.31 version bin --json` confirms that the pinned package exists and exposes `dist/index.js` as `mcp-server-everything`.
- `git diff --check` passes after the fix.
- Cross-platform compilation and live stdio/Streamable HTTP behavior remain pending the next GitHub Actions run; no local build or tests were run.

## Prevention

Pin test fixtures only to versions confirmed in the package registry, and make helper return types reflect or explicitly discard library return values.
