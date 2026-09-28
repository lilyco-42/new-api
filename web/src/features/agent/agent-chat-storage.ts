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

type AgentChatKeyStorage = Pick<Storage, 'length' | 'key'>

const PLAYGROUND_MESSAGES_SUFFIX = ':playground_messages'
const AGENT_CHAT_NAMESPACE_PATTERN = /^agent-user-(\d+)-([a-z-]+)-chat-(\d+)$/

export type AgentChatStorageKey = {
  namespace: string
  presetId: string
  chatId: number
}

export function getAgentChatStorageNamespace(
  userId: number,
  presetId: string,
  chatId: number
): string {
  return `agent-user-${userId}-${presetId}-chat-${chatId}`
}

export function parseAgentChatStorageKey(
  storageKey: string,
  userId: number
): AgentChatStorageKey | null {
  if (!Number.isSafeInteger(userId) || userId < 0) return null
  if (!storageKey.endsWith(PLAYGROUND_MESSAGES_SUFFIX)) return null

  const namespace = storageKey.slice(0, -PLAYGROUND_MESSAGES_SUFFIX.length)
  const match = namespace.match(AGENT_CHAT_NAMESPACE_PATTERN)
  if (!match) return null

  const storedUserId = Number(match[1])
  const chatId = Number(match[3])
  if (
    !Number.isSafeInteger(storedUserId) ||
    storedUserId !== userId ||
    !Number.isSafeInteger(chatId)
  ) {
    return null
  }

  return {
    namespace,
    presetId: match[2],
    chatId,
  }
}

export function getNextAgentChatId(
  userId: number,
  presetId: string,
  currentChatId: number,
  storage?: AgentChatKeyStorage
): number {
  let nextChatId = Math.max(0, currentChatId + 1)
  if (!Number.isSafeInteger(userId) || userId < 0) return nextChatId
  if (!storage && typeof window === 'undefined') return nextChatId

  try {
    const keyStorage = storage ?? window.localStorage
    const prefix = `agent-user-${userId}-${presetId}-chat-`
    let highestStoredChatId = -1

    for (let index = 0; index < keyStorage.length; index += 1) {
      const key = keyStorage.key(index)
      if (
        !key?.startsWith(prefix) ||
        !key.endsWith(PLAYGROUND_MESSAGES_SUFFIX)
      ) {
        continue
      }

      const rawChatId = key.slice(
        prefix.length,
        -PLAYGROUND_MESSAGES_SUFFIX.length
      )
      if (!/^\d+$/.test(rawChatId)) continue
      const storedChatId = Number(rawChatId)
      if (!Number.isSafeInteger(storedChatId)) continue
      highestStoredChatId = Math.max(highestStoredChatId, storedChatId)
    }

    nextChatId = Math.max(nextChatId, highestStoredChatId + 1)
  } catch {
    // Storage can be unavailable in restricted browser contexts; still move
    // forward from the current conversation instead of reusing its namespace.
  }

  return nextChatId
}
