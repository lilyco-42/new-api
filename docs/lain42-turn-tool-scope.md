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

This change is the control-plane boundary only. The currently pinned DSH peer
does not consume turn version 3, and the browser does not yet send `tool_scope`.
Do not enable it for users, deploy, or claim the public-search defect solved
until DSH binds permission to the exact logged active prompt, narrows both
model-visible tools and dispatch using its scoped registry/guard, includes scope
in immutable request/context checks, and the browser carries it in the matching
retry snapshot. A shared mutable session flag or model-provided request ID is
insufficient. Matching peers must pass recorded-session, model-tool continuation,
public-source, later account-read, cancellation/restart and account-isolation
checks in Actions. Production OAuth and commercial model capacity remain separate
release gates.
