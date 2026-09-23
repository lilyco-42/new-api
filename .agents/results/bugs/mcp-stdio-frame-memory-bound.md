# MCP stdio frame memory bound

Date: 2026-09-24

## Symptom and root cause

The desktop and headless companion capped tool results after RMCP had parsed
the response. For stdio MCP, RMCP 3.4.0 first reads a complete newline-delimited
JSON-RPC message into an internal `Vec`; an untrusted or broken MCP child could
emit an arbitrarily long line and grow that buffer before the application-level
64 KiB check ran. Streamable HTTP already configures an SSE event-size limit.

## Fix

Both stdio clients now use the same bounded reader and RMCP async read/write
transport. The reader tracks each line and returns `InvalidData` as soon as a
line exceeds 64 KiB, before forwarding the overflowing chunk to RMCP. The
transport retains process-wrap child cleanup, including cleanup on connection
failure or disconnect. HTTP transport behavior is unchanged.

## Regression coverage

- Accept a line exactly at the limit and verify the counter resets after LF.
- Reject a line one byte over the limit and verify overflow bytes are not
  forwarded.
- GitHub Actions must pass desktop and headless companion Rust tests and all
  platform builds before release. No local Rust build was used.

## Prevention

Keep limits at byte-stream boundaries, before parsing or deserializing remote
data. Post-parse size checks remain useful for product-level response budgets,
but are not substitutes for transport framing limits.
