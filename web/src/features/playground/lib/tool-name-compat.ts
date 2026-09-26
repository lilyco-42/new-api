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

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionToolCall,
} from '../types'

const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u

export interface MappedToolRequest {
  payload: ChatCompletionRequest
  internalNamesByModelName: ReadonlyMap<string, string>
}

function isValidModelToolName(name: string): boolean {
  return MODEL_TOOL_NAME_PATTERN.test(name)
}

function collectToolNames(payload: ChatCompletionRequest): Set<string> {
  const names = new Set<string>()

  for (const tool of payload.tools ?? []) {
    names.add(tool.function.name)
  }

  for (const message of payload.messages) {
    if (message.name) names.add(message.name)
    for (const call of message.tool_calls ?? []) {
      names.add(call.function.name)
    }
  }

  return names
}

function createToolNameMaps(names: Set<string>): {
  modelNamesByInternalName: Map<string, string>
  internalNamesByModelName: Map<string, string>
} {
  const modelNamesByInternalName = new Map<string, string>()
  const internalNamesByModelName = new Map<string, string>()
  const reservedNames = new Set([...names].filter(isValidModelToolName))
  let aliasIndex = 0

  for (const internalName of names) {
    let modelName = internalName
    if (!isValidModelToolName(internalName)) {
      do {
        modelName = `l42_tool_${aliasIndex}`
        aliasIndex += 1
      } while (
        reservedNames.has(modelName) ||
        internalNamesByModelName.has(modelName)
      )
      reservedNames.add(modelName)
    }

    modelNamesByInternalName.set(internalName, modelName)
    internalNamesByModelName.set(modelName, internalName)
  }

  return { modelNamesByInternalName, internalNamesByModelName }
}

function mapToolCallName(
  call: ChatCompletionToolCall,
  names: ReadonlyMap<string, string>
): ChatCompletionToolCall {
  const name = names.get(call.function.name) ?? call.function.name
  return name === call.function.name
    ? call
    : { ...call, function: { ...call.function, name } }
}

/**
 * Keep dotted, namespaced tool IDs inside the app while sending provider-safe
 * function names to OpenAI-compatible APIs. Aliases are rebuilt from the full
 * request, including historical tool calls, so tool results remain associated
 * with the same canonical operation even when the available tool list changes.
 */
export function mapToolNamesForModel(
  payload: ChatCompletionRequest
): MappedToolRequest {
  const {
    modelNamesByInternalName,
    internalNamesByModelName,
  } = createToolNameMaps(collectToolNames(payload))

  return {
    payload: {
      ...payload,
      messages: payload.messages.map((message) => {
        const name = message.name
          ? modelNamesByInternalName.get(message.name) ?? message.name
          : undefined
        const toolCalls = message.tool_calls?.map((call) =>
          mapToolCallName(call, modelNamesByInternalName)
        )
        return {
          ...message,
          ...(name ? { name } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        }
      }),
      ...(payload.tools
        ? {
            tools: payload.tools.map((tool) => ({
              ...tool,
              function: {
                ...tool.function,
                name:
                  modelNamesByInternalName.get(tool.function.name) ??
                  tool.function.name,
              },
            })),
          }
        : {}),
    },
    internalNamesByModelName,
  }
}

/**
 * Restore provider-safe aliases before the local tool loop applies its
 * allowlist.
 */
export function restoreInternalToolNames(
  response: ChatCompletionResponse,
  internalNamesByModelName: ReadonlyMap<string, string>
): ChatCompletionResponse {
  let changed = false
  const choices = response.choices.map((choice) => {
    const calls = choice.message.tool_calls
    if (!calls?.length) return choice

    let choiceChanged = false
    const toolCalls = calls.map((call) => {
      const name = internalNamesByModelName.get(call.function.name)
      if (!name || name === call.function.name) return call
      changed = true
      choiceChanged = true
      return { ...call, function: { ...call.function, name } }
    })

    return choiceChanged
      ? { ...choice, message: { ...choice.message, tool_calls: toolCalls } }
      : choice
  })

  return changed ? { ...response, choices } : response
}
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
