# Lain42 DSH model relay

The private `POST /v1/agent/chat/completions` endpoint routes DSH model calls
through New API's existing Playground relay and quota ledger. It is intended
for the DSH server only; browser clients must never receive the relay secret.

Both servers must have the same independently generated value in
`LAIN42_AGENT_MODEL_RELAY_SECRET` (at least 32 UTF-8 bytes). Do not reuse the
desktop pairing secret or the DSH inbound-turn secret. Keep the New API endpoint
behind HTTPS.

Each request carries a short-lived HMAC over the protocol version, timestamp,
one-time nonce, fixed HTTP method and path, active internal DSH session id, and
selected model. New API resolves that DSH session in `agent_web_sessions`,
derives the owner from the database, rejects disabled or revoked owners, and
claims the nonce in a shared database table before entering Playground billing.
The caller cannot choose a user id or billing group. Requests are limited to
20 MiB and must use JSON; provider profile `baseURL` should end in
`/v1/agent`, so the OpenAI-compatible adapter requests this endpoint.

The DSH provider route is `lain42-web`. Its dynamic header resolver is installed
by `dsh-web-app`; it signs only that route and requires a 64-character
server-owned session id. A profile can use a non-secret placeholder API key if
the OpenAI-compatible client requires one: New API ignores that key on this
private route and authenticates the HMAC instead.

## Browser turn proxy

The authenticated browser sends `POST /api/agent/turns` with only
`{"session_id":"<public session id>","text":"<user message>"}`. The route
requires the logged-in New API account, the normal session-cookie Origin guard,
and a bounded request. It resolves the public session id under that account,
then forwards the stored private DSH session id to
`POST /lain42/bridge/v1/turn`. Browser callers cannot select a user, DSH
session, model, device, or working directory. Cross-account, revoked, and
unknown sessions are returned as not found without contacting DSH.

Configure New API with `LAIN42_DSH_BRIDGE_URL`, set to the exact HTTPS bridge
URL (including `/lain42/bridge/v1/turn`), and `LAIN42_DSH_BRIDGE_SECRET`, a
random shared secret of at least 32 UTF-8 bytes. Configure the same secret in
DSH's bridge setting. HTTP is accepted only for loopback development/testing;
redirects are not followed. Keep this endpoint private to New API at the
network layer where possible. The signed request uses the bridge's v1
timestamp, one-time nonce, path, body digest, and HMAC-SHA256 contract.

The browser route has a 125-second upstream deadline and a 24 KiB user-text
limit. It returns a normal New API success envelope containing `request_id`
and the completed answer. This first bridge contract is non-streaming and
text-only; attachments, durable conversation listing, cancellation, and
streamed token delivery remain separate work and must not be represented as
available until their browser flow is wired and tested.

## Operational limitation

The bridge only works after the authenticated Agent flow creates an active
`AgentWebSession` and the DSH server uses its private `dsh_session_id` as the
session id on model requests. The public session id returned to the browser is
accepted only by the authenticated `/api/agent/turns` proxy and is never sent to
the DSH model-relay endpoint. Do not expose or accept the internal id from
browser input; session provisioning, turn forwarding, and billing identity
must remain server-authenticated.

The replay table is cleaned by expiry during nonce claims and is indexed by
expiry. Multiple New API instances can safely share it because uniqueness is
enforced by the database.
