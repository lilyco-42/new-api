/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { Cable, Plug, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
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
import { Input } from '@/components/ui/input'

import type {
  McpConnectRequest,
  McpServerDescriptor,
  McpToolProviderController,
} from '../mcp-tool-provider'

type McpServersCardProps = {
  controller: McpToolProviderController
  isDesktop: boolean
  revision: number
  onChanged: () => void
  remoteServers?: McpServerDescriptor[]
  onRemoteRefresh?: () => Promise<McpServerDescriptor[]>
}

export function McpServersCard({
  controller,
  isDesktop,
  revision,
  onChanged,
  remoteServers,
  onRemoteRefresh,
}: McpServersCardProps) {
  const { t } = useTranslation()
  const [transport, setTransport] =
    useState<McpConnectRequest['transport']>('stdio')
  const [serverId, setServerId] = useState('local-tools')
  const [name, setName] = useState('Local tools')
  const [command, setCommand] = useState('npx')
  const [args, setArgs] = useState('@modelcontextprotocol/server-filesystem .')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [servers, setServers] = useState<McpServerDescriptor[]>([])

  useEffect(() => {
    setServers(remoteServers ?? controller.servers())
  }, [controller, remoteServers, revision])

  const refresh = async () => {
    setBusy(true)
    try {
      const next =
        !isDesktop && onRemoteRefresh
          ? await onRemoteRefresh()
          : await controller.refresh()
      setServers(next)
      onChanged()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('MCP refresh failed.')
      )
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    const request: McpConnectRequest = {
      server_id: serverId.trim(),
      name: name.trim(),
      transport,
      ...(transport === 'stdio'
        ? {
            command: command.trim(),
            args: args
              .split(/\r?\n|\s+/)
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {
            url: url.trim(),
            ...(token.trim() ? { bearer_token: token.trim() } : {}),
          }),
    }
    if (!request.server_id || !request.name) {
      toast.error(t('Enter an MCP server id and name.'))
      return
    }
    setBusy(true)
    try {
      const server = await controller.connect(request)
      setServers((current) => [
        ...current.filter((item) => item.server_id !== server.server_id),
        server,
      ])
      setToken('')
      onChanged()
      toast.success(t('MCP server connected.'))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('MCP connection failed.')
      )
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (serverIdToRemove: string) => {
    setBusy(true)
    try {
      await controller.disconnect(serverIdToRemove)
      setServers((current) =>
        current.filter((server) => server.server_id !== serverIdToRemove)
      )
      onChanged()
      toast.success(t('MCP server disconnected.'))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('MCP disconnect failed.')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card size='sm'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <Cable className='text-primary size-4' />
          {t('MCP servers')}
        </CardTitle>
        <CardDescription className='text-xs leading-5'>
          {isDesktop
            ? t(
                'Connect a user-selected stdio or HTTPS MCP server. Every call asks for exact parameter approval.'
              )
            : t(
                'MCP connections are configured in the Tauri desktop app or by the Radxa administrator. A paired browser can use the connected tools; headless nodes expose only their explicit local allowlist.'
              )}
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-3'>
        {isDesktop ? (
          <>
            <div className='grid grid-cols-2 gap-2'>
              <Input
                aria-label={t('MCP server id')}
                className='h-8 text-xs'
                onChange={(event) => setServerId(event.target.value)}
                placeholder={t('Server id')}
                value={serverId}
              />
              <Input
                aria-label={t('MCP server name')}
                className='h-8 text-xs'
                onChange={(event) => setName(event.target.value)}
                placeholder={t('Display name')}
                value={name}
              />
            </div>
            <select
              aria-label={t('MCP transport')}
              className='bg-background h-8 rounded-md border px-2 text-xs'
              onChange={(event) =>
                setTransport(
                  event.target.value as McpConnectRequest['transport']
                )
              }
              value={transport}
            >
              <option value='stdio'>{t('Local stdio process')}</option>
              <option value='streamable_http'>
                {t('HTTPS streamable MCP')}
              </option>
            </select>
            {transport === 'stdio' ? (
              <>
                <Input
                  aria-label={t('MCP command')}
                  className='h-8 text-xs'
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder='npx / uvx / executable'
                  value={command}
                />
                <textarea
                  aria-label={t('MCP command arguments')}
                  className='bg-background min-h-16 rounded-md border px-2 py-1.5 text-xs'
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder={t('Arguments separated by spaces or lines')}
                  value={args}
                />
              </>
            ) : (
              <>
                <Input
                  aria-label={t('MCP server URL')}
                  className='h-8 text-xs'
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder='https://example.com/mcp'
                  value={url}
                />
                <Input
                  aria-label={t('MCP bearer token')}
                  className='h-8 text-xs'
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={t('Optional bearer token; never shown again')}
                  type='password'
                  value={token}
                />
              </>
            )}
            <Button disabled={busy} onClick={() => void connect()} size='sm'>
              {busy ? <RefreshCw className='animate-spin' /> : <Plug />}
              {t('Connect MCP server')}
            </Button>
          </>
        ) : (
          <div className='text-muted-foreground rounded-lg border border-dashed p-3 text-xs leading-5'>
            {t(
              'Open the Lain42 desktop app to connect a local or HTTPS MCP server.'
            )}
          </div>
        )}
        <div className='flex items-center justify-between gap-2'>
          <span className='text-muted-foreground text-[10px] uppercase'>
            {t('Connected servers')}
          </span>
          <Button
            aria-label={t('Refresh MCP servers')}
            disabled={(!isDesktop && !onRemoteRefresh) || busy}
            onClick={() => void refresh()}
            size='icon-xs'
            variant='ghost'
          >
            <RefreshCw className='size-3.5' />
          </Button>
        </div>
        {servers.length === 0 ? (
          <span className='text-muted-foreground text-xs'>
            {t('No MCP servers connected.')}
          </span>
        ) : (
          <div className='grid gap-1.5'>
            {servers.map((server) => (
              <div
                className='bg-muted/20 flex items-center gap-2 rounded-lg border p-2'
                key={server.server_id}
              >
                <Server className='text-primary size-4 shrink-0' />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-xs font-medium'>
                    {server.name}
                  </span>
                  <span className='text-muted-foreground block text-[10px]'>
                    {server.transport} · {server.tools.length} {t('tools')}
                  </span>
                </span>
                <Badge className='h-5 px-1.5 text-[10px]' variant='secondary'>
                  {t('Connected')}
                </Badge>
                {isDesktop && (
                  <Button
                    aria-label={t('Disconnect MCP server')}
                    disabled={busy}
                    onClick={() => void disconnect(server.server_id)}
                    size='icon-xs'
                    variant='ghost'
                  >
                    <Trash2 className='size-3.5' />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
