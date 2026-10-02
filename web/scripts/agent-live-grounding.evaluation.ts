// Real public GitHub data and real website inference, through the candidate
// provider and tool loop. The HTTP adapter is a test boundary, NOT site OAuth.
import { mkdir, writeFile } from 'node:fs/promises'

import { afterAll, beforeAll, expect, it, vi } from 'vitest'

import { AGENT_TOOL_PROMPT, LYCO_DEFAULT_SYSTEM_PROMPT } from '../src/features/agent/agent-prompts'
import { createBrowserAgentToolProvider } from '../src/features/agent/web-agent-tool-provider'
import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../src/features/playground/constants'
import { runLocalToolLoop } from '../src/features/playground/hooks/local-tool-loop'
import { buildChatCompletionPayload } from '../src/features/playground/lib/streaming/payload-builder'
import { applyChatCompletionResponse } from '../src/features/playground/lib/message/message-streaming-utils'
import type { ChatCompletionRequest, ChatCompletionResponse, Message } from '../src/features/playground/types'
import { api } from '../src/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('../src/features/agent/client-crawler/client-crawler', () => ({
  crawlClientSite: vi.fn(() => { throw new Error('Unexpected crawl in GitHub evaluation.') }),
  fetchClientPage: vi.fn(() => { throw new Error('Unexpected fetch in GitHub evaluation.') }),
  searchClientSources: vi.fn(() => { throw new Error('Unexpected search in GitHub evaluation.') }),
}))

type PublicActivity = { number: number; title: string; html_url: string; body: string | null; pull_request?: unknown; body_truncated?: boolean }
const repository = 'ast-grep/ast-grep'
const results: Array<Record<string, unknown>> = []
let inferenceCalls = 0
const key = process.env.LAIN42_AGENT_EVAL_API_KEY?.trim()
const model = process.env.LAIN42_AGENT_EVAL_MODEL?.trim()

beforeAll(() => {
  if (!key || !model) throw new Error('Live evaluation requires a configured credential and model; missing configuration is a failure.')
  if (!['nvidia/nemotron-3-super-120b-a12b', 'meta/llama-3.2-11b-vision-instruct'].includes(model)) {
    throw new Error('Model is outside the bounded evaluation allowlist.')
  }
})

function message(key: string, from: Message['from'], content: string): Message {
  return { key, from, versions: [{ id: key, content }], status: 'complete' }
}

it.each([
  ['issues', '/api/agent/github/issues', 'issues'],
  ['pull requests', '/api/agent/github/pull-requests', 'pulls'],
])('grounds a final answer in real %s without native model tool calls', async (resource, sitePath, githubPath) => {
  const started = Date.now()
  let source: PublicActivity[] = []
  let answer = ''
  let usage: unknown
  let caseCalls = 0
  let lookups = 0
  let stage = 'lookup'
  const userText = `请阅读 ${repository} 的 ${resource}，仅列出返回结果中前两条的编号、标题、简短摘要和原始链接。不要给我操作教程，也不要使用本机 CLI。`
  let currentRequest = userText
  vi.mocked(api.get).mockImplementation(async (path, config) => {
    lookups += 1
    if (lookups > 1) throw new Error('The source must not be read again for a query-method follow-up.')
    expect(path).toBe(sitePath)
    expect(config?.params?.repo).toBe(repository)
    const response = await fetch(`https://api.github.com/repos/${repository}/${githubPath}?state=open&sort=updated&direction=desc&per_page=10`, {
      redirect: 'error', signal: AbortSignal.any([config?.signal as AbortSignal, AbortSignal.timeout(15_000)]),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lain42-bounded-public-grounding-evaluation' },
    })
    if (!response.ok) throw new Error(`Public GitHub lookup HTTP ${response.status}`)
    const data = await response.json() as PublicActivity[]
    source = data.filter((item) => githubPath !== 'issues' || !item.pull_request).map((item) => ({
      number: item.number, title: item.title, html_url: item.html_url, body: item.body?.slice(0, 2000) ?? null,
      body_truncated: (item.body?.length ?? 0) > 2000,
    }))
    expect(source.length).toBeGreaterThanOrEqual(1)
    return { data: { success: true, data: { items: source.map((item) => ({
      number: item.number, title: item.title, url: item.html_url, body: item.body, body_truncated: item.body_truncated,
    })) } } }
  })
  const request = async (payload: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> => {
    expect(source.length).toBeGreaterThanOrEqual(1)
    expect(payload.tools).toEqual([])
    expect(payload.messages.at(-1)?.content).toBe(currentRequest)
    if (caseCalls === 0) {
      const evidence = payload.messages.find((entry) => entry.name === 'lain42_github_oauth_context')
      expect(evidence?.content).toContain(source[0].title)
    } else {
      expect(payload.messages.find((entry) => entry.role === 'assistant')?.content).toContain('读取记录：网站 GitHub OAuth')
      const record = payload.messages.find((entry) => entry.name === 'lain42_execution_record')
      expect(record?.content).toContain('"repo":"ast-grep/ast-grep"')
      expect(record?.content).toContain('"limit":10')
    }
    caseCalls += 1
    inferenceCalls += 1
    if (caseCalls > (resource === 'issues' ? 2 : 1) || inferenceCalls > 3) throw new Error('Live inference budget exceeded; no retries are allowed.')
    stage = 'inference'
    const response = await fetch('https://api.lain42.top/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`Website inference HTTP ${response.status}`)
    const body = await response.json() as ChatCompletionResponse
    usage = body.usage
    const text = body.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim() || (key && text.includes(key))) {
      throw new Error('Missing or unsafe model text.')
    }
    answer = text
    return body
  }
  try {
    const payload = buildChatCompletionPayload([
      message('system', 'system', `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}`),
      message('user', 'user', userText),
    ], { ...DEFAULT_CONFIG, model: model ?? '', stream: false, max_tokens: 1024 },
    { ...DEFAULT_PARAMETER_ENABLED, max_tokens: true, temperature: false,
      top_p: false, frequency_penalty: false, presence_penalty: false }, true)
    const provider = createBrowserAgentToolProvider(undefined, false)
    const firstResponse = await runLocalToolLoop(payload, provider, AbortSignal.timeout(90_000), undefined, request)
    stage = 'grounding'
    for (const item of source.slice(0, 2)) {
      expect(answer).toContain(item.html_url)
      expect(answer.toLowerCase()).toContain(item.title.toLowerCase())
    }
    const returnedLinks = answer.match(/https:\/\/github\.com\/ast-grep\/ast-grep\/(?:issues|pull)\/\d+/gu) ?? []
    const allowedLinks = new Set(source.slice(0, 2).map((item) => item.html_url))
    expect(returnedLinks.every((link) => allowedLinks.has(link))).toBe(true)
    if (source.length === 1) {
      expect(answer).not.toMatch(/(?:^|\n)\s*2[.)、]\s/mu)
    }
    const numberedReferences = [...answer.matchAll(/#(\d+)\b/gu)].map((match) => Number(match[1]))
    const allowedNumbers = new Set(source.slice(0, 2).map((item) => item.number))
    expect(numberedReferences.every((number) => allowedNumbers.has(number))).toBe(true)
    expect(answer).not.toMatch(/gh auth login|github\.oauth\.\w+\.\w+\(\)/iu)
    results.push({ resource, passed: true, elapsed_ms: Date.now() - started, expected_items: Math.min(2, source.length), inference_calls: caseCalls, source: source.slice(0, 2), answer: answer.slice(0, 8000), usage })
    if (resource === 'issues') {
      stage = 'follow-up'
      currentRequest = '你怎么查询的?'
      const actualAnswer = firstResponse.choices[0]?.message.content
      expect(typeof actualAnswer).toBe('string')
      const actualMessage = applyChatCompletionResponse(message('actual-answer', 'assistant', ''), firstResponse)
      if (!actualMessage) throw new Error('The first model response did not form a completed message.')
      const followup = buildChatCompletionPayload([
        message('system', 'system', `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}`),
        message('user', 'user', userText),
        actualMessage,
        message('follow-up', 'user', currentRequest),
      ], { ...DEFAULT_CONFIG, model: model ?? '', stream: false, max_tokens: 1024 },
      { ...DEFAULT_PARAMETER_ENABLED, max_tokens: true, temperature: false,
        top_p: false, frequency_penalty: false, presence_penalty: false }, true)
      await runLocalToolLoop(followup, provider, AbortSignal.timeout(90_000), undefined, request)
      stage = 'follow-up-grounding'
      expect(answer).toMatch(/oauth/iu)
      expect(answer).toMatch(/网站|本站|浏览器|website|site|browser/iu)
      expect(answer).not.toMatch(/lyco-skill|(?:需要|必须|请先).{0,15}(?:gh auth login|登录.{0,8}(?:CLI|gh))/iu)
      expect(answer).not.toMatch(/\bowner\s*[:=]|\bname\s*[:=]|未传入\s*[`"']?limit|(?:按|按照)创建时间|(?:仓库|返回|获取).{0,12}全部(?:公开)?\s*issue|默认分页/iu)
      expect(answer).toMatch(/repo\s*[:=]\s*[`"']?ast-grep\/ast-grep|ast-grep\/ast-grep/iu)
      expect(answer).toMatch(/limit(?:\*\*|[`"'])?\s*[:：=]\s*(?:\*\*|[`"'])?10\b|(?:上限|最多|至多).{0,8}10/iu)
      expect(lookups).toBe(1)
      results.push({ resource: 'query-method-follow-up', passed: true, elapsed_ms: Date.now() - started,
        inference_calls: 1, lookup_calls: lookups, actual_previous_answer: String(actualAnswer).slice(0, 8000),
        answer: answer.slice(0, 8000), usage })
    }
  } catch {
    results.push({ resource, passed: false, elapsed_ms: Date.now() - started, source: source.slice(0, 2),
      answer: answer.slice(0, 8000), stage, inference_calls: caseCalls, error: 'Lookup, timeout, inference or grounding assertions failed.', usage })
    throw new Error('Live grounding failed; inspect the bounded evidence artifact.')
  }
})

afterAll(async () => {
  await mkdir('evaluation-results', { recursive: true })
  await writeFile('evaluation-results/agent-grounding.json', JSON.stringify({
    candidate_sha: process.env.GITHUB_SHA, model, created_at: new Date().toISOString(),
    scope: 'Actual candidate payload builder, provider and tool loop; real public GitHub data via an external HTTP test adapter, real website model, and a follow-up using the actual previous answer and read record. NOT website OAuth, DSH, browser, mobile or two-user E2E.',
    max_inference_requests: 3, max_output_tokens_per_request: 1024, inferenceCalls, results,
  }, null, 2))
})
