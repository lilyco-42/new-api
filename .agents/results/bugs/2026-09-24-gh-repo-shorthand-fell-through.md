# GitHub repository shorthand fell through to model advice

**Date:** 2026-09-24  
**Severity:** Medium (incorrect authentication guidance)  
**Status:** Fixed and verified in production

## Problem

In the Agent page, the request `gh repo 我的项目` received advice to sign in to the local GitHub CLI even though the browser showed `OAuth connected · lilyco-42`.

## Root cause

The GitHub intent matcher recognized repository reads only when the message included an explicit list/view verb such as “查看” or “list”. The shorthand named a GitHub repository and said “my projects”, but had no recognized verb. The browser OAuth repository preflight therefore did not run and the model generated unsupported CLI-login advice.

## Fix

Treat ownership phrases such as “我的”, “我自己的”, and “my own” as an implicit request to list repositories when a GitHub repository term is present. Browser repository requests then use the existing deterministic OAuth preflight, so the model cannot substitute a local `gh` login requirement.

## Regression coverage

- `gh repo 我的项目` resolves to the browser OAuth repository-list intent, not a local CLI request.
- The tool loop calls `/api/agent/github/repositories` before inference and returns the OAuth result without asking the model to guess.

## Verification

- [GitHub Actions run 35982609589](https://github.com/lilyco-42/new-api/actions/runs/35982609589) passed the frontend build and tests, Agent API tests, device ownership tests, and Linux amd64 build.
- The deployed server binary SHA-256 (`0de83e0e7f2c2cf67d22fa256d9ecf6d2329daf394adc33d066c56284cbb6fc8`) matches the Actions artifact; the production container is healthy.
- Live browser test with the linked `lilyco-42` OAuth account: `gh repo 我的项目` returned 10 repository entries through browser OAuth in 884 ms. The OAuth/CLI-confusion text received the correct clarification in 24 ms without a model call. No Radxa or local `gh` operation was used.
- The incorrect response already stored in the older chat remains as history; new requests use the fixed route.
