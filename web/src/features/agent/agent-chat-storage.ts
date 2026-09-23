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

export function getNextAgentChatId(
  presetId: string,
  currentChatId: number,
  storage?: AgentChatKeyStorage
): number {
  let nextChatId = Math.max(0, currentChatId + 1)
  if (!storage && typeof window === 'undefined') return nextChatId

  try {
    const keyStorage = storage ?? window.localStorage
    const prefix = `agent-${presetId}-chat-`
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
      highestStoredChatId = Math.max(highestStoredChatId, Number(rawChatId))
    }

    nextChatId = Math.max(nextChatId, highestStoredChatId + 1)
  } catch {
    // Storage can be unavailable in restricted browser contexts; still move
    // forward from the current conversation instead of reusing its namespace.
  }

  return nextChatId
}
