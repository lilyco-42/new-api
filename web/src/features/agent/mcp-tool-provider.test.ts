import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ChatCompletionTool,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'

import {
  combineLocalToolProviders,
  createBrowserMcpToolProvider,
} from './mcp-tool-provider'

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

describe('browser MCP approval', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const mcpWriteCall: ChatCompletionToolCall = {
    id: 'call-write-file',
    type: 'function',
    function: {
      name: 'mcp.notes.write_file',
      arguments: JSON.stringify({ path: 'README.md', content: 'new text' }),
    },
  }

  it('fails closed when the browser has no confirmation UI', async () => {
    const bridge = { request: vi.fn(async () => ({})) }
    const provider = createBrowserMcpToolProvider(bridge)
    vi.stubGlobal('window', undefined)

    await expect(
      provider.requiresApproval?.(mcpWriteCall, new AbortController().signal)
    ).resolves.toBe(false)
    expect(bridge.request).not.toHaveBeenCalled()
  })

  it('shows the exact MCP operation and arguments and preserves rejection', async () => {
    const confirm = vi.fn((_message: string) => false)
    const bridge = { request: vi.fn(async () => ({})) }
    const provider = createBrowserMcpToolProvider(bridge)
    vi.stubGlobal('window', { confirm })

    await expect(
      provider.requiresApproval?.(mcpWriteCall, new AbortController().signal)
    ).resolves.toBe(false)

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.[0]).toContain('mcp.notes.write_file')
    expect(confirm.mock.calls[0]?.[0]).toContain('"path": "README.md"')
    expect(confirm.mock.calls[0]?.[0]).toContain('"content": "new text"')
    expect(bridge.request).not.toHaveBeenCalled()
  })
})
