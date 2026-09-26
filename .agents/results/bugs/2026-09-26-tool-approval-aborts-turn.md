# A declined tool approval must not abort the chat turn

**Status:** Fixed on the current branch; GitHub Actions verification pending.

## Observed behavior

When a tool provider returns `false` from its approval callback, the local tool loop throws `LocalToolLoopError` with `Tool call <name> was not approved.` The chat handler treats this like an API failure, so the user sees a raw error instead of a response explaining that the tool was not run.

## Cause

The approval decision is handled as an exception before the loop records a tool result or asks the model to finish the turn. A permission refusal is an expected user decision, not a transport or inference failure.

## Fix

- Record a structured “declined; not run” tool result and prohibit further proposed tool calls in that turn.
- Ask the model to respond using only the available context and explain that the requested action was not completed.
- Show a localized progress message; never invoke the declined tool.
- Treat an explicitly supplied public URL as the user's request to read it. `web.fetch` may read only the exact normalized URL from the latest user message. `web.crawl` additionally requires an explicit crawl request and is bounded to same-site pages. Public-HTTPS validation, bounded reads, no-cookie requests, and redirect rejection remain in force. This removes a delayed native confirmation dialog that could be suppressed by browsers after the model round trip.

## Regression coverage

- A guarded tool refusal results in a tool event plus a no-tools synthesis request; the tool's invoke callback is never called and the chat response succeeds.
- An explicitly requested URL sends the fetched page text in the tool message back to the model without a native confirmation prompt.

## Verification

The frontend regression tests and CI build have not yet run. Per project constraints, verification is delegated to GitHub Actions; no local build or test was run.
