import type {
  ChatCompletionMessage,
  ChatCompletionToolCall,
} from '@/features/playground/types'
import { containsPublicPageUrlReference } from '@/features/playground/lib/input/search-context'

export type GitHubReadIntent =
  | 'status'
  | 'repositories'
  | 'repository_search'
  | 'issues'
  | 'pull_requests'

function latestUserText(messages: ChatCompletionMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') return message.content.trim()
    if (Array.isArray(message.content)) {
      // The request precedes attachment parts. Attached text remains model
      // evidence, but cannot grant access to account or device tools.
      const text = message.content.find((part) => part.type === 'text')?.text?.trim() ?? ''
      return /^\[Attached\b/iu.test(text) ? '' : text
    }
    return ''
  }
  return ''
}

function isQuestionAboutToolBehavior(text: string): boolean {
  return /(?:怎么还这样|为什么.{0,30}(?:还|仍然|依旧)|为何.{0,30}(?:还|仍然|依旧)|why.{0,60}\b(?:still|keeps?|continue|again)\b|how come)/iu.test(
    text
  )
}

function explicitlyDeclinesWebResearch(text: string): boolean {
  const explicitlyDeclinesWeb =
    /(?:不需要|无需|不用|不要|别|禁止|不必|不想|无须).{0,8}(?:上网|联网|网页|网络|查资料|web\s+search|search (?:the )?web|browse (?:the )?web)|\b(?:do not|don't|dont|no need to|without|not necessary to)\s+(?:search (?:the )?web|browse (?:the )?web|use (?:the )?web)\b/iu.test(
      text
    )
  if (explicitlyDeclinesWeb) return true

  const declinesGenericSearch =
    /(?:不需要|无需|不用|不要|别|禁止|不必|不想|无须).{0,4}(?:搜索|search|browse|look up)|\b(?:do not|don't|dont|no need to|without|not necessary to)\s+(?:search|browse|look up)\b/iu.test(
      text
    )
  return declinesGenericSearch && !explicitlyDeclinesAccountRepositories(text)
}

function explicitlyDeclinesPageRead(text: string): boolean {
  return /(?:不需要|无需|不用|不要|别|禁止|不必|不想|无须).{0,6}(?:打开|读取|阅读|访问|抓取|fetch|read|open|visit|crawl)|\b(?:do not|don't|dont|no need to|without|not necessary to)\s+(?:read|open|fetch|visit|crawl)\b/iu.test(
    text
  )
}

export function explicitlyRequestsBrowserWebSearch(text: string): boolean {
  return /(?:浏览器(?:端|中)?(?:的)?(?:网页)?搜索|网页搜索(?:功能)?|用网页搜索|search (?:the )?web|web search)/iu.test(
    text
  )
}

export function requestsKnownAIEntityDefinition(text: string): boolean {
  const knownAIEntity =
    /\b(?:deepseek|qwen|llama|claude|chatgpt|gemini|openai|anthropic|hugging[ -]?face)\b/iu
  const isBareEntity =
    /^\s*(?:deepseek|qwen|llama|claude|chatgpt|gemini|openai|anthropic|hugging[ -]?face)\s*[?？!.。！]*\s*$/iu.test(
      text
    )
  const asksForDefinition =
    /(?:是什么|是什麼|是啥|指什么|指什麼|介绍一下|介紹一下|介绍下|介紹下|\bwhat\s+is\b|\bwho\s+is\b|\btell me about\b|\bdefine\b|\bexplain\b)/iu.test(
      text
    )

  return isBareEntity || (asksForDefinition && knownAIEntity.test(text))
}

function explicitlyDeclinesAccountRepositories(text: string): boolean {
  return (
    /(?:不要|不用|别|不许|禁止|避免|排除)\s*(?:搜索|查找|搜|查看|列出|访问|读取|阅读)?\s*(?:我的|我自己的|我账号的|我账户的|(?:我|本人)(?:通过|已通过|在)).{0,48}(?:github\s*)?(?:仓库|项目|repositories|repository|repos?)/iu.test(
      text
    ) ||
    /\b(?:do not|don't|don’t|dont|without|avoid|exclude)\s+(?:(?:search|find|look up|browse|read|access|list|fetch|inspect|query|show|view)\s+)?(?:my(?: own)?\s+(?:personal\s+)?(?:github\s+)?|(?:my|the)\s+connected\s+github\s+(?:account(?:'s|’s)?\s+)?)(?:repositories|repository|repos?)\b/iu.test(
      text
    )
  )
}

export function targetsAccountRepositories(text: string): boolean {
  const explicitlyTargetsAccount =
    /\bmy(?: own)?\s+(?:github\s+)?(?:repositories|repository|repos?)\b|(?:我的|我自己的|我账号的|我账户的).{0,12}(?:github\s*)?(?:项目|仓库|repositories|repository|repos?)/iu.test(
      text
    ) ||
    /(?:我|本人)(?:通过|已通过|在).{0,24}(?:github\s*)?oauth.{0,16}(?:授权|连接).{0,12}仓库|\b(?:my|the)\s+connected\s+github\s+(?:account(?:'s|’s)?\s+)?(?:repositories|repository|repos?)\b/iu.test(text) ||
    /\bgh\s+repo\b.{0,16}(?:我的|我自己的)项目/iu.test(text)

  return (
    explicitlyTargetsAccount && !explicitlyDeclinesAccountRepositories(text)
  )
}

export function getGitHubReadIntent(
  value: string
): GitHubReadIntent | null {
  const text = value.trim()
  if (/(?:不要|不用|别|禁止|不许)\s*(?:读取|阅读|查看|列出|获取)|\b(?:do not|don't|don’t)\s+(?:read|fetch|list|view|access)\b/iu.test(text)) {
    return null
  }
  if (!text || isQuestionAboutToolBehavior(text) || /(?:项目看板|项目板|github\s+projects\b|project\s+boards?\b)/iu.test(text)) {
    return null
  }

  if (
    /(?:检查|查看|查询|确认|显示|check|show|tell me).{0,30}(?:github|gh|oauth).{0,24}(?:登录|连接|授权状态|授权是否成功|授权成功|状态|status|\bauth\b|connected|logged in|signed in)|(?:github|gh|oauth).{0,24}(?:登录状态|连接状态|授权状态|授权是否成功|授权成功|状态|status|\bauth\b|connected|logged in|signed in).{0,24}(?:吗|么|没|是否|check|show|status)?/iu.test(
      text
    )
  ) {
    return 'status'
  }
  if (
    /(?:issue|issues|工单|议题|问题列表)/iu.test(text) &&
    /(?:查看|列出|搜索|读取|阅读|获取|查|show|list|search|read|fetch|get|look up|check)/iu.test(
      text
    )
  ) {
    return 'issues'
  }
  if (
    /(?:pull\s*requests?|\bprs?\b|拉取请求|合并请求)/iu.test(text) &&
    /(?:查看|列出|搜索|读取|阅读|获取|查|show|list|search|read|fetch|get|look up|check)/iu.test(
      text
    )
  ) {
    return 'pull_requests'
  }
  const mentionsRepositories =
    /(?:github\s*)?(?:仓库|repositories|repository|repos?\b)/iu.test(text) ||
    (/github\s*项目/iu.test(text) && targetsAccountRepositories(text))
  const explicitlyReadsRepositories =
    mentionsRepositories &&
    /(?:查看|看|列出|浏览|获取|读取|阅读|show|list|view|browse|get|read|fetch|inspect)/iu.test(
      text
    ) &&
    !/(?:搜索|搜一下|搜寻|查找|search|find|look up)/iu.test(text)
  if (explicitlyReadsRepositories) {
    return 'repositories'
  }

  if (mentionsRepositories) {
    if (/(?:搜索|搜一下|搜寻|查找|search|find|look up)/iu.test(text)) {
      return 'repository_search'
    }
    if (
      /(?:查看|看|列出|浏览|获取|show|list|view|browse|get)/iu.test(text) ||
      /(?:读取|阅读|read|fetch|inspect)/iu.test(text) ||
      /(?:我的|我自己的|我账号的|my(?: own)?)/iu.test(text)
    ) {
      return 'repositories'
    }
  }
  return null
}

/** A read may target exactly one repository named by the user, never a model guess. */
export function explicitGitHubRepository(text: string): string | null {
  const repositories = new Set<string>()
  for (const match of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/giu)) {
    repositories.add(`${match[1]}/${match[2]}`.toLowerCase())
  }
  const withoutURLs = text.replaceAll(/https?:\/\/[^\s<>]+/giu, ' ')
  for (const match of withoutURLs.matchAll(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/gu)) {
    const candidate = match[0].toLowerCase()
    // Common requested output formats are not an additional repository grant.
    // A real repository with one of these names can still use its explicit URL.
    if (['before/after', 'owner/name', 'ci/cd'].includes(candidate)) continue
    repositories.add(candidate)
  }
  return repositories.size === 1 ? [...repositories][0] ?? null : null
}

export function explicitlyTargetsLocalGitHub(text: string): boolean {
  const targetPattern =
    /(?:在|使用|通过|让|调用|运行|交给|use|via|run|on)[^。.!?！？;；\n]{0,24}(?:本机|本地|我的设备|配对设备|Radxa|A7A|gh\s*CLI|GitHub\s*CLI|terminal|local\s+(?:device|cli|gh)|paired\s+device|desktop)/giu
  for (const match of text.matchAll(targetPattern)) {
    const prefixStart = Math.max(0, (match.index ?? 0) - 16)
    const prefix = text.slice(prefixStart, match.index)
    if (
      /(?:不要|别|不许|禁止|避免|不(?:要求|需要|必)(?:你)?(?:修改文件或)?|do not|don't|dont|avoid)\s*$/iu.test(
        prefix
      )
    ) {
      continue
    }
    return true
  }
  return false
}

function toolIntent(name: string): GitHubReadIntent | null {
  if (name === 'github.oauth.auth.status' || name === 'github.auth.status') {
    return 'status'
  }
  if (
    name === 'github.oauth.repositories.list'
  ) {
    return 'repositories'
  }
  if (
    name === 'github.oauth.repositories.search' ||
    name === 'github.repositories.search'
  ) {
    return 'repository_search'
  }
  if (name === 'github.oauth.issues.list' || name === 'github.issues.list') {
    return 'issues'
  }
  if (
    name === 'github.oauth.pull_requests.list' ||
    name === 'github.pull_requests.list'
  ) {
    return 'pull_requests'
  }
  return null
}

export function shouldRunGitHubTool(
  call: ChatCompletionToolCall,
  messages: ChatCompletionMessage[],
  source: 'oauth' | 'local'
): boolean {
  const request = source === 'oauth'
    ? browserGitHubReadRequestText(messages)
    : latestUserText(messages)
  const intent = getGitHubReadIntent(request)
  if (!intent || toolIntent(call.function.name) !== intent) return false
  if (
    source === 'oauth' && request !== latestUserText(messages) &&
    (intent === 'issues' || intent === 'pull_requests')
  ) {
    const repository = explicitGitHubRepository(request)
    try {
      const args: unknown = JSON.parse(call.function.arguments)
      if (!repository || !args || typeof args !== 'object' || !('repo' in args) ||
        typeof args.repo !== 'string' || args.repo.toLowerCase() !== repository.toLowerCase()) {
        return false
      }
    } catch {
      return false
    }
  }
  if (
    intent === 'repository_search' &&
    explicitlyRequestsBrowserWebSearch(request) &&
    !targetsAccountRepositories(request)
  ) {
    return false
  }
  if (intent === 'repositories' && call.function.name === 'github.oauth.repositories.list') {
    return targetsAccountRepositories(request)
  }
  const localRequested = explicitlyTargetsLocalGitHub(request)
  return source === 'local' ? localRequested : !localRequested
}

/**
 * Local and paired-device tools must match the user's latest request. A model
 * proposing a tool is not enough: generic questions must never touch a user's
 * private desktop or headless node.
 */
export function shouldRunLocalAgentTool(
  name: string,
  messages: ChatCompletionMessage[]
): boolean {
  const text = latestUserText(messages)
  if (!text || isQuestionAboutToolBehavior(text)) return false

  // Website OAuth tools do not require a paired device or its gh login.
  if (name.startsWith('github.oauth.')) return false

  if (name.startsWith('github.')) {
    return shouldRunGitHubTool(
      {
        id: 'local-intent-check',
        type: 'function',
        function: { name, arguments: '{}' },
      },
      messages,
      'local'
    )
  }

  const action =
    /(?:列出|浏览|查看|显示|读取|预览|打开|检查|搜索|查找|找到|定位|追踪|分析|list|browse|show|read|preview|open|inspect|check|search|find|trace|explore|analy[sz]e)/iu.test(
      text
    )
  const workspaceTarget =
    /(?:工作区|工作目录|当前项目|当前仓库|当前目录|本地项目|本地仓库|本地目录|项目目录|代码库|仓库|workspace|worktree|repository|\brepo\b|project)/iu.test(
      text
    )
  const fileTarget =
    /(?:文件|目录|文件夹|路径|files?|directory|folder|path|\.[a-z0-9]{1,8}\b|[\\/])/iu.test(
      text
    )

  switch (name) {
    case 'developer.tools.status':
      return action &&
        /(?:开发工具|工具|cli|命令行|installed|available|tools?)/iu.test(
          text
        )
    case 'files.browse':
    case 'agent.workspace.list':
    case 'agent.workspace.browse':
      return action && workspaceTarget && fileTarget
    case 'files.preview':
    case 'agent.workspace.preview':
      return fileTarget &&
        /(?:读取|预览|打开|查看|read|preview|open|inspect)/iu.test(text) &&
        (workspaceTarget || /\.[a-z0-9]{1,8}\b/iu.test(text))
    case 'vcs.history':
      return /(?:提交|commit|变更|更改|历史|history|git\s+log|jj\s+log)/iu.test(
        text
      ) &&
        (workspaceTarget || /(?:git\s+log|jj\s+log)/iu.test(text)) &&
        (action || /(?:git\s+log|jj\s+log)/iu.test(text))
    case 'code.search':
      return action && workspaceTarget &&
        /(?:代码|源码|函数|符号|实现|code|source|function|symbol|identifier|bug|error|defect|错误|缺陷|报错)/iu.test(
          text
        )
    case 'code.graph':
      return workspaceTarget &&
        /(?:调用链|调用关系|依赖关系|符号关系|影响范围|引用关系|codegraph|call\s+graph|dependency\s+graph|symbol\s+graph|callers?)/iu.test(
        text
      )
    default:
      if (name.startsWith('mcp.')) {
        return /\bmcp\b/iu.test(text) &&
          /(?:调用|使用|运行|执行|call|use|invoke|run)/iu.test(text)
      }
      // Unknown local tools fail closed until an explicit intent mapping is
      // added for them.
      return false
  }
}

export function shouldAdvertiseBrowserGitHubTool(
  name: string,
  messages: ChatCompletionMessage[],
  bridgeConnected: boolean
): boolean {
  const request = browserGitHubReadRequestText(messages)
  const intent = getGitHubReadIntent(request)
  if (!intent || toolIntent(name) !== intent) return false
  if (
    intent === 'repository_search' &&
    explicitlyRequestsBrowserWebSearch(request) &&
    !targetsAccountRepositories(request)
  ) {
    return false
  }
  const localRequested = explicitlyTargetsLocalGitHub(request)
  if (name === 'github.oauth.repositories.list') {
    return targetsAccountRepositories(request)
  }
  if (name.startsWith('github.oauth.')) {
    return !localRequested || !bridgeConnected
  }
  if (name.startsWith('github.')) {
    return localRequested && bridgeConnected
  }
  return false
}

export function shouldRunWebResearchTool(
  call: ChatCompletionToolCall,
  messages: ChatCompletionMessage[]
): boolean {
  const text = latestUserText(messages)
  const name = call.function.name
  if (isQuestionAboutToolBehavior(text)) return false

  if (name === 'web.fetch') {
    return (
      containsPublicPageUrlReference(text) &&
      !explicitlyDeclinesPageRead(text)
    )
  }

  if (name === 'web.crawl' && explicitlyDeclinesPageRead(text)) return false
  if (explicitlyDeclinesWebResearch(text)) return false

  const githubIntent = getGitHubReadIntent(text)
  if (
    githubIntent &&
    !(
      githubIntent === 'repository_search' &&
      name === 'web.search' &&
      explicitlyRequestsBrowserWebSearch(text) &&
      !targetsAccountRepositories(text)
    )
  ) {
    return false
  }
  switch (name) {
    case 'web.search':
      return /(?:搜索|搜一下|查找资料|网上查|网页搜索|研究一下|调研|找项目|探索项目|发现项目|research|web search|search the web|search online|look up online|find interesting|discover projects|latest|current|recent|today|right now|price|release notes|最新|近期|当前版本|当前价格|今天|今日|实时|现在的价格)/iu.test(
        text
      ) || requestsKnownAIEntityDefinition(text)
    case 'web.crawl':
      return /https:\/\//iu.test(text) &&
        /(?:爬取|抓取|遍历|crawl|spider|follow links)/iu.test(text)
    default:
      return false
  }
}

export function shouldRunWebAgentTool(
  call: ChatCompletionToolCall,
  messages: ChatCompletionMessage[]
): boolean {
  const intent = toolIntent(call.function.name)
  if (intent) return shouldRunGitHubTool(call, messages, 'oauth')
  return shouldRunWebResearchTool(call, messages)
}

export function latestUserRequestText(
  messages: ChatCompletionMessage[]
): string {
  return latestUserText(messages)
}

export type PendingRepositoryChoices = {
  intent: 'issues' | 'pull_requests'
  returnedCount: number
  repositories: Array<{ full_name: string; html_url: string }>
  executionContext: string
}

export function readPendingGitHubRepositoryChoices(
  messages: ChatCompletionMessage[]
): PendingRepositoryChoices | undefined {
  let latestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestUserIndex = index
      break
    }
  }
  let assistantIndex = latestUserIndex - 1
  while (assistantIndex >= 0 && messages[assistantIndex]?.role !== 'assistant') assistantIndex -= 1
  const recordMessage = messages[assistantIndex + 1]
  if (recordMessage?.role !== 'system' || recordMessage.name !== 'lain42_execution_record' ||
    typeof recordMessage.content !== 'string' || new TextEncoder().encode(recordMessage.content).byteLength > 4608) {
    return undefined
  }

  const json = recordMessage.content.split('\n').find((line) => line.startsWith('{'))
  if (!json || new TextEncoder().encode(json).byteLength > 4096) return undefined
  try {
    const record: unknown = JSON.parse(json)
    if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
    const value = record as Record<string, unknown>
    const parameters = value.parameters
    if (value.source !== 'website GitHub OAuth' || value.resource !== 'repositories' ||
      value.scope !== 'this page only' || value.outcome !== 'read completed' || value.local_gh_used !== false ||
      (value.pending_intent !== 'issues' && value.pending_intent !== 'pull_requests') ||
      value.repository_order !== 'updated' ||
      !Number.isSafeInteger(value.returned_count) || Number(value.returned_count) < 1 || Number(value.returned_count) > 10 ||
      typeof value.fetched_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value.fetched_at) ||
      !parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
      !Number.isSafeInteger((parameters as Record<string, unknown>).limit) ||
      Number((parameters as Record<string, unknown>).limit) < 1 || Number((parameters as Record<string, unknown>).limit) > 20 ||
      !Array.isArray(value.repository_choices) || value.repository_choices.length < 1 ||
      value.repository_choices.length > Number(value.returned_count) || value.repository_choices.length > 10) return undefined

    const repositories: PendingRepositoryChoices['repositories'] = []
    for (const choice of value.repository_choices) {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return undefined
      const entry = choice as Record<string, unknown>
      if (typeof entry.full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.full_name) ||
        typeof entry.html_url !== 'string') return undefined
      const url = new URL(entry.html_url)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password ||
        url.search || url.hash || url.pathname.toLowerCase() !== `/${entry.full_name}`.toLowerCase()) return undefined
      repositories.push({ full_name: entry.full_name, html_url: url.toString() })
    }
    return { intent: value.pending_intent, returnedCount: Number(value.returned_count), repositories, executionContext: json }
  } catch {
    return undefined
  }
}

function selectedRepositoryFromChoices(
  messages: ChatCompletionMessage[]
): { intent: 'issues' | 'pull_requests'; repository: string } | undefined {
  const choices = readPendingGitHubRepositoryChoices(messages)
  if (!choices) return undefined
  const latest = latestUserText(messages).trim()
  const numeric = /^(?:第\s*)?(\d{1,2})(?:\s*(?:个|项|号|[.)]))?$/u.exec(latest) ??
    /^(?:我选|选|选择|就选)\s*(?:第\s*)?(\d{1,2})(?:\s*(?:个|项|号))?$/u.exec(latest)
  const chineseOrdinal = /^(?:我选|选|选择|就选)?\s*第?([一二三四五六七八九十])(?:个|项|号)?$/u.exec(latest)
  const chineseNumbers: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  }
  const explicit = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/iu.exec(latest)
  let choiceNumber: number | undefined
  if (numeric?.[1]) choiceNumber = Number(numeric[1])
  else if (chineseOrdinal?.[1]) choiceNumber = chineseNumbers[chineseOrdinal[1]]
  const selected = choiceNumber !== undefined
    ? choices.repositories[choiceNumber - 1]
    : choices.repositories.find((repository) => repository.full_name.toLowerCase() === explicit?.[1]?.toLowerCase())
  return selected ? { intent: choices.intent, repository: selected.full_name } : undefined
}

/** Preserve a user's immediate read request, without inheriting device or attachment authorization. */
export function browserGitHubReadRequestText(messages: ChatCompletionMessage[]): string {
  const latest = latestUserText(messages)
  const selection = selectedRepositoryFromChoices(messages)
  if (selection) {
    return `读取 ${selection.repository} 的 ${selection.intent === 'issues' ? 'issues' : 'pull requests'}`
  }
  if (getGitHubReadIntent(latest)) return latest
  const continuesReading =
    /^(?:请|麻烦)?(?:你(?:自己|来)?|继续|接着)?(?:阅读|读取|查看|读)(?:一下|吧)?[。.!！?？]*$/u.test(latest) ||
    /^(?:please\s+)?(?:read|check)(?:\s+(?:it|them))?(?:\s+(?:yourself|again))?[.!?]*$/iu.test(latest)
  if (!continuesReading) return latest

  const autonomousRead =
    /^(?:请|麻烦)?(?:你自己|你来|你)(?:阅读|读取|查看|读)(?:一下|吧)?[。.!！?？]*$/u.test(latest) ||
    /^(?:please\s+)?read(?:\s+(?:it|them))?\s+yourself[.!?]*$/iu.test(latest)
  const pendingChoices = readPendingGitHubRepositoryChoices(messages)
  const preferredRepository = pendingChoices?.repositories[0]
  if (autonomousRead && pendingChoices && preferredRepository) {
    return `读取 ${preferredRepository.full_name} 的 ${pendingChoices.intent === 'issues' ? 'issues' : 'pull requests'}`
  }

  let foundLatest = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (!foundLatest) {
      if (Array.isArray(message.content) && (message.content.length !== 1 || message.content[0]?.type !== 'text')) {
        return latest
      }
      foundLatest = true
      continue
    }
    const previous = latestUserText([message])
    if (explicitlyTargetsLocalGitHub(previous) || /(?:不要|不用|无需|别|禁止|do not|don't|without)/iu.test(previous)) {
      return latest
    }
    const intent = getGitHubReadIntent(previous)
    if (intent === 'repositories' && targetsAccountRepositories(previous)) return previous
    if ((intent === 'issues' || intent === 'pull_requests') &&
      (explicitGitHubRepository(previous) || targetsAccountRepositories(previous))) {
      return previous
    }
    return latest
  }
  return latest
}

export function shouldAdvertiseWebAgentTool(
  name: string,
  messages: ChatCompletionMessage[]
): boolean {
  if (toolIntent(name)) {
    return shouldAdvertiseBrowserGitHubTool(name, messages, false)
  }
  return shouldRunWebAgentTool(
    {
      id: 'routing-check',
      type: 'function',
      function: { name, arguments: '{}' },
    },
    messages
  )
}
