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

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import type { Message } from '../../../types'
import { buildChatCompletionPayload } from '../payload-builder'

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
  it.each([
    ['查看我的 GitHub 仓库', 'OAuth returned merchant/image-workflow.', '你怎么查询的?'],
    ['修复 merchant/image-workflow 的 workflow', 'Which workflow service is failing?', 'github action'],
    ['阅读 merchant/image-workflow 的 issues', 'You can open the Issues page yourself.', '你自己阅读'],
  ])('preserves the current task context for the user continuation %s → %s → %s', (initialRequest, reply, continuation) => {
    const payload = buildChatCompletionPayload(
      [
        message('system', 'system', 'Use tools to complete the current task.'),
        message('initial-user', 'user', initialRequest),
        message('previous-answer', 'assistant', reply),
        message('follow-up', 'user', continuation),
      ],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      true
    )

    expect(payload.messages).toContainEqual({ role: 'user', content: initialRequest })
    expect(payload.messages).toContainEqual({ role: 'assistant', content: reply })
    expect(payload.messages.at(-1)).toEqual({ role: 'user', content: continuation })
    expect(payload.messages[0]).toEqual({ role: 'system', content: 'Use tools to complete the current task.' })
  })

  it('omits failed turns from model context but keeps successful and current turns', () => {
    const messages = [
      message('system', 'system', 'answer the latest request'),
      message('prior-user', 'user', 'earlier question'),
      message('prior-assistant', 'assistant', 'earlier answer'),
      message('failed-user', 'user', 'unanswered question'),
      message('failed-assistant', 'assistant', 'service unavailable', 'error'),
      message('latest-user', 'user', 'and a new follow-up'),
      message('latest-assistant', 'assistant', '', 'loading'),
    ]

    const payload = buildChatCompletionPayload(
      messages,
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      true
    )

    expect(payload.messages).toEqual([
      { role: 'system', content: 'answer the latest request' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'and a new follow-up' },
    ])
  })

  it('keeps recent history while placing a new knowledge request last and preserving system roles', () => {
    const messages = [
      message('system', 'system', 'answer the latest request'),
      message('old-user', 'user', '查看我的 GitHub 仓库'),
      message('old-assistant', 'assistant', '请先登录本机 gh CLI。'),
      message('current-user', 'user', 'DeepSeek 是什么？'),
      message('current-assistant', 'assistant', '', 'loading'),
    ]

    const payload = buildChatCompletionPayload(
      messages,
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      true
    )

    expect(payload.messages).toEqual([
      { role: 'system', content: 'answer the latest request' },
      { role: 'user', content: '查看我的 GitHub 仓库' },
      { role: 'assistant', content: '请先登录本机 gh CLI。' },
      { role: 'user', content: 'DeepSeek 是什么？' },
    ])
  })

  it('preserves full conversational context outside Agent mode', () => {
    const messages = [
      message('system', 'system', 'general assistant'),
      message('prior-user', 'user', 'My project is called Solstice.'),
      message('prior-assistant', 'assistant', 'Understood.'),
      message('latest-user', 'user', 'What should I name the next release?'),
    ]

    const payload = buildChatCompletionPayload(
      messages,
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED
    )

    expect(payload.messages).toHaveLength(4)
    expect(payload.messages[1]?.content).toBe(
      'My project is called Solstice.'
    )
  })
})
