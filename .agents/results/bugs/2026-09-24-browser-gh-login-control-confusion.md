# Browser GitHub OAuth was confused with local CLI login

**Date**: 2026-09-24  
**Severity**: Medium (confusing authentication guidance)  
**Status**: Follow-up fix in source; awaiting CI and production deployment

## Problem

The Agent could show `OAuth connected · lilyco-42` and still tell the user to run `gh auth login`. The browser OAuth credential and a device's `gh` login are separate, but the old production image (`agent-abe183b`) did not contain the source correction. Even after updating the site, `tool_choice: auto` still let a model answer a normal "view my GitHub repositories" request from the connection summary instead of calling the OAuth repository endpoint.

## Fix

Render local `gh` status, login details, and CLI setup instructions only when the Tauri runtime is present. In browser sessions, correct pasted OAuth/CLI confusion locally and read the user's repository list directly through the OAuth API before asking the model to answer. This avoids depending on models that ignore tool requests or emit invalid forced-tool JSON. Repository reads do not depend on device `gh` authentication.

## Regression coverage

Tests assert that browser sessions hide local `gh` login controls, that the OAuth repository endpoint is called for "view my repositories" without a model request, and that asynchronous pre-model handling works when tool providers are combined.

## Verification

GitHub Actions run `35966835540` passed the previous iteration, but an online test with the site's default Llama model showed that `tool_choice: required` can produce invalid tool JSON. That iteration was replaced by a client-side OAuth repository read. Verify it in GitHub Actions and redeploy; do not use a local build for this project.
