# Agent browser search triggered a gateway tool-schema error

**Date:** 2026-09-26
**Severity:** High for research queries; simple model chat was separately affected by a disk-pressure incident that has since been cleared.
**Status:** Fix and regression coverage prepared; GitHub Actions verification and deployment are pending.

## User-visible behavior

- A normal `say hi` request previously failed with `system disk overloaded (current: 96.2%, threshold: 95%)`. After the clean-image deployment, the production root disk was reported at 75%, and a fresh authenticated chat completed successfully.
- A fresh request, `DeepSeek 是什么？请用一句话说明它是公司、模型系列还是搜索工具。`, failed in the live Agent with a vLLM Pydantic validation error while the browser search tool was being selected.

## Root cause

The browser already had a WASM-backed search adapter, but a known AI name caused `webAgentToolProvider.getToolChoice` to force provider-native `tool_choice: required`. The selected inference route rejected that tool request. The search result had not yet been obtained in the browser, so it could not ground the model's answer.

## Fix prepared

- Pre-search supported public indexes in the browser for routed web-search requests, including known AI entities and explicit search requests.
- Add bounded result titles, URLs, excerpts, and retrieval time as an explicitly untrusted context message before the latest user turn; do not send browser cookies.
- Do not expose web-agent tools to the model for a request whose search context was already prepared; honor existing routing that declines searches.
- Answer a short `say hi` greeting locally so it does not require inference availability.
- If browser search fails, pass a sanitized lookup-failed context to the model rather than leaking upstream details or claiming results were found.

## Regression coverage prepared

- A named AI-definition query sends browser WASM excerpts and source URLs to the model with no provider-native tools advertised.
- An explicit GitHub web-search query follows the same browser-first route.
- A search failure is explained without exposing its internal error.
- A `say hi` greeting returns locally without making a model request.

## Verification

- `git diff --check` passes.
- No local build or tests were run, following the project constraint that builds and tests run through GitHub Actions only.
- The live site was manually exercised before this patch: the greeting completed after the disk cleanup; the named-AI search reproduced the validation error. The new patch itself has not yet been tested in Actions or deployed.
- GitHub Actions run and post-deployment browser verification are pending.
