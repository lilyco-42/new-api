import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatCompletionToolCall } from '@/features/playground/types'
import { api } from '@/lib/api'

import { webAgentToolProvider } from './web-agent-tool-provider'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

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
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.get).mockResolvedValue({
      data: { success: true, data: { items: [] } },
    } as never)
  })

  it('clamps model-generated search limits to the supported maximum', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.search', { query: 'rust ai', limit: 100 }),
      new AbortController().signal
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/search',
      expect.objectContaining({ params: { q: 'rust ai', limit: 8 } })
    )
  })

  it('uses the default limit for malformed model output instead of aborting', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.search', { query: 'rust ai', limit: 'many' }),
      new AbortController().signal
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/search',
      expect.objectContaining({ params: { q: 'rust ai', limit: 5 } })
    )
  })

  it('removes URL fragments before fetching a page', async () => {
    await webAgentToolProvider.invoke(
      toolCall('web.fetch', { url: 'https://docs.example.com/guide#setup' }),
      new AbortController().signal
    )

    expect(api.get).toHaveBeenCalledWith(
      '/api/agent/fetch',
      expect.objectContaining({ params: { url: 'https://docs.example.com/guide' } })
    )
  })
})
