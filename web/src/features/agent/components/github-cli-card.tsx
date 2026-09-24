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
import { Check, Clipboard, ExternalLink, GitBranch, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { createOAuthFlow } from '@/features/auth/api'
import { OAUTH_BIND_RESULT_MESSAGE } from '@/features/auth/constants'
import {
  OAUTH_BIND_REQUEST_TIMEOUT_MS,
  OAUTH_BIND_FLOW_DEADLINE_MS,
  OAUTH_BIND_RESULT_CHANNEL,
  parseOAuthBindResultBroadcast,
  startOAuthBindResponseDeadline,
  watchOAuthPopupClosed,
} from '@/features/auth/lib/oauth-bind-window'
import {
  getOAuthSessionStorage,
  markOAuthBindPopup,
} from '@/features/auth/lib/oauth-callback-mode'
import { api } from '@/lib/api'

import { parseGitHubOAuthBindCallback } from '../lib/github-oauth-bind'

type GhAuthStatus = {
  profile_id: string
  gh_config_dir: string
  installed: boolean
  authenticated: boolean
  account?: string
  message: string
  login_command_windows: string
  login_command_unix: string
}

type GhRepository = {
  full_name?: string
  html_url?: string
  stargazers_count?: number
  description?: string | null
}

type GhActivity = {
  number?: number
  title?: string
  url?: string
  state?: string
  updatedAt?: string
}

type BrowserGitHubStatus = {
  enabled: boolean
  connected: boolean
  login?: string
  scope?: string[]
  client_id?: string
}

type PendingGitHubOAuth = {
  popup: Window
  state: string
  wasConnectedBefore: boolean
  handlingCallback: boolean
  stopCloseWatcher: () => void
  stopResponseDeadline: () => void
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

function getInvoke() {
  if (typeof window === 'undefined') return null
  return (window as TauriWindow).__TAURI__?.core?.invoke ?? null
}

function isGhStatus(value: unknown): value is GhAuthStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<GhAuthStatus>
  return (
    typeof status.installed === 'boolean' &&
    typeof status.authenticated === 'boolean' &&
    typeof status.message === 'string' &&
    typeof status.login_command_windows === 'string' &&
    typeof status.login_command_unix === 'string'
  )
}

function readRepositories(value: unknown): GhRepository[] {
  if (!value || typeof value !== 'object') return []
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items.filter(
    (item): item is GhRepository =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as GhRepository).full_name === 'string'
  )
}

function readActivity(value: unknown): GhActivity[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is GhActivity =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as GhActivity).title === 'string'
  )
}

export function GithubCliCard() {
  const { t } = useTranslation()
  const hasLocalGhRuntime = Boolean(getInvoke())
  const [status, setStatus] = useState<GhAuthStatus | null>(null)
  const [query, setQuery] = useState('rust ai')
  const [repo, setRepo] = useState('')
  const [repositories, setRepositories] = useState<GhRepository[]>([])
  const [activity, setActivity] = useState<GhActivity[]>([])
  const [activityKind, setActivityKind] = useState<
    'issues' | 'pull requests' | null
  >(null)
  const [checking, setChecking] = useState(false)
  const [searching, setSearching] = useState(false)
  const [copied, setCopied] = useState(false)
  const [browserStatus, setBrowserStatus] =
    useState<BrowserGitHubStatus | null>(null)
  const [browserStatusLoading, setBrowserStatusLoading] = useState(true)
  const [connectingBrowser, setConnectingBrowser] = useState(false)
  const pendingGitHubOAuth = useRef<PendingGitHubOAuth | null>(null)

  const loadBrowserStatus = useCallback(async () => {
    const response = await api.get('/api/agent/github/status', {
      timeout: 15_000,
      disableDuplicate: true,
      skipErrorHandler: true,
    })
    const value = response.data?.data
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as BrowserGitHubStatus).enabled !== 'boolean' ||
      typeof (value as BrowserGitHubStatus).connected !== 'boolean'
    ) {
      throw new Error(response.data?.message || t('GitHub OAuth failed.'))
    }
    const nextStatus = value as BrowserGitHubStatus
    setBrowserStatus(nextStatus)
    return nextStatus
  }, [t])

  const refreshBrowserStatus = useCallback(async () => {
    setBrowserStatusLoading(true)
    try {
      return await loadBrowserStatus()
    } catch {
      // Status refresh is best-effort outside an explicit connect attempt.
      return null
    } finally {
      setBrowserStatusLoading(false)
    }
  }, [loadBrowserStatus])

  useEffect(() => {
    void refreshBrowserStatus()
  }, [refreshBrowserStatus])

  const clearPendingGitHubOAuth = useCallback(
    (expected?: PendingGitHubOAuth) => {
      const pending = pendingGitHubOAuth.current
      if (!pending || (expected && pending !== expected)) return
      pending.stopCloseWatcher()
      pending.stopResponseDeadline()
      pendingGitHubOAuth.current = null
    },
    []
  )

  useEffect(() => {
    const handleOAuthCallback = async (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return
      const pending = pendingGitHubOAuth.current
      if (!pending || pending.handlingCallback) return
      const message = parseGitHubOAuthBindCallback(
        event.data,
        pending.state,
        event.source,
        pending.popup
      )
      if (!message) return

      pending.handlingCallback = true
      let success = false
      let resultMessage = t('GitHub OAuth failed.')
      try {
        const params: Record<string, string> = { state: pending.state }
        if (typeof message.code === 'string') params.code = message.code
        if (typeof message.error === 'string') params.error = message.error
        if (typeof message.errorDescription === 'string') {
          params.error_description = message.errorDescription
        }
        const response = await api.get('/api/oauth/github', {
          params,
          timeout: OAUTH_BIND_REQUEST_TIMEOUT_MS,
          skipBusinessError: true,
          skipErrorHandler: true,
        })
        success = Boolean(response.data?.success)
        resultMessage = response.data?.message || resultMessage
        if (success) {
          toast.success(t('Binding successful!'))
          setBrowserStatus((previous) =>
            previous ? { ...previous, connected: true } : previous
          )
          void refreshBrowserStatus().then((nextStatus) => {
            if (!nextStatus) {
              setBrowserStatus((previous) =>
                previous ? { ...previous, connected: true } : previous
              )
            }
          })
        } else {
          toast.error(resultMessage)
        }
      } catch (error: unknown) {
        resultMessage =
          (error as { response?: { data?: { message?: string } } }).response
            ?.data?.message ||
          (error instanceof Error ? error.message : resultMessage)
        const recoveredStatus = pending.wasConnectedBefore
          ? null
          : await refreshBrowserStatus()
        if (recoveredStatus?.connected) {
          success = true
          resultMessage = t('Binding successful!')
          toast.success(resultMessage)
        } else {
          toast.error(resultMessage)
        }
      } finally {
        clearPendingGitHubOAuth(pending)
        setConnectingBrowser(false)
        if (!pending.popup.closed) {
          pending.popup.postMessage(
            {
              type: OAUTH_BIND_RESULT_MESSAGE,
              provider: 'github',
              state: pending.state,
              success,
              message: resultMessage,
            },
            window.location.origin
          )
        }
      }
    }

    window.addEventListener('message', handleOAuthCallback)
    return () => window.removeEventListener('message', handleOAuthCallback)
  }, [clearPendingGitHubOAuth, refreshBrowserStatus, t])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(OAUTH_BIND_RESULT_CHANNEL)
    const handleBroadcast = (event: MessageEvent<unknown>) => {
      const pending = pendingGitHubOAuth.current
      if (!pending || pending.handlingCallback) return
      const result = parseOAuthBindResultBroadcast(
        event.data,
        'github',
        pending.state
      )
      if (!result) return

      pending.handlingCallback = true
      clearPendingGitHubOAuth(pending)
      setConnectingBrowser(false)
      if (result.success) {
        toast.success(t('Binding successful!'))
        void refreshBrowserStatus().then((nextStatus) => {
          if (!nextStatus) {
            setBrowserStatus((previous) =>
              previous ? { ...previous, connected: true } : previous
            )
          }
        })
      } else {
        void refreshBrowserStatus().then((nextStatus) => {
          if (!pending.wasConnectedBefore && nextStatus?.connected) {
            toast.success(t('Binding successful!'))
            return
          }
          toast.error(t('GitHub OAuth failed.'))
        })
      }
      if (!pending.popup.closed) pending.popup.close()
    }
    channel.addEventListener('message', handleBroadcast)
    return () => {
      channel.removeEventListener('message', handleBroadcast)
      channel.close()
    }
  }, [clearPendingGitHubOAuth, refreshBrowserStatus, t])

  useEffect(
    () => () => {
      const pending = pendingGitHubOAuth.current
      clearPendingGitHubOAuth(pending ?? undefined)
      if (pending && !pending.popup.closed) pending.popup.close()
    },
    [clearPendingGitHubOAuth]
  )

  const connectBrowserGitHub = async () => {
    let popup: Window | null = null
    setConnectingBrowser(true)
    try {
      // Open synchronously while the click still has user activation. If we
      // await a status request first, browsers may block the later popup.
      popup = window.open('', '_blank', 'width=520,height=720')
      if (!popup) throw new Error(t('OAuth pop-up was blocked'))

      let status: BrowserGitHubStatus | null
      try {
        status = await loadBrowserStatus()
      } catch (error) {
        const requestError = error as {
          isAxiosError?: boolean
          response?: { status?: unknown }
        }
        if (typeof requestError.response?.status === 'number') {
          throw new Error(
            t('Could not check GitHub OAuth status (HTTP {{status}}).', {
              status: requestError.response.status,
            })
          )
        }
        if (requestError.isAxiosError) {
          throw new Error(
            t('Could not check GitHub OAuth status. Please retry.')
          )
        }
        throw error
      }
      if (!status?.enabled || !status.client_id) {
        throw new Error(
          t(
            'GitHub OAuth is not configured. Set a Client ID and Secret in System settings → Authentication → OAuth, enable it, and register the callback URL shown there.'
          )
        )
      }
      if (status.connected) {
        setBrowserStatus(status)
        popup.close()
        setConnectingBrowser(false)
        return
      }
      const state = await createOAuthFlow('github', 'bind')
      if (!markOAuthBindPopup(getOAuthSessionStorage(popup), 'github', state)) {
        popup.close()
        throw new Error(t('OAuth pop-up storage is unavailable'))
      }
      const pending: PendingGitHubOAuth = {
        popup,
        state,
        wasConnectedBefore: Boolean(status.connected),
        handlingCallback: false,
        stopCloseWatcher: () => undefined,
        stopResponseDeadline: () => undefined,
      }
      pending.stopCloseWatcher = watchOAuthPopupClosed(popup, () => {
        clearPendingGitHubOAuth(pending)
        setConnectingBrowser(false)
        void refreshBrowserStatus().then((nextStatus) => {
          if (!pending.wasConnectedBefore && nextStatus?.connected) {
            toast.success(t('Binding successful!'))
          }
        })
      })
      pending.stopResponseDeadline = startOAuthBindResponseDeadline(() => {
        clearPendingGitHubOAuth(pending)
        setConnectingBrowser(false)
        toast.error(t('GitHub OAuth failed.'))
        void refreshBrowserStatus()
      }, OAUTH_BIND_FLOW_DEADLINE_MS)
      pendingGitHubOAuth.current = pending
      const authorization = new URL('https://github.com/login/oauth/authorize')
      authorization.searchParams.set('client_id', status.client_id)
      authorization.searchParams.set('state', state)
      authorization.searchParams.set('scope', 'repo read:user user:email')
      popup.location.replace(authorization.toString())
    } catch (error) {
      clearPendingGitHubOAuth()
      if (popup && !popup.closed) popup.close()
      setConnectingBrowser(false)
      toast.error(
        error instanceof Error ? error.message : t('GitHub OAuth failed.')
      )
    }
  }

  let connectButtonLabel = t('Connect GitHub in browser')
  if (browserStatusLoading) connectButtonLabel = t('Checking…')
  if (connectingBrowser) connectButtonLabel = t('Waiting for GitHub…')

  const disconnectBrowserGitHub = async () => {
    try {
      await api.delete('/api/agent/github/authorization', {
        skipErrorHandler: true,
      })
      setBrowserStatus((previous) =>
        previous
          ? { ...previous, connected: false, login: undefined }
          : previous
      )
      toast.success(t('GitHub authorization removed.'))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('GitHub disconnect failed.')
      )
    }
  }

  const checkGh = async () => {
    const invoke = getInvoke()
    if (!invoke) {
      await refreshBrowserStatus()
      return
    }
    setChecking(true)
    try {
      const result = await invoke('gh_auth_status')
      if (isGhStatus(result)) setStatus(result)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('GitHub CLI check failed.')
      )
    } finally {
      setChecking(false)
    }
  }

  const searchGithub = async () => {
    const invoke = getInvoke()
    if (!invoke) {
      if (!query.trim()) return
      setSearching(true)
      try {
        const response = await api.get(
          '/api/agent/github/repositories/search',
          {
            params: { q: query.trim(), limit: 6 },
            skipErrorHandler: true,
          }
        )
        setRepositories(response.data?.data?.items ?? [])
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t('GitHub search failed.')
        )
      } finally {
        setSearching(false)
      }
      return
    }
    if (!query.trim()) return
    setSearching(true)
    try {
      const result = await invoke('gh_search_repositories', {
        query: query.trim(),
        limit: 6,
      })
      setRepositories(readRepositories(result))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('GitHub search failed.')
      )
    } finally {
      setSearching(false)
    }
  }

  const copyLoginCommand = async () => {
    const command = navigator.platform.toLowerCase().includes('win')
      ? status?.login_command_windows
      : status?.login_command_unix
    if (command) await navigator.clipboard?.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const getStatusLabel = () => {
    if (!status) return null
    if (status.authenticated) {
      return t('Connected{{account}}', {
        account: status.account ? ` · ${status.account}` : '',
      })
    }
    if (status.installed) return t('Not connected')
    return t('gh not installed')
  }

  const loadActivity = async (kind: 'issues' | 'pull requests') => {
    const invoke = getInvoke()
    if (!invoke) {
      if (!repo.includes('/')) {
        toast.error(t('Enter a repository such as owner/name first.'))
        return
      }
      try {
        const path =
          kind === 'issues'
            ? '/api/agent/github/issues'
            : '/api/agent/github/pull-requests'
        const response = await api.get(path, {
          params: {
            repo: repo.trim(),
            limit: 6,
            state: 'open',
            sort: 'updated',
          },
          skipErrorHandler: true,
        })
        setActivity(response.data?.data?.items ?? [])
        setActivityKind(kind)
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('GitHub activity load failed.')
        )
      }
      return
    }
    if (!repo.includes('/')) {
      toast.error(t('Enter a repository such as owner/name first.'))
      return
    }
    try {
      const command =
        kind === 'issues' ? 'gh_list_issues' : 'gh_list_pull_requests'
      const result = await invoke(command, {
        repo: repo.trim(),
        limit: 6,
      })
      setActivity(readActivity(result))
      setActivityKind(kind)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('GitHub activity load failed.')
      )
    }
  }

  return (
    <Card size='sm'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <GitBranch className='text-primary size-4' />
          {t('GitHub access')}
        </CardTitle>
        <CardDescription className='text-xs leading-5'>
          {t(
            'Connect GitHub in the browser with OAuth, or use the local gh CLI. The Agent never receives either token.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-3'>
        <div className='flex flex-wrap items-center gap-2'>
          {!browserStatus?.connected && (
            <Button
              disabled={connectingBrowser || browserStatusLoading}
              onClick={() => void connectBrowserGitHub()}
              size='sm'
              variant='default'
            >
              {connectButtonLabel}
            </Button>
          )}
          {browserStatus?.connected && (
            <Badge variant='secondary'>
              {t('OAuth connected{{account}}', {
                account: browserStatus.login ? ` · ${browserStatus.login}` : '',
              })}
            </Badge>
          )}
          {browserStatus?.connected && (
            <Button
              onClick={() => void disconnectBrowserGitHub()}
              size='sm'
              variant='ghost'
            >
              {t('Disconnect')}
            </Button>
          )}
        </div>
        {hasLocalGhRuntime && (
          <div className='flex items-center gap-2'>
            <Button
              disabled={checking}
              onClick={checkGh}
              size='sm'
              variant='outline'
            >
              {checking ? t('Checking…') : t('Check gh login')}
            </Button>
            {status && (
              <Badge variant={status.authenticated ? 'secondary' : 'warning'}>
                {getStatusLabel()}
              </Badge>
            )}
          </div>
        )}
        {hasLocalGhRuntime && status && !status.authenticated && (
          <div className='bg-muted/30 grid gap-2 rounded-lg p-2 text-xs'>
            <span className='text-muted-foreground'>{t(status.message)}</span>
            <div className='flex items-center gap-2'>
              <code className='bg-background flex-1 truncate rounded px-2 py-1 text-[10px]'>
                {navigator.platform.toLowerCase().includes('win')
                  ? status.login_command_windows
                  : status.login_command_unix}
              </code>
              <Button
                aria-label={t('Copy gh login command')}
                onClick={copyLoginCommand}
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
            <span className='text-muted-foreground truncate text-[10px]'>
              {t('Profile directory')}: {status.gh_config_dir}
            </span>
          </div>
        )}
        <div className='flex gap-2'>
          <Input
            aria-label={t('GitHub search')}
            className='h-8 text-xs'
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void searchGithub()
            }}
            placeholder={t('Search repositories')}
            value={query}
          />
          <Button
            disabled={searching}
            onClick={searchGithub}
            size='icon-sm'
            variant='secondary'
          >
            <Search />
          </Button>
        </div>
        <div className='grid gap-2'>
          <Input
            aria-label={t('Repository for issues and pull requests')}
            className='h-8 text-xs'
            onChange={(event) => setRepo(event.target.value)}
            placeholder={t('owner/name')}
            value={repo}
          />
          <div className='grid grid-cols-2 gap-2'>
            <Button
              onClick={() => void loadActivity('issues')}
              size='sm'
              variant='outline'
            >
              {t('Issues')}
            </Button>
            <Button
              onClick={() => void loadActivity('pull requests')}
              size='sm'
              variant='outline'
            >
              {t('Pull Requests')}
            </Button>
          </div>
        </div>
        {repositories.length > 0 && (
          <div className='grid gap-1.5'>
            {repositories.map((repository) => (
              <a
                className='hover:bg-muted/50 flex items-start gap-2 rounded-md p-1.5 text-xs'
                href={repository.html_url}
                key={repository.full_name}
                rel='noreferrer'
                target='_blank'
              >
                <GitBranch className='mt-0.5 size-3 shrink-0' />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate font-medium'>
                    {repository.full_name}
                  </span>
                  <span className='text-muted-foreground block truncate'>
                    ★ {repository.stargazers_count ?? 0} ·{' '}
                    {repository.description || t('No description')}
                  </span>
                </span>
                <ExternalLink className='text-muted-foreground size-3 shrink-0' />
              </a>
            ))}
          </div>
        )}
        {activityKind && (
          <div className='grid gap-1.5'>
            <span className='text-muted-foreground text-[10px] uppercase'>
              {t(activityKind)} · {repo}
            </span>
            {activity.length === 0 && (
              <span className='text-muted-foreground text-xs'>
                {t('No records found')}
              </span>
            )}
            {activity.map((item) => (
              <a
                className='hover:bg-muted/50 flex items-center gap-2 rounded-md p-1.5 text-xs'
                href={item.url}
                key={`${item.number}-${item.url}`}
                rel='noreferrer'
                target='_blank'
              >
                <span className='text-muted-foreground shrink-0'>
                  #{item.number}
                </span>
                <span className='min-w-0 flex-1 truncate'>{item.title}</span>
                <span className='text-muted-foreground shrink-0'>
                  {item.state}
                </span>
              </a>
            ))}
          </div>
        )}
        {hasLocalGhRuntime && (
          <a
            className='text-primary inline-flex items-center gap-1 text-xs hover:underline'
            href='https://cli.github.com/manual/gh_auth_login'
            rel='noreferrer'
            target='_blank'
          >
            {t('How to connect your own GitHub token')}
            <ExternalLink className='size-3' />
          </a>
        )}
      </CardContent>
    </Card>
  )
}
