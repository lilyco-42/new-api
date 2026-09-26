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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputFooter,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'

import {
  filePartsToContentParts,
  getSubmittableInputText,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from '../../lib'
import type {
  ModelOption,
  GroupOption,
  ParameterEnabled,
  PlaygroundConfig,
} from '../../types'
import { PlaygroundInputControls } from './playground-input-controls'
import { PlaygroundInputTools } from './playground-input-tools'

interface PlaygroundInputProps {
  config: PlaygroundConfig
  onSubmit: (text: string, parts?: import('../../types').ContentPart[]) => void
  onStop?: () => void
  disabled?: boolean
  isGenerating?: boolean
  models: ModelOption[]
  modelValue: string
  onModelChange: (value: string) => void
  isModelLoading?: boolean
  groups: GroupOption[]
  groupValue: string
  onGroupChange: (value: string) => void
  hasMessages?: boolean
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
  onClearMessages?: () => void
  onParameterEnabledChange: (
    key: keyof ParameterEnabled,
    value: boolean
  ) => void
  parameterEnabled: ParameterEnabled
}

export function PlaygroundInput({
  config,
  onSubmit,
  onStop,
  disabled,
  isGenerating,
  models,
  modelValue,
  onModelChange,
  isModelLoading = false,
  groups,
  groupValue,
  onGroupChange,
  hasMessages = false,
  onConfigChange,
  onClearMessages,
  onParameterEnabledChange,
  parameterEnabled,
}: PlaygroundInputProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')

  const handleSubmit = async (message: PromptInputMessage) => {
    const submittableText = getSubmittableInputText(message, disabled)

    if (!submittableText) return
    let contentParts: import('../../types').ContentPart[] | undefined
    try {
      contentParts = message.files?.length
        ? await filePartsToContentParts(message.files, message.signal)
        : undefined
      if (message.signal?.aborted) {
        throw message.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
    } catch (error) {
      if (message.signal?.aborted) {
        throw message.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      toast.error(
        t(
          error instanceof Error
            ? error.message
            : 'Unable to read this PDF. Check that it is not encrypted or damaged.'
        )
      )
      throw error
    }
    onSubmit(submittableText, contentParts)
    setText('')
  }

  const addSearchContextToDraft = (context: string) => {
    setText((current) =>
      [current.trim(), context.trim()].filter(Boolean).join('\n\n')
    )
  }

  return (
    <div className='grid shrink-0 gap-4 px-3 pb-3 sm:px-4 sm:pb-4'>
      <PromptInput
        accept='image/*,application/pdf,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.js,.ts,.tsx,.py,.rs,.go,.java,.sql'
        maxFileSize={MAX_ATTACHMENT_FILE_SIZE_BYTES}
        maxFiles={5}
        multiple
        className='relative'
        groupClassName='bg-background/95 dark:bg-muted/50 border-border/70 shadow-[0_18px_60px_-32px_rgba(0,0,0,0.65)] ring-1 ring-foreground/5 rounded-[1.5rem] overflow-hidden transition-all duration-200 focus-within:border-primary/45 focus-within:ring-primary/15 focus-within:shadow-[0_22px_70px_-34px_rgba(0,0,0,0.75)]'
        onSubmit={handleSubmit}
        onError={(error) => toast.error(t(error.message))}
      >
        <div className='flex flex-wrap gap-1.5 px-3 pt-3'>
          <PromptInputAttachments>
            {(file) => <PromptInputAttachment data={file} />}
          </PromptInputAttachments>
        </div>
        <PromptInputTextarea
          autoComplete='off'
          autoCorrect='off'
          autoCapitalize='off'
          spellCheck={false}
          className='min-h-16 px-4 pt-4 pb-2 leading-7 md:min-h-20 md:text-base'
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('Ask anything')}
          value={text}
        />

        <PromptInputFooter className='border-0 bg-transparent px-3 pt-1.5 pb-3'>
          <PlaygroundInputControls
            disabled={disabled}
            groups={groups}
            groupValue={groupValue}
            isGenerating={isGenerating}
            isModelLoading={isModelLoading}
            models={models}
            modelValue={modelValue}
            onGroupChange={onGroupChange}
            onModelChange={onModelChange}
            onStop={onStop}
            text={text}
            tools={
              <PlaygroundInputTools
                config={config}
                disabled={disabled}
                hasMessages={hasMessages}
                onUseSearchContext={addSearchContextToDraft}
                onConfigChange={onConfigChange}
                onClearMessages={onClearMessages}
                onParameterEnabledChange={onParameterEnabledChange}
                parameterEnabled={parameterEnabled}
              />
            }
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
