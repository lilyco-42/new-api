/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import { describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { sendChatCompletion } from './api'
import type { ChatCompletionRequest, ChatCompletionResponse } from './types'

const apiClient = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock('@/lib/api', () => ({ api: apiClient }))

describe('sendChatCompletion tool-name compatibility', () => {
  test('sends a provider-safe alias and restores returned calls for local routing', async () => {
    const payload: ChatCompletionRequest = {
      model: 'test-model',
      stream: false,
      messages: [{ role: 'user', content: 'Search for ast-grep.' }],
      tools: [
        {
          type: 'function',
          function: { name: 'web.search', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
    }
    const modelResponse: ChatCompletionResponse = {
      id: 'response',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_search',
                type: 'function',
                function: {
                  name: 'l42_tool_0',
                  arguments: '{"query":"ast-grep"}',
                },
              },
            ],
          },
        },
      ],
    }
    vi.mocked(api.post).mockResolvedValueOnce({ data: modelResponse } as never)

    const result = await sendChatCompletion(payload)
    const postedPayload = vi.mocked(api.post).mock.calls[0][1] as
      ChatCompletionRequest

    expect(postedPayload.tools?.[0].function.name).toBe('l42_tool_0')
    expect(postedPayload.tools?.[0].function.name).toMatch(
      /^[a-zA-Z0-9_-]{1,64}$/u
    )
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe(
      'web.search'
    )
  })
})
/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
