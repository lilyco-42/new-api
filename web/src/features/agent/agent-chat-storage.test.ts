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

import { getNextAgentChatId } from './agent-chat-storage'

function keyStorage(keys: string[]) {
  return {
    length: keys.length,
    key: (index: number) => keys[index] ?? null,
  }
}

describe('getNextAgentChatId', () => {
  test('does not reuse a saved conversation id after a page reload', () => {
    const storage = keyStorage([
      'agent-general-chat-0:playground_messages',
      'agent-general-chat-1:playground_messages',
    ])

    expect(getNextAgentChatId('general', 0, storage)).toBe(2)
  })

  test('uses the next id when the active conversation is the newest', () => {
    const storage = keyStorage([
      'agent-general-chat-0:playground_messages',
      'agent-general-chat-1:playground_messages',
    ])

    expect(getNextAgentChatId('general', 1, storage)).toBe(2)
  })

  test('ignores other agent presets and unrelated local storage entries', () => {
    const storage = keyStorage([
      'agent-general-chat-3:playground_messages',
      'agent-code-chat-12:playground_messages',
      'agent-general-chat-x:playground_messages',
      'settings:theme',
    ])

    expect(getNextAgentChatId('general', 0, storage)).toBe(4)
  })

  test('still advances if local storage cannot be read', () => {
    const storage = {
      get length() {
        throw new Error('storage unavailable')
      },
      key: () => null,
    }

    expect(getNextAgentChatId('general', 1, storage)).toBe(2)
  })
})
