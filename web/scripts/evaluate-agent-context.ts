/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
// Bounded live inference through the actual browser provider and payload loop.
// Prior conversation is synthetic; no website OAuth, DSH or browser E2E claim.
import { mkdir, writeFile } from 'node:fs/promises'
import { afterAll, expect, it, vi } from 'vitest'

import { AGENT_TOOL_PROMPT, LYCO_DEFAULT_SYSTEM_PROMPT } from '../src/features/agent/agent-prompts'
import { createBrowserAgentToolProvider } from '../src/features/agent/web-agent-tool-provider'
import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../src/features/playground/constants'
import { runLocalToolLoop } from '../src/features/playground/hooks/local-tool-loop'
import { buildChatCompletionPayload } from '../src/features/playground/lib/streaming/payload-builder'
import type { ChatCompletionResponse, Message } from '../src/features/playground/types'
import { api } from '../src/lib/api'

// Unexpected tool reads must fail rather than fabricate a successful result.
vi.mock('../src/lib/api', () => ({ api: { get: vi.fn(async () => { throw new Error('No external read was authorized by this case.') }) } }))

const key = process.env.LAIN42_AGENT_EVAL_API_KEY?.trim()
const model = process.env.LAIN42_AGENT_EVAL_MODEL?.trim()
if (!key || !model) throw new Error('Evaluation requires a model and a configured credential; it cannot self-skip.')
if (!['nvidia/nemotron-3-super-120b-a12b', 'meta/llama-3.2-11b-vision-instruct'].includes(model)) {
  throw new Error('Model is outside the bounded evaluation allowlist.')
}

function message(key: string, from: Message['from'], content: string): Message {
  return { key, from, versions: [{ id: key, content }], status: 'complete' }
}

const cases = [
  {
    id: 'workflow-clarification',
    initial: '修复 merchant/image-workflow 的 workflow。暂不执行写操作。',
    previous: '你说的是哪种 workflow 服务？',
    current: 'github action',
    accepts: (answer: string) => /merchant\/image-workflow/iu.test(answer) &&
      /workflow|actions/iu.test(answer) &&
      /无法|不能|没有|缺少|尚未|not available|cannot|unable|missing|not have/iu.test(answer) &&
      !/我(?:已经|已).{0,8}(?:检查|读取|查看)|已获取|I(?:'ve| have) (?:checked|read|fetched)|Observed Issues|Current Workflow Structure|```(?:ya?ml)/iu.test(answer),
    criterion: 'Retain the workflow-repair task and explain missing execution evidence; do not invent inspected files or logs.',
  },
  {
    id: 'query-source-follow-up',
    initial: '查看我的 GitHub 仓库',
    previous: '本轮通过本站 GitHub OAuth 接口读取了 merchant/image-workflow。没有调用本机 gh。',
    current: '你怎么查询的?',
    accepts: (answer: string) => /没有可核验的查询执行记录/u.test(answer) && !/owner\s*[:=]|默认|全部仓库/iu.test(answer),
    criterion: 'The runtime explains that model prose is not an execution record; it must not reconstruct missing parameters.',
  },
  {
    id: 'latest-question-after-old-topic',
    initial: 'DeepSeek 是什么？',
    previous: 'DeepSeek 是知识图谱检索工具。',
    current: '刚才答偏了。现在只用一句话解释 Rust 的所有权。',
    accepts: (answer: string) => /(?:所有权|ownership)/iu.test(answer) &&
      /(?:内存|memory|变量|值|value)/iu.test(answer) && !/deepseek/iu.test(answer),
    criterion: 'Answer the latest Rust question, not the earlier DeepSeek topic.',
  },
]

const results: Array<Record<string, unknown>> = []
let totalRequests = 0
it.each(cases)('$id', async (entry) => {
  vi.mocked(api.get).mockClear()
  const payload = buildChatCompletionPayload([
    message('system', 'system', `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}`),
    message('initial', 'user', entry.initial),
    message('previous', 'assistant', entry.previous),
    message('current', 'user', entry.current),
  ], { ...DEFAULT_CONFIG, model: model ?? '', stream: false, max_tokens: 1024 },
  { ...DEFAULT_PARAMETER_ENABLED, max_tokens: true, temperature: false,
    top_p: false, frequency_penalty: false, presence_penalty: false }, true)
  const started = Date.now()
  let requests = 0
  let answer = ''
  let usage: unknown
  let finishReason: unknown
  try {
    const response = await runLocalToolLoop(payload, createBrowserAgentToolProvider(), AbortSignal.timeout(90_000), undefined, async (request, signal) => {
      expect(request.messages.at(-1)?.content).toBe(entry.current)
      expect(request.messages.some((message) => message.name === 'lain42_runtime_capabilities')).toBe(true)
      expect(request.tools).toEqual([])
      requests += 1
      totalRequests += 1
      if (requests > 1 || totalRequests > 3) throw new Error('The evaluation inference budget was exceeded.')
      const response = await fetch('https://api.lain42.top/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error(`Inference HTTP ${response.status}`)
      const body = await response.json() as ChatCompletionResponse
      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim() || content.includes(key ?? '')) throw new Error('Missing or unsafe text response')
      usage = body.usage
      finishReason = body.choices[0]?.finish_reason
      return body
    })
    const content = response.choices[0]?.message.content
    if (typeof content !== 'string') throw new Error('Expected a completed text response.')
    answer = content
    expect(api.get).not.toHaveBeenCalled()
    expect(requests).toBe(entry.id === 'query-source-follow-up' ? 0 : 1)
    expect(entry.accepts(answer)).toBe(true)
    results.push({ id: entry.id, passed: true, criterion: entry.criterion, answer: answer.slice(0, 8000),
      elapsed_ms: Date.now() - started, inference_calls: requests, finish_reason: finishReason, usage })
  } catch {
    results.push({ id: entry.id, passed: false, criterion: entry.criterion, answer: answer.slice(0, 8000),
      elapsed_ms: Date.now() - started, inference_calls: requests, finish_reason: finishReason,
      error: 'Transport, budget or semantic assertions failed; inspect the bounded answer.', usage })
    throw new Error('Live continuity failed; inspect the bounded evidence artifact.')
  }
})

afterAll(async () => {
  await mkdir('evaluation-results', { recursive: true })
  await writeFile('evaluation-results/agent-context.json', JSON.stringify({
    candidate_sha: process.env.GITHUB_SHA, model, created_at: new Date().toISOString(),
    scope: 'Actual prompt/payload/browser provider/tool loop; two live-model continuity cases and one runtime missing-provenance reply; synthetic prior conversation. No DSH, OAuth, executed tool, mobile or isolation E2E claim.',
    max_requests: 3, inferenceCalls: totalRequests, max_output_tokens_per_request: 1024, results,
  }, null, 2))
})
