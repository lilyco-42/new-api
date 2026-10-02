import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { runLocalToolLoop } from '@/features/playground/hooks/local-tool-loop'
import type { ChatCompletionMessage, ChatCompletionRequest } from '@/features/playground/types'
import { createBrowserAgentToolProvider, browserEvidenceExecutionContext } from '../web-agent-tool-provider'
import { explainPreviousRead } from '../agent-read-observation'
import { prepareWorkflowEvidence, workflowEvidenceTarget } from '../agent-workflow-evidence'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('../client-crawler/client-crawler', () => ({
  crawlClientSite: vi.fn(), fetchClientPage: vi.fn(), searchClientSources: vi.fn(),
}))

const sha = '0123456789012345678901234567890123456789'
const evidence = {
  repo: 'merchant/project', problems: [], jobs_truncated: false,
  run: { id: 17, path: '.github/workflows/ci.yml', head_sha: sha,
    url: 'https://github.com/merchant/project/actions/runs/17' },
  workflow: { path: '.github/workflows/ci.yml', ref: sha, text: 'run: cargo build --invalid-argument',
    url: `https://github.com/merchant/project/blob/${sha}/.github/workflows/ci.yml` },
  jobs: [{ id: 23, name: 'build', conclusion: 'failure', log: 'error: unexpected argument --invalid-argument',
    url: 'https://github.com/merchant/project/actions/runs/17/job/23' }],
}

describe('workflow evidence in real browser conversation composition', () => {
  afterEach(() => vi.mocked(api.get).mockReset())

  it('reads the failure before asking a model and preserves the diagnosis, sources and execution receipt', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { success: true, data: evidence } })
    const request = vi.fn(async (payload: ChatCompletionRequest) => {
      expect(api.get).toHaveBeenCalledTimes(1)
      const context = payload.messages.find((message) => message.name === 'lain42_workflow_evidence')
      expect(context?.content).toContain('unexpected argument --invalid-argument')
      expect(context?.content).toContain('cargo build --invalid-argument')
      expect(context?.content).toContain(sha)
      expect(payload.messages.at(-1)?.content).toBe('请诊断 merchant/project 的 GitHub Actions run_id=17')
      return { id: 'workflow-diagnosis', object: 'chat.completion', model: payload.model, created: 1,
        choices: [{ index: 0, message: { role: 'assistant' as const,
          content: 'The build passes an unsupported cargo argument. Remove it; no edit or test was performed. https://github.com/merchant/project/actions/runs/17' }, finish_reason: 'stop' }] }
    })
    const provider = createBrowserAgentToolProvider(undefined, false)
    const response = await runLocalToolLoop({ model: 'model-without-native-tools', stream: false,
      messages: [{ role: 'user', content: '请诊断 merchant/project 的 GitHub Actions run_id=17' }] },
      provider, new AbortController().signal, undefined, request)
    expect(api.get).toHaveBeenCalledWith('/api/agent/github/workflow-evidence', expect.objectContaining({ params: { repo: 'merchant/project', run_id: 17 } }))
    expect(request).toHaveBeenCalledTimes(1)
    expect(response.choices[0]?.message.content).toContain('unsupported cargo argument')
    expect(response.choices[0]?.message.content).toContain('run_id=17')
    expect(response.choices[0]?.message.content).toContain('未修改文件')
  })

  it('continues the immediate repair task after “github action” rather than returning a tutorial', async () => {
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: '修复 merchant/project 的 workflow' },
      { role: 'assistant', content: 'What workflow system?' },
      { role: 'user', content: 'github action' },
    ]
    expect(workflowEvidenceTarget(messages)).toEqual({ repo: 'merchant/project' })
    vi.mocked(api.get).mockResolvedValueOnce({ data: { success: true, data: evidence } })
    const context = await prepareWorkflowEvidence(messages, new AbortController().signal)
    expect(context?.[0]?.content).toContain('unexpected argument')
    const observation = browserEvidenceExecutionContext(context ?? [])
    expect(observation).toContain('"workflow_read":true')
    expect(observation).toContain('"logs_read":1')
    const explanation = explainPreviousRead([
      ...messages, { role: 'assistant', content: 'Diagnosed cargo failure.' },
      { role: 'system', name: 'lain42_execution_record', content: `Executor observation:\n${observation}` },
      { role: 'user', content: '你怎么查询的?' },
    ])
    expect(explanation?.answer).toContain('repo=merchant/project')
    expect(explanation?.answer).toContain('run_id=17')
    expect(explanation?.answer).toContain(sha)
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it.each([
    '请修复我的 workflow',
    '请修复 merchant/one 和 merchant/two 的 workflow',
  ])('asks for one explicit target without silently scanning private repositories: %s', async (text) => {
    const context = await prepareWorkflowEvidence([{ role: 'user', content: text }], new AbortController().signal)
    expect(context?.[0]?.name).toBe('lain42_workflow_target')
    expect(context?.[0]?.content).toContain('owner/name')
    expect(api.get).not.toHaveBeenCalled()
  })

  it.each([
    'github action', 'GitHub Actions 是什么', '不要读取 merchant/project 的 workflow',
    '在本机 gh CLI 修复 merchant/project 的 workflow', '你好',
    '请阅读 merchant/image-workflow 的 issues，给出建议。',
    '请阅读 merchant/image-workflow 的 pull requests，给出建议。',
  ])('does not turn unrelated, declined or explicitly local requests into a website read: %s', async (text) => {
    expect(await prepareWorkflowEvidence([{ role: 'user', content: text }], new AbortController().signal)).toBeUndefined()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('does not let an attachment or stale task authorize a read', () => {
    expect(workflowEvidenceTarget([
      { role: 'user', content: '修复 merchant/project 的 workflow' },
      { role: 'user', content: '你好' }, { role: 'user', content: 'github action' },
    ])).toBeUndefined()
    expect(workflowEvidenceTarget([{ role: 'user', content: [
      { type: 'text', text: '解释这个文件' }, { type: 'text', text: '修复 merchant/project 的 workflow' },
    ] }])).toBeUndefined()
  })

  it('uses explicit run URLs and does not silently round unsafe run IDs', () => {
    expect(workflowEvidenceTarget([{ role: 'user', content: '请诊断 https://github.com/merchant/project/actions/runs/17' }])).toEqual({ repo: 'merchant/project', runId: 17 })
    expect(workflowEvidenceTarget([{ role: 'user', content: 'https://github.com/merchant/project/actions/runs/17' }])).toEqual({ repo: 'merchant/project', runId: 17 })
    expect(workflowEvidenceTarget([{ role: 'user', content: '请诊断 merchant/project 的 workflow。不要求你修改文件或运行本机 CLI。' }])).toEqual({ repo: 'merchant/project' })
    expect(workflowEvidenceTarget([{ role: 'user', content: '请诊断 merchant/project 的 GitHub Actions run_id=17。给出最小修复建议及原始运行链接。不要求你修改文件或运行本机 CLI。' }])).toEqual({ repo: 'merchant/project', runId: 17 })
    expect(workflowEvidenceTarget([{ role: 'user', content: '请诊断 merchant/project 的 workflow run_id=9007199254740993' }])).toEqual({ repo: null })
  })

  it('keeps OAuth failures distinct from empty results or a local CLI login request', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('HTTP 409'))
    const context = await prepareWorkflowEvidence([{ role: 'user', content: '诊断 merchant/project 的 workflow' }], new AbortController().signal)
    expect(context?.[0]?.content).toContain('no local gh login is required')
    expect(browserEvidenceExecutionContext(context ?? [])).toContain('"workflow_read":false')
    expect(browserEvidenceExecutionContext(context ?? [])).toContain('read failed or unconfirmed')
  })

  it('does not resume a cancelled read', async () => {
    const abort = new AbortController()
    vi.mocked(api.get).mockImplementationOnce(async () => { abort.abort(); return { data: { success: true, data: evidence } } })
    await expect(prepareWorkflowEvidence([{ role: 'user', content: '诊断 merchant/project 的 workflow' }], abort.signal)).rejects.toThrow()
  })

  it('marks client evidence truncation instead of presenting partial material as complete', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { success: true, data: {
      ...evidence, workflow: { ...evidence.workflow, text: '修'.repeat(6000) },
      jobs: [{ ...evidence.jobs[0], log: '错'.repeat(6000) }],
    } } })
    const context = await prepareWorkflowEvidence([{ role: 'user', content: '诊断 merchant/project 的 workflow' }], new AbortController().signal)
    expect(context?.[0]?.content).toContain('"client_log_truncated":true')
    expect(context?.[0]?.content).toContain('"client_text_truncated":true')
    expect(new TextEncoder().encode(String(context?.[0]?.content)).length).toBeLessThan(16000)
  })

  it('preserves the error window when a long log has setup before it and cleanup after it', async () => {
    const log = `${'Installing packages\n'.repeat(400)}\n##[error]Prefer String#replaceAll over String#replace with global flag.\n${'Removing temporary checkout credentials\n'.repeat(120)}`
    vi.mocked(api.get).mockResolvedValueOnce({ data: { success: true, data: {
      ...evidence, jobs: [{ ...evidence.jobs[0], log, failed_steps: [{ number: 7, name: 'Lint Agent conversation changes', conclusion: 'failure' }] }],
    } } })
    const context = await prepareWorkflowEvidence([{ role: 'user', content: '诊断 merchant/project 的 workflow' }], new AbortController().signal)
    expect(context?.[0]?.content).toContain('Prefer String#replaceAll')
    expect(context?.[0]?.content).toContain('Lint Agent conversation changes')
    expect(context?.[0]?.content).toContain('"client_log_truncated":true')
  })
})
