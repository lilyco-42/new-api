/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { describe, expect, test } from 'vitest'

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LocalToolProvider,
} from '../types'
import { LocalToolLoopError, runLocalToolLoop } from './local-tool-loop'

const tool = {
  type: 'function' as const,
  function: {
    name: 'github.issues.list',
    parameters: { type: 'object' },
  },
}

const initialPayload: ChatCompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'show the latest issues' }],
  stream: true,
}

function response(
  message: ChatCompletionResponse['choices'][number]['message']
): ChatCompletionResponse {
  return {
    id: 'test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  }
}

function provider(invoke: LocalToolProvider['invoke']): LocalToolProvider {
  return { tools: [tool], isAvailable: () => true, invoke }
}

describe('local structured tool loop', () => {
  test('returns a provider preflight answer without calling the model or tools', async () => {
    const localAnswer = response({
      role: 'assistant',
      content: 'Please add context for this number.',
    })
    const request = async () => {
      throw new Error('The model must not be called for this input.')
    }
    const invoke = async () => {
      throw new Error('A tool must not run for this input.')
    }
    const guardedProvider: LocalToolProvider = {
      ...provider(invoke),
      preflight: (messages) =>
        messages.at(-1)?.content === '1123' ? localAnswer : null,
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [{ role: 'user', content: '1123' }],
      },
      guardedProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(result).toBe(localAnswer)
  })

  test('executes a structured call and gives the result back to the model', async () => {
    const requests: ChatCompletionRequest[] = []
    const events: string[] = []
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'github.issues.list',
                arguments: '{"repo":"lilyco-42/new-api"}',
              },
            },
          ],
        })
      }
      return response({ role: 'assistant', content: 'Issue #42 is open.' })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      provider(async () => '{"number":42,"state":"OPEN"}'),
      new AbortController().signal,
      (event) => events.push(event.type),
      request
    )

    expect(result.choices[0]?.message.content).toBe('Issue #42 is open.')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.stream).toBe(false)
    expect(requests[0]?.tools?.[0]?.function.name).toBe('github.issues.list')
    expect(requests[1]?.messages.at(-2)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-1' }],
    })
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
    })
    expect(events).toEqual(['requested', 'running', 'completed'])
  })

  test('rejects malformed and unknown calls before invoking a tool', async () => {
    let invoked = false
    const request = async () =>
      response({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'unknown', arguments: '{not-json' },
          },
        ],
      })

    await expect(
      runLocalToolLoop(
        initialPayload,
        provider(async () => {
          invoked = true
          return 'should not run'
        }),
        new AbortController().signal,
        undefined,
        request
      )
    ).rejects.toBeInstanceOf(LocalToolLoopError)
    expect(invoked).toBe(false)
  })

  test('stops before another request when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const request = async () =>
      response({ role: 'assistant', content: 'unused' })

    await expect(
      runLocalToolLoop(
        initialPayload,
        provider(async () => 'unused'),
        controller.signal,
        undefined,
        request
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('requires approval before invoking a guarded tool', async () => {
    let invoked = false
    const guarded: LocalToolProvider = {
      tools: [tool],
      isAvailable: () => true,
      requiresApproval: () => false,
      invoke: async () => {
        invoked = true
        return 'should not run'
      },
    }
    const request = async () =>
      response({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-approval',
            type: 'function',
            function: {
              name: 'github.issues.list',
              arguments: '{"repo":"lilyco-42/new-api"}',
            },
          },
        ],
      })

    await expect(
      runLocalToolLoop(
        initialPayload,
        guarded,
        new AbortController().signal,
        undefined,
        request
      )
    ).rejects.toThrow('was not approved')
    expect(invoked).toBe(false)
  })
})
