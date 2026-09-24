import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runLocalToolLoop } from '@/features/playground/hooks/local-tool-loop'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'
import { api } from '@/lib/api'

import {
  crawlClientSite,
  fetchClientPage,
  searchClientSources,
} from '../client-crawler/client-crawler'
import {
  createBrowserAgentToolProvider,
  webAgentToolProvider,
} from '../web-agent-tool-provider'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('../client-crawler/client-crawler', () => ({
  crawlClientSite: vi.fn(),
  fetchClientPage: vi.fn(),
  searchClientSources: vi.fn(),
}))

function toolCall(
  name: string,
  args: Record<string, unknown>
): ChatCompletionToolCall {
  return {
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

describe('webAgentToolProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.get).mockResolvedValue({
      data: { success: true, data: { items: [] } },
    } as never)
    vi.mocked(searchClientSources)
      .mockReset()
      .mockResolvedValue({
        execution: 'browser-wasm',
        query: 'rust ai',
        fetched_at: '2026-09-23T00:00:00.000Z',
        sources: ['GitHub'],
        warnings: [],
        items: [],
      })
    vi.mocked(fetchClientPage).mockReset().mockResolvedValue({
      title: 'Guide',
      url: 'https://docs.example.com/guide',
      text: 'Guide body',
      fetched_at: '2026-09-23T00:00:00.000Z',
      links: [],
    })
    vi.mocked(crawlClientSite).mockReset().mockResolvedValue({
      execution: 'browser-wasm',
      start_url: 'https://docs.example.com/',
      query: '',
      fetched_at: '2026-09-23T00:00:00.000Z',
      pages: [],
      warnings: [],
    })
  })

  it('asks for context locally instead of searching for a standalone number', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: '123' }],
      stream: false,
    }
    const request = vi.fn(async () => {
      throw new Error('No model request should be made.')
    })
    const bridgeProvider: LocalToolProvider = {
      tools: [],
      isAvailable: () => true,
      invoke: async () => '',
    }

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(bridgeProvider),
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('你发来的是一个数字')
    expect(request).not.toHaveBeenCalled()
    expect(searchClientSources).not.toHaveBeenCalled()
  })

  it('recognizes a numeric text part but preserves image questions for the model', () => {
    const numeric = webAgentToolProvider.preflight?.([
      { role: 'user', content: [{ type: 'text', text: '123' }] },
    ])
    const imageQuestion = webAgentToolProvider.preflight?.([
      {
        role: 'user',
        content: [
          { type: 'text', text: '123' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/a.png' },
          },
        ],
      },
    ])

    expect(numeric?.choices[0]?.message.content).toContain('你发来的是一个数字')
    expect(imageQuestion).toBeNull()
  })

  it('answers a greeting from the latest turn without carrying over an old topic', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [
        { role: 'user', content: 'DeepSeek 是什么？' },
        {
          role: 'assistant',
          content: 'DeepSeek 是一个编程代理。',
        },
        { role: 'user', content: '你好' },
      ],
      stream: false,
    }
    const request = vi.fn(async () => {
      throw new Error('A standalone greeting should not reach the model.')
    })

    const response = await runLocalToolLoop(
      payload,
      webAgentToolProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('你好')
    expect(response.choices[0]?.message.content).not.toContain('DeepSeek')
    expect(request).not.toHaveBeenCalled()
  })

  it('asks for clarification on punctuation instead of repeating the previous answer', () => {
    const response = webAgentToolProvider.preflight?.([
      { role: 'user', content: 'DeepSeek 是什么？' },
      { role: 'assistant', content: '旧话题回复' },
      { role: 'user', content: '?' },
    ])

    expect(response?.choices[0]?.message.content).toContain('标点')
    expect(response?.choices[0]?.message.content).not.toContain('旧话题')
  })

  it('acknowledges a correction about a greeting without reusing prior context', () => {
    const response = webAgentToolProvider.preflight?.([
      { role: 'user', content: 'DeepSeek 是什么？' },
      { role: 'assistant', content: '旧话题回复' },
      { role: 'user', content: '刚才不是只问了个问好' },
    ])

    expect(response?.choices[0]?.message.content).toContain('刚才答偏了')
    expect(response?.choices[0]?.message.content).not.toContain('旧话题')
  })

  it('runs local preflight before falling back from an unavailable provider', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: '123' }],
      stream: false,
    }
    const request = vi.fn(async () => {
      throw new Error('No model request should be made.')
    })
    const provider: LocalToolProvider = {
      ...webAgentToolProvider,
      isAvailable: () => false,
    }

    const response = await runLocalToolLoop(
      payload,
      provider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('你发来的是一个数字')
    expect(request).not.toHaveBeenCalled()
  })

  it('clamps model-generated search limits to the supported maximum', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.search', { query: 'rust ai', limit: 100 }),
      new AbortController().signal
    )

    expect(searchClientSources).toHaveBeenCalledWith(
      'rust ai',
      8,
      expect.any(AbortSignal),
      'auto'
    )
    expect(api.get).not.toHaveBeenCalled()
  })

  it('uses the default limit for malformed model output instead of aborting', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.search', { query: 'rust ai', limit: 'many' }),
      new AbortController().signal
    )

    expect(searchClientSources).toHaveBeenCalledWith(
      'rust ai',
      5,
      expect.any(AbortSignal),
      'auto'
    )
  })

  it('preserves an explicit paper search scope', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.search', {
        query: 'Rust async cancellation',
        scope: 'papers',
      }),
      new AbortController().signal
    )

    expect(searchClientSources).toHaveBeenCalledWith(
      'Rust async cancellation',
      5,
      expect.any(AbortSignal),
      'papers'
    )
  })

  it('rejects unsupported search scopes', async () => {
    await expect(
      webAgentToolProvider.invoke(
        toolCall('web.search', { query: 'Rust', scope: 'rustcc' }),
        new AbortController().signal
      )
    ).rejects.toThrow(
      'Search scope must be auto, github, huggingface, papers, or all.'
    )
  })

  it('removes URL fragments before fetching a page', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.fetch', { url: 'https://docs.example.com/guide#setup' }),
      new AbortController().signal
    )

    expect(fetchClientPage).toHaveBeenCalledWith(
      'https://docs.example.com/guide',
      expect.any(AbortSignal)
    )
    expect(api.get).not.toHaveBeenCalled()
  })

  it('bounds client crawl work and permits an omitted query', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.crawl', {
        url: 'https://docs.example.com/#top',
        max_pages: 100,
      }),
      new AbortController().signal
    )

    expect(crawlClientSite).toHaveBeenCalledWith(
      'https://docs.example.com/',
      '',
      5,
      expect.any(AbortSignal)
    )
    expect(api.get).not.toHaveBeenCalled()
  })

  it('asks before reading page text that will be sent to the selected model', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    vi.stubGlobal('window', { confirm })

    const approved = await webAgentToolProvider.requiresApproval?.(
      toolCall('web.crawl', {
        url: 'https://docs.example.com/private-docs',
        max_pages: 4,
      }),
      new AbortController().signal
    )

    expect(approved).toBe(false)
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('docs.example.com')
    )
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('No cookies are sent')
    )
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('selected AI model')
    )
  })

  it('keeps browser OAuth and paired gh CLI tools separately routable', async () => {
    const githubStatusTool = webAgentToolProvider.tools.find(
      (tool) => tool.function.name === 'github.oauth.auth.status'
    )
    if (!githubStatusTool) throw new Error('GitHub status tool is missing.')
    const cliStatusTool = {
      type: 'function' as const,
      function: {
        name: 'github.auth.status',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    }
    const bridgeInvoke = vi.fn().mockResolvedValue('bridge-status')
    const bridgeProvider: LocalToolProvider = {
      tools: [cliStatusTool],
      isAvailable: () => true,
      invoke: bridgeInvoke,
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider)

    await provider.invoke(
      toolCall('github.oauth.auth.status', {}),
      new AbortController().signal
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/status',
      expect.objectContaining({ params: {} })
    )
    expect(bridgeInvoke).not.toHaveBeenCalled()
    await provider.invoke(
      toolCall('github.auth.status', {}),
      new AbortController().signal
    )
    expect(bridgeInvoke).toHaveBeenCalledOnce()
  })

  it('advertises browser OAuth rather than local gh for a normal repository request', () => {
    const bridgeProvider: LocalToolProvider = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'github.repositories.search',
            parameters: { type: 'object' },
          },
        },
        {
          type: 'function',
          function: {
            name: 'github.auth.status',
            parameters: { type: 'object' },
          },
        },
      ],
      isAvailable: () => true,
      invoke: vi.fn(),
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: '查看我的 GitHub 仓库' },
    ]
    const names = provider
      .availableTools?.(messages)
      .map((tool) => tool.function.name)

    expect(names).toContain('github.oauth.repositories.list')
    expect(names).not.toContain('github.repositories.search')
    expect(names).not.toContain('github.auth.status')
  })

  it('lists repositories through the connected GitHub OAuth account', async () => {
    const bridgeProvider: LocalToolProvider = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'github.repositories.search',
            parameters: { type: 'object' },
          },
        },
      ],
      isAvailable: () => true,
      invoke: vi.fn(),
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: '查看我的 GitHub 仓库' },
    ]
    const names = provider
      .availableTools?.(messages)
      .map((tool) => tool.function.name)
    expect(names).toContain('github.oauth.repositories.list')

    await provider.invoke(
      toolCall('github.oauth.repositories.list', { limit: 4 }),
      new AbortController().signal
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/repositories',
      expect.objectContaining({ params: { limit: 4 } })
    )
    expect(bridgeProvider.invoke).not.toHaveBeenCalled()
  })

  it('routes a stale local gh tool call to browser OAuth for a normal web request', async () => {
    const bridgeInvoke = vi.fn(async () => 'should not be called')
    const bridgeProvider: LocalToolProvider = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'github.repositories.search',
            parameters: { type: 'object' },
          },
        },
        {
          type: 'function',
          function: {
            name: 'github.auth.status',
            parameters: { type: 'object' },
          },
        },
      ],
      isAvailable: () => true,
      invoke: bridgeInvoke,
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: '搜索 Rust 的 GitHub 仓库' },
    ]
    provider.availableTools?.(messages)

    const result = await provider.invoke(
      toolCall('github.repositories.search', { query: 'owner projects' }),
      new AbortController().signal
    )

    expect(bridgeInvoke).not.toHaveBeenCalled()
    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/repositories/search',
      expect.objectContaining({ params: { q: 'owner projects', limit: 10 } })
    )
    expect(result).toContain('browser GitHub OAuth')
  })

  it('falls back to OAuth when an explicitly requested local CLI is not authenticated', async () => {
    const bridgeInvoke = vi.fn(async (call: ChatCompletionToolCall) => {
      expect(call.function.name).toBe('github.auth.status')
      return JSON.stringify({
        source: 'paired desktop gh cli',
        data: { authenticated: false },
      })
    })
    const bridgeProvider: LocalToolProvider = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'github.repositories.search',
            parameters: { type: 'object' },
          },
        },
        {
          type: 'function',
          function: {
            name: 'github.auth.status',
            parameters: { type: 'object' },
          },
        },
      ],
      isAvailable: () => true,
      invoke: bridgeInvoke,
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const messages: ChatCompletionMessage[] = [
      {
        role: 'user',
        content:
          '请在我的 Radxa A7A 上用本机 gh CLI 搜索 Rust 的 GitHub 仓库',
      },
    ]
    provider.availableTools?.(messages)

    const result = await provider.invoke(
      toolCall('github.repositories.search', { query: 'owner projects' }),
      new AbortController().signal
    )

    expect(bridgeInvoke).toHaveBeenCalledOnce()
    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/repositories/search',
      expect.objectContaining({ params: { q: 'owner projects', limit: 10 } })
    )
    expect(result).toContain('browser GitHub OAuth')
  })

  it('does not advertise paired-device tools while that device is offline', () => {
    const bridgeProvider: LocalToolProvider = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'agent.workspace.list',
            parameters: { type: 'object' },
          },
        },
      ],
      isAvailable: () => true,
      invoke: vi.fn(),
    }

    const connected = createBrowserAgentToolProvider(bridgeProvider, true)
    const offline = createBrowserAgentToolProvider(bridgeProvider, false)
    const webSearchMessages: ChatCompletionMessage[] = [
      { role: 'user', content: '搜索 Rust 最近的 GitHub 项目' },
    ]
    const issueMessages: ChatCompletionMessage[] = [
      { role: 'user', content: '查看 lilyco-42/new-api 的 issues' },
    ]

    const connectedNames = connected
      .availableTools?.(webSearchMessages)
      .map((tool) => tool.function.name)
    const offlineSearchNames = offline
      .availableTools?.(webSearchMessages)
      .map((tool) => tool.function.name)
    const offlineIssueNames = offline
      .availableTools?.(issueMessages)
      .map((tool) => tool.function.name)

    expect(connectedNames).toContain('agent.workspace.list')
    expect(offlineSearchNames).not.toContain('agent.workspace.list')
    expect(offlineSearchNames).toContain('web.search')
    expect(offlineIssueNames).toContain('github.oauth.issues.list')
    expect(offlineIssueNames).not.toContain('github.issues.list')
  })

  it('removes paired-device tools from an in-flight provider after disconnect', () => {
    let connected = true
    const bridgeTool = {
      type: 'function' as const,
      function: {
        name: 'agent.workspace.list',
        parameters: { type: 'object' },
      },
    }
    const bridgeProvider: LocalToolProvider = {
      tools: [bridgeTool],
      availableTools: () => (connected ? [bridgeTool] : []),
      isAvailable: () => connected,
      invoke: vi.fn(),
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: '搜索 Rust 最近的 GitHub 项目' },
    ]

    expect(
      provider.availableTools?.(messages).map((tool) => tool.function.name)
    ).toContain('agent.workspace.list')
    connected = false
    const availableToolNames = provider
      .availableTools?.(messages)
      .map((tool) => tool.function.name)
    expect(availableToolNames).not.toContain('agent.workspace.list')
    expect(availableToolNames).toContain('web.search')
  })
})
