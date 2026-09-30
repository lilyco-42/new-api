import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LocalToolProvider,
  Message,
} from '@/features/playground/types'
import { api } from '@/lib/api'

import { createAgentDSHConversation } from '../agent-dsh'
import { browserSearchResponseAppendix, webAgentToolProvider } from '../web-agent-tool-provider'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../web-agent-tool-provider', () => ({
  browserSearchResponseAppendix: vi.fn(() => ''),
  webAgentToolProvider: {
    tools: [],
    preflight: vi.fn(() => null),
    requiresApproval: vi.fn(async () => true),
    invoke: vi.fn(async () => JSON.stringify({ error: 'CORS blocked the page read' })),
    beforeModel: vi.fn(async () => null),
    prepareContext: vi.fn(async () => []),
    finalizeResponse: vi.fn((response: ChatCompletionResponse) => response),
  },
}))

const SESSION_ID = 'A'.repeat(64)
const OTHER_SESSION_ID = 'B'.repeat(64)
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000'
const providers: Array<ReturnType<typeof createAgentDSHConversation>> = []
const browserHooks = webAgentToolProvider as LocalToolProvider & Required<Pick<
  LocalToolProvider,
  'beforeModel' | 'preflight' | 'prepareContext' | 'finalizeResponse' | 'requiresApproval'
>>

function storageFixture() {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

function success<T>(data: T) {
  return { data: { success: true, data } }
}

function request(content: ChatCompletionMessage['content']): ChatCompletionRequest {
  return {
    model: 'openai/gpt-5.6-sol',
    messages: [{ role: 'user', content }],
    stream: false,
  }
}

function message(key: string, content: string): Message[] {
  return [{
    key,
    from: 'user',
    versions: [{ id: key, content }],
  }]
}

describe('Lain42 DSH conversation adapter', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.post).mockReset()
    vi.mocked(browserHooks.beforeModel).mockReset().mockResolvedValue(null)
    vi.mocked(browserHooks.preflight).mockReset().mockReturnValue(null)
    vi.mocked(browserHooks.prepareContext).mockClear()
    vi.mocked(browserHooks.finalizeResponse).mockClear()
    vi.mocked(browserSearchResponseAppendix).mockReset().mockReturnValue('')
    vi.mocked(browserHooks.requiresApproval).mockReset().mockResolvedValue(true)
    vi.mocked(browserHooks.invoke).mockReset()
    vi.stubGlobal('crypto', {
      randomUUID: () => REQUEST_ID,
      subtle: globalThis.crypto.subtle,
    })
  })

  afterEach(() => {
    providers.splice(0).forEach((provider) => provider.reset())
    vi.unstubAllGlobals()
  })

  it('sends an authenticated research turn to DSH and returns its answer', async () => {
    const storage = storageFixture()
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'Here is the verified answer.',
      }) as never)

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-research-chat-7',
      mode: 'research',
      storage,
    })
    providers.push(provider)
    const result = await provider.send(
      request('Compare these two options.'),
      message('user-1', 'Compare these two options.'),
      new AbortController().signal
    )

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      '/api/agent/dsh/sessions',
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/api/agent/dsh/turns',
      expect.objectContaining({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        model: 'openai/gpt-5.6-sol',
        mode: 'research',
        text: expect.stringContaining('Current user request:\nCompare these two options.'),
      }),
      expect.objectContaining({ timeout: 130_000 })
    )
    expect(result?.choices[0]?.message.content).toBe('Here is the verified answer.')
    expect(webAgentToolProvider.prepareContext).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(api.post).mock.calls.at(-1)?.[1])).not.toContain(
      'Browser-prepared context:'
    )
  })

  it('keeps ordinary hosted chat working when the paired local device is offline', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'DeepSeek is an AI company and model family.',
      }) as never)

    const localToolProvider: LocalToolProvider = {
      tools: [{
        type: 'function',
        function: {
          name: 'agent.workspace.browse',
          description: 'Browse the paired device workspace.',
          parameters: { type: 'object', properties: {} },
        },
      }],
      isAvailable: () => false,
      invoke: vi.fn(async () => 'agent device is offline'),
    }
    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-14',
      mode: 'general',
      localToolProvider,
      storage: storageFixture(),
    })
    providers.push(provider)
    const query = 'What is DeepSeek?'

    const result = await provider.send(
      request(query),
      message('offline-device-question', query),
      new AbortController().signal
    )

    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/api/agent/dsh/turns',
      expect.objectContaining({
        mode: 'general',
        text: expect.stringContaining(`Current user request:\n${query}`),
      }),
      expect.any(Object)
    )
    expect(localToolProvider.invoke).not.toHaveBeenCalled()
    expect(result?.choices[0]?.message.content).toBe(
      'DeepSeek is an AI company and model family.'
    )
  })

  it.each(['hi', '123', '??'])('uses hosted inference rather than preflight for short input %j', async (text) => {
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID, request_id: REQUEST_ID, answer: 'Selected model reply.' }) as never)
    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-13', mode: 'general', storage: storageFixture(),
    })
    providers.push(provider)
    const result = await provider.send(request(text), message('short-input', text), new AbortController().signal)
    expect(result?.choices[0]?.message.content).toBe('Selected model reply.')
    expect(api.post).toHaveBeenLastCalledWith('/api/agent/dsh/turns', expect.objectContaining({ text: expect.stringContaining(text) }), expect.any(Object))
    expect(webAgentToolProvider.preflight).not.toHaveBeenCalled()
  })

  it('fails closed when no site model is selected instead of using the DSH host default', async () => {
    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-14',
      mode: 'general',
      storage: storageFixture(),
    })
    providers.push(provider)

    const result = await provider.send(
      { ...request('hello'), model: '' },
      message('missing-model', 'hello'),
      new AbortController().signal
    )

    expect(result?.choices[0]?.message.content).toBe('Select a site model before sending a message.')
    expect(api.get).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('forwards locally extracted Office text as part of the DSH user turn', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'The spreadsheet shows revenue of 4,200.',
      }) as never)

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-12',
      mode: 'general',
      storage: storageFixture(),
    })
    providers.push(provider)
    const prompt = request([
      { type: 'text', text: 'Summarize this spreadsheet.' },
      {
        type: 'text',
        text: '[Attached XLSX: sales.xlsx]\n[Untrusted document text]\nWorksheet: Sales\nRow 1: A1=Revenue | B1=4200',
      },
    ])

    const result = await provider.send(
      prompt,
      message('office-attachment', 'Summarize this spreadsheet.'),
      new AbortController().signal
    )

    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        text: expect.stringContaining(
          'Worksheet: Sales\nRow 1: A1=Revenue | B1=4200'
        ),
      }),
      expect.any(Object)
    )
    expect(result?.choices[0]?.message.content).toBe(
      'The spreadsheet shows revenue of 4,200.'
    )
  })

  it('passes connected GitHub evidence to DSH instead of returning the browser list', async () => {
    const evidence: ChatCompletionMessage = { role: 'system', name: 'lain42_github_oauth_context', content: 'lilyco-42/rembg-ui: image processing repository' }
    vi.mocked(browserHooks.prepareContext).mockResolvedValueOnce([evidence])
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID, request_id: REQUEST_ID, answer: 'Repository analysis from DSH.' }) as never)
    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-11', mode: 'general', storage: storageFixture(),
    })
    providers.push(provider)
    const result = await provider.send(request('查看我的 GitHub 仓库'), message('github-repository-list', '查看我的 GitHub 仓库'), new AbortController().signal)
    expect(result?.choices[0]?.message.content).toBe('Repository analysis from DSH.')
    expect(webAgentToolProvider.beforeModel).not.toHaveBeenCalled()
    expect(api.post).toHaveBeenLastCalledWith('/api/agent/dsh/turns', expect.objectContaining({ text: expect.stringContaining('image processing repository') }), expect.any(Object))
  })

  it('adds explicitly requested browser search evidence to the hosted DSH turn', async () => {
    const storage = storageFixture()
    const evidence: ChatCompletionMessage = {
      role: 'system',
      name: 'lain42_browser_search_context',
      content: 'Public GitHub result: https://github.com/ast-grep/ast-grep',
    }
    vi.mocked(browserHooks.prepareContext).mockResolvedValueOnce([evidence])
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'The DSH model used its account-scoped search tool.',
      }) as never)

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-research-chat-8',
      mode: 'research',
      storage,
    })
    providers.push(provider)
    const query = '请用网页搜索在浏览器端查找 GitHub 上 ast-grep 的官方仓库，给我仓库名和来源链接。不要搜索我的个人仓库，也不要用本机 gh 或 Radxa。'
    const result = await provider.send(
      request(query),
      message('research-search', query),
      new AbortController().signal
    )

    expect(webAgentToolProvider.prepareContext).toHaveBeenCalledOnce()
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        mode: 'research',
        text: expect.stringContaining('[Lain42 browser-fetched evidence] These results were prepared'),
      }),
      expect.any(Object)
    )
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        text: expect.stringContaining(`Current user request:\n${query}`),
      }),
      expect.any(Object)
    )
    expect(result?.choices[0]?.message.content).toBe(
      'The DSH model used its account-scoped search tool.'
    )
  })

  it('passes browser search evidence into DSH without substituting its analysis', async () => {
    const storage = storageFixture()
    const evidence: ChatCompletionMessage = {
      role: 'system',
      name: 'lain42_browser_search_context',
      content: 'Official DeepSeek model releases. URL: https://huggingface.co/deepseek-ai',
    }
    vi.mocked(browserHooks.prepareContext).mockResolvedValueOnce([evidence])
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'DeepSeek model comparison: report evidence and architecture analysis.',
      }) as never)

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-10',
      mode: 'general',
      storage,
    })
    providers.push(provider)
    const query = 'deepseek'
    const result = await provider.send(
      request(query),
      message('deepseek-definition', query),
      new AbortController().signal
    )

    expect(webAgentToolProvider.prepareContext).toHaveBeenCalledOnce()
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        text: expect.stringContaining('[Lain42 browser-fetched evidence] These results were prepared'),
      }),
      expect.any(Object)
    )
    expect(browserSearchResponseAppendix).toHaveBeenCalledWith(
      expect.any(Array),
      [evidence]
    )
    expect(webAgentToolProvider.finalizeResponse).not.toHaveBeenCalled()
    expect(result?.choices[0]?.message.content).toBe(
      'DeepSeek model comparison: report evidence and architecture analysis.'
    )
  })

  it('passes a client-only failure notice when CORS prevents browser-side URL reading', async () => {
    const storage = storageFixture()
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'I could not verify the page from the available sources.',
      }) as never)
    vi.mocked(browserHooks.invoke).mockResolvedValueOnce(
      JSON.stringify({ error: 'CORS blocked the page read' })
    )

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-9',
      mode: 'general',
      storage,
    })
    providers.push(provider)
    const query = 'Summarize https://example.com/docs'
    const result = await provider.send(
      request(query),
      message('url-after-cors', query),
      new AbortController().signal
    )

    expect(webAgentToolProvider.requiresApproval).toHaveBeenCalledOnce()
    expect(webAgentToolProvider.invoke).toHaveBeenCalledOnce()
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        text: expect.stringContaining(`Current user request:\n${query}`),
      }),
      expect.any(Object)
    )
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        text: expect.stringContaining('[Lain42 browser page read failed; no page content was retrieved.]'),
      }),
      expect.any(Object)
    )
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        text: expect.stringContaining('There is no server-side page-fetch tool.'),
      }),
      expect.any(Object)
    )
    expect(result?.choices[0]?.message.content).toBe(
      'I could not verify the page from the available sources.'
    )
  })

  it('reuses the same request id after a network failure so a retry cannot duplicate the DSH turn', async () => {
    const storage = storageFixture()
    vi.mocked(api.get)
      .mockResolvedValueOnce(success({ configured: true }) as never)
      .mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'Recovered answer.',
      }) as never)

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-7',
      mode: 'general',
      storage,
    })
    providers.push(provider)
    const payload = request('Continue after reconnecting.')
    const messages = message('user-retry', 'Continue after reconnecting.')
    const signal = new AbortController().signal

    await expect(provider.send(payload, messages, signal)).rejects.toThrow(
      'network timeout'
    )
    const result = await provider.send(payload, messages, signal)

    const firstTurn = vi.mocked(api.post).mock.calls[1]?.[1]
    const retriedTurn = vi.mocked(api.post).mock.calls[2]?.[1]
    expect(firstTurn).toMatchObject({ request_id: REQUEST_ID })
    expect(retriedTurn).toMatchObject({ request_id: REQUEST_ID })
    expect(vi.mocked(api.post)).toHaveBeenCalledTimes(3)
    expect(result?.choices[0]?.message.content).toBe('Recovered answer.')
  })

  it('starts a fresh DSH session when a failed user message is edited before retry', async () => {
    const storage = storageFixture()
    const requestIds = [
      '123e4567-e89b-42d3-a456-426614174000',
      '123e4567-e89b-42d3-a456-426614174001',
    ]
    vi.stubGlobal('crypto', {
      randomUUID: () => requestIds.shift() ?? REQUEST_ID,
      subtle: globalThis.crypto.subtle,
    })
    vi.mocked(api.get)
      .mockResolvedValueOnce(success({ configured: true }) as never)
      .mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(success({ session_id: OTHER_SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: OTHER_SESSION_ID,
        request_id: '123e4567-e89b-42d3-a456-426614174001',
        answer: 'Answer for the edited request.',
      }) as never)

    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-8',
      mode: 'general',
      storage,
    })
    providers.push(provider)
    const signal = new AbortController().signal

    await expect(provider.send(
      request('What is the first question?'),
      message('user-edited', 'What is the first question?'),
      signal
    )).rejects.toThrow('network timeout')
    await provider.send(
      request('What is the corrected question?'),
      message('user-edited', 'What is the corrected question?'),
      signal
    )

    expect(vi.mocked(api.post).mock.calls.filter(
      ([path]) => path === '/api/agent/dsh/sessions'
    )).toHaveLength(2)
    const turnCalls = vi.mocked(api.post).mock.calls.filter(
      ([path]) => path === '/api/agent/dsh/turns'
    )
    expect(turnCalls.map(([, body]) => (body as { request_id: string }).request_id))
      .toEqual([
        '123e4567-e89b-42d3-a456-426614174000',
        '123e4567-e89b-42d3-a456-426614174001',
      ])
  })

  it('forwards bounded inline image attachments through a DSH v2 turn', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'The picture contains a red object.',
      }) as never)
    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-7',
      mode: 'general',
      storage: storageFixture(),
    })
    providers.push(provider)
    const payload = request([
      { type: 'text', text: 'Describe this picture.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } },
    ])

    const result = await provider.send(
      payload,
      message('user-image', 'Describe this picture.'),
      new AbortController().signal
    )

    expect(api.post).toHaveBeenLastCalledWith(
      '/api/agent/dsh/turns',
      expect.objectContaining({
        text: expect.stringContaining('Describe this picture.'),
        images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' }],
      }),
      expect.any(Object)
    )
    expect(result?.choices[0]?.message.content).toBe('The picture contains a red object.')
  })

  it('does not forward remote image URLs or unsupported image formats to DSH', async () => {
    const provider = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-8',
      mode: 'general',
      storage: storageFixture(),
    })
    providers.push(provider)
    const payload = request([
      { type: 'text', text: 'Describe this picture.' },
      { type: 'image_url', image_url: { url: 'https://example.com/private.png' } },
    ])

    const result = await provider.send(
      payload,
      message('user-remote-image', 'Describe this picture.'),
      new AbortController().signal
    )
    expect(api.get).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
    expect(result?.choices[0]?.message.content).toContain('PNG')
  })

  it('does not reuse a hosted session across account namespaces', async () => {
    const storage = storageFixture()
    vi.mocked(api.get)
      .mockResolvedValueOnce(success({ configured: true }) as never)
      .mockResolvedValueOnce(success({ configured: true }) as never)
    vi.mocked(api.post)
      .mockResolvedValueOnce(success({ session_id: SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'Account A answer.',
      }) as never)
      .mockResolvedValueOnce(success({ session_id: OTHER_SESSION_ID }) as never)
      .mockResolvedValueOnce(success({
        session_id: OTHER_SESSION_ID,
        request_id: REQUEST_ID,
        answer: 'Account B answer.',
      }) as never)

    const accountA = createAgentDSHConversation({
      storageNamespace: 'agent-user-42-general-chat-1',
      mode: 'general',
      storage,
    })
    providers.push(accountA)
    const accountB = createAgentDSHConversation({
      storageNamespace: 'agent-user-43-general-chat-1',
      mode: 'general',
      storage,
    })
    providers.push(accountB)
    const payload = request('hello')
    const messages = message('same-visible-message-id', 'hello')
    const signal = new AbortController().signal

    await accountA.send(payload, messages, signal)
    await accountB.send(payload, messages, signal)

    const turnCalls = vi.mocked(api.post).mock.calls.filter(
      ([path]) => path === '/api/agent/dsh/turns'
    )
    expect(turnCalls.map(([, body]) => (body as { session_id: string }).session_id))
      .toEqual([SESSION_ID, OTHER_SESSION_ID])
  })
})
