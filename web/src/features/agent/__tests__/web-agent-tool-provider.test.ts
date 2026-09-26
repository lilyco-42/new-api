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

function modelResponse(content: string): ChatCompletionResponse {
  return {
    id: 'test-response',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
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

  it('sends a short greeting to the configured model', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'say hi' }],
      stream: false,
    }
    const request = vi.fn(async (_payload: ChatCompletionRequest) =>
      modelResponse('Hello from the configured model.')
    )

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain(
      'Hello from the configured model.'
    )
    expect(request).toHaveBeenCalledOnce()
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

  it('keeps the model answer and cites only sources returned by browser search', async () => {
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
            content: 'DeepSeek 是与人工智能模型相关的公司和模型系列。',
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
      'DeepSeek 是与人工智能模型相关的公司和模型系列。'
    )
    expect(response.choices[0]?.message.content).toContain(
      '[DeepSeek model collection](<https://huggingface.co/deepseek-ai>)'
    )
    expect(response.choices[0]?.message.content).not.toContain(
      'https://www.deepseek.com/'
    )
  })

  it('advertises browser page reading for a user-provided public URL', () => {
    const tools = webAgentToolProvider.availableTools?.([
      {
        role: 'user',
        content: '请总结这个网页：https://docs.example.com/guide。',
      },
    ]) ?? []

    expect(tools.map((tool) => tool.function.name)).toContain('web.fetch')
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
    const query = '请用浏览器公开索引搜索 ast-grep 官方项目，只返回项目全名、用途和来源链接，不访问我的账号仓库。'
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
      'github'
    )
    expect(api.get).not.toHaveBeenCalled()
    expect(searchContext?.content).toContain('AST-based code search')
    expect(searchContext?.content).toContain('https://github.com/ast-grep/ast-grep')
    expect(sent?.tools).toEqual([])
    expect(sent?.tool_choice).toBe('none')
    expect(response.choices[0]?.message.content).toContain(
      '[ast-grep/ast-grep](<https://github.com/ast-grep/ast-grep>)'
    )
  })

  it('gives the model a public GitHub URL without listing private account repositories', async () => {
    const url = 'https://github.com/ast-grep/ast-grep'
    const query = `请读取 ${url} ，告诉我这个仓库做什么，并附来源链接。`
    vi.mocked(fetchClientPage).mockResolvedValue({
      title: 'ast-grep/ast-grep',
      url,
      text: 'AST-based code search, lint, and rewriting.',
      fetched_at: '2026-09-26T00:00:00.000Z',
      links: [],
    })
    const request = vi.fn(async (input: ChatCompletionRequest) => ({
      id: 'public-repository-answer',
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: 'ast-grep 是代码结构搜索工具。' },
        finish_reason: 'stop',
      }],
    }))

    const response = await runLocalToolLoop(
      { model: 'test-model', messages: [{ role: 'user', content: query }], stream: false },
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    expect(fetchClientPage).toHaveBeenCalledWith(url, expect.any(AbortSignal))
    expect(api.get).not.toHaveBeenCalled()
    expect(searchClientSources).not.toHaveBeenCalled()
    const sent = request.mock.calls[0]?.[0]
    expect(sent?.messages.some((message) =>
      message.name === 'lain42_browser_search_context' &&
      typeof message.content === 'string' &&
      message.content.includes('AST-based code search, lint, and rewriting.')
    )).toBe(true)
    expect(sent?.tools).toEqual([])
    expect(response.choices[0]?.message.content).toContain(url)
  })

  it('reads a public website URL on the client and gives its content to the model', async () => {
    const url = 'https://docs.example.com/guide'
    const query = `请总结这个网页：${url}，说明页面用途并给出来源链接。`
    vi.mocked(fetchClientPage).mockResolvedValue({
      title: 'Guide',
      url,
      text: 'The guide explains safe Rust async cancellation.',
      fetched_at: '2026-09-26T00:00:00.000Z',
      links: [],
    })
    const request = vi.fn(async (input: ChatCompletionRequest) => ({
      id: 'public-page-answer',
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as const,
          content: '网页介绍了 Rust 异步取消的安全处理。',
        },
        finish_reason: 'stop',
      }],
    }))

    const response = await runLocalToolLoop(
      { model: 'test-model', messages: [{ role: 'user', content: query }], stream: false },
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    const sent = request.mock.calls[0]?.[0]
    const pageContext = sent?.messages.find(
      (message) => message.name === 'lain42_browser_search_context'
    )
    expect(fetchClientPage).toHaveBeenCalledWith(url, expect.any(AbortSignal))
    expect(api.get).not.toHaveBeenCalled()
    expect(searchClientSources).not.toHaveBeenCalled()
    expect(pageContext?.content).toContain('The guide explains safe Rust async cancellation.')
    expect(pageContext?.content).toContain('public HTTPS URL supplied in the latest user message')
    expect(sent?.tools).toEqual([])
    expect(sent?.tool_choice).toBe('none')
    expect(response.choices[0]?.message.content).toContain(
      '网页介绍了 Rust 异步取消的安全处理。'
    )
    expect(response.choices[0]?.message.content).toContain(
      '[Guide](<https://docs.example.com/guide>)'
    )
  })

  it('reports a CORS-blocked URL instead of passing unsupported page claims to the user', async () => {
    const url = 'https://docs.example.com/private-guide'
    vi.mocked(fetchClientPage).mockRejectedValueOnce(
      new Error('The site blocked cross-origin access (CORS).')
    )
    const request = vi.fn(async (input: ChatCompletionRequest) => ({
      id: 'page-read-blocked',
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as const,
          content: '按网页内容，答案是 42。',
        },
        finish_reason: 'stop',
      }],
    }))

    const response = await runLocalToolLoop(
      {
        model: 'test-model',
        messages: [{ role: 'user', content: `请总结 ${url}` }],
        stream: false,
      },
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    const sent = request.mock.calls[0]?.[0]
    expect(fetchClientPage).toHaveBeenCalledWith(url, expect.any(AbortSignal))
    expect(api.get).not.toHaveBeenCalled()
    expect(searchClientSources).not.toHaveBeenCalled()
    expect(sent?.messages.some((message) =>
      message.name === 'lain42_browser_search_context' &&
      typeof message.content === 'string' &&
      message.content.includes('The site blocked cross-origin access (CORS).')
    )).toBe(true)
    expect(response.choices[0]?.message.content).toContain(
      'The site blocked cross-origin access (CORS).'
    )
    expect(response.choices[0]?.message.content).not.toContain(
      '答案是 42'
    )
  })

  it('searches a project slug even when the user names it before GitHub', async () => {
    const query = '用网页搜索查找 ast-grep 的 GitHub 官方仓库。请给出仓库名、链接和一句说明；不要搜索我的个人仓库或调用 Radxa。'
    vi.mocked(searchClientSources).mockResolvedValue({
      execution: 'browser-wasm',
      query: 'ast-grep',
      fetched_at: '2026-09-26T00:00:00.000Z',
      sources: ['GitHub'],
      warnings: [],
      items: [{
        title: 'ast-grep/ast-grep',
        url: 'https://github.com/ast-grep/ast-grep',
        snippet: 'AST-based code search.',
        source: 'GitHub',
      }],
    })
    const request = vi.fn(async (input: ChatCompletionRequest) => ({
      id: 'repository-result',
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: 'ast-grep/ast-grep' },
        finish_reason: 'stop',
      }],
    }))

    const response = await runLocalToolLoop(
      { model: 'test-model', messages: [{ role: 'user', content: query }], stream: false },
      createBrowserAgentToolProvider(),
      new AbortController().signal,
      undefined,
      request
    )

    expect(searchClientSources).toHaveBeenCalledWith(
      'ast-grep', 5, expect.any(AbortSignal), 'github'
    )
    expect(request.mock.calls[0]?.[0].messages.some((message) =>
      message.name === 'lain42_browser_search_context' &&
      typeof message.content === 'string' &&
      message.content.includes('https://github.com/ast-grep/ast-grep')
    )).toBe(true)
    expect(response.choices[0]?.message.content).toContain('ast-grep/ast-grep')
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

  it('passes OAuth results to the model for the shorthand request "gh repo 我的项目"', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'gh repo 我的项目' }],
      stream: false,
    }
    const requests: ChatCompletionRequest[] = []
    const request = vi.fn(async (requestPayload: ChatCompletionRequest) => {
      requests.push(requestPayload)
      return modelResponse('你的 GitHub 仓库包括 lilyco-42/lyco。')
    })
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          items: [
            {
              full_name: 'lilyco-42/lyco',
              html_url: 'https://github.com/lilyco-42/lyco',
              private: false,
              stargazers_count: 1,
            },
          ],
        },
      },
    } as never)

    const response = await runLocalToolLoop(
      payload,
      createBrowserAgentToolProvider(undefined, false),
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('lilyco-42/lyco')
    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/repositories',
      expect.objectContaining({ params: { limit: 10 } })
    )
    expect(requests).toHaveLength(1)
    expect(
      requests[0]?.messages.find(
        (message) =>
          message.name === 'lain42_browser_github_repositories_context'
      )?.content
    ).toContain('lilyco-42/lyco')
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

  it('sends a greeting to the model instead of returning a canned local answer', async () => {
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
    const request = vi.fn(async (_payload: ChatCompletionRequest) =>
      modelResponse('模型回答：你好！')
    )

    const response = await runLocalToolLoop(
      payload,
      webAgentToolProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('模型回答：你好！')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0].messages).toEqual(payload.messages)
  })

  it.each(['?', '??', '>??', '> ??', '\\>??', '\\> ??'])(
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

  it.each(['??', '\\>??'])(
    'keeps punctuation-only turn %s out of model inference',
    async (input) => {
      const request = vi.fn(async () => {
        throw new Error('Punctuation-only input must not reach model inference.')
      })

      const response = await runLocalToolLoop(
        {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'DeepSeek 是什么？' },
            { role: 'assistant', content: '旧话题回复' },
            { role: 'user', content: input },
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
    }
  )

  it('guides the model to recover when a user corrects a greeting response', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '您好！' },
        { role: 'user', content: '刚才不是只问了个问好' },
      ],
      stream: false,
    }
    const request = vi.fn(async (_payload: ChatCompletionRequest) =>
      modelResponse('刚才你只是在打招呼，我理解错了。你好！你现在需要我帮什么？')
    )

    const response = await runLocalToolLoop(
      payload,
      webAgentToolProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(response.choices[0]?.message.content).toContain('我理解错了')
    expect(request).toHaveBeenCalledOnce()
    const requestMessages = request.mock.calls[0]?.[0].messages ?? []
    const correctionContext = requestMessages.find(
      (message) => message.name === 'lain42_correction_recovery_context'
    )
    expect(correctionContext?.content).toContain(
      'corrects your response to a greeting'
    )
    expect(correctionContext?.content).toContain('你好！有什么我能帮你？')
    expect(requestMessages.at(-1)).toEqual(payload.messages.at(-1))
    expect(api.get).not.toHaveBeenCalled()
    expect(searchClientSources).not.toHaveBeenCalled()
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

  it('reads only the public URL explicitly supplied in the user request', () => {
    const messages: ChatCompletionMessage[] = [
      {
        role: 'user',
        content: 'Read https://docs.example.com/guide and summarize it.',
      },
    ]

    expect(webAgentToolProvider.requiresApproval).toBeUndefined()
    expect(
      webAgentToolProvider.shouldRunTool?.(
        toolCall('web.fetch', { url: 'https://docs.example.com/guide' }),
        messages
      )
    ).toBe(true)
    expect(
      webAgentToolProvider.shouldRunTool?.(
        toolCall('web.fetch', { url: 'https://other.example.com/page' }),
        messages
      )
    ).toBe(false)
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

  it('passes OAuth repository data to the model before answering', async () => {
    const bridgeProvider: LocalToolProvider = {
      tools: [],
      isAvailable: () => true,
      invoke: vi.fn(),
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider, true)
    const requests: ChatCompletionRequest[] = []
    const request = vi.fn(async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      return modelResponse(
        '我从你的 GitHub OAuth 读取到 repo-one、repo-two 和 repo-three。'
      )
    })
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          items: [
            {
              full_name: 'lilyco-42/repo-one',
              html_url: 'https://github.com/lilyco-42/repo-one',
              private: false,
              stargazers_count: 1,
            },
            {
              full_name: 'lilyco-42/repo-two',
              html_url: 'https://github.com/lilyco-42/repo-two',
              private: false,
              stargazers_count: 2,
            },
            {
              full_name: 'lilyco-42/repo-three',
              html_url: 'https://github.com/lilyco-42/repo-three',
              private: false,
              stargazers_count: 3,
            },
          ],
        },
      },
    } as never)

    const result = await runLocalToolLoop(
      {
        model: 'test-model',
        messages: [
          {
            role: 'user',
            content:
              '请读取我通过网站 GitHub OAuth 授权的仓库，只列前 3 个仓库名称和 GitHub 链接；如果 OAuth 仓库查询失败，请说明具体错误。不要要求我登录本机 gh CLI，也不要调用 Radxa。',
          },
        ],
        stream: false,
      },
      provider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/repositories',
      expect.objectContaining({ params: { limit: 3 } })
    )
    expect(result.choices[0]?.message.content).toContain('repo-one')
    expect(requests).toHaveLength(1)
    const repositoryContext = requests[0]?.messages.find(
      (message) =>
        message.name === 'lain42_browser_github_repositories_context'
    )
    expect(repositoryContext?.content).toContain('lilyco-42/repo-one')
    expect(repositoryContext?.content).toContain('lilyco-42/repo-three')
  })

  it('passes OAuth repository failures to the model without blaming local gh', async () => {
    const provider = createBrowserAgentToolProvider(undefined, false)
    const requests: ChatCompletionRequest[] = []
    const request = vi.fn(async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      return modelResponse(
        'GitHub OAuth 仓库读取失败，HTTP 401；请重新连接 GitHub。'
      )
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

    expect(result.choices[0]?.message.content).toContain('HTTP 401')
    expect(requests).toHaveLength(1)
    const repositoryContext = requests[0]?.messages.find(
      (message) =>
        message.name === 'lain42_browser_github_repositories_context'
    )
    expect(repositoryContext?.content).toContain('status code 401')
    expect(repositoryContext?.content).toContain(
      '这与本机 GitHub CLI 是否登录无关'
    )
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
