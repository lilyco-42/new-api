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
import { Input } from '@/components/ui/input'

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

  const checkGh = async () => {
    const invoke = getInvoke()
    if (!invoke) {
      toast.info(
        t('GitHub CLI actions are available in the Tauri desktop app.')
      )
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
      toast.info(
        t('GitHub CLI actions are available in the Tauri desktop app.')
      )
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
      toast.info(
        t('GitHub CLI actions are available in the Tauri desktop app.')
      )
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
          {t('Your GitHub CLI')}
        </CardTitle>
        <CardDescription className='text-xs leading-5'>
          {t(
            'Use the local gh CLI and your own token. The Agent never receives the token.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-3'>
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
        {status && !status.authenticated && (
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
        <a
          className='text-primary inline-flex items-center gap-1 text-xs hover:underline'
          href='https://cli.github.com/manual/gh_auth_login'
          rel='noreferrer'
          target='_blank'
        >
          {t('How to connect your own GitHub token')}
          <ExternalLink className='size-3' />
        </a>
      </CardContent>
    </Card>
  )
}
