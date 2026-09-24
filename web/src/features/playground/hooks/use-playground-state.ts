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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../constants'
import {
  saveConfig,
  saveParameterEnabled,
  saveMessages,
  applyMessageStateUpdate,
  getInitialParameterEnabled,
  getInitialPlaygroundConfig,
  loadMessages,
  reconcileSystemPrompt,
  type MessageStateUpdater,
} from '../lib'
import type {
  Message,
  PlaygroundConfig,
  ParameterEnabled,
  ModelOption,
  GroupOption,
} from '../types'

const MESSAGE_SAVE_DEBOUNCE_MS = 500

type UsePlaygroundStateOptions = {
  /** Optional localStorage namespace for an independent workspace. */
  storageNamespace?: string
  /** Optional instruction message used by an agent preset. */
  systemPrompt?: string
}

function createSystemMessage(content: string): Message {
  return {
    key: `system-${content.slice(0, 24).replaceAll(/[^a-z0-9]+/gi, '-')}`,
    from: 'system',
    versions: [{ id: 'system', content }],
    createdAt: 0,
    status: 'complete',
  }
}

/**
 * Main state management hook for playground
 */
export function usePlaygroundState(options: UsePlaygroundStateOptions = {}) {
  const { storageNamespace = '', systemPrompt } = options
  // Load initial state from localStorage
  const [config, setConfig] = useState<PlaygroundConfig>(() =>
    getInitialPlaygroundConfig(storageNamespace)
  )

  const [parameterEnabled, setParameterEnabled] = useState<ParameterEnabled>(
    () => getInitialParameterEnabled(storageNamespace)
  )

  const [messages, setMessages] = useState<Message[]>([])
  const [isLoadingMessages, setIsLoadingMessages] = useState(true)
  const messagesSaveTimerRef = useRef<number | null>(null)
  const latestMessagesRef = useRef<Message[]>(messages)
  const hasLoadedMessagesRef = useRef(false)
  const systemMessage = useMemo(
    () => (systemPrompt ? createSystemMessage(systemPrompt) : null),
    [systemPrompt]
  )

  const [models, setModels] = useState<ModelOption[]>([])
  const [groups, setGroups] = useState<GroupOption[]>([])

  const persistMessages = useCallback(
    (messagesToSave: Message[]) => {
      latestMessagesRef.current = messagesToSave

      if (!hasLoadedMessagesRef.current) {
        return
      }

      if (messagesSaveTimerRef.current !== null) {
        window.clearTimeout(messagesSaveTimerRef.current)
      }

      messagesSaveTimerRef.current = window.setTimeout(() => {
        messagesSaveTimerRef.current = null
        saveMessages(latestMessagesRef.current, storageNamespace)
      }, MESSAGE_SAVE_DEBOUNCE_MS)
      if (storageNamespace.startsWith('agent-')) {
        window.dispatchEvent(new Event('lain42:agent-chat-updated'))
      }
    },
    [storageNamespace]
  )

  useEffect(() => {
    let cancelled = false

    window.setTimeout(() => {
      const loadedMessages = loadMessages(storageNamespace) ?? []
      const initialMessages = reconcileSystemPrompt(
        loadedMessages,
        systemMessage
      )
      if (cancelled) {
        return
      }

      latestMessagesRef.current = initialMessages
      hasLoadedMessagesRef.current = true
      setMessages(initialMessages)
      setIsLoadingMessages(false)
    }, 0)

    return () => {
      cancelled = true
    }
  }, [storageNamespace, systemMessage])

  useEffect(
    () => () => {
      if (messagesSaveTimerRef.current !== null) {
        window.clearTimeout(messagesSaveTimerRef.current)
        saveMessages(latestMessagesRef.current, storageNamespace)
      }
    },
    [storageNamespace]
  )

  // Update config with automatic save
  const updateConfig = useCallback(
    <K extends keyof PlaygroundConfig>(key: K, value: PlaygroundConfig[K]) => {
      setConfig((prev) => {
        const updated = { ...prev, [key]: value }
        saveConfig(updated, storageNamespace)
        return updated
      })
    },
    [storageNamespace]
  )

  // Update parameter enabled with automatic save
  const updateParameterEnabled = useCallback(
    (key: keyof ParameterEnabled, value: boolean) => {
      setParameterEnabled((prev) => {
        const updated = { ...prev, [key]: value }
        saveParameterEnabled(updated, storageNamespace)
        return updated
      })
    },
    [storageNamespace]
  )

  // Update messages with automatic save
  const updateMessages = useCallback(
    (updater: MessageStateUpdater) => {
      setMessages((prev) => {
        const newMessages = applyMessageStateUpdate(prev, updater)
        persistMessages(newMessages)
        return newMessages
      })
    },
    [persistMessages]
  )

  // Clear all messages
  const clearMessages = useCallback(() => {
    updateMessages(systemMessage ? [systemMessage] : [])
  }, [systemMessage, updateMessages])

  // Reset config to defaults
  const resetConfig = useCallback(() => {
    setConfig(DEFAULT_CONFIG)
    setParameterEnabled(DEFAULT_PARAMETER_ENABLED)
    saveConfig(DEFAULT_CONFIG, storageNamespace)
    saveParameterEnabled(DEFAULT_PARAMETER_ENABLED, storageNamespace)
  }, [storageNamespace])

  return {
    // State
    config,
    parameterEnabled,
    messages,
    isLoadingMessages,
    models,
    groups,

    // Setters
    setModels,
    setGroups,

    // Actions
    updateConfig,
    updateParameterEnabled,
    updateMessages,
    clearMessages,
    resetConfig,
  }
}
