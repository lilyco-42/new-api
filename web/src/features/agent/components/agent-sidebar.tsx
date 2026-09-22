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
  Bell,
  CalendarClock,
  ChevronDown,
  Compass,
  ExternalLink,
  Image as ImageIcon,
  MoreHorizontal,
  MessageSquarePlus,
  Puzzle,
  Search,
  Sparkles,
  type LucideIcon,
  Wrench,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

export type AgentPreset = {
  id: string
  title: string
  description: string
  prompt: string
  icon: LucideIcon
  tone: string
}

type RecentAgentChat = {
  key: string
  presetId: string
  chatId: number
  preview: string
  updatedAt: number
}

type AgentSidebarProps = {
  presets: AgentPreset[]
  activePresetId: string
  className?: string
  onNewChat: () => void
  onSearchChats: () => void
  onOpenTools: (view?: 'tools' | 'files' | 'preview') => void
  onSelectChat: (presetId: string, chatId: number) => void
  onPresetChange: (preset: AgentPreset) => void
}

function readRecentAgentChats(): RecentAgentChat[] {
  if (typeof window === 'undefined') return []

  const results: RecentAgentChat[] = []
  const namespacePattern = /^agent-([a-z-]+)-chat-(\d+):playground_messages$/
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const storageKey = window.localStorage.key(index)
    const match = storageKey?.match(namespacePattern)
    if (!storageKey || !match) continue

    try {
      const parsed = JSON.parse(
        window.localStorage.getItem(storageKey) ?? ''
      ) as {
        data?: Array<{
          from?: string
          createdAt?: number
          versions?: Array<{ content?: string }>
        }>
      }
      const messages = Array.isArray(parsed.data) ? parsed.data : []
      const latest = [...messages]
        .reverse()
        .find(
          (message) =>
            (message.from === 'user' || message.from === 'assistant') &&
            Boolean(message.versions?.at(-1)?.content?.trim())
        )
      const preview = latest?.versions?.at(-1)?.content?.trim()
      if (!preview) continue
      results.push({
        key: storageKey,
        presetId: match[1],
        chatId: Number(match[2]),
        preview: preview.slice(0, 72),
        updatedAt: latest?.createdAt ?? 0,
      })
    } catch {
      // Ignore malformed or stale local conversation data.
    }
  }

  return results
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8)
}

export function AgentSidebar({
  presets,
  activePresetId,
  className,
  onNewChat,
  onSearchChats,
  onOpenTools,
  onSelectChat,
  onPresetChange,
}: AgentSidebarProps) {
  const { t } = useTranslation()
  const [recentChats, setRecentChats] = useState<RecentAgentChat[]>([])
  const accountName = useAuthStore(
    (state) =>
      state.auth.user?.display_name || state.auth.user?.username || 'Lain42'
  )
  const accountInitials = accountName.slice(0, 2).toUpperCase()

  useEffect(() => {
    const refresh = () => setRecentChats(readRecentAgentChats())
    refresh()
    window.addEventListener('lain42:agent-chat-updated', refresh)
    return () =>
      window.removeEventListener('lain42:agent-chat-updated', refresh)
  }, [])

  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground flex min-h-0 w-[min(21rem,22vw)] shrink-0 flex-col border-r',
        className
      )}
    >
      <div className='flex h-14 shrink-0 items-center justify-between px-3'>
        <Button
          aria-label={t('Workspace menu')}
          className='h-9 min-w-0 justify-start gap-2 rounded-lg px-2 text-sm font-semibold'
          onClick={() => onOpenTools('tools')}
          type='button'
          variant='ghost'
        >
          <div className='bg-primary/15 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg'>
            <Sparkles className='size-3.5' aria-hidden='true' />
          </div>
          <span className='truncate text-sm font-semibold'>Lain42 Agent</span>
          <ChevronDown
            className='text-sidebar-foreground/50 size-3.5 shrink-0'
            aria-hidden='true'
          />
        </Button>
        <div className='flex shrink-0 items-center gap-0.5'>
          <Button
            aria-label={t('Search')}
            className='text-sidebar-foreground/60 hover:text-sidebar-foreground'
            onClick={onSearchChats}
            size='icon-sm'
            type='button'
            variant='ghost'
          >
            <Search className='size-4' aria-hidden='true' />
          </Button>
          <Button
            aria-label={t('Notifications')}
            className='text-sidebar-foreground/60 hover:text-sidebar-foreground'
            onClick={() => toast.info(t('No new notifications.'))}
            size='icon-sm'
            type='button'
            variant='ghost'
          >
            <Bell className='size-4' aria-hidden='true' />
          </Button>
        </div>
      </div>

      <div className='grid shrink-0 gap-1.5 px-3 pb-3'>
        <Button
          className='h-10 justify-start gap-2.5 rounded-lg px-3 text-sm font-medium'
          onClick={onNewChat}
          type='button'
          variant='outline'
        >
          <MessageSquarePlus className='size-4' aria-hidden='true' />
          {t('New chat')}
        </Button>
        <Button
          aria-label={t('Search chats')}
          className='text-sidebar-foreground/70 hover:text-sidebar-foreground h-9 justify-start gap-2.5 rounded-lg px-3 text-sm'
          onClick={onSearchChats}
          type='button'
          variant='ghost'
        >
          <Search className='size-4' aria-hidden='true' />
          {t('Search chats')}
        </Button>
      </div>

      <nav
        aria-label={t('Workspace navigation')}
        className='grid shrink-0 gap-0.5 px-2 pb-3'
      >
        {[
          { icon: ImageIcon, label: 'Images' },
          { icon: CalendarClock, label: 'Scheduled tasks' },
          { icon: Puzzle, label: 'Plugins' },
          { icon: Compass, label: 'Explore' },
        ].map(({ icon: Icon, label }) => (
          <Button
            className='text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground h-9 justify-start gap-2.5 rounded-lg px-2.5 text-sm'
            key={label}
            onClick={() => onOpenTools(label === 'Images' ? 'files' : 'tools')}
            type='button'
            variant='ghost'
          >
            <Icon className='size-4' aria-hidden='true' />
            {t(label)}
          </Button>
        ))}
      </nav>

      <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-3'>
        <div className='text-sidebar-foreground/45 px-2 pt-2 pb-2 text-[11px] font-medium tracking-wide uppercase'>
          {t('Agents')}
        </div>
        <nav aria-label={t('Choose an agent')} className='grid gap-0.5'>
          {presets.map((preset) => {
            const Icon = preset.icon
            const isActive = preset.id === activePresetId

            return (
              <button
                aria-pressed={isActive}
                className={cn(
                  'group flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                )}
                key={preset.id}
                onClick={() => onPresetChange(preset)}
                type='button'
              >
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', preset.tone)}
                  aria-hidden='true'
                />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-sm font-medium'>
                    {t(preset.title)}
                  </span>
                  <span className='text-sidebar-foreground/50 mt-0.5 block truncate text-xs'>
                    {t(preset.description)}
                  </span>
                </span>
              </button>
            )
          })}
        </nav>

        <div className='text-sidebar-foreground/45 px-2 pt-7 pb-2 text-[11px] font-medium tracking-wide uppercase'>
          {t('Recent')}
        </div>
        {recentChats.length > 0 ? (
          <nav aria-label={t('Recent')} className='grid gap-0.5'>
            {recentChats.map((chat) => (
              <button
                className='text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground min-w-0 rounded-lg px-2.5 py-2 text-left text-xs'
                key={chat.key}
                onClick={() => onSelectChat(chat.presetId, chat.chatId)}
                type='button'
              >
                <span className='text-sidebar-foreground/45 mb-0.5 block text-[10px] uppercase'>
                  {t(
                    presets.find((preset) => preset.id === chat.presetId)
                      ?.title ?? chat.presetId
                  )}{' '}
                  · chat {chat.chatId}
                </span>
                <span className='block truncate'>{chat.preview}</span>
              </button>
            ))}
          </nav>
        ) : (
          <p className='text-sidebar-foreground/45 px-2.5 text-xs leading-5'>
            {t('No saved conversations yet')}
          </p>
        )}
      </div>

      <div className='border-sidebar-border/70 grid shrink-0 gap-1 border-t p-2'>
        <Button
          className='text-sidebar-foreground/70 hover:text-sidebar-foreground h-9 justify-start gap-2.5 rounded-lg px-2.5 text-sm'
          onClick={() => onOpenTools('tools')}
          type='button'
          variant='ghost'
        >
          <Wrench className='size-4' aria-hidden='true' />
          {t('Workspace tools')}
        </Button>
        <Button
          className='text-sidebar-foreground/50 hover:text-sidebar-foreground h-8 justify-start gap-2 px-2.5 text-xs'
          render={
            <a
              href='https://github.com/lilyco-42/lyco-skill'
              rel='noreferrer'
              target='_blank'
            />
          }
          type='button'
          variant='ghost'
        >
          <span className='truncate'>{t('lyco-skill default')}</span>
          <ExternalLink
            className='ml-auto size-3 shrink-0'
            aria-hidden='true'
          />
        </Button>
      </div>
      <div className='border-sidebar-border/70 flex shrink-0 items-center gap-2 border-t px-3 py-2.5'>
        <div className='bg-sidebar-primary text-sidebar-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold'>
          {accountInitials}
        </div>
        <div className='min-w-0 flex-1'>
          <span className='block truncate text-xs font-medium'>
            {accountName}
          </span>
          <span className='text-sidebar-foreground/45 block truncate text-[10px]'>
            {t('Personal workspace')}
          </span>
        </div>
        <Button
          aria-label={t('Account menu')}
          className='text-sidebar-foreground/55 hover:text-sidebar-foreground'
          render={<a href='/profile' />}
          size='icon-xs'
          type='button'
          variant='ghost'
        >
          <MoreHorizontal className='size-4' aria-hidden='true' />
        </Button>
      </div>
    </aside>
  )
}
