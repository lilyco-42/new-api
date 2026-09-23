# Bug: Agent route redirects between `/agent` and `/agent/`

**Date**: 2026-09-23

**Severity**: HIGH

**Status**: FIXED AND DEPLOYED

## Problem

Opening the public Agent route returned alternating 301 redirects between
`/agent` and `/agent/`, preventing the Agent page and its tools from loading.

## Root Cause

The embedded static filesystem reported any openable path as an existing asset,
including directories without an `index.html`. The browser WASM asset created an
`agent/` directory, so the static file server claimed the `/agent` SPA route and
performed directory redirects instead of falling through to the application.
The existence check also left opened filesystem handles unclosed.

## Fix

Only report regular files or directories containing `index.html` as static
assets, and close handles after inspecting them. Both `/agent` page forms are
also registered as explicit SPA routes before the plugin router snapshots its
static route table. Asset-only directories fall through while nested files
remain directly serveable.

## Files Modified

- `common/embed-file-system.go`
- `common/embed-file-system_test.go`
- `router/main.go`
- `router/web-router.go`
- `router/web-router_test.go`

## Testing

- [x] Regression test failed before the fix because `/agent` was considered an
  existing static path.
- [x] Regression test asserts `/agent` and `/agent/` both serve the SPA without
  redirecting.
- [x] `go test ./common ./router`
- [x] `go test ./...`
- [x] Production `agent-c1b50d2` is healthy; `/agent`, `/agent/`, and the WASM
  asset each return HTTP 200 without redirects.
- [x] Browser navigation with a cache-busting query reaches the sign-in page.

## Existing Browser Cache

Browsers that cached both old permanent redirects may continue looping on the
bare `/agent` URL. Open `/agent?cacheBust=c1b50d2` once or clear that site's
cached redirects; the deployed server now serves both URL forms directly.

## Prevention

Embedded static route existence checks must distinguish files from directories
and mirror the index-file rule used for directory serving.
