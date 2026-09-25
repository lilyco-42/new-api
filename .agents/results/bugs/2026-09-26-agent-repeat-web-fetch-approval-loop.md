# Bug: Repeated browser URL fetch asks for approval again
**Date**: 2026-09-26
**Severity**: MEDIUM
**Status**: FIXED, CI and production verification pending

## Problem
When the Agent read a public URL, it completed `web.fetch` once but requested the identical page again. Each duplicate call reopened the browser approval prompt, and declining a later prompt ended the turn with `Tool call web.fetch was not approved` instead of summarizing the content already fetched.

## Root Cause
The local tool loop deduplicated repeated `web.search` calls but did not track completed `web.fetch` calls. Repeated model tool calls therefore passed through approval and fetch again.

## Fix
Normalize the fetch URL by removing its fragment and track completed page reads. When the model asks for the same page again, skip approval and refetch, provide a duplicate-call result, and synthesize a final answer using the content already returned.

## Files Modified
- `web/src/features/playground/hooks/local-tool-loop.ts`
- `web/src/features/playground/hooks/__tests__/local-tool-loop.test.ts`

## Testing
- [x] Regression test added for a repeated URL with and without a fragment.
- [ ] GitHub Actions regression checks.
- [ ] Production browser verification.

## Prevention
Keep per-turn call signatures for public browser reads so a model retry cannot repeatedly prompt or fetch an already-read page.
