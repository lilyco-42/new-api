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
import { describe, expect, it } from 'vitest'

import type { Message } from '../../types'
import { reconcileSystemPrompt } from './playground-state-utils'

function message(key: string, from: Message['from'], content: string): Message {
  return {
    key,
    from,
    versions: [{ id: key, content }],
    status: 'complete',
  }
}

describe('reconcileSystemPrompt', () => {
  it('replaces saved system prompts while preserving conversation history', () => {
    const oldPrompt = message('old-prompt', 'system', 'stale instructions')
    const userMessage = message('user', 'user', 'hello')
    const oldPromptDuplicate = message('old-prompt-2', 'system', 'older')
    const latestPrompt = message(
      'latest-prompt',
      'system',
      'current instructions'
    )

    expect(
      reconcileSystemPrompt(
        [oldPrompt, userMessage, oldPromptDuplicate],
        latestPrompt
      )
    ).toEqual([latestPrompt, userMessage])
  })

  it('keeps existing system messages for the standard playground', () => {
    const messages = [message('custom-system', 'system', 'custom')]

    expect(reconcileSystemPrompt(messages, null)).toBe(messages)
  })
})
