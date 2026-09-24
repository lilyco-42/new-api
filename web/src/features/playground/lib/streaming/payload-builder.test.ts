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

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import type { Message } from '../../types'
import { buildChatCompletionPayload } from './payload-builder'

function message(
  key: string,
  from: Message['from'],
  content: string,
  status: Message['status'] = 'complete'
): Message {
  return {
    key,
    from,
    versions: [{ id: key, content }],
    status,
  }
}

describe('buildChatCompletionPayload', () => {
  it('omits failed turns from model context but keeps successful and current turns', () => {
    const messages = [
      message('system', 'system', 'answer the latest request'),
      message('prior-user', 'user', 'earlier question'),
      message('prior-assistant', 'assistant', 'earlier answer'),
      message('failed-user', 'user', 'unanswered question'),
      message('failed-assistant', 'assistant', 'service unavailable', 'error'),
      message('latest-user', 'user', 'new question'),
      message('latest-assistant', 'assistant', '', 'loading'),
    ]

    const payload = buildChatCompletionPayload(
      messages,
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED
    )

    expect(payload.messages).toEqual([
      { role: 'system', content: 'answer the latest request' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'new question' },
    ])
  })
})
