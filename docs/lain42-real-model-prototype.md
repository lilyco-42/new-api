# Bounded actual-runtime model prototype

Run the existing **Build Lain42 Agent Server** workflow on
`feat/agent-dsh-control-plane` with `evaluate_only=true` and
`evaluation_kind=dsh-prototype`. It does not package or deploy a server.
The gate accepts only this branch of the `lilyco-42/new-api` fork. It checks out
the triggering New API SHA and DSH `8c46372eca41f7a55efb2006013ebb1987827052`.

The dedicated `LAIN42_PROTOTYPE_NVIDIA_KEY` Actions secret must contain the
owner's authorized NVIDIA developer API credential. It is available only to
the live-test step, never DSH's child process or the browser. Missing credentials
fail the manual lane; ordinary PR checks only compile/vet this test and use
deterministic fixtures for the existing composition gate.

The test uses the actual New API router, SQLite account/session ownership,
read-only GitHub tool, model adapter, wallet settlement and supported DSH Web
runtime. GitHub data and both accounts are synthetic. Only the model endpoint
is real: `https://integrate.api.nvidia.com/v1/chat/completions`, fixed model
`deepseek-ai/deepseek-v4-flash-0731`. There is no paid fallback, redirect or
automatic upstream retry. The test permits at most six external requests,
1024 output tokens per request, 64 KiB inputs and a 50-second upstream timeout.
Its test-only external boundary sets `reasoning_effort=none` and the output cap;
it leaves messages and tool definitions unchanged.

Required outcomes:

- Read the Issue and discussion using the account's synthetic OAuth credential;
  then return both tool-only markers, source URL, state and the discussed fix.
- Answer a contextual follow-up in the same session.
- Answer the latest client-prepared text attachment instruction without replacing
  it with the earlier export task. The existing browser fixture gate separately
  tests actual file selection and client attachment conversion.
- Restart DSH and replay the identical final answer with no extra inference.
- Reconcile actual owner charges with wallet and consume logs, leave the other
  account's wallet unchanged, and create no persistent user API token.

The artifact contains only whitelisted outcome/count/scope fields. It omits keys,
raw model inputs/outputs, runtime logs, screenshots and traces. Provider denial
stops external requests and leaves a failed gate with its HTTP status (or `-1`
for a transport failure). A successful run proves this bounded prototype;
it does not prove production OAuth, physical Android, all-resource user isolation,
partial-output cancellation billing or commercial supply eligibility.

NVIDIA developer service eligibility is for prototyping/testing, with separate
production requirements. A model license or catalog listing does not establish
free commercial API capacity. Sources checked on 2026-10-03:

- [NIM account and production FAQ](https://docs.api.nvidia.com/nim/docs/product)
- [Model service terms and metadata](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-0731)
- [Chat API](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer)
