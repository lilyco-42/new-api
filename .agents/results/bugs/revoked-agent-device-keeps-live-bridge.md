# Bug: Revoked Agent device kept a live bridge

**Status:** Fixed in source; GitHub Actions verification pending
**Severity:** High (revocation / account authorization boundary)

## Expected and actual behavior

When an owner revokes a paired device, its active companion connection and pending tool calls must stop being usable. A database record should not be the only part of the system that changes.

Before this fix, `service.RevokeAgentDevice` only updated the database. `AgentBridgeHub` kept the desktop socket and pending request map, so a browser WebSocket that had already passed its initial owner check could continue relaying requests.

## Reproduction trace

1. Pair a headless companion and open an authenticated browser bridge to that owner's device.
2. Keep the desktop WebSocket open and have a tool request pending.
3. Revoke the device through the authenticated device endpoint.
4. The database marks the device revoked, but the hub still reports the desktop connected and does not clear its pending relay state.

This was established by tracing the endpoint through `service.RevokeAgentDevice`, `model.RevokeAgentDevice`, and the process-local `AgentBridgeHub` maps; no production user's device was contacted.

## Root cause and fix

The revoke service did not coordinate the persistent record with the in-memory bridge lifecycle. The service now confirms owner-scoped device access, then asks the hub to fence that device while the database change runs. The hub cancels pending calls, rejects new requests during the transition, removes and closes the desktop connection after successful persistence, and retains an in-memory revoked fence against stale handshakes. If persistence fails, the temporary fence is cleared and the authorized desktop remains available.

The relay also re-checks the bridge lifecycle under the hub lock immediately before writing a request to the desktop, closing the race between accepting a request and beginning revocation.

## Regression coverage

- Successful revocation blocks relay requests during persistence, interrupts pending work, and makes the device unavailable afterward.
- Failed persistence restores connected status.
- An owner cannot revoke another user's active device.

These checks run in GitHub Actions; local compilation and tests are intentionally not used for this project.

## Prevention

Any endpoint that revokes credentials, device access, or account authorization must invalidate process-local sessions and pending requests in the same service operation. Keep account identity server-derived, device IDs owner-scoped, and add a two-user bridge contract test whenever the protocol or hub is changed.

## Files

- `service/agent_pairing.go`
- `service/agent_bridge.go`
- `service/agent_bridge_test.go`
