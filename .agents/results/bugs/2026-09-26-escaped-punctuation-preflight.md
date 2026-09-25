# Escaped punctuation reached model inference

## Reproduction

Send `\\>??` as the latest user message after any prior assistant reply.

## Root cause

The Agent preflight stripped plain Markdown blockquote prefixes (`>`) before checking for punctuation-only input, but did not strip a literal escaped prefix (`\\>`). The escaped text therefore missed the local clarification path and was sent to model inference, where the reported request failed with `openai_error`.

## Fix and regression coverage

- Normalize both `>` and `\\>` prefixes before classifying punctuation-only input.
- Cover both forms in preflight classification and through the full local tool loop, asserting no model request is made.

## Validation

`git diff --check` passed locally. Per project instructions, build and tests are delegated to GitHub Actions; no local build or test was run.
