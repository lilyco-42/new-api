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
import { PlaygroundChat } from './components/chat/playground-chat'
import { PlaygroundInput } from './components/input/playground-input'
import { MESSAGE_ROLES, MESSAGE_STATUS } from './constants'
import {
  useChatHandler,
  usePlaygroundConversation,
  usePlaygroundOptions,
  usePlaygroundState,
} from './hooks'
import type { HostedTurnProvider, LocalToolProvider } from './types'

export interface PlaygroundProps {
  /** Optional instruction message for a focused agent workspace. */
  systemPrompt?: string
  /** Isolate agent history/config from the normal playground. */
  storageNamespace?: string
  /** Optional empty-state heading for branded agent workspaces. */
  emptyStateTitle?: string
  /** Optional empty-state description for branded agent workspaces. */
  emptyStateDescription?: string
  /** Optional desktop-only tool bridge. It is unavailable in a normal browser. */
  localToolProvider?: LocalToolProvider
  /** Optional server-owned Agent turn runtime; null falls back to the existing chat path. */
  hostedTurnProvider?: HostedTurnProvider
  /** Keep unrelated Agent prompts from inheriting stale topics or failed turns. */
  agentMode?: boolean
}

export function Playground({
  systemPrompt,
  storageNamespace = '',
  emptyStateTitle,
  emptyStateDescription,
  localToolProvider,
  hostedTurnProvider,
  agentMode = false,
}: PlaygroundProps = {}) {
  const {
    config,
    parameterEnabled,
    messages,
    isLoadingMessages,
    models,
    groups,
    updateMessages,
    setModels,
    setGroups,
    updateConfig,
    updateParameterEnabled,
    clearMessages,
  } = usePlaygroundState({ storageNamespace, systemPrompt })

  const { sendChat, stopGeneration, isGenerating } = useChatHandler({
    config,
    parameterEnabled,
    onMessageUpdate: updateMessages,
    localToolProvider,
    hostedTurnProvider,
    isolateAgentTurnContext: agentMode,
  })

  const {
    editingMessageKey,
    handleSendMessage,
    handleRegenerateMessage,
    handleEditMessage,
    handleEditOpenChange,
    applyEdit,
    handleDeleteMessage,
  } = usePlaygroundConversation({
    messages,
    updateMessages,
    sendChat,
  })

  const handleClearMessages = () => {
    hostedTurnProvider?.reset()
    handleEditOpenChange(false)
    clearMessages()
  }

  const handleRegenerateWithHostedRecovery = (
    message: Parameters<typeof handleRegenerateMessage>[0]
  ) => {
    // Retry a failed observation with its accepted identity. Regenerating a
    // completed answer deliberately starts a new execution instead.
    if (
      message.from !== MESSAGE_ROLES.ASSISTANT ||
      message.status !== MESSAGE_STATUS.ERROR
    ) {
      hostedTurnProvider?.reset()
    }
    handleRegenerateMessage(message)
  }

  const handleDeleteWithHostedReset = (
    message: Parameters<typeof handleDeleteMessage>[0]
  ) => {
    hostedTurnProvider?.reset()
    handleDeleteMessage(message)
  }

  const handleEditWithHostedReset = (content: string, submit: boolean) => {
    hostedTurnProvider?.reset()
    applyEdit(content, submit)
  }

  const handleChooseModel = () => {
    const selector = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-agent-model-selector-trigger="true"]'
      ),
    ].find((element) => element.getClientRects().length > 0)

    if (!selector) return
    selector.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.requestAnimationFrame(() => selector.click())
  }

  const { isLoadingModels } = usePlaygroundOptions({
    currentGroup: config.group,
    currentModel: config.model,
    setGroups,
    setModels,
    updateConfig,
  })

  return (
    <div className='relative flex size-full min-h-0 flex-col overflow-hidden'>
      {/* Full-width scroll container: scrolling works even over side whitespace */}
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        <PlaygroundChat
          emptyStateDescription={emptyStateDescription}
          emptyStateTitle={emptyStateTitle}
          messages={messages}
          isLoadingMessages={isLoadingMessages}
          onRegenerateMessage={handleRegenerateWithHostedRecovery}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteWithHostedReset}
          onSelectPrompt={handleSendMessage}
          onChooseModel={handleChooseModel}
          isGenerating={isGenerating}
          editingKey={editingMessageKey}
          onCancelEdit={handleEditOpenChange}
          onSaveEdit={(newContent) =>
            handleEditWithHostedReset(newContent, false)
          }
          onSaveEditAndSubmit={(newContent) =>
            handleEditWithHostedReset(newContent, true)
          }
        />
      </div>

      {/* Input area: center content and constrain to the same container width */}
      <div className='mx-auto w-full max-w-3xl'>
        <PlaygroundInput
          config={config}
          disabled={isGenerating}
          groups={groups}
          groupValue={config.group}
          isGenerating={isGenerating}
          isModelLoading={isLoadingModels}
          modelValue={config.model}
          models={models}
          onGroupChange={(value) => updateConfig('group', value)}
          onConfigChange={updateConfig}
          onClearMessages={handleClearMessages}
          onModelChange={(value) => updateConfig('model', value)}
          onParameterEnabledChange={updateParameterEnabled}
          onStop={stopGeneration}
          onSubmit={handleSendMessage}
          parameterEnabled={parameterEnabled}
          hasMessages={messages.length > 0}
        />
      </div>
    </div>
  )
}
