// Real production Go reader output + candidate browser provider + website model.
// The HTTP adapter does not establish a production browser OAuth session.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterAll, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import { AGENT_TOOL_PROMPT, LYCO_DEFAULT_SYSTEM_PROMPT } from '../src/features/agent/agent-prompts'
import { createBrowserAgentToolProvider } from '../src/features/agent/web-agent-tool-provider'
import { runLocalToolLoop } from '../src/features/playground/hooks/local-tool-loop'
import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../src/features/playground/constants'
import { buildChatCompletionPayload } from '../src/features/playground/lib/streaming/payload-builder'
import { applyChatCompletionResponse } from '../src/features/playground/lib/message/message-streaming-utils'
import type { ChatCompletionRequest, ChatCompletionResponse, Message } from '../src/features/playground/types'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('../src/features/agent/client-crawler/client-crawler', () => ({
  crawlClientSite: vi.fn(() => { throw new Error('Unexpected crawl') }),
  fetchClientPage: vi.fn(() => { throw new Error('Unexpected page fetch') }),
  searchClientSources: vi.fn(() => { throw new Error('Unexpected search') }),
}))
const results: Array<Record<string, unknown>> = []
const key = process.env.LAIN42_AGENT_EVAL_API_KEY?.trim()
const model = process.env.LAIN42_AGENT_EVAL_MODEL?.trim()
let calls = 0

function message(id: string, from: Message['from'], content: string): Message {
  return { key: id, from, versions: [{ id, content }], status: 'complete' }
}

it('diagnoses an actual failed Actions run from commit-pinned file and real job logs', async () => {
  let answer = ''
  let finalAnswer = ''
  let stage = 'configuration'
  let usage: unknown
  let finishReason: string | null = null
  try {
    if (!key || !model || !process.env.LAIN42_WORKFLOW_EVIDENCE_FILE) throw new Error('Missing manual evaluation configuration')
    if (!['nvidia/nemotron-3-super-120b-a12b', 'meta/llama-3.2-11b-vision-instruct'].includes(model)) throw new Error('Model not allowlisted')
    const evidence = JSON.parse(await readFile(process.env.LAIN42_WORKFLOW_EVIDENCE_FILE, 'utf8')) as {
      repo: string; run: { id: number; head_sha: string; path: string; url: string };
      workflow: { text: string; url: string }; jobs: Array<{ log?: string; log_error?: string }>;
    }
    expect(evidence.repo).toBe('lilyco-42/new-api')
    expect(evidence.workflow.text).toBeTruthy()
    expect(evidence.jobs.some((job) => typeof job.log === 'string' && job.log.length > 0)).toBe(true)
    let reads = 0
    vi.mocked(api.get).mockImplementation(async (path, options) => {
      reads++
      expect(reads).toBe(1)
      expect(path).toBe('/api/agent/github/workflow-evidence')
      expect(options?.params).toEqual({ repo: evidence.repo, run_id: evidence.run.id })
      return { data: { success: true, data: evidence } }
    })
    const user = `请用六行以内诊断 ${evidence.repo} 的 GitHub Actions run_id=${evidence.run.id}：实际失败步骤和具体报错、工作流路径与提交、最小修复建议、原始运行链接、证据限制。不要求你修改文件或运行本机 CLI。不要把未执行步骤或未看到的错误说成事实。`
    const history = [message('system', 'system', `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}`), message('user', 'user', user)]
    const payload = (items: Message[]) => buildChatCompletionPayload(items,
      { ...DEFAULT_CONFIG, model, stream: false, max_tokens: 2048 },
      { ...DEFAULT_PARAMETER_ENABLED, max_tokens: true, temperature: false, top_p: false,
        frequency_penalty: false, presence_penalty: false }, true)
    const request = async (input: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> => {
      if (calls >= 1) throw new Error('One-inference budget exceeded; no retries')
      expect(input.tools).toEqual([])
      const context = input.messages.find((item) => item.name === 'lain42_workflow_evidence')
      expect(context?.content).toContain(evidence.run.head_sha)
      expect(context?.content).toContain(evidence.run.path)
      expect(context?.content).toContain('String#replaceAll')
      stage = 'inference'
      calls++
      const response = await fetch('https://api.lain42.top/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`Website model HTTP ${response.status}`)
      const body = await response.json() as ChatCompletionResponse
      const text = body.choices?.[0]?.message.content
      if (typeof text !== 'string' || !text.trim() || text.includes(key)) throw new Error('Missing or unsafe answer')
      answer = text
      usage = body.usage
      finishReason = body.choices[0]?.finish_reason ?? null
      if (finishReason !== 'stop') throw new Error(`Incomplete model response: finish_reason=${finishReason}`)
      return body
    }
    const provider = createBrowserAgentToolProvider(undefined, false)
    const first = await runLocalToolLoop(payload(history), provider, AbortSignal.timeout(90_000), undefined, request)
    finalAnswer = String(first.choices[0]?.message.content ?? '')
    stage = 'grounding'
    expect(answer).toContain(evidence.run.path)
    expect(answer).toContain(`https://github.com/${evidence.repo}/actions/runs/${evidence.run.id}`)
    expect(answer).not.toMatch(/gh auth login|github\.oauth\.\w+\.\w+\(\)/iu)
    expect(answer).not.toMatch(/(?:已经|已)(?:修复|修改|提交|部署)|(?:I have|I've) (?:fixed|modified|committed|deployed)/iu)
    // Fixed historical run failed scoped frontend lint. Require the real issue,
    // not a plausible missing-lockfile or deployment tutorial.
    expect(answer).toMatch(/replaceAll/iu)
    expect(answer).toMatch(/(?:lint|oxlint)/iu)
    expect(answer).not.toMatch(/未读取(?:任何)?(?:仓库|工作流|文件)|(?:did not|have not|haven't) read (?:any )?(?:repository|workflow|files?)/iu)
    expect(answer).not.toMatch(/未见.{0,12}完整文件|(?:删[去除]|移除).{0,8}[`'“]?g[`'”]?.{0,4}标志/iu)
    const completed = applyChatCompletionResponse(message('answer', 'assistant', ''), first)
    if (!completed) throw new Error('No completed response')
    stage = 'execution-provenance'
    const explanation = await runLocalToolLoop(payload([...history, completed, message('followup', 'user', '你怎么查询的?')]),
      provider, AbortSignal.timeout(10_000), undefined, request)
    expect(explanation.choices[0]?.message.content).toContain(`run_id=${evidence.run.id}`)
    expect(explanation.choices[0]?.message.content).toContain(evidence.run.head_sha)
    expect(calls).toBe(1)
    expect(reads).toBe(1)
    results.push({ passed: true, inference_calls: calls, evidence, answer, final_answer: finalAnswer,
      query_method: explanation.choices[0]?.message.content, usage, finish_reason: finishReason })
  } catch (error) {
    results.push({ passed: false, stage, inference_calls: calls, answer, final_answer: finalAnswer, usage, finish_reason: finishReason,
      error: error instanceof Error ? error.message : 'Evaluation failed' })
    throw error
  }
})

afterAll(async () => {
  await mkdir('evaluation-results', { recursive: true })
  await writeFile('evaluation-results/agent-workflow-live.json', JSON.stringify({
    evaluated_at: new Date().toISOString(), model, inference_calls: calls,
    scope: 'Production Go reader with Actions read token, real historical public run, actual browser tool loop, website inference. Not production browser OAuth, hosted DSH, device, mobile or multi-user E2E. Manual semantic review required.', results,
  }, null, 2))
})
