# Bounded actual-runtime model prototype

Run the existing **Build Lain42 Agent Server** workflow on
`feat/agent-dsh-control-plane` with `evaluate_only=true` and
`evaluation_kind=dsh-prototype`. It does not package or deploy a server.
The gate accepts only this branch of the `lilyco-42/new-api` fork. It checks out
the triggering New API SHA and DSH `3f5ed100f28f863f351611703ba53053248ab41b`.

The dedicated `LAIN42_PROTOTYPE_NVIDIA_KEY` Actions secret must contain the
owner's authorized NVIDIA developer API credential. It is available only to
the live-test step, never DSH's child process or the browser. Missing credentials
fail the manual lane; ordinary PR checks only compile/vet this test and use
deterministic fixtures for the existing composition gate.

The test uses the actual New API router, SQLite account/session ownership,
read-only GitHub tool, model adapter, wallet settlement and supported DSH Web
runtime. GitHub data and both accounts are synthetic. Only the model endpoint
is real: `https://integrate.api.nvidia.com/v1/chat/completions`, fixed model
`nvidia/nemotron-3-super-120b-a12b`. There is no paid fallback, redirect or
automatic upstream retry. The test permits at most six external requests,
1024 output tokens per request, 64 KiB inputs and a 50-second upstream timeout.
Its test-only external boundary sets `chat_template_kwargs.enable_thinking=false` and the output cap;
it leaves messages and tool definitions unchanged.

Required outcomes:

- Read the Issue and discussion using the account's synthetic OAuth credential;
  then return both tool-only markers, source URL, state and the discussed fix.
- Answer a contextual follow-up in the same session.
- Answer a new ordinary DeepSeek question as company/model information rather
  than returning the prior Issue or fabricated DeepWalker/OpenAlex definition.
- Log in through the built frontend on a Pixel 7 Chromium viewport, choose a
  synthetic text file, receive the real model's file facts in the assistant
  message, and retain that answer after reload without another inference. This
  adds one request within the same six-request ceiling; no auth/store/API/answer
  is injected or intercepted, and the browser driver does not inherit the key.
- In that same mobile cookie/storage context, sign out A, sign in B, verify
  empty B history, reject B's attempts to read/cancel A's session, then sign
  back into A and restore its answer without another inference. Attack probes
  use only B's actual sign-in credential in test-driver memory; no credential
  is exported or injected into frontend state. Rejected requests create no
  admission and cannot change A's cancellation intent.
- Restart DSH and replay the identical final answer with no extra inference.
- Reconcile actual owner charges with wallet and consume logs, leave the other
  account's wallet unchanged, and create no persistent user API token.

The artifact contains whitelisted outcome/count/scope fields and screenshots of
the declared synthetic mobile conversation and empty B history. It omits keys, raw network inputs/
outputs, runtime logs, cookies and traces. Provider denial
stops external requests and leaves a failed gate with its HTTP status and a
separate transport-failure flag. A successful run proves this bounded prototype;
it does not prove production OAuth, physical Android, all-resource user isolation,
partial-output cancellation billing or commercial supply eligibility.

NVIDIA developer service eligibility is for prototyping/testing, with separate
production requirements. A model license or catalog listing does not establish
free commercial API capacity. Sources checked on 2026-10-10:

- [NIM account and production FAQ](https://docs.api.nvidia.com/nim/docs/product)
- [Current free prototype availability](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b)
- [Chat API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer)

## Independent public research scenario

Choose `evaluation_kind=dsh-research` to run a separate research prototype under
the same six-request ceiling, provider pin, credential isolation and wallet
assertions. It does not append requests to the Issue/file scenario.

The actual DSH `web_search` tool must reach a real public search source, receive
the official ast-grep repository source and produce a sourced final answer.
Explicit GitHub queries now use the anonymous repository index when no search
provider is configured; broad queries retain Bing RSS. Then an actual
mobile browser signs in, obtains anonymous GitHub public search results, sends
those results in the current turn and displays the real answer. Neither path
may read the connected account's synthetic GitHub data or use a paired device.

The browser subsequently approves the public raw HTTPS URL of
`testdata/lain42-browser-research.html` at the exact triggering SHA. It must
load the deployed crawler `.wasm`, parse page-only facts while omitting script
content, send those facts in the same hosted turn, and display a sourced real
answer. Reload retains the answer without inference; a contextual follow-up
returns the page's delivery color. DSH restart replay and ledger reconciliation
remain required. The document is clearly synthetic and contains no user data.

The research artifact adds only declared search/page screenshots and outcome
booleans/counts. Search/provider/CORS failure fails the lane; no source fixtures,
auth/storage injection, server page fetch, retry or paid fallback are used to
make it pass. Screenshots disable animation for capture. Ordinary CI covers
declined and unreadable page flows separately with labelled external fixtures.
These checks do not establish universal web access, production OAuth, physical
Android, or commercial API eligibility.

An empty search response is reported to DSH as `search_no_results`, without a
successful evidence payload. The tool asks the model to explain missing evidence
or use a different relevant public source rather than repeat the same query or
invent sources. This distinguishes no results from a transport/provider failure;
it does not guarantee that a model will obey, or prove why a live search failed.

Choose `evaluation_kind=dsh-client-research` for independent browser search and
URL/WASM acceptance. It uses the same actual signed-in mobile interface, three
genuine model answers, source checks, reload, restart replay and wallet checks,
without the preceding hosted repository search. A private temporary file carries the
first synthetic/public browser turn for immutable restart replay; it is excluded
from exported artifacts and contains no authentication headers or credentials.
The artifact marks `client_research_only=true`; a pass cannot clear the separate
hosted public-search gate. Both lanes keep the original six-request ceiling.

Choose `evaluation_kind=dsh-hosted-research` for independent hosted-search
repository-search acceptance. It requires actual public repository evidence, a sourced final answer,
zero connected-account GitHub reads, restart replay without more inference,
and account ledger reconciliation, under the unchanged six-request ceiling.
It performs no browser search or URL/WASM phase. Its artifact explicitly marks
`hosted_research_only=true` and `mobile_research_flow=false`. Both independent
lanes must pass at the candidate revision; one cannot clear the other. The
original combined lane remains available as a separate, stricter scenario;
previous failures are not reclassified as successes.

Choose `evaluation_kind=dsh-account-issues` to test the user's unqualified
"read an Issue from my projects" request with the real model. No repository,
Issue number, URL or diagnostic marker is supplied in the instruction. DSH must
discover an open Issue through the connected account's search tool, then read
its body and discussion and produce the sourced fix. The external GitHub
account/Issue remains explicitly synthetic; this is not a real OAuth consent
exchange. The named-URL Issue scenario is retained independently.

Account discovery adds exactly one authorized search to the expected Issue
and discussion reads. Follow-up/new-topic and the actual mobile file answer
must not read GitHub again. The existing six-attempt fence, no-tool assertions,
mobile login/file/reload/A-to-B-to-A/foreign-denial checks, restart replay and
exact owner billing remain required. If the real model asks for a repository,
only reports OAuth status or exceeds the budget, this gate fails; the assertions
and request budget are not relaxed to make it pass.

RSS-only run 38025202252 failed after six valid nonempty responses did not
retrieve the official repository. The repair shares source selection with the
HTTP search endpoint and reuses GitHub's public index; it neither increases the
six-inference ceiling nor proves general Bing relevance. The observer bypasses
only the synthetic account fixture for anonymous `/search/repositories` calls,
checks no Authorization/Cookie, and observes the unmodified real JSON. Counts
distinguish repository requests from Bing requests; empty/invalid response
diagnostics now cover either format. Missing or malformed sources still fail.
No OAuth/account source, fixed project answer or provider response is injected.

The hosted search observer exports only counts for empty RSS, invalid RSS,
non-200 responses and repeated normalized queries at the same origin. Query
identities remain in test-process memory, and unchanged responses still reach
the real tool. Cross-origin redirects are distinct observations. The official
source check requires an actual RSS item link, not a substring in arbitrary
HTML. These diagnostics distinguish failure classes without exporting prompts
or response bodies; counts alone do not prove search relevance or model quality.

## Observed provider retirement and explicit repin

The first prototype at e166229 / run 37094876969 used the local configured
`deepseek-ai/deepseek-v4-flash-0731` ID. Its first inference returned HTTP 410,
so it stopped, refunded the account reservation and did not call GitHub. This
is a failed prototype, not a passing quality test or proof that the key is invalid.
Catalog-only Actions run 37095413474 returned HTTP 200: that old ID and
`nvidia/deepseek-v4.1-flash` were absent; Nemotron 3 Super was present. The new
pin is an explicit test configuration change, not a runtime fallback. Catalog
presence alone still does not prove inference, tools or production eligibility.

Use `evaluation_kind=prototype-catalog` to repeat only this bounded metadata
diagnostic; it performs one GET, never inference, redirects or raw key logging.
It saves only fixed candidate-presence booleans and a status. A catalog
failure is unavailable evidence, not proof that a model is gone.

Current model references:

- [Official prototype endpoint](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b)
- [Official thinking toggle](https://docs.nvidia.com/nim/large-language-models/2.0.4/turbo/get-started-nemotron-3-super-120b-a12b.html)

## Current trial candidate — 2026-10-10

The preceding `openai/gpt-oss-20b` candidate reached an Issue-derived answer but
failed the ordinary DeepSeek factual assertion in run `37437299340`. That failure
is retained; the assertion and scopes are not weakened. The isolated trial now
pins Nemotron 3 Super, whose official page currently lists its free prototype
endpoint as available. This uses the existing authorized secret and the same
six-call, 1024-token, input, response and timeout bounds; it does not change a
production channel or introduce runtime fallback. Current request scopes and
the pinned DSH runtime differ from the earlier successful Nemotron prototype,
so the historical pass cannot certify this candidate.

Only after the exact candidate's ordinary CI passes may one manual bounded
trial run. Missing access, denial, transport failure or a quality failure stays
failed, without an unchanged retry. GPT-OSS 120B is not selected: its official
page currently marks the free endpoint deprecated despite an API reference
still existing. No inference has yet validated this repin.
