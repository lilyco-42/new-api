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
import { GlobeIcon, PaperclipIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  PromptInputButton,
  usePromptInputAttachments,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { api } from '@/lib/api'

import { ATTACHMENT_ACTIONS } from '../../lib'
import type { ParameterEnabled, PlaygroundConfig } from '../../types'
import { PlaygroundParameterPanel } from './playground-parameter-panel'

type PlaygroundInputToolsProps = {
  config: PlaygroundConfig
  disabled?: boolean
  hasMessages?: boolean
  onClearMessages?: () => void
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
  onParameterEnabledChange: (
    key: keyof ParameterEnabled,
    value: boolean
  ) => void
  parameterEnabled: ParameterEnabled
}

export function PlaygroundInputTools({
  config,
  disabled,
  hasMessages = false,
  onClearMessages,
  onConfigChange,
  onParameterEnabledChange,
  parameterEnabled,
}: PlaygroundInputToolsProps) {
  const { t } = useTranslation()
  const attachments = usePromptInputAttachments()
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchFallbackUrl, setSearchFallbackUrl] = useState('')
  const [searchResults, setSearchResults] = useState<
    Array<{ title: string; url: string; snippet?: string }>
  >([])

  const captureMediaFrame = async (kind: 'screen' | 'camera') => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices) {
      attachments.openFileDialog()
      return
    }

    let stream: MediaStream | null = null
    try {
      stream =
        kind === 'screen'
          ? await mediaDevices.getDisplayMedia({ video: true, audio: false })
          : await mediaDevices.getUserMedia({ video: true, audio: false })
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      await video.play()
      await new Promise<void>((resolve) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          resolve()
        } else {
          video.addEventListener('loadeddata', () => resolve(), { once: true })
        }
      })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || 1280
      canvas.height = video.videoHeight || 720
      canvas
        .getContext('2d')
        ?.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png')
      )
      if (!blob) throw new Error(t('Could not capture an image.'))
      const prefix = kind === 'screen' ? 'screenshot' : 'photo'
      attachments.add([
        new File([blob], `${prefix}-${Date.now()}.png`, { type: 'image/png' }),
      ])
    } catch (error) {
      if ((error as DOMException)?.name !== 'NotAllowedError') {
        toast.error(
          error instanceof Error ? error.message : t('Capture failed.')
        )
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
    }
  }

  const handleFileAction = (action: string) => {
    if (action === 'upload-file' || action === 'upload-photo') {
      attachments.openFileDialog()
      return
    }
    void captureMediaFrame(action === 'take-screenshot' ? 'screen' : 'camera')
  }

  const runSearch = async () => {
    const query = searchQuery.trim()
    if (!query) {
      toast.error(t('Search query is required.'))
      return
    }
    setSearching(true)
    setSearchFallbackUrl('')
    try {
      const response = await api.get('/api/agent/search', {
        params: { q: query, limit: 6 },
        skipErrorHandler: true,
      })
      // Keep the input compatible with both the standard API envelope
      // (`{ data: { items } }`) and lightweight/self-hosted proxies that
      // return the search payload directly.
      const data = response.data?.data ?? response.data
      const items = Array.isArray(data?.items) ? data.items : []
      setSearchResults(items)
      if (items.length === 0) {
        setSearchFallbackUrl(
          typeof data?.search_url === 'string'
            ? data.search_url
            : `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
        )
      }
    } catch (error) {
      setSearchResults([])
      setSearchFallbackUrl(
        `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
      )
      const status =
        error && typeof error === 'object' && 'response' in error
          ? (error as { response?: { status?: unknown } }).response?.status
          : undefined
      if (status !== 502) {
        toast.error(
          error instanceof Error ? error.message : t('Search failed.')
        )
      }
    } finally {
      setSearching(false)
    }
  }

  const handleClearMessages = () => {
    onClearMessages?.()
    setClearConfirmOpen(false)
    toast.success(t('Conversation cleared'))
  }

  return (
    <>
      <PromptInputTools className='bg-background/70 border-border/60 rounded-lg border p-1 shadow-xs'>
        <Tooltip>
          <DropdownMenu>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <PromptInputButton
                      aria-label={t('Attach')}
                      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
                      disabled={disabled}
                      variant='ghost'
                    />
                  }
                >
                  <PaperclipIcon size={16} />
                </DropdownMenuTrigger>
              }
            />
            <TooltipContent>
              <p>{t('Attach')}</p>
            </TooltipContent>
            <DropdownMenuContent align='start'>
              {ATTACHMENT_ACTIONS.map(({ action, icon: Icon, label }) => (
                <DropdownMenuItem
                  key={action}
                  onClick={() => handleFileAction(action)}
                >
                  <Icon className='mr-2' size={16} />
                  {t(label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Tooltip>

        <Popover open={searchOpen} onOpenChange={setSearchOpen}>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <PromptInputButton
                      aria-label={t('Search')}
                      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
                      disabled={disabled}
                      variant='ghost'
                    >
                      <GlobeIcon size={16} />
                    </PromptInputButton>
                  }
                />
              }
            />
            <TooltipContent>
              <p>{t('Search')}</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            align='start'
            className='w-[min(24rem,calc(100vw-2rem))]'
          >
            <div className='flex gap-2'>
              <Input
                autoFocus
                aria-label={t('Search')}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSearch()
                }}
                placeholder={t('Search the web')}
                value={searchQuery}
              />
              <Button
                disabled={searching}
                onClick={() => void runSearch()}
                size='sm'
              >
                {searching ? t('Searching…') : t('Search')}
              </Button>
            </div>
            {searchResults.length > 0 && (
              <div className='mt-2 grid max-h-72 gap-1 overflow-y-auto'>
                {searchResults.map((result) => (
                  <a
                    className='hover:bg-muted/60 rounded-md p-2 text-xs'
                    href={result.url}
                    key={result.url}
                    rel='noreferrer'
                    target='_blank'
                  >
                    <span className='block truncate font-medium'>
                      {result.title}
                    </span>
                    <span className='text-muted-foreground mt-0.5 line-clamp-2 block leading-4'>
                      {result.snippet || result.url}
                    </span>
                  </a>
                ))}
              </div>
            )}
            {!searching && searchQuery.trim() && searchResults.length === 0 && (
              <>
                {searchFallbackUrl ? (
                  <a
                    className='text-muted-foreground hover:text-foreground mt-2 block text-xs underline underline-offset-2'
                    href={searchFallbackUrl}
                    rel='noreferrer'
                    target='_blank'
                  >
                    {t('Open web search results')}
                  </a>
                ) : (
                  <p className='text-muted-foreground mt-2 text-xs'>
                    {t('No records found')}
                  </p>
                )}
              </>
            )}
          </PopoverContent>
        </Popover>

        <PlaygroundParameterPanel
          config={config}
          disabled={disabled}
          onConfigChange={onConfigChange}
          onParameterEnabledChange={onParameterEnabledChange}
          parameterEnabled={parameterEnabled}
        />

        <Tooltip>
          <TooltipTrigger
            render={
              <PromptInputButton
                aria-label={t('Clear chat history')}
                className='text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-medium'
                disabled={disabled || !hasMessages || !onClearMessages}
                onClick={() => setClearConfirmOpen(true)}
                variant='ghost'
              >
                <Trash2Icon size={16} />
              </PromptInputButton>
            }
          />
          <TooltipContent>
            <p>{t('Clear chat history')}</p>
          </TooltipContent>
        </Tooltip>
      </PromptInputTools>

      <ConfirmDialog
        destructive
        desc={t(
          'All playground messages saved in this browser will be removed. This cannot be undone.'
        )}
        confirmText={t('Clear')}
        handleConfirm={handleClearMessages}
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title={t('Clear chat history?')}
      />
    </>
  )
}
