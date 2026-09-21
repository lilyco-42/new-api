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
  Eye,
  Bot,
  ChevronDown,
  Code2,
  FileCode2,
  FolderOpen,
  Globe2,
  Menu,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  PenLine,
  Share2,
  Wrench,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Playground } from '@/features/playground'
import { useMediaQuery } from '@/hooks'

import { localAgentToolProvider } from './agent-tool-provider'
import { AgentSidebar, type AgentPreset } from './components/agent-sidebar'
import { DeveloperToolkitCard } from './components/developer-toolkit-card'
import { GithubCliCard } from './components/github-cli-card'
import { PlatformAccessCard } from './components/platform-access-card'
import { ResearchSourcesCard } from './components/research-sources-card'

const LYCO_DEFAULT_SYSTEM_PROMPT = `你是云枢智创 Agent，默认采用 lyco-skill 的“预研先行”方法。

处理新需求时：先用一句话复述目标、约束和验收标准；信息不足时只问最关键的澄清问题。需求明确后，优先通过本机 gh CLI 或公开网页查找现成方案、Issue、Pull Request、论文和社区经验；不要编造候选或结论。比较采用、扩展和自研的 ROI、许可证、维护成本与风险，主流方案覆盖约 80% 时优先采用。随后用最小可验证步骤落地，记录证据和回滚点。每轮最后用不超过 12 行要点汇报事实、推断、未知和下一步。

本机 gh CLI 只使用用户自己的登录状态，token 留在本机，不读取浏览器 Cookie；任何外部写入、发送消息或敏感操作都先请求明确授权。`

const AGENT_TOOL_PROMPT = `
当用户要求读取 GitHub 仓库最近 Issue 时，如果工具列表中有 github.issues.list，必须使用结构化工具调用，并传入 owner/name；不要把“Tool: …”之类的文字当成工具调用，也不要猜测仓库内容。工具返回后引用其中的标题、状态、更新时间和链接；如果工具不可用，明确说明需要在 Lain42 桌面版完成 gh 登录。`

const PRESETS: AgentPreset[] = [
  {
    id: 'general',
    title: '通用助手',
    description: '整理信息、写作、计划与日常问答',
    prompt: `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}`,
    icon: Bot,
    tone: 'text-sky-500',
  },
  {
    id: 'coding',
    title: '代码 Agent',
    description: '读代码、定位问题、设计实现与复盘',
    prompt: `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}\n\n你当前承担代码 Agent 角色：优先阅读现有实现，给出最小可行改动、验证方法与回滚点。除非用户明确授权，不执行破坏性操作。`,
    icon: Code2,
    tone: 'text-violet-500',
  },
  {
    id: 'research',
    title: '研究 Agent',
    description: '拆解问题、比较方案、输出带来源结论',
    prompt: `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}\n\n你当前承担研究 Agent 角色：把问题拆成可验证的子问题，区分事实、推断和未知，并为关键结论提供来源链接。`,
    icon: Globe2,
    tone: 'text-emerald-500',
  },
  {
    id: 'content',
    title: '内容 Agent',
    description: '产品文案、教程、脚本和多语言改写',
    prompt: `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}\n\n你当前承担内容 Agent 角色：先确认受众和使用场景，再输出可直接发布的版本；保留事实边界，避免空泛营销语。`,
    icon: PenLine,
    tone: 'text-amber-500',
  },
]

function WorkspaceToolsCards() {
  return (
    <div className='grid gap-3'>
      <DeveloperToolkitCard />
      <PlatformAccessCard />
      <ResearchSourcesCard />
      <GithubCliCard />
    </div>
  )
}

type WorkspaceView = 'tools' | 'files' | 'preview'

const WORKSPACE_VIEWS: Array<{
  id: WorkspaceView
  label: string
  icon: typeof Wrench
}> = [
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'preview', label: 'Preview', icon: Eye },
]

function WorkspaceViewPlaceholder({
  view,
}: {
  view: Exclude<WorkspaceView, 'tools'>
}) {
  const { t } = useTranslation()
  const isFiles = view === 'files'
  const Icon = isFiles ? FileCode2 : Eye

  return (
    <div className='flex min-h-[22rem] flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center'>
      <div className='bg-muted/50 text-muted-foreground mb-3 flex size-10 items-center justify-center rounded-xl'>
        <Icon className='size-5' aria-hidden='true' />
      </div>
      <h3 className='text-sm font-medium'>
        {t(isFiles ? 'No file selected' : 'No preview yet')}
      </h3>
      <p className='text-muted-foreground mt-1 max-w-xs text-xs leading-5'>
        {t(
          isFiles
            ? 'Open a repository or attach a file to see it in the workspace.'
            : 'Run a task or open a file to populate the preview pane.'
        )}
      </p>
    </div>
  )
}

function WorkspacePanelHeader({
  onClose,
  onViewChange,
  view,
}: {
  onClose: () => void
  onViewChange: (view: WorkspaceView) => void
  view: WorkspaceView
}) {
  const { t } = useTranslation()

  return (
    <header className='shrink-0 border-b'>
      <div className='flex h-14 items-center justify-between px-4'>
        <div className='min-w-0'>
          <h2 className='truncate text-sm font-semibold'>{t('Workspace')}</h2>
          <p className='text-muted-foreground truncate text-xs'>
            {t('One workspace for web, desktop and mobile')}
          </p>
        </div>
        <Button
          aria-label={t('Close Agent tools')}
          className='text-muted-foreground hover:text-foreground'
          onClick={onClose}
          size='icon-sm'
          type='button'
          variant='ghost'
        >
          <PanelRightClose className='size-4' aria-hidden='true' />
        </Button>
      </div>
      <div className='flex h-10 items-end gap-1 px-2'>
        {WORKSPACE_VIEWS.map(({ id, icon: Icon, label }) => (
          <Button
            aria-pressed={view === id}
            className='relative h-9 gap-1.5 rounded-b-none px-3 text-xs'
            key={id}
            onClick={() => onViewChange(id)}
            type='button'
            variant='ghost'
          >
            <Icon className='size-3.5' aria-hidden='true' />
            {t(label)}
            {view === id && (
              <span className='bg-primary absolute inset-x-2 bottom-0 h-0.5 rounded-full' />
            )}
          </Button>
        ))}
      </div>
    </header>
  )
}

export function AgentWorkspace() {
  const { t } = useTranslation()
  const useToolsSheet = useMediaQuery('(max-width: 1279px)')
  const [preset, setPreset] = useState<AgentPreset>(PRESETS[0])
  const [chatId, setChatId] = useState(0)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('tools')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    setToolsOpen(!useToolsSheet)
  }, [useToolsSheet])

  const handlePresetChange = (nextPreset: AgentPreset) => {
    setPreset(nextPreset)
    setSidebarOpen(false)
  }

  const handleNewChat = () => {
    setChatId((current) => current + 1)
    setSidebarOpen(false)
  }

  return (
    <div className='bg-background text-foreground flex size-full min-h-0 overflow-hidden'>
      <AgentSidebar
        activePresetId={preset.id}
        className='hidden lg:flex'
        onNewChat={handleNewChat}
        onOpenTools={() => setToolsOpen(true)}
        onPresetChange={handlePresetChange}
        presets={PRESETS}
      />

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          className='w-[min(88vw,16.5rem)] overflow-hidden border-0 p-0'
          side='left'
        >
          <SheetHeader className='sr-only'>
            <SheetTitle>{t('Lain42 Agent')}</SheetTitle>
            <SheetDescription>{t('Choose an agent')}</SheetDescription>
          </SheetHeader>
          <AgentSidebar
            activePresetId={preset.id}
            className='h-full w-full border-0'
            onNewChat={handleNewChat}
            onOpenTools={() => {
              setSidebarOpen(false)
              setToolsOpen(true)
            }}
            onPresetChange={handlePresetChange}
            presets={PRESETS}
          />
        </SheetContent>
      </Sheet>

      <div className='flex min-w-0 flex-1 flex-col'>
        <header className='bg-background/90 flex h-14 shrink-0 items-center justify-between border-b px-3 backdrop-blur-md sm:px-5'>
          <div className='flex min-w-0 items-center gap-1'>
            <Button
              aria-label={t('Open sidebar')}
              className='lg:hidden'
              onClick={() => setSidebarOpen(true)}
              size='icon-sm'
              type='button'
              variant='ghost'
            >
              <Menu className='size-4' aria-hidden='true' />
            </Button>
            <div className='flex min-w-0 items-center gap-2 px-2.5'>
              <div className='bg-primary/12 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg'>
                <Bot className='size-3.5' aria-hidden='true' />
              </div>
              <button
                className='hover:bg-muted/60 flex h-9 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold transition-colors'
                onClick={() => setSidebarOpen(true)}
                type='button'
              >
                <span className='truncate'>{t(preset.title)}</span>
                <ChevronDown
                  className='text-muted-foreground size-3.5 shrink-0'
                  aria-hidden='true'
                />
              </button>
            </div>
          </div>

          <div className='flex items-center gap-1'>
            <span className='text-muted-foreground hidden text-xs sm:inline'>
              {t('lyco-skill default')}
            </span>
            <Button
              aria-label={t('More conversation actions')}
              className='text-muted-foreground hover:text-foreground'
              onClick={() =>
                toast.info(
                  t(
                    'Conversation actions are available after the first message.'
                  )
                )
              }
              size='icon-sm'
              type='button'
              variant='ghost'
            >
              <MoreHorizontal className='size-4' aria-hidden='true' />
            </Button>
            <Button
              aria-label={t('Share conversation')}
              className='text-muted-foreground hover:text-foreground'
              onClick={() =>
                toast.info(
                  t('Share links will be available for saved conversations.')
                )
              }
              size='icon-sm'
              type='button'
              variant='ghost'
            >
              <Share2 className='size-4' aria-hidden='true' />
            </Button>
            <Button
              aria-label={t(
                toolsOpen ? 'Close Agent tools' : 'Open Agent tools'
              )}
              aria-pressed={toolsOpen}
              className='text-muted-foreground hover:text-foreground'
              onClick={() => setToolsOpen((open) => !open)}
              size='icon-sm'
              type='button'
              variant='ghost'
            >
              <PanelRight className='size-4' aria-hidden='true' />
            </Button>
          </div>
        </header>

        <main className='min-h-0 min-w-0 flex-1'>
          <Playground
            key={`${preset.id}-${chatId}`}
            emptyStateDescription={t(
              'Test a model with a starter prompt, or write your own request below.'
            )}
            emptyStateTitle={t('How can I help you today?')}
            storageNamespace={`agent-${preset.id}-chat-${chatId}`}
            systemPrompt={preset.prompt}
            localToolProvider={localAgentToolProvider}
          />
        </main>
      </div>

      {toolsOpen && !useToolsSheet && (
        <aside className='bg-background flex w-[min(43vw,52rem)] shrink-0 flex-col border-l'>
          <WorkspacePanelHeader
            onClose={() => setToolsOpen(false)}
            onViewChange={setWorkspaceView}
            view={workspaceView}
          />
          <div className='min-h-0 flex-1 overflow-y-auto p-4'>
            {workspaceView === 'tools' ? (
              <WorkspaceToolsCards />
            ) : (
              <WorkspaceViewPlaceholder view={workspaceView} />
            )}
          </div>
        </aside>
      )}

      {useToolsSheet && (
        <Sheet open={toolsOpen} onOpenChange={setToolsOpen}>
          <SheetContent
            className='w-full overflow-y-auto sm:max-w-md'
            side='right'
          >
            <SheetHeader>
              <SheetTitle>{t('Workspace tools')}</SheetTitle>
              <SheetDescription>
                {t('One workspace for web, desktop and mobile')}
              </SheetDescription>
            </SheetHeader>
            <WorkspaceToolsCards />
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
