# Public research must never fall through to account GitHub search

**Date:** 2026-09-26  
**Severity:** High (private-account data boundary)  
**Status:** Follow-up fix prepared; Actions verification and deployment pending.

## Observed behavior

After deployment of `agent-c10b273`, a browser-only request to find the public
official `ast-grep` repository explicitly said not to search the user's personal
repositories. The live Agent still emitted a completed
`github.oauth.repositories.search` tool event. Generation was stopped without
inspecting or using that tool result.

The same deployment also returned “no public browser-index results” for a
DeepSeek definition request. This was not the gateway validation error fixed in
`2026-09-26-agent-search-gateway-validation.md`; it was a query-quality failure.

## Cause

- `targetsAccountRepositories` treated a negated phrase such as “不要搜索我的
  个人仓库” as positive account-search intent.
- `webAgentToolProvider.availableTools` exposed every web/GitHub tool before the
  model chose one, even when only browser public search matched the request.
- Known AI definition requests passed the full natural-language question as an
  index search term, which often produced no usable result.

## Follow-up change

- Ignore a negated mention of personal repositories when selecting account
  OAuth search.
- Advertise only tools allowed by the latest user intent; prepared browser
  context continues to disable additional tool calls for that turn.
- Search known AI definitions by the recognized entity name, not the entire
  question.

## Verification

- Production version `agent-c10b273` served `/api/status` successfully and its
  container was healthy. Root disk usage was 75% (9.8 GB available).
- A normal Rust question reached inference and returned in 4.25 seconds.
- The public GitHub query reproduced the account-search routing issue once.
- `git diff --check` passes for the follow-up patch. Builds and tests are being
  run through GitHub Actions only.
- CI and post-deployment public-source search checks are pending.
