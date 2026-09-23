import { describe, expect, it, vi } from 'vitest'

import type {
  ChatCompletionTool,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'

import { combineLocalToolProviders } from './mcp-tool-provider'

const call: ChatCompletionToolCall = {
  id: 'call-search',
  type: 'function',
  function: { name: 'web.search', arguments: '{"query":"rust"}' },
}

const tool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web.search',
    description: 'Search the public web.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}

describe('combineLocalToolProviders', () => {
  it('allows tools from providers that do not require an approval callback', async () => {
    const provider: LocalToolProvider = {
      tools: [tool],
      isAvailable: () => true,
      invoke: vi.fn().mockResolvedValue('results'),
    }
    const combined = combineLocalToolProviders(provider)

    await expect(combined.requiresApproval?.(call, new AbortController().signal)).resolves.toBe(true)
    await expect(combined.invoke(call, new AbortController().signal)).resolves.toBe('results')
    expect(provider.invoke).toHaveBeenCalledOnce()
  })

  it('preserves explicit rejection for providers that require approval', async () => {
    const provider: LocalToolProvider = {
      tools: [tool],
      isAvailable: () => true,
      requiresApproval: vi.fn().mockResolvedValue(false),
      invoke: vi.fn(),
    }
    const combined = combineLocalToolProviders(provider)

    await expect(combined.requiresApproval?.(call, new AbortController().signal)).resolves.toBe(false)
    expect(provider.invoke).not.toHaveBeenCalled()
  })
})
