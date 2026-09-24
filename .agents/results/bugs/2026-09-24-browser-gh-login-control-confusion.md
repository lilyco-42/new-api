# Browser GitHub OAuth was confused with local CLI login

**Date**: 2026-09-24  
**Severity**: Medium (confusing authentication guidance)  
**Status**: Fixed and deployed to production as `agent-08d2a63`

## Problem

The Agent could show `OAuth connected · lilyco-42` and still tell the user to run `gh auth login`. The browser OAuth credential and a device's `gh` login are separate, but the old production image (`agent-abe183b`) did not contain the source correction. Even after updating the site, `tool_choice: auto` still let a model answer a normal "view my GitHub repositories" request from the connection summary instead of calling the OAuth repository endpoint.

## Fix

Render local `gh` status, login details, and CLI setup instructions only when the Tauri runtime is present. In browser sessions, correct pasted OAuth/CLI confusion locally and require a structured GitHub read call for repository, issue, and pull-request requests. Normal browser reads use the site's GitHub OAuth API; they do not depend on device `gh` authentication.

## Regression coverage

Tests assert that browser sessions hide local `gh` login controls, that the OAuth repository endpoint is called for "view my repositories", and that tool-required requests use the structured tool loop.

## Verification

GitHub Actions run `35966835540` passed frontend build/tests, agent API tests, device re-pair lifecycle tests, and the Linux amd64 server build. Its binary SHA-256 (`4dbb45e316b13e7ec6a1221a251f73de4a6dad6cb4c11ab06ef831a5f5a0382a`) matches the deployed container. Production reports the new image healthy and serves both `/agent` and `/api/status` with HTTP 200. The prior image remains available for rollback. Do not use a local build for this project.
