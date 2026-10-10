import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ChatCompletionRequest,
  Message,
} from '@/features/playground/types'
import { api } from '@/lib/api'

import { createAgentDSHConversation } from '../agent-dsh'
import { searchClientSources } from '../client-crawler/client-crawler'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../client-crawler/client-crawler', () => ({
  crawlClientSite: vi.fn(),
  fetchClientPage: vi.fn(),
  searchClientSources: vi.fn(),
}))

const SESSION_ID = 'A'.repeat(64)
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000'
const providers: Array<ReturnType<typeof createAgentDSHConversation>> = []

function storageFixture() {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

function success<T>(data: T) {
  return { data: { success: true, data } }
}

function request(text: string): ChatCompletionRequest {
  return {
    model: 'openai/gpt-5.6-sol',
    messages: [{ role: 'user', content: text }],
    stream: false,
  }
}

function messages(text: string): Message[] {
  return [{
    key: 'search-request',
    from: 'user',
    versions: [{ id: 'search-request', content: text }],
  }]
}

describe('hosted DSH browser search evidence', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.post).mockReset()
    vi.mocked(searchClientSources).mockReset()
    vi.stubGlobal('crypto', {
      randomUUID: () => REQUEST_ID,
      subtle: globalThis.crypto.subtle,
    })
  })

  afterEach(() => {
    providers.splice(0).forEach((provider) => provider.reset())
    vi.unstubAllGlobals()
  })

  it('returns a model answer with verified search source links', async () => {
    const query = '请用网页搜索查 GitHub 上 ast-grep 的官方仓库，并给出来源链接。'
    const signal = new AbortController().signal
    vi.mocked(searchClientSources).mockResolvedValueOnce({
      execution: 'browser-wasm',
      query: 'ast-grep',
      fetched_at: '2026-09-30T00:00:00.000Z',
      sources: ['GitHub'],
      warnings: [],
      items: [{
        title: 'ast-grep/ast-grep',
        url: 'https://github.com/ast-grep/ast-grep',
        snippet: 'AST-based code search, lint, and rewriting.',
        source: 'GitHub',
      }],
    })
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'ast-grep/ast-grep is the repository for ast-grep.',
      }) as never)

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-research-chat-41',
      mode: 'research',
      storage: storageFixture(),
    })
    providers.push(provider)

    const result = await provider.send(request(query), messages(query), signal)

    expect(searchClientSources).toHaveBeenCalledWith(
      'ast-grep',
      5,
      signal,
      'github'
    )
    const turn = vi.mocked(api.post).mock.calls.find(
      ([path]) => path === '/api/agent/dsh/turns'
    )
    expect(turn?.[1]).toEqual(expect.objectContaining({
      text: expect.stringContaining('AST-based code search, lint, and rewriting.'),
    }))
    expect(turn?.[1]).toEqual(expect.objectContaining({
      text: expect.stringContaining('https://github.com/ast-grep/ast-grep'),
    }))
    expect(result?.choices[0]?.message.content).toContain(
      'ast-grep/ast-grep is the repository for ast-grep.'
    )
    expect(result?.choices[0]?.message.content).toContain('检索来源：')
    expect(result?.choices[0]?.message.content).toContain(
      'https://github.com/ast-grep/ast-grep'
    )
  })
})
