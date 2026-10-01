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
  FileText,
  Globe2,
  Image as ImageIcon,
  Menu,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  PenLine,
  Share2,
  Upload,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Playground } from '@/features/playground'
import {
  attachFilesToCurrentPromptInput,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from '@/features/playground/lib/input/input-tool-utils'
import type {
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'
import { useMediaQuery } from '@/hooks'
import { useAuthStore } from '@/stores/auth-store'

import {
  createBrowserAgentBridge,
  createBrowserBridgeProvider,
  confirmAgentPairing,
  createAgentPairing,
  listAgentDevices,
  listAgentRunEvents,
  pairCurrentDesktop,
  startDesktopAgentBridge,
  type AgentBridgeStatus,
  type AgentPairingSession,
  type AgentRunEvent,
} from './agent-bridge'
import {
  getAgentChatStorageNamespace,
  getNextAgentChatId,
  parseAgentChatStorageKey,
} from './agent-chat-storage'
import {
  createAgentDSHConversation,
  type AgentDSHMode,
} from './agent-dsh'
import { AGENT_TOOL_PROMPT, LYCO_DEFAULT_SYSTEM_PROMPT } from './agent-prompts'
import { localAgentToolProvider } from './agent-tool-provider'
import { AgentBridgeCard } from './components/agent-bridge-card'
import { AgentSidebar, type AgentPreset } from './components/agent-sidebar'
import { DeveloperToolkitCard } from './components/developer-toolkit-card'
import { GithubCliCard } from './components/github-cli-card'
import { McpServersCard } from './components/mcp-servers-card'
import { PlatformAccessCard } from './components/platform-access-card'
import { ResearchSourcesCard } from './components/research-sources-card'
import {
  combineLocalToolProviders,
  createBrowserMcpToolProvider,
  createMcpToolProvider,
  type McpServerDescriptor,
} from './mcp-tool-provider'
import {
  createBrowserAgentToolProvider,
  webAgentToolProvider,
} from './web-agent-tool-provider'
import {
  readWorkspaceTextPreview,
  selectWorkspaceFiles,
} from './workspace-file-utils'

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

function WorkspaceToolsCards({
  bridgeStatus,
  deviceId,
  deviceName,
  isDesktop,
  onPair,
  onReconnect,
  onCreatePairing,
  onConfirmPairing,
  pairingId,
  pairingTicket,
  mcpController,
  mcpRevision,
  onMcpChanged,
  remoteMcpServers,
  onRemoteMcpRefresh,
  journal,
  onCheckRemoteTools,
}: {
  bridgeStatus: AgentBridgeStatus
  deviceId?: number
  deviceName?: string
  isDesktop: boolean
  onPair?: () => Promise<void>
  onReconnect?: () => Promise<void>
  onCreatePairing?: (replaceDeviceId?: number) => Promise<void>
  onConfirmPairing?: (ticket: string) => Promise<void>
  pairingId?: number
  pairingTicket?: string
  mcpController: ReturnType<typeof createMcpToolProvider>
  mcpRevision: number
  onMcpChanged: () => void
  remoteMcpServers?: McpServerDescriptor[]
  onRemoteMcpRefresh?: () => Promise<McpServerDescriptor[]>
  journal?: AgentRunEvent[]
  onCheckRemoteTools?: () => Promise<unknown>
}) {
  return (
    <div className='grid gap-3'>
      <AgentBridgeCard
        deviceId={deviceId}
        deviceName={deviceName}
        isDesktop={isDesktop}
        onConfirmPairing={onConfirmPairing}
        onCreatePairing={onCreatePairing}
        onPair={onPair}
        onReconnect={onReconnect}
        pairingId={pairingId}
        pairingTicket={pairingTicket}
        journal={journal}
        status={bridgeStatus}
      />
      <DeveloperToolkitCard onCheckRemoteTools={onCheckRemoteTools} />
      <McpServersCard
        controller={mcpController}
        isDesktop={isDesktop}
        onChanged={onMcpChanged}
        onRemoteRefresh={onRemoteMcpRefresh}
        remoteServers={remoteMcpServers}
        revision={mcpRevision}
      />
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

type WorkspaceFile = {
  id: string
  name: string
  type: string
  size: number
  url: string
  file: File
  text?: string
}

function WorkspaceFiles({
  view,
  onAttachFile,
}: {
  view: Exclude<WorkspaceView, 'tools'>
  onAttachFile: (file: File) => void
}) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(
    () => () => {
      files.forEach((file) => URL.revokeObjectURL(file.url))
    },
    [files]
  )

  const selected = files.find((file) => file.id === selectedId)
  const loadFiles = async (incoming: FileList | null) => {
    if (!incoming?.length) return
    const selection = selectWorkspaceFiles([...incoming])
    if (selection.oversized.length > 0) {
      toast.error(t('Maximum attachment size is 8 MB.'))
    }
    if (selection.overLimit.length > 0) {
      toast.error(t('Only the first 10 workspace files can be loaded.'))
    }
    const next = selection.accepted
    if (next.length === 0) return
    let prepared: Array<Omit<WorkspaceFile, 'url'>>
    try {
      prepared = await Promise.all(
        next.map(async (file, index) => {
          const id = `${file.name}-${file.lastModified}-${index}`
          const text = await readWorkspaceTextPreview(file)
          return {
            id,
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: file.size,
            file,
            ...(text !== undefined ? { text } : {}),
          }
        })
      )
    } catch {
      toast.error(t('Could not read the selected workspace files.'))
      return
    }
    const loaded: WorkspaceFile[] = prepared.map((file) => ({
      ...file,
      url: URL.createObjectURL(file.file),
    }))
    setFiles((previous) => {
      previous.forEach((file) => URL.revokeObjectURL(file.url))
      return loaded
    })
    setSelectedId(loaded[0]?.id)
  }

  const filesContent = (
    <>
      <div className='flex items-center justify-between gap-2'>
        <div>
          <h3 className='text-sm font-medium'>{t('Workspace files')}</h3>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Files stay in this browser until you attach them to a message.'
            )}
          </p>
          <p className='text-muted-foreground mt-1 text-[10px]'>
            {t(
              'Workspace file limits: 10 files, 8 MB each; text previews read up to 120 KB.'
            )}
          </p>
        </div>
        <div className='flex shrink-0 gap-1.5'>
          <Button
            disabled={!selected}
            onClick={() => selected && onAttachFile(selected.file)}
            size='sm'
            variant='outline'
          >
            {t('Attach selected file')}
          </Button>
          <Button onClick={() => inputRef.current?.click()} size='sm'>
            <Upload className='mr-1.5 size-3.5' aria-hidden='true' />
            {t('Upload files')}
          </Button>
        </div>
      </div>
      {files.length === 0 ? (
        <button
          className='text-muted-foreground hover:border-primary/50 hover:text-foreground flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center text-xs'
          onClick={() => inputRef.current?.click()}
          type='button'
        >
          <FileCode2 className='mb-2 size-6' aria-hidden='true' />
          {t('Choose files to inspect them here.')}
        </button>
      ) : (
        <div className='grid gap-1'>
          {files.map((file) => {
            const FileIcon = file.type.startsWith('image/')
              ? ImageIcon
              : FileText
            return (
              <button
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${file.id === selectedId ? 'bg-muted' : 'hover:bg-muted/60'}`}
                key={file.id}
                onClick={() => setSelectedId(file.id)}
                type='button'
              >
                <FileIcon className='size-4 shrink-0' aria-hidden='true' />
                <span className='min-w-0 flex-1 truncate'>{file.name}</span>
                <span className='text-muted-foreground shrink-0'>
                  {Math.ceil(file.size / 1024)} KB
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )

  let previewContent: ReactNode
  if (!selected) {
    previewContent = (
      <div className='flex min-h-[22rem] flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center'>
        <Eye className='text-muted-foreground mb-3 size-6' aria-hidden='true' />
        <h3 className='text-sm font-medium'>{t('No preview yet')}</h3>
        <p className='text-muted-foreground mt-1 max-w-xs text-xs leading-5'>
          {t('Choose a file in the Files tab to preview it here.')}
        </p>
        <Button
          className='mt-4'
          onClick={() => inputRef.current?.click()}
          size='sm'
        >
          {t('Upload files')}
        </Button>
      </div>
    )
  } else {
    let body: ReactNode
    if (selected.type.startsWith('image/')) {
      body = (
        <img
          alt={selected.name}
          className='max-h-[30rem] w-full rounded-lg border object-contain'
          src={selected.url}
        />
      )
    } else if (selected.text !== undefined) {
      body = (
        <pre className='bg-muted/40 min-h-44 overflow-auto rounded-lg p-3 text-xs leading-5 whitespace-pre-wrap'>
          {selected.text}
        </pre>
      )
    } else {
      body = (
        <div className='text-muted-foreground flex min-h-44 items-center justify-center rounded-lg border border-dashed text-xs'>
          {t('Preview is unavailable for this file type.')}
        </div>
      )
    }
    previewContent = (
      <div className='grid min-h-0 gap-3'>
        <div className='flex items-center justify-between gap-2'>
          <div className='min-w-0'>
            <h3 className='truncate text-sm font-medium'>{selected.name}</h3>
            <p className='text-muted-foreground truncate text-xs'>
              {selected.type}
            </p>
          </div>
          <Button
            onClick={() => onAttachFile(selected.file)}
            size='sm'
            variant='default'
          >
            {t('Attach selected file')}
          </Button>
        </div>
        {body}
      </div>
    )
  }

  return (
    <div className='grid min-h-[22rem] gap-3'>
      <input
        accept='image/*,application/pdf,.pdf,.docx,.xlsx,.txt,.md,.json,.csv,.xml,.yaml,.yml,.js,.ts,.tsx,.py,.rs,.go,.java,.sql'
        className='hidden'
        multiple
        onChange={(event) => {
          void loadFiles(event.target.files)
          event.currentTarget.value = ''
        }}
        ref={inputRef}
        type='file'
      />
      {view === 'files' ? filesContent : previewContent}
    </div>
  )
}

type AgentChatSearchResult = {
  key: string
  namespace: string
  presetId: string
  chatId: number
  preview: string
  updatedAt?: number
}

function readAgentChatSearchResults(
  query: string,
  userId: number
): AgentChatSearchResult[] {
  if (typeof window === 'undefined' || userId <= 0) return []
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []

  const results: AgentChatSearchResult[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const storageKey = window.localStorage.key(index)
    if (!storageKey) continue
    const chatKey = parseAgentChatStorageKey(storageKey, userId)
    if (!chatKey) continue
    try {
      const parsed = JSON.parse(
        window.localStorage.getItem(storageKey) ?? ''
      ) as {
        data?: Array<{
          key?: string
          from?: string
          createdAt?: number
          versions?: Array<{ content?: string }>
        }>
      }
      const messages = Array.isArray(parsed.data) ? parsed.data : []
      for (const message of messages) {
        const content = message.versions?.at(-1)?.content?.trim() ?? ''
        if (!content || !content.toLowerCase().includes(normalizedQuery)) {
          continue
        }
        results.push({
          key: message.key ?? `${storageKey}-${results.length}`,
          namespace: storageKey,
          presetId: chatKey.presetId,
          chatId: chatKey.chatId,
          preview: content.slice(0, 180),
          updatedAt: message.createdAt,
        })
      }
    } catch {
      // Ignore stale or malformed local conversation data.
    }
  }
  return results
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, 30)
}

function AgentChatSearchDialog({
  open,
  onOpenChange,
  onSelect,
  userId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (presetId: string, chatId: number) => void
  userId: number
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const results = readAgentChatSearchResults(query, userId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{t('Search chats')}</DialogTitle>
          <DialogDescription>
            {t('Search local Agent conversations stored in this browser.')}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label={t('Search chats')}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('Search chats')}
          value={query}
        />
        <div className='grid max-h-80 gap-1 overflow-y-auto'>
          {query.trim() && results.length === 0 && (
            <p className='text-muted-foreground px-2 py-6 text-center text-sm'>
              {t('No records found')}
            </p>
          )}
          {results.map((result) => (
            <button
              className='hover:bg-muted flex min-w-0 flex-col rounded-lg px-3 py-2 text-left'
              key={`${result.namespace}-${result.key}`}
              onClick={() => {
                onSelect(result.presetId, result.chatId)
                onOpenChange(false)
              }}
              type='button'
            >
              <span className='text-muted-foreground text-[10px] uppercase'>
                {result.presetId} · chat {result.chatId}
              </span>
              <span className='truncate text-sm'>{result.preview}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
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
  const userId = useAuthStore((state) => state.auth.user?.id ?? 0)
  return <AgentWorkspaceSession key={userId} userId={userId} />
}

function AgentWorkspaceSession({ userId }: { userId: number }) {
  const { t } = useTranslation()
  const useToolsSheet = useMediaQuery('(max-width: 1279px)')
  const [preset, setPreset] = useState<AgentPreset>(PRESETS[0])
  const [chatId, setChatId] = useState(0)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('tools')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [bridgeStatus, setBridgeStatus] =
    useState<AgentBridgeStatus>('unavailable')
  const [bridgeProvider, setBridgeProvider] =
    useState<LocalToolProvider | null>(null)
  const [bridgeDeviceId, setBridgeDeviceId] = useState<number>()
  const [bridgeDeviceName, setBridgeDeviceName] = useState<string>()
  const [bridgeEpoch, setBridgeEpoch] = useState(0)
  const [bridgeJournal, setBridgeJournal] = useState<AgentRunEvent[]>([])
  const [pairingSession, setPairingSession] =
    useState<AgentPairingSession | null>(null)
  const [mcpController] = useState(() => createMcpToolProvider())
  const [mcpRevision, setMcpRevision] = useState(0)
  const [remoteMcpServers, setRemoteMcpServers] = useState<
    McpServerDescriptor[]
  >([])
  const remoteMcpProvider = useRef<ReturnType<
    typeof createBrowserMcpToolProvider
  > | null>(null)
  const checkRemoteTools = async (): Promise<unknown> => {
    if (!bridgeProvider) {
      throw new Error('Pair a desktop or Radxa node before checking tools.')
    }
    const call: ChatCompletionToolCall = {
      id: 'developer-tools-status',
      type: 'function',
      function: {
        name: 'developer.tools.status',
        arguments: '{}',
      },
    }
    const raw = await bridgeProvider.invoke(call, new AbortController().signal)
    try {
      const envelope = JSON.parse(raw)
      const result =
        envelope && typeof envelope === 'object' && 'data' in envelope
          ? envelope.data
          : envelope
      if (
        result &&
        typeof result === 'object' &&
        'stdout' in result &&
        typeof result.stdout === 'string'
      ) {
        return JSON.parse(result.stdout)
      }
      return result
    } catch {
      throw new Error('The remote tool status response was invalid.')
    }
  }
  const isDesktop = localAgentToolProvider.isAvailable()
  const activeToolProvider = useMemo(() => {
    if (isDesktop) {
      return combineLocalToolProviders(
        localAgentToolProvider,
        mcpController,
        webAgentToolProvider
      )
    }
    if (bridgeProvider) {
      return createBrowserAgentToolProvider(
        bridgeProvider,
        bridgeStatus === 'connected'
      )
    }
    return createBrowserAgentToolProvider(undefined, false)
  }, [bridgeProvider, bridgeStatus, isDesktop, mcpController])

  const chatStorageNamespace = getAgentChatStorageNamespace(
    userId,
    preset.id,
    chatId
  )
  const hostedTurnProvider = useMemo(
    () => createAgentDSHConversation({
      storageNamespace: chatStorageNamespace,
      mode: toAgentDSHMode(preset.id),
      localToolProvider: activeToolProvider,
    }),
    [activeToolProvider, chatStorageNamespace, preset.id]
  )

  useEffect(() => {
    setToolsOpen(!useToolsSheet)
  }, [useToolsSheet])

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null
    setBridgeProvider(null)
    setRemoteMcpServers([])
    remoteMcpProvider.current = null
    setBridgeDeviceId(undefined)
    setBridgeDeviceName(undefined)
    setBridgeJournal([])
    setPairingSession(null)
    setBridgeStatus(isDesktop ? 'unavailable' : 'connecting')

    if (isDesktop) {
      void startDesktopAgentBridge(setBridgeStatus)
        .then((dispose) => {
          if (disposed) {
            dispose?.()
            return
          }
          cleanup = dispose
          if (!dispose) setBridgeStatus('unavailable')
        })
        .catch(() => {
          if (!disposed) setBridgeStatus('error')
        })
      return () => {
        disposed = true
        remoteMcpProvider.current = null
        cleanup?.()
      }
    }

    void listAgentDevices()
      .then(async (devices) => {
        if (disposed) return
        const device = devices[0]
        if (!device) {
          setBridgeStatus('unavailable')
          return
        }
        setBridgeDeviceId(device.id)
        setBridgeDeviceName(device.device_name)
        const client = createBrowserAgentBridge(device.id)
        if (!client) {
          setBridgeStatus('unavailable')
          return
        }
        cleanup = () => client.close()
        const removeStatus = client.onStatus(setBridgeStatus)
        const provider = createBrowserBridgeProvider(client)
        const mcpProvider = createBrowserMcpToolProvider(client)
        remoteMcpProvider.current = mcpProvider
        try {
          await client.connect()
          try {
            setBridgeJournal(await listAgentRunEvents(device.id))
          } catch {
            // Journal support is additive; live bridge tools remain usable on
            // an older server that does not expose the events endpoint.
            setBridgeJournal([])
          }
          try {
            const servers = await mcpProvider.refresh(
              new AbortController().signal
            )
            setRemoteMcpServers(servers)
            setBridgeProvider(combineLocalToolProviders(provider, mcpProvider))
          } catch {
            // Older servers may not expose the MCP bridge yet; keep GitHub
            // tools available while the paired desktop remains connected.
            setBridgeProvider(provider)
          }
        } catch {
          if (!disposed) setBridgeStatus('offline')
          setBridgeProvider(provider)
        }
        if (disposed) {
          removeStatus()
          cleanup?.()
        }
      })
      .catch(() => {
        if (!disposed) setBridgeStatus('unavailable')
      })

    return () => {
      disposed = true
      remoteMcpProvider.current = null
      cleanup?.()
    }
  }, [bridgeEpoch, isDesktop, userId])

  useEffect(() => {
    if (!isDesktop) return
    void mcpController
      .refresh()
      .then(() => setMcpRevision((value) => value + 1))
      .catch(() => {
        // A desktop without saved MCP connections starts with an empty list.
      })
  }, [isDesktop, mcpController])

  const pairDesktop = async () => {
    await pairCurrentDesktop()
    setBridgeEpoch((value) => value + 1)
  }

  const reconnectDesktop = async () => {
    setBridgeEpoch((value) => value + 1)
  }

  const createWebPairing = async (replaceDeviceId?: number) => {
    const session = await createAgentPairing(replaceDeviceId)
    setPairingSession(session)
  }

  const confirmWebPairing = async (ticket: string) => {
    if (!pairingSession) {
      throw new Error('Create a pairing ticket first.')
    }
    await confirmAgentPairing(pairingSession.id, ticket)
    setPairingSession(null)
    setBridgeEpoch((value) => value + 1)
  }

  const refreshRemoteMcp = async () => {
    if (isDesktop || !remoteMcpProvider.current) return []
    const servers = await remoteMcpProvider.current.refresh(
      new AbortController().signal
    )
    setRemoteMcpServers(servers)
    return servers
  }

  const handlePresetChange = (nextPreset: AgentPreset) => {
    setPreset(nextPreset)
    setSidebarOpen(false)
  }

  const handleNewChat = () => {
    setChatId((current) => getNextAgentChatId(userId, preset.id, current))
    setSidebarOpen(false)
  }

  const handleChatSearchSelect = (presetId: string, selectedChatId: number) => {
    const nextPreset = PRESETS.find((item) => item.id === presetId)
    if (nextPreset) setPreset(nextPreset)
    setChatId(selectedChatId)
    setSidebarOpen(false)
  }

  const openWorkspaceTools = (view: WorkspaceView = 'tools') => {
    setWorkspaceView(view)
    setToolsOpen(true)
    setSidebarOpen(false)
  }

  const attachWorkspaceFile = (file: File) => {
    if (file.size > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
      toast.error(t('Maximum attachment size is 8 MB.'))
      return
    }
    attachFilesToCurrentPromptInput([file])
    setToolsOpen(false)
    toast.success(t('File attached to the next message.'))
  }

  const exportCurrentConversation = () => {
    const namespace = getAgentChatStorageNamespace(userId, preset.id, chatId)
    const raw = window.localStorage.getItem(`${namespace}:playground_messages`)
    if (!raw) {
      toast.info(t('No conversation to export yet.'))
      return
    }
    const blob = new Blob([raw], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `lain42-agent-${preset.id}-${chatId}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success(t('Conversation exported.'))
  }

  return (
    <div className='bg-background text-foreground flex size-full min-h-0 overflow-hidden'>
      <AgentSidebar
        activePresetId={preset.id}
        className='hidden lg:flex'
        onNewChat={handleNewChat}
        onSearchChats={() => setChatSearchOpen(true)}
        onOpenTools={openWorkspaceTools}
        onSelectChat={handleChatSearchSelect}
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
            onSearchChats={() => setChatSearchOpen(true)}
            onOpenTools={openWorkspaceTools}
            onSelectChat={handleChatSearchSelect}
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
              onClick={exportCurrentConversation}
              size='icon-sm'
              type='button'
              variant='ghost'
            >
              <MoreHorizontal className='size-4' aria-hidden='true' />
            </Button>
            <Button
              aria-label={t('Share conversation')}
              className='text-muted-foreground hover:text-foreground'
              onClick={() => {
                const shareUrl = window.location.href
                const shareData = {
                  title: t('Lain42 Agent'),
                  text: t('Open this Lain42 Agent workspace.'),
                  url: shareUrl,
                }
                if (navigator.share) {
                  void navigator.share(shareData).catch(() => undefined)
                  return
                }
                if (navigator.clipboard) {
                  void navigator.clipboard.writeText(shareUrl).then(() => {
                    toast.success(t('Workspace link copied.'))
                  })
                } else {
                  toast.info(
                    t('Copy the current page URL to share this workspace.')
                  )
                }
              }}
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
            agentMode
            key={`${userId}-${preset.id}-${chatId}`}
            emptyStateDescription={t(
              'Test a model with a starter prompt, or write your own request below.'
            )}
            emptyStateTitle={t('How can I help you today?')}
            storageNamespace={chatStorageNamespace}
            systemPrompt={preset.prompt}
            localToolProvider={activeToolProvider ?? undefined}
            hostedTurnProvider={hostedTurnProvider}
          />
        </main>
      </div>

      <AgentChatSearchDialog
        onOpenChange={setChatSearchOpen}
        onSelect={handleChatSearchSelect}
        open={chatSearchOpen}
        userId={userId}
      />

      {toolsOpen && !useToolsSheet && (
        <aside className='bg-background flex w-[min(43vw,52rem)] shrink-0 flex-col border-l'>
          <WorkspacePanelHeader
            onClose={() => setToolsOpen(false)}
            onViewChange={setWorkspaceView}
            view={workspaceView}
          />
          <div className='min-h-0 flex-1 overflow-y-auto p-4'>
            {workspaceView === 'tools' ? (
              <WorkspaceToolsCards
                bridgeStatus={bridgeStatus}
                deviceId={bridgeDeviceId}
                deviceName={bridgeDeviceName}
                isDesktop={isDesktop}
                onPair={isDesktop ? pairDesktop : undefined}
                onReconnect={isDesktop ? reconnectDesktop : undefined}
                onCreatePairing={isDesktop ? undefined : createWebPairing}
                onConfirmPairing={isDesktop ? undefined : confirmWebPairing}
                pairingId={pairingSession?.id}
                pairingTicket={pairingSession?.pairing_ticket}
                mcpController={mcpController}
                mcpRevision={mcpRevision}
                onMcpChanged={() => setMcpRevision((value) => value + 1)}
                onRemoteMcpRefresh={isDesktop ? undefined : refreshRemoteMcp}
                remoteMcpServers={isDesktop ? undefined : remoteMcpServers}
                journal={isDesktop ? undefined : bridgeJournal}
                onCheckRemoteTools={isDesktop ? undefined : checkRemoteTools}
              />
            ) : (
              <WorkspaceFiles
                onAttachFile={attachWorkspaceFile}
                view={workspaceView}
              />
            )}
          </div>
        </aside>
      )}

      {useToolsSheet && (
        <Sheet open={toolsOpen} onOpenChange={setToolsOpen}>
          <SheetContent
            className='flex w-full flex-col overflow-hidden sm:max-w-md'
            side='right'
          >
            <WorkspacePanelHeader
              onClose={() => setToolsOpen(false)}
              onViewChange={setWorkspaceView}
              view={workspaceView}
            />
            <div className='min-h-0 flex-1 overflow-y-auto p-4'>
              {workspaceView === 'tools' ? (
                <WorkspaceToolsCards
                  bridgeStatus={bridgeStatus}
                  deviceId={bridgeDeviceId}
                  deviceName={bridgeDeviceName}
                  isDesktop={isDesktop}
                  onPair={isDesktop ? pairDesktop : undefined}
                  onReconnect={isDesktop ? reconnectDesktop : undefined}
                  onCreatePairing={isDesktop ? undefined : createWebPairing}
                  onConfirmPairing={isDesktop ? undefined : confirmWebPairing}
                  pairingId={pairingSession?.id}
                  pairingTicket={pairingSession?.pairing_ticket}
                  mcpController={mcpController}
                  mcpRevision={mcpRevision}
                  onMcpChanged={() => setMcpRevision((value) => value + 1)}
                  onRemoteMcpRefresh={isDesktop ? undefined : refreshRemoteMcp}
                  remoteMcpServers={isDesktop ? undefined : remoteMcpServers}
                  journal={isDesktop ? undefined : bridgeJournal}
                  onCheckRemoteTools={isDesktop ? undefined : checkRemoteTools}
                />
              ) : (
                <WorkspaceFiles
                  onAttachFile={attachWorkspaceFile}
                  view={workspaceView}
                />
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}

function toAgentDSHMode(presetId: string): AgentDSHMode {
  if (
    presetId === 'coding' ||
    presetId === 'research' ||
    presetId === 'content'
  ) {
    return presetId
  }
  return 'general'
}
