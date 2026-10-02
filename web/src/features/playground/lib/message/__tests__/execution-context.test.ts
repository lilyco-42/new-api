import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import type { ChatCompletionResponse, Message } from '../../../types'
import { loadMessages, saveMessages } from '../../storage/storage'
import { buildChatCompletionPayload } from '../../streaming/payload-builder'
import { applyChatCompletionResponse } from '../message-streaming-utils'
import { updateCurrentVersionContent } from '../message-utils'
import { retainResponseExecutionContext } from '../response-execution-context'

const record = JSON.stringify({ source: 'website GitHub OAuth', parameters: { repo: 'merchant/images', limit: 10 }, returned_count: 1 })

function message(key: string, from: Message['from'], content: string): Message {
  return { key, from, versions: [{ id: key, content }], status: 'complete' }
}

function response(): ChatCompletionResponse {
  return { id: 'model-answer', object: 'chat.completion', created: 1, model: 'model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Repository answer.' }, finish_reason: 'stop' }] }
}

describe('executor context alongside generated answers', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('restores the actual execution record after reload in its account namespace and supplies it to the next inference', () => {
    const completed = applyChatCompletionResponse(message('answer', 'assistant', ''), retainResponseExecutionContext(response(), record))
    if (!completed) throw new Error('Expected a completed model answer.')
    saveMessages([completed], 'agent-user-42-general-chat-29')
    const restored = loadMessages('agent-user-42-general-chat-29')
    expect(restored?.[0]?.versions[0]?.executionContext).toBe(record)
    expect(loadMessages('agent-user-43-general-chat-29')).toBeNull()
    const payload = buildChatCompletionPayload([
      ...(restored ?? []), message('followup', 'user', '你怎么查询的?'),
    ], DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED, true)
    expect(payload.messages.find((entry) => entry.name === 'lain42_execution_record')?.content).toContain(record)
    expect(payload.messages.at(-1)?.content).toBe('你怎么查询的?')
    expect(payload.messages.filter((entry) => entry.role === 'assistant')[0]?.content).toBe('Repository answer.')
  })

  it('does not promote a model JSON field or generated text into an executor record', () => {
    const untrusted = { ...response(), executionContext: record }
    const completed = applyChatCompletionResponse(message('answer', 'assistant', record), untrusted)
    expect(completed?.versions[0]?.executionContext).toBeUndefined()
  })

  it('drops a prior record when its associated message is edited', () => {
    const original = message('answer', 'assistant', 'Original answer.')
    original.versions[0].executionContext = record
    expect(updateCurrentVersionContent(original, 'Edited answer.').versions[0].executionContext).toBeUndefined()
  })

  it('does not use user, failed or oversized records to assert that an operation ran', () => {
    const user = message('user', 'user', 'Read this attachment.')
    const failed = message('failed', 'assistant', 'Failed answer.')
    const oversized = message('oversized', 'assistant', 'Answer.')
    user.versions[0].executionContext = record
    failed.versions[0].executionContext = record
    failed.status = 'error'
    oversized.versions[0].executionContext = '🙂'.repeat(1100)
    const payload = buildChatCompletionPayload([user, failed, oversized, message('latest', 'user', 'Next task.')],
      DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED, true)
    expect(payload.messages.some((entry) => entry.name === 'lain42_execution_record')).toBe(false)
    expect(() => retainResponseExecutionContext(response(), '🙂'.repeat(1100))).toThrow('storage budget')
  })
})
