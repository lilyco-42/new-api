# Greeting correction recovery regression

Status: Partially verified — 2026-09-27. This report records one live scenario, not a claim that conversational quality is fully fixed.

## Reproduction

1. Start a new Agent conversation using the default website model.
2. Send `你好`.
3. After the Agent replies with a greeting, send `刚才不是只问了个问好`.

Before the change, the model interpreted the correction as a request to repeat or explain the greeting (for example, “您是要我直接回答‘您好’而不需要进一步说明。”). A prior live response inferred dissatisfaction instead of understanding the correction.

## Cause

Conversation history already retained the two prior turns, but the small default model did not reliably infer the intent of this terse Chinese correction from general system instructions alone. The model remained the response generator; no deterministic answer shortcut was added.

## Change

`web-agent-tool-provider.ts` now detects a correction following a greeting and adds a narrowly scoped system context: acknowledge briefly, continue naturally, ask what the user needs, and avoid interpreting emotion or explaining “greeting again.” A style example keeps the recovery concise in Chinese. Other correction messages receive generic recovery guidance. The test verifies that this context reaches the model and that the correction path does not invoke search or OAuth APIs.

Commits on `fix/agent-toolkit-capability-claims`:

- `6c035cc`: add short-correction recovery context and realistic regression case.
- `b84d3a4`: make greeting recovery concise and natural.
- `4f9032e`: align the assertion with the final correction guidance.

## Verification

- GitHub Actions CI `36263767947`: frontend typecheck/tests and backend vet/build/tests passed.
- Server artifact workflow `36263767975`: frontend tests, Agent API tests, device re-pair lifecycle test, Linux amd64 build, and clean runtime image packaging passed.
- Deployed image `lain42/new-api:agent-flat-4f9032e`; `/api/status` reported `agent-4f9032e`, `/agent` returned HTTP 200, and the container became healthy.
- Live browser test with `meta/llama-3.2-11b-vision-instruct`: `你好` followed by `刚才不是只问了个问好` produced “对不起！我刚才只是问了个问好，没接着说。现在我知道了，你还有什么需要我帮助的吗？” It acknowledged the missed conversational handoff and asked what help was needed; no tool call was made while Radxa showed offline.
- The correction reply took 30.16 seconds. Semantic recovery passed this single case, but latency and cross-model behavior remain unresolved; do not mark conversation continuity fully accepted yet.

## Remaining work

- Add multi-model and repeated correction/short-follow-up cases to Actions without asserting exact generated prose.
- Investigate long tail latency across default/free model routes separately from intent correctness.
- Re-run after any conversation-prompt or model-routing change; keep the error turn and fresh-question cases in the same regression suite.
