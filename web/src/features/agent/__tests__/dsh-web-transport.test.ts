import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LocalToolProvider,
} from '@/features/playground/types'
import { api } from '@/lib/api'

import { withDshWebTurn } from '../dsh-web-transport'

vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), delete: vi.fn() } }))

const SESSION_ID = 'a'.repeat(64)
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000'
let chatCounter = 0

function provider(): LocalToolProvider {
  return {
    tools: [],
    isAvailable: () => true,
    invoke: async () => '',
  }
}

function payload(content: ChatCompletionRequest['messages'][number]['content'] = 'hello'): ChatCompletionRequest {
  return {
    model: 'openai/gpt-5.6-sol',
    messages: [
      { role: 'system', content: 'Answer the current user request accurately.' },
      { role: 'user', content },
    ],
    stream: false,
  }
}

function nextNamespace(userId: number): string {
  chatCounter += 1
  return `user-${userId}:agent-general-chat-${chatCounter}:playground_messages`
}

function answer(content: string): ChatCompletionResponse {
  return {
    id: 'gateway-answer',
    object: 'chat.completion',
    created: 1,
    model: 'openai/gpt-5.6-sol',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  }
}

describe('Lain42 DSH web transport', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.delete).mockReset().mockResolvedValue({ data: { success: true } } as never)
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('sends browser-prepared evidence through the account model route and reuses the chat session', async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce({ data: { success: true, data: { session_id: SESSION_ID } } } as never)
      .mockResolvedValueOnce({ data: { success: true, data: { request_id: REQUEST_ID, answer: 'Grounded answer.' } } } as never)
      .mockResolvedValueOnce({ data: { success: true, data: { request_id: REQUEST_ID, answer: 'Follow-up answer.' } } } as never)

    const transport = withDshWebTurn(provider(), {
      userId: 7,
      chatStorageNamespace: nextNamespace(7),
    })
    const completeTurn = transport.completeTurn!
    const signal = new AbortController().signal
    const preparedContext = [
      {
        role: 'system' as const,
        name: 'lain42_browser_search_context',
        content: 'Source: https://example.com/fact\nThe page states the answer is 42.',
      },
    ]

    const first = await completeTurn(
      { payload: payload('What does the page say?'), preparedContext, turnId: 'message-1' },
      signal
    )
    const second = await completeTurn(
      {
        payload: {
          ...payload('And what is the number?'),
          messages: [
            ...payload('What does the page say?').messages,
            { role: 'assistant', content: 'Grounded answer.' },
            { role: 'user', content: 'And what is the number?' },
          ],
        },
        preparedContext: [],
        turnId: 'message-2',
      },
      signal
    )

    expect(first?.choices[0]?.message.content).toBe('Grounded answer.')
    expect(second?.choices[0]?.message.content).toBe('Follow-up answer.')
    expect(api.post).toHaveBeenCalledTimes(3)
    expect(api.post).toHaveBeenNthCalledWith(1, '/api/agent/sessions', undefined, expect.any(Object))
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/api/agent/turns',
      expect.objectContaining({
        session_id: SESSION_ID,
        request_id: 'message-1',
        model: 'openai/gpt-5.6-sol',
        text: expect.stringContaining('Source: https://example.com/fact'),
      }),
      expect.any(Object)
    )
    expect(api.post.mock.calls[2]?.[0]).toBe('/api/agent/turns')
    expect(api.post.mock.calls[2]?.[1]).toMatchObject({
      session_id: SESSION_ID,
      request_id: 'message-2',
      text: expect.stringContaining('And what is the number?'),
    })
    expect(api.post.mock.calls[2]?.[1]).not.toHaveProperty('model')
  })

  it('keeps sessions isolated by account and chat', async () => {
    vi.mocked(api.post).mockImplementation(async (url) => {
      if (url === '/api/agent/sessions') {
        return { data: { success: true, data: { session_id: SESSION_ID } } } as never
      }
      return { data: { success: true, data: { answer: 'ok' } } } as never
    })

    const signal = new AbortController().signal
    const userSeven = withDshWebTurn(provider(), {
      userId: 7,
      chatStorageNamespace: nextNamespace(7),
    })
    const userEight = withDshWebTurn(provider(), {
      userId: 8,
      chatStorageNamespace: nextNamespace(8),
    })
    await userSeven.completeTurn!({ payload: payload(), preparedContext: [], turnId: 'message-7' }, signal)
    await userEight.completeTurn!({ payload: payload(), preparedContext: [], turnId: 'message-8' }, signal)

    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/agent/sessions')).toHaveLength(2)
  })

  it('falls back only for an explicitly unavailable DSH service and makes that chat sticky', async () => {
    const unavailable = Object.assign(new Error('unavailable'), {
      response: { data: { code: 'AGENT_TURN_UNAVAILABLE' } },
    })
    vi.mocked(api.post)
      .mockResolvedValueOnce({ data: { success: true, data: { session_id: SESSION_ID } } } as never)
      .mockRejectedValueOnce(unavailable)

    const transport = withDshWebTurn(provider(), {
      userId: 7,
      chatStorageNamespace: nextNamespace(7),
    })
    const input = { payload: payload(), preparedContext: [], turnId: 'message-unavailable' }
    const signal = new AbortController().signal

    expect(await transport.completeTurn!(input, signal)).toBeNull()
    expect(api.delete).toHaveBeenCalledWith(`/api/agent/sessions/${SESSION_ID}`, expect.any(Object))
    expect(await transport.completeTurn!(input, signal)).toBeNull()
    expect(api.post).toHaveBeenCalledTimes(2)
  })

  it('does not resubmit an ambiguous failed turn to the legacy route', async () => {
    const timeout = Object.assign(new Error('timeout'), {
      response: { data: { code: 'AGENT_TURN_TIMEOUT' } },
    })
    vi.mocked(api.post)
      .mockResolvedValueOnce({ data: { success: true, data: { session_id: SESSION_ID } } } as never)
      .mockRejectedValueOnce(timeout)

    const transport = withDshWebTurn(provider(), {
      userId: 7,
      chatStorageNamespace: nextNamespace(7),
    })

    await expect(
      transport.completeTurn!(
        { payload: payload(), preparedContext: [], turnId: 'message-timeout' },
        new AbortController().signal
      )
    ).rejects.toBe(timeout)
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('leaves file-bearing messages on the existing attachment-capable path', async () => {
    const transport = withDshWebTurn(provider(), {
      userId: 7,
      chatStorageNamespace: nextNamespace(7),
    })

    const result = await transport.completeTurn!(
      {
        payload: payload([
          { type: 'text', text: 'Describe this image.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]),
        preparedContext: [],
        turnId: 'message-attachment',
      },
      new AbortController().signal
    )

    expect(result).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })
})
