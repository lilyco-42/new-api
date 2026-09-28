# Bug: punctuation follow-ups lose Agent conversation context

**Date Reported**: 2026-09-29
**Date Fixed**: In Progress
**Reporter**: User report in Codex conversation
**Assignee**: Codex
**Severity**: MEDIUM
**Status**: IN PROGRESS

## Problem

The user reported that the Agent answers can be unrelated to the current turn. In the supplied conversation, a punctuation-only reply such as `??` after a wrong answer did not let the model interpret the prior exchange.

Expected: when a punctuation-only message follows a successful assistant answer, include that exchange in model context and let the model respond to the follow-up. If there is no preceding answer, keep the brief clarification response. Do not bridge across a failed assistant turn to an older answer.

## Reproduction and root cause

1. In Agent mode, ask a question and receive an assistant answer.
2. Send `?`, `??`, `>??`, or `\\>??`.
3. Before the fix, `isFollowUpRequest` classified the punctuation as a new request, so the Agent payload retained only the latest user message. The Agent preflight then returned a fixed clarification without checking whether a successful assistant answer was available.

The issue is in the frontend Agent context path: `web/src/features/playground/lib/streaming/payload-builder.ts` selects context, and `web/src/features/agent/web-agent-tool-provider.ts` applies local preflight. The report does not include browser version, theme, console output, deployment SHA, or database; those are not required to reproduce this deterministic source path.

## Fix

- Treat punctuation-only input as a contextual follow-up in Agent mode.
- Bypass the local clarification only when a prior assistant answer exists, allowing the selected model to interpret the exchange.
- If the immediately preceding assistant turn failed, do not attach an older answer to the punctuation-only follow-up.
- Add payload and tool-loop regression tests for these behaviors.

## Verification

- `git diff --check`: passed.
- Frontend tests and typecheck: not run locally, per the project requirement to verify only through GitHub Actions; PR CI pending.
- Browser and mobile manual verification: not performed.

## Prevention

Conversation-turn classification and preflight behavior must be tested together: retained context is ineffective if a local fast path still intercepts the follow-up, and a fast path must not revive failed turns.
