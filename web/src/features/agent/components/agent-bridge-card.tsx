/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import {
  Cable,
  Check,
  Clipboard,
  Copy,
  ExternalLink,
  Laptop,
  Link2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'
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

import type { AgentBridgeStatus, AgentRunEvent } from '../agent-bridge'
import { createRadxaPairingScript } from '../radxa-pairing-script'

type AgentBridgeCardProps = {
  isDesktop: boolean
  status: AgentBridgeStatus
  deviceName?: string
  onPair?: () => Promise<void>
  onReconnect?: () => Promise<void>
  onCreatePairing?: () => Promise<void>
  onConfirmPairing?: (ticket: string) => Promise<void>
  pairingId?: number
  pairingTicket?: string
  journal?: AgentRunEvent[]
}

function statusVariant(status: AgentBridgeStatus) {
  if (status === 'connected') return 'secondary'
  if (status === 'error') return 'destructive'
  return 'warning'
}

export function AgentBridgeCard({
  isDesktop,
  status,
  deviceName,
  onPair,
  onReconnect,
  onCreatePairing,
  onConfirmPairing,
  pairingId,
  pairingTicket,
  journal = [],
}: AgentBridgeCardProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [confirmationTicket, setConfirmationTicket] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedScript, setCopiedScript] = useState(false)
  const [copiedRestartCommand, setCopiedRestartCommand] = useState(false)
  let deviceStatusMessage = t(
    'Create a short-lived ticket, claim it on Radxa, then paste the confirmation ticket here.'
  )
  if (status === 'connected') {
    deviceStatusMessage = t(
      'The paired device is connected. Local tools are ready.'
    )
  } else if (deviceName && status !== 'connecting') {
    deviceStatusMessage = t(
      'This device is already paired. Run the command below on Radxa to restart its private service.'
    )
  }

  const action = async () => {
    const callback = status === 'connected' ? onReconnect : onPair
    if (!callback) return
    setBusy(true)
    try {
      await callback()
      toast.success(
        t(
          status === 'connected'
            ? 'Desktop bridge restarted.'
            : 'Desktop paired.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('Desktop pairing failed.')
      )
    } finally {
      setBusy(false)
    }
  }

  const createPairing = async () => {
    if (!onCreatePairing) return
    setBusy(true)
    try {
      await onCreatePairing()
      toast.success(t('Pairing ticket created.'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('Pairing failed.'))
    } finally {
      setBusy(false)
    }
  }

  const confirmPairing = async () => {
    if (!onConfirmPairing || !confirmationTicket.trim()) return
    setBusy(true)
    try {
      await onConfirmPairing(confirmationTicket)
      setConfirmationTicket('')
      toast.success(t('Desktop pairing confirmed.'))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('Pairing confirmation failed.')
      )
    } finally {
      setBusy(false)
    }
  }

  const copyPairingTicket = async () => {
    if (!pairingTicket) return
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard access is unavailable.')
      }
      await navigator.clipboard.writeText(pairingTicket)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('Could not copy pairing ticket.')
      )
    }
  }

  const copyPairingScript = async () => {
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard access is unavailable.')
      }
      await navigator.clipboard.writeText(
        createRadxaPairingScript(window.location.origin)
      )
      setCopiedScript(true)
      window.setTimeout(() => setCopiedScript(false), 1600)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('Could not copy Radxa installer command.')
      )
    }
  }

  const copyRestartCommand = async () => {
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard access is unavailable.')
      }
      await navigator.clipboard.writeText(
        'sudo systemctl restart "lain42-agent-companion@$(id -un).service"'
      )
      setCopiedRestartCommand(true)
      window.setTimeout(() => setCopiedRestartCommand(false), 1600)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('Could not copy restart command.')
      )
    }
  }

  let label = t('Desktop offline')
  if (status === 'connected') label = t('Connected')
  if (status === 'connecting') label = t('Connecting…')
  if (status === 'unavailable') label = t('Not paired')
  if (status === 'error') label = t('Connection error')
  let statusIcon = (
    <Link2 className='text-muted-foreground size-4' aria-hidden='true' />
  )
  if (isDesktop) {
    statusIcon = (
      <Laptop className='text-muted-foreground size-4' aria-hidden='true' />
    )
  }
  if (status === 'connected') {
    statusIcon = (
      <Check className='size-4 text-emerald-500' aria-hidden='true' />
    )
  }

  return (
    <Card size='sm'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <Cable className='text-primary size-4' />
          {t('CLI / Radxa bridge')}
        </CardTitle>
        <CardDescription className='text-xs leading-5'>
          {isDesktop
            ? t(
                'Pair this desktop so the web Agent can run your approved local tools.'
              )
            : t(
                'Use a paired desktop or headless Radxa node to run CLI actions from this browser or phone.'
              )}
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-3'>
        <div className='flex items-center gap-2'>
          {statusIcon}
          <Badge variant={statusVariant(status)}>{label}</Badge>
          {deviceName && (
            <span className='text-muted-foreground truncate text-xs'>
              {deviceName}
            </span>
          )}
        </div>
        {!isDesktop && journal.length > 0 && (
          <p className='text-muted-foreground text-xs leading-5'>
            {t(
              'Synced {{count}} bridge events. Incomplete tool calls are never replayed automatically.',
              {
                count: journal.length,
              }
            )}
          </p>
        )}
        {isDesktop ? (
          <Button
            disabled={busy || status === 'connecting'}
            onClick={() => void action()}
            size='sm'
            variant='outline'
          >
            {busy ? <RefreshCw className='animate-spin' /> : <ShieldCheck />}
            {status === 'connected'
              ? t('Reconnect desktop')
              : t('Pair this desktop')}
          </Button>
        ) : (
          <div className='grid gap-2'>
            <p className='text-muted-foreground text-xs leading-5'>
              {deviceStatusMessage}
            </p>
            {deviceName && status !== 'connected' && status !== 'connecting' && (
              <Button
                onClick={() => void copyRestartCommand()}
                size='sm'
                variant='outline'
              >
                {copiedRestartCommand ? <Check /> : <RefreshCw />}
                {copiedRestartCommand
                  ? t('Copied')
                  : t('Copy restart command')}
              </Button>
            )}
            {status !== 'connected' &&
              !deviceName &&
              onCreatePairing &&
              !pairingTicket && (
              <Button
                disabled={busy}
                onClick={() => void createPairing()}
                size='sm'
                variant='outline'
              >
                {busy ? <RefreshCw className='animate-spin' /> : <Link2 />}
                {t('Create Radxa pairing ticket')}
              </Button>
            )}
            {pairingTicket && (
              <div className='grid gap-2 rounded-lg border border-dashed p-2'>
                <span className='text-muted-foreground text-[11px]'>
                  {t(
                    'In the Radxa terminal, run the installer command. It downloads the prebuilt ARM64 companion, may ask for your sudo password, and starts a private service after you enter the short-lived ticket and confirm here.'
                  )}
                </span>
                <div className='flex items-center gap-1.5'>
                  <code className='bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-[10px]'>
                    {pairingTicket}
                  </code>
                  <Button
                    aria-label={t('Copy pairing ticket')}
                    onClick={() => void copyPairingTicket()}
                    size='icon-xs'
                    variant='ghost'
                  >
                    {copied ? (
                      <Check className='text-emerald-500' />
                    ) : (
                      <Clipboard />
                    )}
                  </Button>
                </div>
                <div className='flex flex-wrap items-center gap-2 text-[11px]'>
                  <span className='text-muted-foreground'>
                    {t('Pairing ID')}
                  </span>
                  <code className='bg-muted rounded px-1.5 py-0.5'>
                    {pairingId ?? '—'}
                  </code>
                  <Button
                    disabled={busy}
                    onClick={() => void copyPairingScript()}
                    size='sm'
                    variant='outline'
                  >
                    {copiedScript ? <Check /> : <Copy />}
                    {copiedScript
                      ? t('Copied')
                      : t('Copy Radxa installer command')}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void createPairing()}
                    size='sm'
                    variant='ghost'
                  >
                    <RefreshCw />
                    {t('Generate a new ticket')}
                  </Button>
                </div>
                <p className='text-muted-foreground text-[11px] leading-4'>
                  {t(
                    'Keep this terminal open until you confirm in the browser. The ticket is hidden while typing, and the device credential is never printed.'
                  )}
                </p>
                <a
                  className='text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline'
                  href='https://github.com/lilyco-42/new-api/blob/agent-ui/tauri/agent-companion/README.md'
                  rel='noreferrer'
                  target='_blank'
                >
                  {t('Radxa companion setup guide')}
                  <ExternalLink className='size-3' aria-hidden='true' />
                </a>
                <div className='flex gap-2'>
                  <input
                    aria-label={t('Confirmation ticket')}
                    className='bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-xs'
                    onChange={(event) =>
                      setConfirmationTicket(event.target.value)
                    }
                    placeholder={t('Paste confirmation ticket')}
                    value={confirmationTicket}
                  />
                  <Button
                    disabled={busy || !pairingId || !confirmationTicket.trim()}
                    onClick={() => void confirmPairing()}
                    size='sm'
                    variant='secondary'
                  >
                    {t('Confirm')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
