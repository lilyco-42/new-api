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
  Bot,
  Check,
  Clock3,
  Download,
  ExternalLink,
  GitBranch,
  LockKeyhole,
  Mail,
  MessageCircle,
  Send,
  ShieldCheck,
  Workflow,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
import { Switch } from '@/components/ui/switch'

type ProviderId = 'github' | 'email' | 'telegram' | 'qq' | 'wechat'
type ExportFormat = 'json' | 'csv' | 'markdown'

type IntegrationSettings = {
  sources: Record<ProviderId, boolean>
  format: ExportFormat
  autoReply: boolean
  requireApproval: boolean
  dailyLimit: number
}

type Provider = {
  id: ProviderId
  name: string
  description: string
  method: string
  icon: typeof GitBranch
  available: boolean
  docsUrl?: string
}

const STORAGE_KEY = 'lain42.integrations.settings'

const PROVIDERS: Provider[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: '读取你授权的仓库、Issue、Pull Request 与讨论记录。',
    method: 'OAuth / Fine-grained token',
    icon: GitBranch,
    available: true,
    docsUrl: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps',
  },
  {
    id: 'email',
    name: 'Email',
    description: '按文件夹或标签导出邮件，并用模板生成待审核回复。',
    method: 'OAuth / IMAP + SMTP',
    icon: Mail,
    available: true,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: '通过官方 Bot API 收取消息并发送自动回复。',
    method: 'Bot API',
    icon: Send,
    available: true,
    docsUrl: 'https://core.telegram.org/bots/api',
  },
  {
    id: 'qq',
    name: 'QQ',
    description: '企业或机器人接口可接入；个人账号不读取 Cookie。',
    method: '官方机器人 / Webhook',
    icon: MessageCircle,
    available: false,
  },
  {
    id: 'wechat',
    name: '微信',
    description: '支持公众号、企业微信等官方接口；不做个人号抓取。',
    method: '公众号 / 企业微信 API',
    icon: MessageCircle,
    available: false,
  },
]

const DEFAULT_SETTINGS: IntegrationSettings = {
  sources: {
    github: true,
    email: true,
    telegram: false,
    qq: false,
    wechat: false,
  },
  format: 'json',
  autoReply: false,
  requireApproval: true,
  dailyLimit: 20,
}

function readSettings(): IntegrationSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) || '{}'
    ) as Partial<IntegrationSettings>
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      sources: { ...DEFAULT_SETTINGS.sources, ...stored.sources },
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function IntegrationsWorkspace() {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<IntegrationSettings>(readSettings)
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(
    null
  )

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const selected = useMemo(
    () => PROVIDERS.find((provider) => provider.id === selectedProvider),
    [selectedProvider]
  )

  const updateSettings = <K extends keyof IntegrationSettings>(
    key: K,
    value: IntegrationSettings[K]
  ) => {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  const toggleSource = (provider: ProviderId) => {
    setSettings((current) => ({
      ...current,
      sources: {
        ...current.sources,
        [provider]: !current.sources[provider],
      },
    }))
  }

  const startConnection = (provider: Provider) => {
    setSelectedProvider(provider.id)
    if (!provider.available) {
      toast.info(
        t('This connector requires an official business or bot API first.')
      )
      return
    }
    toast.info(
      t('The connector is ready for server-side OAuth or API configuration.')
    )
  }

  const exportPlan = () => {
    const selectedSources = PROVIDERS.filter(
      (provider) => settings.sources[provider.id]
    ).map((provider) => provider.name)
    if (selectedSources.length === 0) {
      toast.error(t('Select at least one source before exporting.'))
      return
    }
    toast.success(
      t('Export plan saved: {{sources}} as {{format}}.', {
        sources: selectedSources.join(', '),
        format: settings.format.toUpperCase(),
      })
    )
  }

  return (
    <MainContent>
      <header className='border-border/60 bg-background/95 sticky top-0 z-10 border-b px-4 py-4 backdrop-blur md:px-6'>
        <div className='mx-auto flex w-full max-w-6xl items-center justify-between gap-3'>
          <div>
            <div className='flex items-center gap-2'>
              <Workflow className='text-primary size-5' />
              <h1 className='text-lg font-semibold'>{t('Connections')}</h1>
            </div>
            <p className='text-muted-foreground mt-1 text-sm'>
              {t(
                'Connect approved accounts, export records, and prepare replies with a review gate.'
              )}
            </p>
          </div>
          <Badge variant='outline' className='hidden gap-1 sm:inline-flex'>
            <LockKeyhole className='size-3' />
            {t('Server-side credentials')}
          </Badge>
        </div>
      </header>

      <div className='mx-auto grid w-full max-w-6xl gap-5 overflow-y-auto p-4 md:p-6'>
        <Card className='border-primary/20 bg-primary/[0.03]'>
          <CardContent className='grid gap-3 p-4 md:grid-cols-[auto_1fr_auto] md:items-center'>
            <div className='bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl'>
              <ShieldCheck className='size-5' />
            </div>
            <div>
              <p className='font-medium'>{t('Safe by default')}</p>
              <p className='text-muted-foreground mt-1 text-sm leading-5'>
                {t(
                  'Only official OAuth, Bot API, IMAP or webhook integrations are supported. Personal-account cookie scraping is not enabled.'
                )}
              </p>
            </div>
            <Badge variant='secondary' className='w-fit'>
              {t('Human approval before sending')}
            </Badge>
          </CardContent>
        </Card>

        <section className='grid gap-4'>
          <div>
            <h2 className='text-base font-semibold'>{t('Available connectors')}</h2>
            <p className='text-muted-foreground mt-1 text-sm'>
              {t('Choose the sources that the Agent may read or export.')}
            </p>
          </div>
          <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
            {PROVIDERS.map((provider) => {
              const Icon = provider.icon
              const enabled = settings.sources[provider.id]

              return (
                <Card key={provider.id} size='sm' className='h-full'>
                  <CardHeader>
                    <div className='flex items-start justify-between gap-3'>
                      <div className='flex items-center gap-2'>
                        <div className='bg-muted flex size-8 items-center justify-center rounded-lg'>
                          <Icon className='size-4' />
                        </div>
                        <CardTitle>{t(provider.name)}</CardTitle>
                      </div>
                      <Badge variant={provider.available ? 'outline' : 'warning'}>
                        {provider.available ? t('Ready') : t('Official API required')}
                      </Badge>
                    </div>
                    <CardDescription className='leading-5'>
                      {t(provider.description)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className='flex flex-1 flex-col gap-3'>
                    <div className='text-muted-foreground text-xs'>
                      {t('Method')}: {t(provider.method)}
                    </div>
                    <div className='mt-auto flex items-center gap-2'>
                      <Button
                        className='flex-1'
                        onClick={() => startConnection(provider)}
                        size='sm'
                        variant={enabled ? 'secondary' : 'outline'}
                      >
                        {enabled && <Check className='text-emerald-500' />}
                        {enabled ? t('Configured') : t('Configure')}
                      </Button>
                      <Switch
                        aria-label={t('Enable {{provider}}', {
                          provider: provider.name,
                        })}
                        checked={enabled}
                        disabled={!provider.available}
                        onCheckedChange={() => toggleSource(provider.id)}
                      />
                    </div>
                    {provider.docsUrl && (
                      <a
                        className='text-primary inline-flex items-center gap-1 text-xs hover:underline'
                        href={provider.docsUrl}
                        rel='noreferrer'
                        target='_blank'
                      >
                        {t('Official API documentation')}
                        <ExternalLink className='size-3' />
                      </a>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>

        {selected && (
          <Card className='border-dashed'>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Bot className='text-primary size-4' />
                {t('Next step for {{provider}}', { provider: selected.name })}
              </CardTitle>
              <CardDescription>
                {t(
                  'Credentials should be stored on the server and limited to the smallest required scope. The desktop app never reads browser cookies.'
                )}
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        <section className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Download className='text-primary size-4' />
                {t('Record export')}
              </CardTitle>
              <CardDescription>
                {t('Prepare a local export plan without sending any message.')}
              </CardDescription>
            </CardHeader>
            <CardContent className='grid gap-4'>
              <label className='grid gap-1.5 text-sm'>
                <span className='font-medium'>{t('Format')}</span>
                <select
                  className='border-input bg-background h-9 rounded-lg border px-2 text-sm'
                  onChange={(event) =>
                    updateSettings('format', event.target.value as ExportFormat)
                  }
                  value={settings.format}
                >
                  <option value='json'>JSON</option>
                  <option value='csv'>CSV</option>
                  <option value='markdown'>Markdown</option>
                </select>
              </label>
              <div className='grid gap-2 sm:grid-cols-2'>
                {PROVIDERS.map((provider) => (
                  <label
                    className='text-muted-foreground flex items-center gap-2 text-sm'
                    key={provider.id}
                  >
                    <input
                      checked={settings.sources[provider.id]}
                      className='accent-primary size-4'
                      disabled={!provider.available}
                      onChange={() => toggleSource(provider.id)}
                      type='checkbox'
                    />
                    {provider.name}
                  </label>
                ))}
              </div>
              <Button onClick={exportPlan} size='sm'>
                <Download />
                {t('Save export plan')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Clock3 className='text-primary size-4' />
                {t('Reply automation')}
              </CardTitle>
              <CardDescription>
                {t('Keep automatic replies off until a provider and template are reviewed.')}
              </CardDescription>
            </CardHeader>
            <CardContent className='grid gap-4'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='text-sm font-medium'>{t('Enable auto-reply')}</p>
                  <p className='text-muted-foreground text-xs'>
                    {t('Draft replies from the Agent for selected sources.')}
                  </p>
                </div>
                <Switch
                  checked={settings.autoReply}
                  onCheckedChange={(checked) =>
                    updateSettings('autoReply', checked)
                  }
                />
              </div>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='text-sm font-medium'>{t('Require approval')}</p>
                  <p className='text-muted-foreground text-xs'>
                    {t('A person must approve each reply before it is sent.')}
                  </p>
                </div>
                <Switch
                  checked={settings.requireApproval}
                  onCheckedChange={(checked) =>
                    updateSettings('requireApproval', checked)
                  }
                />
              </div>
              <label className='grid gap-1.5 text-sm'>
                <span className='font-medium'>{t('Daily reply limit')}</span>
                <Input
                  min={1}
                  max={1000}
                  onChange={(event) =>
                    updateSettings(
                      'dailyLimit',
                      Math.max(1, Math.min(1000, Number(event.target.value) || 1))
                    )
                  }
                  type='number'
                  value={settings.dailyLimit}
                />
              </label>
            </CardContent>
          </Card>
        </section>
      </div>
    </MainContent>
  )
}

function MainContent(props: React.HTMLAttributes<HTMLElement>) {
  return (
    <main
      {...props}
      className={`flex min-h-0 flex-1 flex-col overflow-hidden ${props.className ?? ''}`}
    />
  )
}
