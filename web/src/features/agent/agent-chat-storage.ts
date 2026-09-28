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
import { getPlaygroundStorageNamespace } from '../playground/lib/storage/storage-scope'

type AgentChatKeyStorage = Pick<Storage, 'length' | 'key'>

export type AgentChatStorageNamespace = {
  key: string
  namespace: string
  presetId: string
  chatId: number
}

const AGENT_CHAT_NAMESPACE_PATTERN =
  /^(guest|user-(\d+)):(agent-([a-z0-9-]+)-chat-(\d+)):playground_messages$/

export function getAgentChatStorageNamespace(
  userId: number | null,
  presetId: string,
  chatId: number
): string {
  return getPlaygroundStorageNamespace(
    userId,
    getAgentChatPlaygroundNamespace(presetId, chatId)
  )
}

export function getAgentChatPlaygroundNamespace(
  presetId: string,
  chatId: number
): string {
  return `agent-${presetId}-chat-${chatId}`
}

export function listAgentChatStorageNamespaces(
  userId: number | null,
  storage?: AgentChatKeyStorage
): AgentChatStorageNamespace[] {
  if (!storage && typeof window === 'undefined') return []

  try {
    const keyStorage = storage ?? window.localStorage
    const ownerScope = userId === null ? 'guest' : `user-${userId}`
    const namespaces: AgentChatStorageNamespace[] = []

    for (let index = 0; index < keyStorage.length; index += 1) {
      const key = keyStorage.key(index)
      const match = key?.match(AGENT_CHAT_NAMESPACE_PATTERN)
      if (!key || !match || match[1] !== ownerScope) continue

      namespaces.push({
        key,
        namespace: match[3],
        presetId: match[4],
        chatId: Number(match[5]),
      })
    }

    return namespaces
  } catch {
    // Storage can be unavailable in restricted browser contexts.
    return []
  }
}

export function getNextAgentChatId(
  presetId: string,
  currentChatId: number,
  userId: number | null,
  storage?: AgentChatKeyStorage
): number {
  const nextChatId = Math.max(0, currentChatId + 1)
  const namespaces = listAgentChatStorageNamespaces(userId, storage)
  const highestStoredChatId = namespaces.reduce(
    (highest, entry) =>
      entry.presetId === presetId ? Math.max(highest, entry.chatId) : highest,
    -1
  )
  return Math.max(nextChatId, highestStoredChatId + 1)
}
