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

The candidate pins DSH `66d6a692715811f7abf90c17fa2d79f108bb9d74`. Its PR CI
run `37472483983` and release/package/compatibility checks passed; live-provider
E2E was skipped because credentials were unavailable. It binds permission to the logged active prompt
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

Matching New API/browser fixture integration passed at `475686c` in Actions
`37144821283`, including immutable retry/Stop, scoped image input and linked/unlinked
GitHub browser reads. The external model and GitHub in that gate are fixtures;
neither that gate nor the DSH gate alone is genuine-model product acceptance.
Matching peers must pass recorded-session, model-tool continuation,
public-source, later account-read, cancellation/restart and account-isolation
checks in Actions. Production OAuth and commercial model capacity remain separate
release gates.

## Bounded genuine-provider evaluation

The opt-in Actions prototype now evaluates the catalog-positive
`openai/gpt-oss-20b` NVIDIA trial endpoint. Issue reading has
`account-read`; public research has `public-only`; follow-up, ordinary chat and
prepared attachments have `evidence-only`. The Issue scenario checks the actual
model request contains no tools on those later turns and the admitted scopes
remain independent. A real mobile-emulated attachment must submit evidence-only.

This changes only isolated acceptance configuration, not production channels.
Six external attempts, 1024 output tokens, 64 KiB input, 2 MiB response and a
50-second provider timeout remain the ceilings. No retries, new key or paid
fallback are allowed. The official [GPT-OSS-20B model card](https://build.nvidia.com/openai/gpt-oss-20b/modelcard)
documents tool use and the [NVIDIA endpoint page](https://build.nvidia.com/openai/gpt-oss-20b/playground)
identifies the trial endpoint. This is development evaluation only; NVIDIA's
[product terms](https://docs.api.nvidia.com/nim/docs/product) distinguish
development/testing access from production entitlement. This candidate still
requires its own genuine-model Actions result. Synthetic GitHub fixtures cannot
certify production OAuth, and Chromium emulation cannot certify physical Android.

The latest Kimi K3 trial on New API head `65ae6ca` returned only punctuation
(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`) on its first response: no GitHub fixture
was read and no answer assertion passed. It was not a provider denial, and the
unchanged Kimi request must not be retried. The metadata-only Actions catalog
run `37190705449` found `z-ai/glm-5.3-flash` and `openai/gpt-oss-20b` present.
GLM's only trial `37424316857` failed at the transport layer before a model
answer or GitHub read; artifact `11394940750` records one attempt and no HTTP
denial. The sanitized harness now reports transport failure separately from
provider HTTP status. GPT-OSS-20B is the next distinct bounded candidate; its
catalog presence is not entitlement or acceptance proof.
