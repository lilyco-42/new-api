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

import { describe, expect, test } from 'vitest'

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../types'
import { mapToolNamesForModel, restoreInternalToolNames } from './tool-name-compat'

const payload: ChatCompletionRequest = {
  model: 'test-model',
  stream: false,
  messages: [
    { role: 'user', content: 'Search for the official project.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_search',
          type: 'function',
          function: { name: 'web.search', arguments: '{"query":"ast-grep"}' },
        },
      ],
    },
    {
      role: 'tool',
      name: 'web.search',
      tool_call_id: 'call_search',
      content: '{"items":[]}',
    },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'web.search',
        description: 'Search public indexes.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
  ],
  tool_choice: 'auto',
}

describe('provider tool-name compatibility', () => {
  test('maps namespaced function names and message history to valid aliases', () => {
    const mapped = mapToolNamesForModel(payload)
    const providerName = mapped.payload.tools?.[0].function.name

    expect(providerName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u)
    expect(providerName).not.toBe('web.search')
    expect(mapped.payload.messages[1].tool_calls?.[0].function.name).toBe(
      providerName
    )
    expect(mapped.payload.messages[2].name).toBe(providerName)
    expect(mapped.payload.tools?.[0].function.description).toBe(
      payload.tools?.[0].function.description
    )
  })

  test('restores the canonical tool name before the local allowlist runs', () => {
    const mapped = mapToolNamesForModel(payload)
    const providerName = mapped.payload.tools?.[0].function.name ?? ''
    const response: ChatCompletionResponse = {
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
                function: { name: providerName, arguments: '{"query":"ast-grep"}' },
              },
            ],
          },
        },
      ],
    }

    const restored = restoreInternalToolNames(
      response,
      mapped.internalNamesByModelName
    )

    expect(restored.choices[0].message.tool_calls?.[0].function.name).toBe(
      'web.search'
    )
  })

  test('avoids aliases already used by valid function names', () => {
    const collisionPayload = {
      ...payload,
      tools: [
        ...(payload.tools ?? []),
        {
          type: 'function' as const,
          function: {
            name: 'l42_tool_0',
            parameters: { type: 'object' },
          },
        },
      ],
    }
    const mapped = mapToolNamesForModel(collisionPayload)
    const names = mapped.payload.tools?.map((tool) => tool.function.name) ?? []

    expect(new Set(names).size).toBe(names.length)
    expect(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/u.test(name))).toBe(true)
  })

  test('leaves provider-compatible names unchanged', () => {
    const safePayload = {
      ...payload,
      tools: [
        {
          type: 'function' as const,
          function: { name: 'web_search', parameters: { type: 'object' } },
        },
      ],
    }

    expect(mapToolNamesForModel(safePayload).payload.tools?.[0].function.name).toBe(
      'web_search'
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
