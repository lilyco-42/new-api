import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '@/features/playground/constants'
import { runLocalToolLoop } from '@/features/playground/hooks/local-tool-loop'
import { buildChatCompletionPayload } from '@/features/playground/lib/streaming/payload-builder'
import type { ChatCompletionRequest, ChatCompletionResponse, Message } from '@/features/playground/types'

import { createBrowserAgentToolProvider } from '../web-agent-tool-provider'

function message(key: string, from: Message['from'], content: string): Message {
  return { key, from, versions: [{ id: key, content }], status: 'complete' }
}

describe('Agent contextual replies before inference', () => {
  it.each([
    ['a query follow-up', '查看我的 GitHub 项目', '本轮通过网站 GitHub OAuth 读取了 merchant/image-workflow。', '?'],
    ['a numbered selection', '这两个仓库我应该先做哪个？', '1. merchant/editor\n2. merchant/image-workflow', '2'],
    ['a correction', '你怎么查询的？', '我采用 lyco-skill 的务实工作方法来回答。', '你在干嘛? 我问你怎么查询的'],
  ])('passes %s and its actual prior conversation to inference without running new tools', async (_name, initial, previous, current) => {
    const payload = buildChatCompletionPayload([
      message('system', 'system', 'Answer the latest request using relevant conversation context.'),
      message('initial', 'user', initial),
      message('previous', 'assistant', previous),
      message('current', 'user', current),
    ], { ...DEFAULT_CONFIG, model: 'external-test-model', stream: false }, DEFAULT_PARAMETER_ENABLED, true)
    const request = vi.fn(async (input: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      expect(input.messages.filter((entry) => entry.role === 'user').map((entry) => entry.content))
        .toEqual([initial, current])
      expect(input.messages.find((entry) => entry.role === 'assistant')?.content).toBe(previous)
      expect(input.messages.at(-1)?.content).toBe(current)
      expect(input.tools).toEqual([])
      return { id: 'external-inference', object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'External model response.' }, finish_reason: 'stop' }] }
    })

    const response = await runLocalToolLoop(payload, createBrowserAgentToolProvider(),
      new AbortController().signal, undefined, request)

    expect(request).toHaveBeenCalledTimes(1)
    expect(response.choices[0]?.message.content).toBe('External model response.')
  })
})
