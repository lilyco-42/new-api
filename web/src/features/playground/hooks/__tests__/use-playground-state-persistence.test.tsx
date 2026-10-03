import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { loadMessages } from '../../lib/storage/storage'
import type { Message } from '../../types'
import { usePlaygroundState } from '../use-playground-state'

const namespace = 'agent-user-42-general-chat-persistence'
const storageKey = `${namespace}:playground_messages`
const user: Message = {
  key: 'user-1', from: 'user', status: 'complete',
  versions: [{ id: 'user-1', content: 'Explain my attachment.' }],
}
const pending: Message = {
  key: 'assistant-1', from: 'assistant', status: 'loading',
  versions: [{ id: 'assistant-1', content: '' }],
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
})

it.each([
  { status: 'complete' as const, content: 'The final attachment answer.' },
  { status: 'error' as const, content: 'The provider is unavailable.' },
  { status: 'complete' as const, content: '', stopState: 'requested' as const },
])('restores $status / $content immediately, before the streaming debounce expires', (outcome) => {
  const { result } = renderHook(() => usePlaygroundState({ storageNamespace: namespace }))
  act(() => { vi.advanceTimersByTime(0) })
  expect(result.current.isLoadingMessages).toBe(false)
  act(() => { result.current.updateMessages([user, pending]) })
  expect(localStorage.getItem(storageKey)).toBeNull()
  const terminal: Message = {
    ...pending, status: outcome.status,
    versions: [{ id: 'assistant-1', content: outcome.content }],
    ...('stopState' in outcome ? { stopState: outcome.stopState } : {}),
  }
  act(() => { result.current.updateMessages([user, terminal]) })
  const restored = renderHook(() => usePlaygroundState({ storageNamespace: namespace }))
  act(() => { vi.advanceTimersByTime(0) })
  expect(restored.result.current.messages).toEqual([user, terminal])
  expect(loadMessages('agent-user-43-general-chat-persistence')).toBeNull()
})

it('notifies recent chats after the final answer has been saved', () => {
  const observed: Array<Message[] | null> = []
  const observe = () => { observed.push(loadMessages(namespace)) }
  window.addEventListener('lain42:agent-chat-updated', observe)
  try {
    const { result } = renderHook(() => usePlaygroundState({ storageNamespace: namespace }))
    act(() => { vi.advanceTimersByTime(0) })
    act(() => { result.current.updateMessages([user, pending]) })
    expect(observed).toEqual([])
    const complete: Message = {
      ...pending, status: 'complete', versions: [{ id: 'assistant-1', content: 'Saved answer.' }],
    }
    act(() => { result.current.updateMessages([user, complete]) })
    expect(observed).toEqual([[user, complete]])
    act(() => { vi.advanceTimersByTime(500) })
    expect(observed).toHaveLength(1)
  } finally {
    window.removeEventListener('lain42:agent-chat-updated', observe)
  }
})

it('retains unfinished input on pagehide without pretending the generation completed', () => {
  const { result, unmount } = renderHook(() => usePlaygroundState({ storageNamespace: namespace }))
  act(() => { vi.advanceTimersByTime(0) })
  act(() => { result.current.updateMessages([user, pending]) })
  expect(localStorage.getItem(storageKey)).toBeNull()
  act(() => { window.dispatchEvent(new Event('pagehide')) })
  const restored = loadMessages(namespace)
  expect(restored?.[0]).toEqual(user)
  expect(restored?.[1]?.status).toBe('error')
  expect(restored?.[1]?.versions[0]?.content).toContain('Generation was interrupted')
  unmount()
  localStorage.clear()
  window.dispatchEvent(new Event('pagehide'))
  expect(localStorage.getItem(storageKey)).toBeNull()
})
