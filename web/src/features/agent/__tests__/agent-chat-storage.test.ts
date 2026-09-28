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

import {
  getAgentChatStorageNamespace,
  getNextAgentChatId,
  parseAgentChatStorageKey,
} from '../agent-chat-storage'

function keyStorage(keys: string[]) {
  return {
    length: keys.length,
    key: (index: number) => keys[index] ?? null,
  }
}

describe('getNextAgentChatId', () => {
  test('does not reuse a saved conversation id after a page reload', () => {
    const storage = keyStorage([
      'agent-user-42-general-chat-0:playground_messages',
      'agent-user-42-general-chat-1:playground_messages',
    ])

    expect(getNextAgentChatId(42, 'general', 0, storage)).toBe(2)
  })

  test('uses the next id when the active conversation is the newest', () => {
    const storage = keyStorage([
      'agent-user-42-general-chat-0:playground_messages',
      'agent-user-42-general-chat-1:playground_messages',
    ])

    expect(getNextAgentChatId(42, 'general', 1, storage)).toBe(2)
  })

  test('ignores other accounts, presets, legacy keys, and unrelated storage', () => {
    const storage = keyStorage([
      'agent-user-42-general-chat-3:playground_messages',
      'agent-user-42-code-chat-12:playground_messages',
      'agent-user-43-general-chat-90:playground_messages',
      'agent-general-chat-99:playground_messages',
      'agent-user-42-general-chat-x:playground_messages',
      'settings:theme',
    ])

    expect(getNextAgentChatId(42, 'general', 0, storage)).toBe(4)
  })

  test('still advances if local storage cannot be read', () => {
    const storage = {
      get length(): number {
        throw new Error('storage unavailable')
      },
      key: () => null,
    }

    expect(getNextAgentChatId(42, 'general', 1, storage)).toBe(2)
  })
})

describe('agent chat storage key isolation', () => {
  test('includes the stable account id in the conversation namespace', () => {
    expect(getAgentChatStorageNamespace(42, 'general', 3)).toBe(
      'agent-user-42-general-chat-3'
    )
    expect(getAgentChatStorageNamespace(43, 'general', 3)).not.toBe(
      getAgentChatStorageNamespace(42, 'general', 3)
    )
  })

  test('parses only the active account conversation key', () => {
    expect(
      parseAgentChatStorageKey(
        'agent-user-42-research-chat-3:playground_messages',
        42
      )
    ).toEqual({
      namespace: 'agent-user-42-research-chat-3',
      presetId: 'research',
      chatId: 3,
    })
    expect(
      parseAgentChatStorageKey(
        'agent-user-43-research-chat-3:playground_messages',
        42
      )
    ).toBeNull()
  })

  test('does not expose pre-isolation conversation keys', () => {
    expect(
      parseAgentChatStorageKey(
        'agent-general-chat-3:playground_messages',
        42
      )
    ).toBeNull()
  })
})
