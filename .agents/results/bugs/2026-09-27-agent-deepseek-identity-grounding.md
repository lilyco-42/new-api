# Bug: DeepSeek identity answers confuse the company with its model-hosting profile

**Date**: 2026-09-27
**Severity**: HIGH
**Status**: Fix prepared; GitHub Actions and production verification pending

## Problem

On the live Agent, asking what DeepSeek is could produce answers that called it a Hugging Face organization or mixed the organization, research team, and model series without directly identifying the company. The behavior reproduced while the paired Radxa device was offline, so device availability was not the cause.

## Root Cause

The identity preflight supplied Hugging Face organization/model results together with a general model-disclosure page. That disclosure called the legal entity a research team but did not directly state that it owns and operates DeepSeek products. After adding the terms page, production returned HTTP 200 for both bounded fetch requests but the identity preflight still failed closed; a separate user-provided URL read successfully returned the same terms text. This points to a preflight aggregation/validation failure rather than network access. The helper discarded per-page diagnostics, so the exact failing predicate could not be observed.

## Fix

- Use DeepSeek's official Terms of Use as direct company/operator evidence.
- Reduce identity verification to one sequential official page so the result follows the already verified single-URL reading path.
- For identity questions, send only the verified official pages into the model context; do not include Hugging Face publisher profiles as identity evidence.
- Tell the model to classify the name as the company/operator when that is what the official evidence establishes, while continuing to generate the answer from evidence and attach a source link.
- Add a regression case that checks the grounded context and citations.

## Files Modified

- `web/src/features/agent/web-agent-tool-provider.ts`
- `web/src/features/agent/__tests__/web-agent-tool-provider.test.ts`

## Testing

- [x] Live failure reproduced after reloading the deployed app; official disclosure was present, but the answer still did not clearly classify the company.
- [x] Regression test added for official ownership evidence, separate model evidence, removal of hosting-profile noise, and citations.
- [ ] Run affected test, typecheck, lint, and production package through GitHub Actions.
- [ ] Re-test the deployed Agent in the browser and verify both the answer and source links.

## Prevention

For entity-identity questions, prefer primary sources that explicitly identify the legal operator. Treat hosting accounts as publisher evidence only, and verify the final answer against the source category the user asked about.
