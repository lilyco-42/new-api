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

import {
  getAgentChatStorageNamespace,
  getNextAgentChatId,
  listAgentChatStorageNamespaces,
} from '../agent-chat-storage'

function keyStorage(keys: string[]) {
  return {
    length: keys.length,
    key: (index: number) => keys[index] ?? null,
  }
}

describe('agent chat storage account isolation', () => {
  test('uses a distinct namespace for each account and guest', () => {
    expect(getAgentChatStorageNamespace(7, 'general', 0)).toBe(
      'user-7:agent-general-chat-0'
    )
    expect(getAgentChatStorageNamespace(8, 'general', 0)).toBe(
      'user-8:agent-general-chat-0'
    )
    expect(getAgentChatStorageNamespace(null, 'general', 0)).toBe(
      'guest:agent-general-chat-0'
    )
  })

  test('lists only conversations owned by the requested account', () => {
    const storage = keyStorage([
      'user-7:agent-general-chat-0:playground_messages',
      'user-8:agent-general-chat-2:playground_messages',
      'guest:agent-general-chat-4:playground_messages',
      'agent-general-chat-9:playground_messages',
      'settings:theme',
    ])

    expect(listAgentChatStorageNamespaces(7, storage)).toEqual([
      {
        key: 'user-7:agent-general-chat-0:playground_messages',
        namespace: 'agent-general-chat-0',
        presetId: 'general',
        chatId: 0,
      },
    ])
  })

  test('does not reuse a chat id owned by another account', () => {
    const storage = keyStorage([
      'user-8:agent-general-chat-12:playground_messages',
      'user-7:agent-coding-chat-15:playground_messages',
      'guest:agent-general-chat-20:playground_messages',
    ])

    expect(getNextAgentChatId('general', 0, 7, storage)).toBe(1)
  })

  test('resumes chat numbering from the same account history', () => {
    const storage = keyStorage([
      'user-7:agent-general-chat-0:playground_messages',
      'user-7:agent-general-chat-1:playground_messages',
      'user-8:agent-general-chat-12:playground_messages',
    ])

    expect(getNextAgentChatId('general', 0, 7, storage)).toBe(2)
  })

  test('keeps guest conversations separate from account and legacy history', () => {
    const storage = keyStorage([
      'user-7:agent-general-chat-0:playground_messages',
      'guest:agent-general-chat-1:playground_messages',
      'agent-general-chat-99:playground_messages',
    ])

    expect(listAgentChatStorageNamespaces(null, storage)).toEqual([
      {
        key: 'guest:agent-general-chat-1:playground_messages',
        namespace: 'agent-general-chat-1',
        presetId: 'general',
        chatId: 1,
      },
    ])
  })

  test('still advances when local storage cannot be read', () => {
    const storage = {
      get length(): number {
        throw new Error('storage unavailable')
      },
      key: () => null,
    }

    expect(getNextAgentChatId('general', 1, 7, storage)).toBe(2)
  })
})
