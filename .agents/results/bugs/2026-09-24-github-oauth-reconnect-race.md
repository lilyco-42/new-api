# Bug: GitHub OAuth reconnects while its saved status is still connected

**Date**: 2026-09-24  
**Severity**: MEDIUM  
**Status**: FIXED

## Problem

After loading the Agent workspace, the GitHub OAuth status is fetched asynchronously. The connect button was immediately enabled, and clicking it always opened a new authorization flow even when the status request showed an existing connection. A click during this window could trigger duplicate consent and make connection troubleshooting confusing.

## Root Cause

The status card did not represent its initial loading state, and `connectBrowserGitHub` did not stop when its fresh status check returned `connected: true`.

## Fix

Disable the connect action while the initial status request is pending, hide it for an already connected account, and close a just-opened popup if a fresh status check finds an existing connection. Add regressions for the loading window and a connection that becomes active between page load and click.

## Files Modified

- `web/src/features/agent/components/github-cli-card.tsx`
- `web/src/features/agent/components/github-cli-card.test.tsx`

## Testing

- [x] Regression tests cover pending status and already-connected status.
- [x] Manual production check confirms OAuth connection persists after reload.

## Prevention

Represent asynchronous authorization status explicitly in the UI, and re-check the server state before beginning a new grant flow.
