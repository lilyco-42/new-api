# Generic chat triggered unrequested Agent tools

**Date**: 2026-09-24  
**Severity**: High (unexpected access to a user's private device)  
**Status**: Resolved and verified in production

## Problem

A normal knowledge question about Rust caused the model to propose `files.browse`. The browser provider advertised paired-device tools for unrelated requests and treated non-GitHub tools as runnable by default. The paired device rejected the request because its workspace was not configured; no file listing was returned. This also risked routing unrelated conversation to a user's private Radxa or desktop.

A second reproduction showed that the phrase “不需要搜索” still advertised and ran `web.search`: the positive keyword matcher saw “搜索” without honoring the surrounding negation. The browser-side search then returned large, irrelevant results and the model could not summarize them.

## Fix

Use a fail-closed intent map for local and paired-device tools. A tool is advertised and executable only when the latest user request explicitly matches its operation and target: workspace listing needs an explicit workspace/file request, file preview needs an explicit file-read request, and code/history tools need matching repository intent. Unknown local tool names remain disabled until mapped. Web research honors explicit Chinese and English negation before matching positive search terms. With no eligible tools, the request explicitly disables tool calls and rejects any hallucinated calls before requesting a direct answer.

## Regression coverage

Tests cover generic questions excluding local file/code/history/search tools, Chinese and English “do not search” requests, explicit workspace requests enabling only the matching operation, file preview requiring an explicit file target, and a model-proposed unrelated `files.browse` call being rejected without invoking the paired device.

## Verification

GitHub Actions run [`35975708173`](https://github.com/lilyco-42/new-api/actions/runs/35975708173) passed the frontend build and tests, Agent API tests, device re-pair tests, and Linux amd64 build. Production runs `lain42/new-api:agent-f1407dd`; the binary SHA-256 matches the CI artifact (`5f3209fccc0e3d4f63bd3fef6cae3aa342858945d2b4f888f152c1dddd4fbdeb`). The container is healthy, and `/agent` and `/api/status` both return HTTP 200.

Two live browser checks succeeded: a plain Rust question and the same question explicitly saying not to search. Both received direct answers without `web.search`, workspace, or paired-device tool events. No local build or test was run; verification used GitHub Actions and the deployed site.

## Prevention

Treat tool execution as a separately authorized action: model-proposed calls are insufficient. Keep intent filters fail-closed for private-device tools, recognize negation before positive search keywords, and force text-only inference when no tools are eligible.
