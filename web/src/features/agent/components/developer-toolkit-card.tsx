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
import {
  Check,
  Clipboard,
  ExternalLink,
  Network,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import { AGENT_TOOL_MANIFEST, type AgentToolManifest } from '../tool-manifest'

type ToolStatus = {
  id: string
  installed: boolean
  version?: string
  message?: string
}

type DeveloperToolkitCardProps = {
  onCheckRemoteTools?: () => Promise<unknown>
}

type TauriWindow = Window & {
  __TAURI__?: {
    core?: {
      invoke: (
        command: string,
        args?: Record<string, unknown>
      ) => Promise<unknown>
    }
  }
}

const DEVELOPER_TOOLS = AGENT_TOOL_MANIFEST

function getInvoke() {
  if (typeof window === 'undefined') return null
  return (window as TauriWindow).__TAURI__?.core?.invoke ?? null
}

function readStatuses(value: unknown): ToolStatus[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is ToolStatus =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as ToolStatus).id === 'string' &&
      typeof (item as ToolStatus).installed === 'boolean'
  )
}

export function DeveloperToolkitCard({
  onCheckRemoteTools,
}: DeveloperToolkitCardProps) {
  const { t } = useTranslation()
  const [statuses, setStatuses] = useState<ToolStatus[]>([])
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const checkTools = useCallback(async () => {
    const invoke = getInvoke()
    if (!invoke && !onCheckRemoteTools) {
      toast.info(t('Tool detection is available in the Tauri desktop app.'))
      return
    }

    setChecking(true)
    try {
      const result = invoke
        ? await invoke('tool_status', {
            tool_ids: DEVELOPER_TOOLS.filter(
              (tool) => tool.protocol === 'cli' || tool.protocol === 'builtin'
            ).map((tool) => tool.id),
          })
        : await onCheckRemoteTools?.()
      setStatuses(readStatuses(result))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('Developer tool detection failed.')
      )
    } finally {
      setChecking(false)
    }
  }, [onCheckRemoteTools, t])

  useEffect(() => {
    if (getInvoke()) void checkTools()
  }, [checkTools])

  const statusFor = (id: string) => statuses.find((status) => status.id === id)

  const copyCommand = async (command: string) => {
    await navigator.clipboard?.writeText(command)
    setCopied(command)
    window.setTimeout(() => setCopied(null), 1600)
  }

  return (
    <Card size='sm'>
      <CardHeader>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <CardTitle className='flex items-center gap-2 text-sm'>
              <Network className='text-primary size-4' />
              {t('Developer toolkit')}
            </CardTitle>
            <CardDescription className='mt-1 text-xs leading-5'>
              {t(
                'High-leverage local tools for browsing, versioning, refactoring and code intelligence.'
              )}
            </CardDescription>
          </div>
          <Button
            aria-label={t('Check developer tools')}
            disabled={checking}
            onClick={() => void checkTools()}
            size='icon-xs'
            type='button'
            variant='ghost'
          >
            <RefreshCw
              className={checking ? 'size-3.5 animate-spin' : 'size-3.5'}
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent className='grid gap-2'>
        {DEVELOPER_TOOLS.map((tool: AgentToolManifest) => {
          const Icon = tool.icon
          const status = statusFor(tool.id)
          const command = status?.installed ? tool.command : tool.installCommand
          let statusLabel = ''
          if (status?.installed) {
            statusLabel = status.version || t('Ready')
          } else if (status && tool.protocol === 'builtin') {
            statusLabel = t('Not configured')
          } else if (status) {
            statusLabel = t('Not installed')
          }

          return (
            <div
              className='bg-muted/20 grid gap-2 rounded-lg border p-2.5'
              key={tool.id}
            >
              <div className='flex min-w-0 items-start gap-2'>
                <Icon className='text-primary mt-0.5 size-4 shrink-0' />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <span className='truncate text-xs font-medium'>
                      {tool.name}
                    </span>
                    <Badge className='h-5 px-1.5 text-[10px]' variant='outline'>
                      {tool.protocol.toUpperCase()}
                    </Badge>
                    {status && (
                      <Badge
                        className='h-5 px-1.5 text-[10px]'
                        variant={status.installed ? 'secondary' : 'outline'}
                      >
                        {statusLabel}
                      </Badge>
                    )}
                  </div>
                  <p className='text-muted-foreground mt-0.5 text-[11px] leading-4'>
                    {t(tool.description)}
                  </p>
                  <div className='mt-1 flex flex-wrap gap-1'>
                    {tool.capabilities.map((capability) => (
                      <span
                        className='text-muted-foreground bg-background rounded px-1.5 py-0.5 text-[9px]'
                        key={capability}
                      >
                        {capability}
                      </span>
                    ))}
                  </div>
                </div>
                {tool.url && (
                  <Button
                    aria-label={t('Open documentation')}
                    className='text-muted-foreground shrink-0'
                    render={
                      <a href={tool.url} rel='noreferrer' target='_blank' />
                    }
                    size='icon-xs'
                    type='button'
                    variant='ghost'
                  >
                    <ExternalLink className='size-3.5' />
                  </Button>
                )}
              </div>
              <div className='flex min-w-0 items-center gap-1.5'>
                <code className='bg-background min-w-0 flex-1 truncate rounded px-2 py-1 text-[10px]'>
                  {command}
                </code>
                <Button
                  aria-label={t('Copy command')}
                  onClick={() => void copyCommand(command)}
                  size='icon-xs'
                  type='button'
                  variant='ghost'
                >
                  {copied === command ? (
                    <Check className='size-3.5 text-emerald-500' />
                  ) : (
                    <Clipboard className='size-3.5' />
                  )}
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
