# Bug: DeepSeek identity answers confuse the company with its model-hosting profile

**Date**: 2026-09-27
**Severity**: HIGH
**Status**: Fix prepared; GitHub Actions and production verification pending

## Problem

On the live Agent, asking what DeepSeek is could produce answers that called it a Hugging Face organization or mixed the organization, research team, and model series without directly identifying the company. The behavior reproduced while the paired Radxa device was offline, so device availability was not the cause.

## Root Cause

The identity preflight supplied Hugging Face organization/model results together with a general model-disclosure page. That disclosure called the legal entity a research team but did not directly state that it owns and operates DeepSeek products. The small default model therefore had weaker and noisier evidence for the requested company-versus-model distinction.

## Fix

- Use DeepSeek's official Terms of Use as direct company/operator evidence and its official model disclosure as separate model evidence.
- For identity questions, send only the verified official pages into the model context; do not include Hugging Face publisher profiles as identity evidence.
- Tell the model to distinguish the company from its model family while continuing to generate the answer from evidence and attach source links.
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
