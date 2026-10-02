import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { createAgentDSHConversation } from '@/features/agent/agent-dsh'
import { api } from '@/lib/api'
import { PlaygroundMessageContent } from '../../components/message/playground-message-content'
import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import { loadMessages, saveMessages } from '../../lib/storage/storage'
import type { HostedTurnProvider, Message } from '../../types'
import { useChatHandler } from '../use-chat-handler'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() }, getFreshAuthHeaders: vi.fn() }))

afterEach(() => { localStorage.clear() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

it.each(['received', 'lost'] as const)('keeps %s Stop visible after reload using the actual conversation and hook', async (delivery) => {
  const sessionId = 'A'.repeat(64)
  const admitted = deferred<void>()
  const turn = deferred<unknown>()
  vi.mocked(api.get).mockResolvedValue({ data: { success: true, data: { configured: true } } } as never)
  vi.mocked(api.post).mockImplementation(async (url, body) => {
    if (url === '/api/agent/dsh/sessions') return { data: { success: true, data: { session_id: sessionId } } } as never
    if (url === '/api/agent/dsh/turns') {
      admitted.resolve()
      return await turn.promise as never
    }
    if (url === '/api/agent/dsh/turns/cancel') {
      if (delivery === 'lost') throw new Error('lost response')
      const identity = body as { session_id: string; request_id: string }
      return { status: 202, data: { success: true, data: { ...identity, cancel_requested: true, delivery: 'received' } } } as never
    }
    throw new Error('Unexpected network operation')
  })
  const namespace = `agent-user-42-general-hook-stop-${delivery}`
  const provider = createAgentDSHConversation({ storageNamespace: namespace, mode: 'general' })
  let messages: Message[] = [
    { key: 'user', from: 'user', versions: [{ id: 'user', content: 'Please reply briefly.' }] },
    { key: 'assistant', from: 'assistant', versions: [{ id: 'assistant', content: '' }], status: 'loading' },
  ]
  const onMessageUpdate = (update: (previous: Message[]) => Message[]) => { messages = update(messages) }
  const { result, unmount } = renderHook(() => useChatHandler({
    config: { ...DEFAULT_CONFIG, model: 'site-model', stream: false },
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    onMessageUpdate,
    hostedTurnProvider: provider,
  }))
  act(() => { result.current.sendChat(messages) })
  await admitted.promise
  act(() => { result.current.stopGeneration() })
  await waitFor(() => expect(messages[1]?.stopState).toBe(delivery === 'received' ? 'requested' : 'unconfirmed'))
  const turnBody = vi.mocked(api.post).mock.calls.find(([url]) => url === '/api/agent/dsh/turns')?.[1] as
    { session_id: string; request_id: string } | undefined
  if (!turnBody) throw new Error('Expected a submitted hosted turn')
  expect(api.post).toHaveBeenCalledWith('/api/agent/dsh/turns/cancel', {
    session_id: sessionId, request_id: turnBody.request_id,
  }, expect.any(Object))
  await act(async () => { turn.resolve({ data: { success: true, data: { ...turnBody, answer: 'late answer' } } }) })
  expect(messages[1]?.versions[0]?.content).toBe('')
  saveMessages(messages, namespace)
  const restored = loadMessages(namespace)
  expect(restored?.[1]?.stopState).toBe(delivery === 'received' ? 'requested' : 'unconfirmed')
  expect(loadMessages('agent-user-43-general-hook-stop')).toBeNull()
  unmount()
  if (!restored?.[1]) throw new Error('Expected the stopped message after reload')
  render(<PlaygroundMessageContent actions={null} alignment='left' message={restored[1]} versionContent='' />)
  expect(screen.getByRole('status').textContent).toBe(delivery === 'received'
    ? 'Stop requested. Background settlement is not confirmed.'
    : 'Stop delivery could not be confirmed. This message will not be resubmitted.')
  provider.reset()
})

it('keeps Stop bound to the original provider after the workspace provider changes', async () => {
  const entered = deferred<void>()
  const response = deferred<null>()
  const original: HostedTurnProvider = {
    reset: vi.fn(),
    send: async () => { entered.resolve(); return await response.promise },
    cancel: vi.fn(async () => 'requested' as const),
  }
  const replacement: HostedTurnProvider = { ...original, cancel: vi.fn(async () => 'requested' as const) }
  let messages: Message[] = [
    { key: 'user', from: 'user', versions: [{ id: 'user', content: 'Please reply briefly.' }] },
    { key: 'assistant', from: 'assistant', versions: [{ id: 'assistant', content: '' }], status: 'loading' },
  ]
  const onMessageUpdate = (update: (previous: Message[]) => Message[]) => { messages = update(messages) }
  const { result, rerender } = renderHook(({ provider }) => useChatHandler({
    config: { ...DEFAULT_CONFIG, model: 'site-model', stream: false },
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    onMessageUpdate,
    hostedTurnProvider: provider,
  }), { initialProps: { provider: original } })
  act(() => { result.current.sendChat(messages) })
  await entered.promise
  rerender({ provider: replacement })
  act(() => { result.current.stopGeneration() })
  expect(original.cancel).toHaveBeenCalledOnce()
  expect(replacement.cancel).not.toHaveBeenCalled()
  await act(async () => { response.resolve(null) })
})
