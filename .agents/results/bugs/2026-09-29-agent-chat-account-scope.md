# Agent conversation account isolation

## Severity

High for shared browser profiles: saved conversation previews and search results were not scoped to the signed-in account.

## Evidence

- `web/src/features/agent/agent-chat-storage.ts` used account-free `agent-{preset}-chat-{id}` keys.
- `web/src/features/agent/components/agent-sidebar.tsx` and `web/src/features/agent/index.tsx` enumerated all matching keys in the browser's local storage.
- Device and GitHub credentials are looked up with the authenticated user ID in `controller/agent_tools.go`, `model/agent_github_credential.go`, and `model/agent_device.go`; browser conversation history did not use that boundary.

## Change

- Add the stable user ID to each Agent chat namespace.
- Filter recent-chat and search views to keys for the active user.
- Remount the Agent workspace when the authenticated user changes so a previous account's pending files, pairing ticket, and device bridge state do not remain in memory.
- Leave old account-free keys untouched but hide them from the Agent UI. They are not automatically assigned to an account because their owner cannot be established safely.

## Verification

- `git diff --check`: passed.
- Focused Oxlint check on the changed TypeScript files: passed.
- Unit regression tests cover distinct account namespaces, excluding another account's keys, and hiding legacy account-free keys.
- GitHub Actions run `36473224344` passed frontend typecheck/tests and backend vet/build/tests for implementation commit `0e490f9`.
- No local build or test was run.
- Shared-browser two-account runtime test: not yet run.

## Residual limits

Chat history remains browser-local. Account-scoped keys prevent accidental cross-account display in the app, but local storage is not encrypted against someone who can inspect the same browser profile.
