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
import { MESSAGE_ROLES, MESSAGE_STATUS } from '../../constants'
import type {
  ChatCompletionRequest,
  Message,
  PlaygroundConfig,
  ParameterEnabled,
} from '../../types'
import {
  formatMessageForAPI,
  getCurrentVersion,
  isValidMessage,
} from '../message/message-utils'

const MAX_FOLLOW_UP_CONTEXT_MESSAGES = 8

function getMessageText(message: Message): string {
  const version = getCurrentVersion(message)
  const attachmentText =
    version.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n') ?? ''
  return [version.content, attachmentText].filter(Boolean).join('\n').trim()
}

function isFollowUpRequest(message: Message): boolean {
  const text = getMessageText(message).toLocaleLowerCase().replace(/\s+/gu, ' ')
  if (!text) return true

  if (
    /^(?:what is|who is|define|explain|search|find|look up|tell me about|introduce|what does .+ mean|what are|how to\b|how do i\b|why\b|如何|怎么|为什么|什么是|.+是什么|.+是谁|解释一下|介绍一下|搜索|查找|查看|列出|帮我(?:查|找|搜索|查看)|请(?:查|找|搜索|查看))/iu.test(
      text
    )
  ) {
    return false
  }

  return (
    /^(?:and\b|also\b|then\b|it\b|that\b|this\b|those\b|these\b|its\b|they\b|how about\b|what about\b|continue\b|tell me more\b|use (?:chinese|english)|answer in\b)/iu.test(
      text
    ) ||
    /^(?:那|这个|它|这些|继续|接着|再说|刚才|上面|之前|还有|然后|详细说|简短点|用(?:中文|英文)|改成|不要|同样)/u.test(
      text
    ) ||
    /^(?:你在干嘛|你在干什么|我问你话|答非所问|回答跑题)/u.test(text)
  )
}

function excludeFailedTurns(messages: Message[]): Message[] {
  const excludedIndices = new Set<number>()

  messages.forEach((message, index) => {
    if (
      message.from !== MESSAGE_ROLES.ASSISTANT ||
      message.status !== MESSAGE_STATUS.ERROR
    ) {
      return
    }

    excludedIndices.add(index)
    if (messages[index - 1]?.from === MESSAGE_ROLES.USER) {
      excludedIndices.add(index - 1)
    }
  })

  return messages.filter((_, index) => !excludedIndices.has(index))
}

function selectRelevantConversationContext(messages: Message[]): Message[] {
  const systemMessages = messages.filter(
    (message) => message.from === MESSAGE_ROLES.SYSTEM
  )
  const conversationMessages = messages.filter(
    (message) => message.from !== MESSAGE_ROLES.SYSTEM
  )
  let latestUserIndex = -1
  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    if (conversationMessages[index]?.from === MESSAGE_ROLES.USER) {
      latestUserIndex = index
      break
    }
  }

  if (latestUserIndex < 0) return [...systemMessages, ...conversationMessages]

  const latestUserMessage = conversationMessages[latestUserIndex]
  if (!isFollowUpRequest(latestUserMessage)) {
    return [...systemMessages, latestUserMessage]
  }

  return [
    ...systemMessages,
    ...conversationMessages.slice(
      Math.max(0, latestUserIndex - MAX_FOLLOW_UP_CONTEXT_MESSAGES + 1)
    ),
  ]
}

/**
 * Build API request payload from messages and config
 */
export function buildChatCompletionPayload(
  messages: Message[],
  config: PlaygroundConfig,
  parameterEnabled: ParameterEnabled,
  isolateAgentTurnContext = false
): ChatCompletionRequest {
  // Filter and format valid messages
  const contextMessages = excludeFailedTurns(messages)
  const processedMessages = (isolateAgentTurnContext
    ? selectRelevantConversationContext(contextMessages)
    : contextMessages)
    .filter(isValidMessage)
    .map(formatMessageForAPI)

  const payload: ChatCompletionRequest = {
    model: config.model,
    group: config.group,
    messages: processedMessages,
    stream: config.stream,
  }

  if (parameterEnabled.temperature) {
    payload.temperature = config.temperature
  }

  if (parameterEnabled.top_p) {
    payload.top_p = config.top_p
  }

  if (parameterEnabled.max_tokens) {
    payload.max_tokens = config.max_tokens
  }

  if (parameterEnabled.frequency_penalty) {
    payload.frequency_penalty = config.frequency_penalty
  }

  if (parameterEnabled.presence_penalty) {
    payload.presence_penalty = config.presence_penalty
  }

  if (parameterEnabled.seed && config.seed !== null) {
    payload.seed = config.seed
  }

  return payload
}
