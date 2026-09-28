# Bug: DeepSeek identity answers confuse the company with its model-hosting profile

**Date**: 2026-09-27
**Severity**: HIGH
**Status**: Follow-up fix prepared; GitHub Actions and production verification pending

## Problem

On the live Agent, asking what DeepSeek is could produce answers that called it a Hugging Face organization or mixed the organization, research team, and model series without directly identifying the company. The behavior reproduced while the paired Radxa device was offline, so device availability was not the cause.

## Root Cause

The first fix removed hosting-profile noise and fetched the official Terms of Use, but a production browser retry still returned the safe “no official source” response. The server log confirms the terms URL was read successfully (HTTP 200), and a separate direct-URL browser request correctly answered from that page. The identity path first kept only the page's opening 2,400 characters; the shared search formatter then capped excerpts at 2,000 characters. Both truncations could remove the later operator clause. The follow-up extracts a bounded excerpt around the verified company and ownership phrases, constrained to the formatter's 2,000-character limit, and verifies both phrases are present before sending it.

## Fix

- Keep DeepSeek's official Terms of Use as direct company/operator evidence.
- Preserve the sequential one-page read and exclude Hugging Face publisher profiles from identity evidence.
- Extract the bounded model excerpt around the verified company and ownership phrases, within the formatter's 2,000-character cap.
- Add a regression fixture where the legal-operator clause appears after the first 2,400 characters.

## Files Modified

- `web/src/features/agent/web-agent-tool-provider.ts`
- `web/src/features/agent/__tests__/web-agent-tool-provider.test.ts`

## Testing

- [x] Reproduced on deployed `agent-c4e72ed`; bounded official terms fetch returned HTTP 200, but the model lacked the operator clause.
- [x] Added a regression fixture with the ownership sentence beyond the fixed 2,400-character prefix.
- [x] GitHub Actions for commit `5638dbd` exposed the second 2,000-character formatter cap; the follow-up now preserves the evidence within that limit.
- [ ] Run affected test, typecheck, lint, and production package through GitHub Actions.
- [ ] Re-test the deployed Agent in the browser and verify both the answer and source links.

## Prevention

For entity-identity questions, prefer primary sources that explicitly identify the legal operator. Treat hosting accounts as publisher evidence only, and verify the final answer against the source category the user asked about.
