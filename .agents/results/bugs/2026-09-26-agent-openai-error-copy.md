# Bare `openai_error` shown in chat

**Status:** The user-facing error mapping and regression case are in the branch; GitHub Actions and production verification are pending.

## Symptom

When the chat stream returns the bare text `openai_error`, the assistant message exposes that internal error name instead of telling the user what to try next.

## Root cause

The stream parser preserves the upstream error message. The chat error formatter only translates rate-limit and common 5xx messages, then returns every other message unchanged. A response whose message is exactly `openai_error` therefore leaks through to the conversation UI.

Backend inspection also found a concrete information-loss path: `RelayErrorHandler` initializes an empty OpenAI error envelope, then records a non-JSON upstream failure in `NewAPIError.Err`. `ToOpenAIError` previously reused the empty envelope message and fell back to `openai_error`. The same stale-envelope behavior discarded the request ID added by `SetMessage`, and could ignore an explicit hidden-message override. Both OpenAI and Claude conversions now use the current underlying message before applying the existing masking step, while preserving provider code/type/parameter fields.

This explains the displayed text only. The pasted browser output does not include the request ID, selected model, HTTP status, or provider/channel log, so it does not establish why the inference request failed.

## Fix

- Map the exact, case-insensitive `openai_error` message to localized retry/switch-model guidance.
- Add a regression case for the exact and whitespace/case-variant forms.
- Register the dynamic translation key and add translations in all seven bundled locales.
- Preserve updated backend messages in both response formats; regression coverage exercises non-JSON upstream failures, request-ID updates, and hidden-message overrides.

## Verification and limits

- All locale JSON files parse and contain the new translation key.
- The source, static key registry, and locale key match; `git diff --check` passes.
- The unit test was added but not run locally, following the project constraint that tests/builds run through GitHub Actions.
- This changes the error shown to the user; it does not repair an upstream model/provider failure. Inspect server request logs at the reported time to identify that cause.
