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

import type { AgentBridgeStatus } from '../agent-bridge'

type AgentBridgeCardProps = {
  isDesktop: boolean
  status: AgentBridgeStatus
  deviceName?: string
  onPair?: () => Promise<void>
  onReconnect?: () => Promise<void>
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
}: AgentBridgeCardProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

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
          {t('CLI desktop bridge')}
        </CardTitle>
        <CardDescription className='text-xs leading-5'>
          {isDesktop
            ? t(
                'Pair this desktop so the web Agent can run your approved local tools.'
              )
            : t(
                'Use a paired desktop to run GitHub CLI actions from this browser or phone.'
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
          <p className='text-muted-foreground text-xs leading-5'>
            {status === 'connected'
              ? t('GitHub tools from this device are ready for the Agent.')
              : t(
                  'Open the Lain42 desktop app, sign in, and pair it before asking for local CLI work.'
                )}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
