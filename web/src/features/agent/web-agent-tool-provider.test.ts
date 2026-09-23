import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'
import { api } from '@/lib/api'

import {
  crawlClientSite,
  fetchClientPage,
  searchClientSources,
} from './client-crawler/client-crawler'
import {
  createBrowserAgentToolProvider,
  webAgentToolProvider,
} from './web-agent-tool-provider'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('./client-crawler/client-crawler', () => ({
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

  it('clamps model-generated search limits to the supported maximum', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.search', { query: 'rust ai', limit: 100 }),
      new AbortController().signal
    )

    expect(searchClientSources).toHaveBeenCalledWith(
      'rust ai',
      8,
      expect.any(AbortSignal)
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
      expect.any(AbortSignal)
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

  it('uses account-backed GitHub tools before a paired device bridge', async () => {
    const githubStatusTool = webAgentToolProvider.tools.find(
      (tool) => tool.function.name === 'github.auth.status'
    )
    if (!githubStatusTool) throw new Error('GitHub status tool is missing.')
    const bridgeInvoke = vi.fn().mockResolvedValue('bridge-status')
    const bridgeProvider: LocalToolProvider = {
      tools: [githubStatusTool],
      isAvailable: () => true,
      invoke: bridgeInvoke,
    }
    const provider = createBrowserAgentToolProvider(bridgeProvider)

    await provider.invoke(
      toolCall('github.auth.status', {}),
      new AbortController().signal
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/github/status',
      expect.objectContaining({ params: {} })
    )
    expect(bridgeInvoke).not.toHaveBeenCalled()
  })
})
