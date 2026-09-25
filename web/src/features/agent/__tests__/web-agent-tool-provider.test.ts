import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runLocalToolLoop } from '@/features/playground/hooks/local-tool-loop'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
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

  it('answers a short say-hi prompt locally without relying on the model gateway', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'say hi' }],
      stream: false,
    }
    const request = vi.fn(async () => {
      throw new Error('A greeting should not need an inference request.')
    })

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('Hi!')
    expect(request).not.toHaveBeenCalled()
    expect(searchClientSources).not.toHaveBeenCalled()
  })

  it('does not force provider-native tool calling for a known AI entity', () => {
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: 'deepseek' },
    ]
    const provider = createBrowserAgentToolProvider()
    const tools = provider.availableTools?.(messages) ?? []

    expect(tools.map((tool) => tool.function.name)).toContain('web.search')
    expect(provider.getToolChoice?.(messages, tools)).toBe('auto')
    expect(
      provider.getToolChoice?.(
        [
          ...messages,
          {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall('web.search', { query: 'deepseek' })],
          },
        ],
        tools
      )
    ).toBe('auto')
  })

  it('grounds DeepSeek definition in its verified official model search source', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'DeepSeek 是什么？' }],
      stream: false,
    }
    vi.mocked(searchClientSources).mockResolvedValue({
      execution: 'browser-wasm',
      query: 'DeepSeek 是什么？',
      fetched_at: '2026-09-26T00:00:00.000Z',
      sources: ['Hugging Face'],
      warnings: [],
      items: [
        {
          title: 'DeepSeek model collection',
          url: 'https://huggingface.co/deepseek-ai',
          snippet: 'Official DeepSeek model releases.',
          source: 'Hugging Face',
        },
      ],
    })
    const request = vi.fn(async (input: ChatCompletionRequest) => ({
      id: 'grounded-answer',
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: 'DeepSeek 是一个知识图谱检索工具。',
          },
          finish_reason: 'stop',
        },
      ],
    }))

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    const sent = request.mock.calls[0]?.[0]
    const searchContext = sent?.messages.find(
      (message) => message.name === 'lain42_browser_search_context'
    )
    expect(searchClientSources).toHaveBeenCalledWith(
      'DeepSeek',
      5,
      expect.any(AbortSignal),
      'auto'
    )
    expect(searchContext?.content).toContain('Official DeepSeek model releases.')
    expect(searchContext?.content).toContain('https://huggingface.co/deepseek-ai')
    expect(sent?.messages.at(-1)).toEqual(payload.messages[0])
    expect(sent?.tools).toEqual([])
    expect(sent?.tool_choice).toBe('none')
    expect(response.choices[0]?.message.content).toContain(
      'DeepSeek 是一家人工智能公司，也开发 DeepSeek 系列模型'
    )
    expect(response.choices[0]?.message.content).toContain('它不是搜索工具。')
    expect(response.choices[0]?.message.content).not.toContain('知识图谱检索工具')
    expect(response.choices[0]?.message.content).toContain(
      '[DeepSeek 官方网站](<https://www.deepseek.com/>)'
    )
    expect(response.choices[0]?.message.content).toContain(
      '[DeepSeek 官方 Hugging Face 模型组织](<https://huggingface.co/deepseek-ai/models>)'
    )
  })

  it('advertises only browser search for public repository queries that exclude personal repositories', () => {
    const messages: ChatCompletionMessage[] = [
      {
        role: 'user',
        content:
          '请用网页搜索查 GitHub 上 ast-grep 的官方仓库，给出仓库名和链接；不要搜索我的个人仓库。',
      },
    ]
    const tools = webAgentToolProvider.availableTools?.(messages) ?? []
    const names = tools.map((tool) => tool.function.name)

    expect(names).toContain('web.search')
    expect(names).not.toContain('github.oauth.repositories.search')
  })

  it('prepares explicit browser web-search results before model inference', async () => {
    const query = '请用网页搜索查 GitHub 上 ast-grep 的官方仓库，只搜索公开索引，不要搜索我的个人仓库，不要用 gh CLI，回复仓库名和官方链接。'
    const searchQuery = 'ast-grep'
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: query }],
      stream: false,
    }
    vi.mocked(searchClientSources).mockResolvedValue({
      execution: 'browser-wasm',
      query: searchQuery,
      fetched_at: '2026-09-26T00:00:00.000Z',
      sources: ['GitHub'],
      warnings: [],
      items: [
        {
          title: 'ast-grep/ast-grep',
          url: 'https://github.com/ast-grep/ast-grep',
          snippet: 'AST-based code search, lint, and rewriting.',
          source: 'GitHub',
        },
      ],
    })
    const request = vi.fn(async (input: ChatCompletionRequest) => ({
      id: 'browser-search-answer',
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: '[ast-grep/ast-grep](https://github.com/ast-grep/ast-grep)',
          },
          finish_reason: 'stop',
        },
      ],
    }))

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    const sent = request.mock.calls[0]?.[0]
    const searchContext = sent?.messages.find(
      (message) => message.name === 'lain42_browser_search_context'
    )
    expect(searchClientSources).toHaveBeenCalledWith(
      searchQuery,
      5,
      expect.any(AbortSignal),
      'auto'
    )
    expect(searchContext?.content).toContain('AST-based code search')
    expect(searchContext?.content).toContain('https://github.com/ast-grep/ast-grep')
    expect(sent?.tools).toEqual([])
    expect(sent?.tool_choice).toBe('none')
    expect(response.choices[0]?.message.content).toContain(
      '[ast-grep/ast-grep](<https://github.com/ast-grep/ast-grep>)'
    )
  })

  it('tells the model browser search was unavailable without leaking its error', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'DeepSeek 是什么？' }],
      stream: false,
    }
    vi.mocked(searchClientSources).mockRejectedValueOnce(
      new Error('private upstream detail')
    )
    const request = vi.fn(async (input: ChatCompletionRequest) => ({
      id: 'search-unavailable',
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: 'DeepSeek 是一个搜索工具。',
          },
          finish_reason: 'stop',
        },
      ],
    }))

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    const sent = request.mock.calls[0]?.[0]
    const searchContext = sent?.messages.find(
      (message) => message.name === 'lain42_browser_search_context'
    )
    expect(searchContext?.content).toContain('search failed')
    expect(searchContext?.content).not.toContain('private upstream detail')
    expect(sent?.tools).toEqual([])
    expect(sent?.tool_choice).toBe('none')
    expect(response.choices[0]?.message.content).toContain('没有可核验的来源')
    expect(response.choices[0]?.message.content).not.toContain('搜索工具')
    expect(response.choices[0]?.message.content).not.toContain(
      'private upstream detail'
    )
  })

  it('corrects a false gh login requirement when OAuth is connected', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content:
            'GitHub access · OAuth connected · lilyco-42。连接了，怎么还这样？我想这是因为 GitHub CLI 还没有登录，才能搜索仓库。',
        },
      ],
      stream: false,
    }
    const request = vi.fn(async () => {
      throw new Error(
        'The known OAuth/CLI confusion should be answered locally.'
      )
    })

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(undefined, false),
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain(
      '网站 GitHub OAuth 已连接'
    )
    expect(response.choices[0]?.message.content).toContain(
      '不要求本机 gh CLI 登录'
    )
    expect(request).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('uses browser OAuth for the shorthand request "gh repo 我的项目"', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'gh repo 我的项目' }],
      stream: false,
    }
    const request = vi.fn(async () => {
      throw new Error('Repository requests must not ask the model to guess.')
    })

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(undefined, false),
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('GitHub OAuth 读取成功')
    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/repositories',
      expect.objectContaining({ params: { limit: 10 } })
    )
    expect(request).not.toHaveBeenCalled()
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

  it.each(['?', '??', '>??', '> ??'])(
    'asks for clarification on punctuation-only input %s instead of repeating the previous answer',
    (input) => {
      const response = webAgentToolProvider.preflight?.([
        { role: 'user', content: 'DeepSeek 是什么？' },
        { role: 'assistant', content: '旧话题回复' },
        { role: 'user', content: input },
      ])

      expect(response?.choices[0]?.message.content).toContain('标点')
      expect(response?.choices[0]?.message.content).not.toContain('旧话题')
    }
  )

  it('keeps punctuation-only turns out of model inference', async () => {
    const request = vi.fn(async () => {
      throw new Error('Punctuation-only input must not reach model inference.')
    })

    const response = await runLocalToolLoop(
      {
        model: 'test-model',
        messages: [
          { role: 'user', content: 'DeepSeek 是什么？' },
          { role: 'assistant', content: '旧话题回复' },
          { role: 'user', content: '??' },
        ],
        stream: false,
      },
      webAgentToolProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('标点')
    expect(response.choices[0]?.message.content).not.toContain('旧话题')
    expect(request).not.toHaveBeenCalled()
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

  it('returns a readable tool result when the browser cannot fetch a page', async () => {
    vi.mocked(fetchClientPage).mockRejectedValueOnce(
      new Error('The site blocked cross-origin access (CORS).')
    )

    const result = await webAgentToolProvider.invoke(
      toolCall('web.fetch', { url: 'https://docs.example.com/guide' }),
      new AbortController().signal
    )

    expect(JSON.parse(result)).toMatchObject({
      error: 'The site blocked cross-origin access (CORS).',
    })
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

  it('lists the connected account repositories before asking the model', async () => {
    const bridgeProvider: LocalToolProvider = {
      tools: [],
      isAvailable: () => true,
      invoke: vi.fn(),
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const request = vi.fn(async () => {
      throw new Error('The model must not be called for repository listing.')
    })
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          items: [
            {
              full_name: 'lilyco-42/new-api',
              html_url: 'https://github.com/lilyco-42/new-api',
              private: false,
              stargazers_count: 1,
            },
          ],
        },
      },
    } as never)

    const result = await runLocalToolLoop(
      {
        model: 'test-model',
        messages: [{ role: 'user', content: '查看我的 GitHub 仓库' }],
        stream: false,
      },
      provider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/repositories',
      expect.objectContaining({ params: { limit: 10 } })
    )
    expect(result.choices[0]?.message.content).toContain(
      '已通过连接的 GitHub OAuth 获取到 1 个仓库'
    )
    expect(result.choices[0]?.message.content).toContain(
      'lilyco-42/new-api'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('reports OAuth repository failures without blaming local gh login', async () => {
    const provider = createBrowserAgentToolProvider(undefined, false)
    const request = vi.fn(async () => {
      throw new Error('The model must not be called for repository listing.')
    })
    vi.mocked(api.get).mockRejectedValueOnce(
      new Error('Request failed with status code 401')
    )

    const result = await runLocalToolLoop(
      {
        model: 'test-model',
        messages: [{ role: 'user', content: '查看我的 GitHub 仓库' }],
        stream: false,
      },
      provider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(result.choices[0]?.message.content).toContain(
      'GitHub OAuth 仓库读取失败'
    )
    expect(result.choices[0]?.message.content).toContain(
      '这与本机 GitHub CLI 是否登录无关'
    )
    expect(request).not.toHaveBeenCalled()
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

  it('advertises paired-device tools only for matching intent while connected', () => {
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
    const workspaceMessages: ChatCompletionMessage[] = [
      { role: 'user', content: '请列出我的工作区根目录文件' },
    ]

    const connectedNames = connected
      .availableTools?.(webSearchMessages)
      .map((tool) => tool.function.name)
    const connectedWorkspaceNames = connected
      .availableTools?.(workspaceMessages)
      .map((tool) => tool.function.name)
    const offlineSearchNames = offline
      .availableTools?.(webSearchMessages)
      .map((tool) => tool.function.name)
    const offlineWorkspaceNames = offline
      .availableTools?.(workspaceMessages)
      .map((tool) => tool.function.name)
    const offlineIssueNames = offline
      .availableTools?.(issueMessages)
      .map((tool) => tool.function.name)

    expect(connectedNames).not.toContain('agent.workspace.list')
    expect(connectedWorkspaceNames).toContain('agent.workspace.list')
    expect(offlineSearchNames).not.toContain('agent.workspace.list')
    expect(offlineWorkspaceNames).not.toContain('agent.workspace.list')
    expect(offlineSearchNames).toContain('web.search')
    expect(offlineIssueNames).toContain('github.oauth.issues.list')
    expect(offlineIssueNames).not.toContain('github.issues.list')
  })

  it('blocks a model-proposed workspace read for an unrelated question', async () => {
    const bridgeTool = {
      type: 'function' as const,
      function: {
        name: 'files.browse',
        parameters: { type: 'object' },
      },
    }
    const bridgeInvoke = vi.fn(async () => '{"files":[]}')
    const bridgeProvider: LocalToolProvider = {
      tools: [bridgeTool],
      availableTools: () => [bridgeTool],
      isAvailable: () => true,
      invoke: bridgeInvoke,
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: '用一句话解释 Rust 的所有权。' },
    ]
    let requestCount = 0
    const request = vi.fn(async (): Promise<ChatCompletionResponse> => {
      requestCount += 1
      if (requestCount === 1) {
        return {
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [toolCall('files.browse', { path: '.' })],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }
      }
      return {
        id: 'test',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Rust ownership gives each value one clear owner.',
            },
            finish_reason: 'stop',
          },
        ],
      }
    })

    const availableNames = provider
      .availableTools?.(messages)
      .map((tool) => tool.function.name)
    const result = await runLocalToolLoop(
      {
        model: 'test-model',
        messages,
        stream: false,
      },
      provider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(availableNames).not.toContain('files.browse')
    expect(bridgeInvoke).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.choices[0]?.message.content).toContain('Rust ownership')
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
    const workspaceMessages: ChatCompletionMessage[] = [
      { role: 'user', content: '请列出我的工作区根目录文件' },
    ]
    const webSearchMessages: ChatCompletionMessage[] = [
      { role: 'user', content: '搜索 Rust 最近的 GitHub 项目' },
    ]

    expect(
      provider
        .availableTools?.(workspaceMessages)
        .map((tool) => tool.function.name)
    ).toContain('agent.workspace.list')
    connected = false
    const availableWorkspaceToolNames = provider
      .availableTools?.(workspaceMessages)
      .map((tool) => tool.function.name)
    const availableWebToolNames = provider
      .availableTools?.(webSearchMessages)
      .map((tool) => tool.function.name)
    expect(availableWorkspaceToolNames).not.toContain('agent.workspace.list')
    expect(availableWebToolNames).toContain('web.search')
  })
})
