# Request-bound tool permissions

The control plane accepts optional `tool_scope` on an authenticated browser
turn. It validates and persists the scope with the owning account, session and
request ID before forwarding. This is an execution permission, never a value
derived from a model's arguments or retrieved source text.

| Scope | Permitted shipped surface |
| --- | --- |
| Omitted | Existing read-only tools, for legacy callers |
| `account-read` | Existing account and public read-only tools |
| `public-only` | Public `web_search` and the existing client-required `web_fetch` response |
| `evidence-only` | No additional relay tools; answer from already supplied evidence |

None of these scopes enables shell, device execution, writes or unregistered
tools. Account authentication and the existing tool whitelist still apply.
The permission can differ on the next request, but reusing an admitted ID with
a different scope fails with `AGENT_DSH_REQUEST_CONFLICT`. A cancellation cannot
clear or widen permission, and remains terminal even when recorded before turn
admission. Storage retains scope after restart without storing prompts or tokens.

## Private wire compatibility

A nonempty scope uses turn wire version 3 and `toolScope`. Older DSH bridge
versions reject that version instead of accepting an unknown permission field.
Tool relay version 2 includes `request_id` in the HMAC-covered body and resolves
only that already admitted owned identity. Missing, foreign, cancelled or denied
execution returns a structured tool error before credential lookup or upstream
HTTP. It does not infer permission from the latest session request.

Once a session contains a scoped admission, version 1 tool calls without an
exact request identity are denied. This is a conservative compatibility fence,
not a session-wide execution permission: subsequent version 2 requests retain
their own independent scope. Existing unscoped sessions keep version 1 behavior.
The existing signature canonical prefix remains `v1`; the signed body covers
the relay payload version and exact identity. One-use nonces are unchanged.

## Integration gate

The candidate pins DSH `5abc327fb1092d1f357975bb38efeb83910e7063`, whose full
Actions run `37131875749` passed. It binds permission to the logged active prompt
and narrows both model-visible tools and dispatch. The browser now carries scope
in a version-3 immutable retry snapshot and submits the saved scope on retries.
Ordinary chat and prepared evidence (including explicit read-failure notices)
are evidence-only; a direct current public-research or account-read instruction
can enable the corresponding read scope when preparation supplied no context.
Attachments, model arguments, retrieved content and prior requests do not grant
account permissions. Reconnecting does not rerun preparation or derive a new scope.

Predecessor v1/v2 request keys are checked before any reset or new ID. An existing
record cannot be migrated implicitly, even if stopped or damaged; the user must
start a new message. Scope participates in the saved fingerprint while the lookup
key uses a versioned digest of the original text/images/model/mode. No raw image
or credential is persisted in that retry record.

New API/browser matching-peer integration is pending its own Actions run; the DSH
gate alone is not product acceptance. Matching peers must pass recorded-session, model-tool continuation,
public-source, later account-read, cancellation/restart and account-isolation
checks in Actions. Production OAuth and commercial model capacity remain separate
release gates.
