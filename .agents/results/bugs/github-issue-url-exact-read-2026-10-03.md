# Exact GitHub Issue URL reads

## Symptom and evidence

A user-supplied GitHub Issue URL could enter browser CORS page reading or retrieve the repository's recent open-issue list instead of the linked issue. This excluded older and closed issues and omitted discussion comments. GitHub Actions run [37033336166](https://github.com/lilyco-42/new-api/actions/runs/37033336166) at `624a266` reproduced both bare-link and analyze-link failures; the other 701 frontend tests passed.

## Fix

The browser OAuth adapter now identifies one explicitly supplied Issue URL and reads that repository and number through the authenticated `/api/agent/github/issue` endpoint before submitting the same DSH turn. The endpoint reads a body up to 12 KiB and at most three oldest comments up to 2 KiB each. It reports truncation and partial comment failures, requires this New API account's GitHub grant, rejects invalid targets, and never exposes the token in results. The model receives the returned issue state, body, comments and source, with instructions to distinguish hypotheses from verified facts and avoid claiming code edits or unseen files.

The execution receipt records the actual issue number and selected-issue scope, so a follow-up can explain how the read happened without inventing an open-list query. Tool authorization binds the repo and number to the user-supplied URL. Links present only in an attachment are not read grants; canceled preparation cannot submit a DSH turn.

## Validation and remaining work

Run [37034792690](https://github.com/lilyco-42/new-api/actions/runs/37034792690) passed backend validation but exposed another routing gap in four hosted-flow tests: generic page preparation requested browser approval before the OAuth adapter ran. The fix skips this competing CORS path for exact, non-local Issue reads; unrelated webpage reading keeps its existing approval behavior.

Product tests and builds run only in GitHub Actions. Added hosted-flow regressions use the real browser adapter and DSH request preparation while mocking external GitHub and inference boundaries; backend tests protect exact addressing, credential isolation, UTF-8 limits and partial comment failure. The fix's CI result is pending at commit preparation. Actual production OAuth/model behavior, full discussion paging, and source-code-based repairs remain unverified. No merge or deployment occurred.
