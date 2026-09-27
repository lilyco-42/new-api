# Bug: DeepSeek identity answers confuse the company with its model-hosting profile

**Date**: 2026-09-27
**Severity**: HIGH
**Status**: Follow-up fix prepared; GitHub Actions and production verification pending

## Problem

On the live Agent, asking what DeepSeek is could produce answers that called it a Hugging Face organization or mixed the organization, research team, and model series without directly identifying the company. The behavior reproduced while the paired Radxa device was offline, so device availability was not the cause.

## Root Cause

The first fix removed hosting-profile noise and fetched the official Terms of Use, but a production browser retry still returned the safe “no official source” response. The server log confirms the terms URL was read successfully (HTTP 200). Comparing the identity path with the successful direct-URL path found that the identity path retained only the first 2,400 characters of the page for the model. The operator clause can occur later in the terms, so the model received the URL but not the evidence needed to answer. This follow-up extracts a bounded excerpt around both the company name and ownership phrase, and verifies both phrases are present in the excerpt before sending it.

## Fix

- Keep DeepSeek's official Terms of Use as direct company/operator evidence.
- Preserve the sequential one-page read and exclude Hugging Face publisher profiles from identity evidence.
- Extract the bounded model excerpt around the verified company and ownership phrases rather than taking a fixed prefix.
- Add a regression fixture where the legal-operator clause appears after the first 2,400 characters.

## Files Modified

- `web/src/features/agent/web-agent-tool-provider.ts`
- `web/src/features/agent/__tests__/web-agent-tool-provider.test.ts`

## Testing

- [x] Reproduced on deployed `agent-c4e72ed`; bounded official terms fetch returned HTTP 200, but the model lacked the operator clause.
- [x] Added a regression fixture with the ownership sentence beyond the fixed 2,400-character prefix.
- [ ] Run affected test, typecheck, lint, and production package through GitHub Actions.
- [ ] Re-test the deployed Agent in the browser and verify both the answer and source links.

## Prevention

For entity-identity questions, prefer primary sources that explicitly identify the legal operator. Treat hosting accounts as publisher evidence only, and verify the final answer against the source category the user asked about.
