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

## Operational limitation

This endpoint only works after the authenticated Agent flow creates an active
`AgentWebSession` and the DSH server uses its private `dsh_session_id` as the
session id on model requests. The public session id returned to the browser is
not accepted by this route. Do not expose or accept the internal id from browser
input; session provisioning and turn forwarding must remain server-authenticated.

The replay table is cleaned by expiry during nonce claims and is indexed by
expiry. Multiple New API instances can safely share it because uniqueness is
enforced by the database.
