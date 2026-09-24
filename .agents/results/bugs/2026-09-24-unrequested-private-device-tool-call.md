# Generic chat triggered unrequested Agent tools

**Date**: 2026-09-24  
**Severity**: High (unexpected access to a user's private device)  
**Status**: Fix implemented; awaiting GitHub Actions and production verification

## Problem

A normal knowledge question about Rust caused the model to propose `files.browse`. The browser provider advertised paired-device tools for unrelated requests and treated non-GitHub tools as runnable by default. The paired device rejected the request because its workspace was not configured; no file listing was returned. This also risked routing unrelated conversation to a user's private Radxa or desktop.

A second reproduction showed that the phrase “不需要搜索” still advertised and ran `web.search`: the positive keyword matcher saw “搜索” without honoring the surrounding negation. The browser-side search then returned large, irrelevant results and the model could not summarize them.

## Fix

Use a fail-closed intent map for local and paired-device tools. A tool is advertised and executable only when the latest user request explicitly matches its operation and target: workspace listing needs an explicit workspace/file request, file preview needs an explicit file-read request, and code/history tools need matching repository intent. Unknown local tool names remain disabled until mapped. Web research honors explicit Chinese and English negation before matching positive search terms. With no eligible tools, the request explicitly disables tool calls and rejects any hallucinated calls before requesting a direct answer.

## Regression coverage

Tests cover generic questions excluding local file/code/history/search tools, Chinese and English “do not search” requests, explicit workspace requests enabling only the matching operation, file preview requiring an explicit file target, and a model-proposed unrelated `files.browse` call being rejected without invoking the paired device.

## Verification

Pending GitHub Actions. Local builds and tests are intentionally not used; production verification will use the CI-built artifact.
