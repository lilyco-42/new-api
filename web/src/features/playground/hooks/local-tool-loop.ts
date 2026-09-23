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
import { sendChatCompletion } from '../api'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '../types'

const MAX_STEPS = 8
const MAX_TOOL_CALLS = 8
const MAX_ARGUMENT_BYTES = 16 * 1024
const MAX_RESULT_BYTES = 128 * 1024

export type LocalToolLoopEvent =
  | { type: 'requested'; call: ChatCompletionToolCall }
  | { type: 'running'; call: ChatCompletionToolCall }
  | { type: 'completed'; call: ChatCompletionToolCall; result: string }

export class LocalToolLoopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalToolLoopError'
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedResult(value: string): string {
  if (byteLength(value) <= MAX_RESULT_BYTES) return value
  const bytes = new TextEncoder().encode(value).slice(0, MAX_RESULT_BYTES)
  return `${new TextDecoder().decode(bytes)}\n[tool result truncated]`
}

function parseArguments(call: ChatCompletionToolCall): Record<string, unknown> {
  if (!call.id || call.id.length > 128) {
    throw new LocalToolLoopError('Tool call id is missing or too long.')
  }
  if (call.type !== 'function' || !call.function?.name) {
    throw new LocalToolLoopError('Only function tool calls are supported.')
  }
  if (typeof call.function.arguments !== 'string') {
    throw new LocalToolLoopError('Tool arguments must be a JSON string.')
  }
  if (byteLength(call.function.arguments) > MAX_ARGUMENT_BYTES) {
    throw new LocalToolLoopError('Tool arguments exceed the allowed size.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(call.function.arguments)
  } catch {
    throw new LocalToolLoopError(
      `Tool arguments for ${call.function.name} are not valid JSON.`
    )
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalToolLoopError(
      `Tool arguments for ${call.function.name} must be a JSON object.`
    )
  }
  return parsed as Record<string, unknown>
}

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('The tool loop was cancelled.', 'AbortError')
  }
}

function assistantMessageFromResponse(
  response: ChatCompletionResponse
): ChatCompletionMessage {
  const message = response.choices?.[0]?.message
  if (!message) throw new LocalToolLoopError('The model returned no message.')
  return {
    role: 'assistant',
    content: message.content ?? null,
    ...(message.reasoning_content
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  } as ChatCompletionMessage
}

export async function runLocalToolLoop(
  initialPayload: ChatCompletionRequest,
  provider: LocalToolProvider,
  signal: AbortSignal,
  onEvent?: (event: LocalToolLoopEvent) => void,
  request = sendChatCompletion
): Promise<ChatCompletionResponse> {
  assertSignal(signal)
  const preflightResponse = provider.preflight?.(initialPayload.messages)
  if (preflightResponse) return preflightResponse
  if (!provider.isAvailable()) return request(initialPayload, signal)

  const messages: ChatCompletionMessage[] = [...initialPayload.messages]
  let response = await request(
    {
      ...initialPayload,
      messages,
      stream: false,
      tools: provider.tools,
      tool_choice: 'auto',
    },
    signal
  )
  let totalCalls = 0
  const seenCallIds = new Set<string>()

  for (let step = 0; step < MAX_STEPS; step += 1) {
    assertSignal(signal)
    const assistantMessage = assistantMessageFromResponse(response)
    const calls = assistantMessage.tool_calls ?? []
    if (calls.length === 0) return response

    if (totalCalls + calls.length > MAX_TOOL_CALLS) {
      throw new LocalToolLoopError('The tool call budget was exceeded.')
    }

    for (const call of calls) {
      parseArguments(call)
      if (seenCallIds.has(call.id)) {
        throw new LocalToolLoopError(`Duplicate tool call id: ${call.id}.`)
      }
      seenCallIds.add(call.id)
      if (
        !provider.tools.some(
          (tool) => tool.function.name === call.function.name
        )
      ) {
        throw new LocalToolLoopError(
          `Tool is not allowed: ${call.function.name}.`
        )
      }
    }

    messages.push(assistantMessage)
    for (const call of calls) {
      assertSignal(signal)
      onEvent?.({ type: 'requested', call })
      if (provider.requiresApproval) {
        const approved = await provider.requiresApproval(call, signal)
        assertSignal(signal)
        if (!approved) {
          throw new LocalToolLoopError(
            `Tool call ${call.function.name} was not approved.`
          )
        }
      }
      onEvent?.({ type: 'running', call })
      const result = boundedResult(await provider.invoke(call, signal))
      onEvent?.({ type: 'completed', call, result })
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      totalCalls += 1
    }

    response = await request(
      {
        ...initialPayload,
        messages,
        stream: false,
        tools: provider.tools,
        tool_choice: 'auto',
      },
      signal
    )
  }

  throw new LocalToolLoopError('The tool loop reached its step limit.')
}
