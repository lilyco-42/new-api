# Browser GitHub OAuth was confused with local CLI login

**Date**: 2026-09-24  
**Severity**: Medium (confusing authentication guidance)  
**Status**: Resolved and verified in production

## Problem

The Agent could show `OAuth connected · lilyco-42` and still tell the user to run `gh auth login`. The browser OAuth credential and a device's `gh` login are separate, but the old production image (`agent-abe183b`) did not contain the source correction. Even after updating the site, `tool_choice: auto` still let a model answer a normal "view my GitHub repositories" request from the connection summary instead of calling the OAuth repository endpoint.

## Fix

Render local `gh` status, login details, and CLI setup instructions only when the Tauri runtime is present. In browser sessions, correct pasted OAuth/CLI confusion locally and read the user's repository list directly through the OAuth API before asking the model to answer. This avoids depending on models that ignore tool requests or emit invalid forced-tool JSON. Repository reads do not depend on device `gh` authentication.

## Regression coverage

Tests assert that browser sessions hide local `gh` login controls, that the OAuth repository endpoint is called for "view my repositories" without a model request, and that asynchronous pre-model handling works when tool providers are combined.

## Verification

GitHub Actions run [`35968759817`](https://github.com/lilyco-42/new-api/actions/runs/35968759817) passed the frontend tests, Go agent API tests, device re-pair tests, and amd64 build. Production now runs `lain42/new-api:agent-c8ab627`; the deployed binary SHA-256 matches the CI artifact (`f7298c1e672a06492bba81de29a9f5906a0ceb0380e01ae9f94d060092e76eb6`). The container is healthy and both `/agent` and `/api/status` return HTTP 200. A live browser test with the connected GitHub OAuth account returned 10 repository entries, with no CLI-login advice or inference error. No Radxa/CLI operation was used.
