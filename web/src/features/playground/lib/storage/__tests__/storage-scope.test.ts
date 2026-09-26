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
  getPlaygroundStorageNamespace,
  isAgentChatStorageNamespace,
} from '../storage-scope'

describe('playground storage account isolation', () => {
  test('uses a separate default namespace for each account', () => {
    expect(getPlaygroundStorageNamespace(7)).toBe('user-7:default')
    expect(getPlaygroundStorageNamespace(8)).toBe('user-8:default')
  })

  test('keeps named workspaces within their owning account', () => {
    expect(getPlaygroundStorageNamespace(7, 'agent-general-chat-0')).toBe(
      'user-7:agent-general-chat-0'
    )
    expect(getPlaygroundStorageNamespace(8, 'agent-general-chat-0')).toBe(
      'user-8:agent-general-chat-0'
    )
  })

  test('keeps anonymous history in a guest-only namespace', () => {
    expect(getPlaygroundStorageNamespace(null)).toBe('guest:default')
    expect(getPlaygroundStorageNamespace(null, 'agent-general-chat-0')).toBe(
      'guest:agent-general-chat-0'
    )
  })

  test('recognizes only account-scoped Agent chat workspaces', () => {
    expect(
      isAgentChatStorageNamespace('user-7:agent-general-chat-0')
    ).toBe(true)
    expect(isAgentChatStorageNamespace('guest:agent-coding-chat-12')).toBe(true)
    expect(isAgentChatStorageNamespace('user-7:default')).toBe(false)
    expect(isAgentChatStorageNamespace('agent-general-chat-0')).toBe(false)
  })
})
