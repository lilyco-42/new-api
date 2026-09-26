import type {
  ChatCompletionMessage,
  ChatCompletionToolCall,
} from '@/features/playground/types'
import {
  containsPublicPageUrlReference,
  extractPublicPageUrlReferences,
  normalizePublicPageUrlInput,
} from '@/features/playground/lib/input/search-context'

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
      return message.content
        .map((part) => (part.type === 'text' ? part.text ?? '' : ''))
        .join('\n')
        .trim()
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

function explicitlyRequestsBrowserWebSearch(text: string): boolean {
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
    /(?:不要|别|不许|禁止|避免|排除)\s*(?:搜索|查找|搜|查看|访问|读取)?\s*(?:我的|我自己的|我账号的|我账户的).{0,8}(?:github\s*)?(?:仓库|repositories|repository|repos?)/iu.test(
      text
    ) ||
    /\b(?:do not|don't|dont|without|avoid|exclude)\s+(?:(?:search|find|look up|browse|read|access)\s+)?my(?: own)?\s+(?:personal\s+)?(?:github\s+)?(?:repositories|repository|repos?)\b/iu.test(
      text
    )
  )
}

function targetsAccountRepositories(text: string): boolean {
  const explicitlyTargetsAccount =
    /\bmy(?: own)?\s+(?:github\s+)?(?:repositories|repository|repos?)\b|(?:我的|我自己的|我账号的|我账户的).{0,12}(?:github\s*)?(?:仓库|repositories|repository|repos?)|我通过网站\s*GitHub\s*OAuth\s*授权的仓库|\bgh\s+repo\s+我的项目/iu.test(
      text
    )

  return (
    explicitlyTargetsAccount && !explicitlyDeclinesAccountRepositories(text)
  )
}

export function getGitHubReadIntent(
  value: string
): GitHubReadIntent | null {
  const text = value.trim()
  if (!text || isQuestionAboutToolBehavior(text)) {
    return null
  }

  const mentionsRepositories =
    /(?:github\s*)?(?:仓库|repositories|repository|repos?\b)/iu.test(text)
  if (
    /(?:检查|查看|查询|确认|显示|check|show|tell me).{0,30}(?:github|gh|oauth).{0,24}(?:登录|连接|授权状态|授权是否成功|授权成功|状态|status|\bauth\b|connected|logged in|signed in)|(?:github|gh|oauth).{0,24}(?:登录状态|连接状态|授权状态|授权是否成功|授权成功|状态|status|\bauth\b|connected|logged in|signed in).{0,24}(?:吗|么|没|是否|check|show|status)?/iu.test(
      text
    )
  ) {
    return 'status'
  }
  if (
    /(?:issue|issues|工单|议题|问题列表)/iu.test(text) &&
    /(?:查看|列出|搜索|读取|获取|查|show|list|search|read|fetch|get|look up|check)/iu.test(
      text
    )
  ) {
    return 'issues'
  }
  if (
    /(?:pull\s*requests?|\bprs?\b|拉取请求|合并请求)/iu.test(text) &&
    /(?:查看|列出|搜索|读取|获取|查|show|list|search|read|fetch|get|look up|check)/iu.test(
      text
    )
  ) {
    return 'pull_requests'
  }
  // An explicit page URL identifies a particular public page. It must never
  // trigger a listing of the signed-in user's (possibly private) repositories.
  if (containsPublicPageUrlReference(text)) return null

  if (mentionsRepositories) {
    if (/(?:搜索|搜一下|搜寻|查找|search|find|look up)/iu.test(text)) {
      return 'repository_search'
    }
    if (targetsAccountRepositories(text)) {
      return 'repositories'
    }
  }
  return null
}

export function explicitlyTargetsLocalGitHub(text: string): boolean {
  const targetPattern =
    /(?:在|使用|通过|让|调用|运行|交给|use|via|run|on).{0,24}(?:本机|本地|我的设备|配对设备|Radxa|A7A|gh\s*CLI|GitHub\s*CLI|terminal|local\s+(?:device|cli|gh)|paired\s+device|desktop)/giu
  for (const match of text.matchAll(targetPattern)) {
    const prefixStart = Math.max(0, (match.index ?? 0) - 16)
    const prefix = text.slice(prefixStart, match.index)
    if (
      /(?:不要|别|不许|禁止|避免|do not|don't|dont|avoid)\s*$/iu.test(
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
  const request = latestUserText(messages)
  const intent = getGitHubReadIntent(request)
  if (!intent || toolIntent(call.function.name) !== intent) return false
  if (
    intent === 'repository_search' &&
    explicitlyRequestsBrowserWebSearch(request) &&
    !targetsAccountRepositories(request)
  ) {
    return false
  }
  if (intent === 'repositories' && call.function.name === 'github.oauth.repositories.list') {
    return true
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
  const request = latestUserText(messages)
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
    return intent === 'repositories'
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

  if (name === 'web.fetch' || name === 'web.crawl') {
    if (explicitlyDeclinesPageRead(text)) return false
    if (
      name === 'web.crawl' &&
      !/(?:爬取|抓取|遍历|crawl|spider|follow links)/iu.test(text)
    ) {
      return false
    }
    let args: unknown
    try {
      args = JSON.parse(call.function.arguments)
    } catch {
      return false
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false
    const url = (args as { url?: unknown }).url
    if (typeof url !== 'string') return false
    const toolUrl = normalizePublicPageUrlInput(url)
    if (!toolUrl) return false
    const normalizedToolUrl = new URL(toolUrl)
    normalizedToolUrl.hash = ''
    return (
      extractPublicPageUrlReferences(text).some((reference) => {
        const normalizedReference = new URL(reference)
        normalizedReference.hash = ''
        return normalizedReference.href === normalizedToolUrl.href
      })
    )
  }

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

export function shouldAdvertiseWebAgentTool(
  name: string,
  messages: ChatCompletionMessage[]
): boolean {
  // Advertisement has no model-supplied arguments yet. Use one of the
  // user's own URLs as a probe so the strict execution-time URL match does
  // not hide the fetch tool before the model can call it. Execution still
  // validates the actual requested URL against every URL in the user turn.
  const args: Record<string, string> = {}
  if (name === 'web.fetch' || name === 'web.crawl') {
    const [userUrl] = extractPublicPageUrlReferences(latestUserText(messages))
    if (userUrl) args.url = userUrl
  }

  return shouldRunWebAgentTool(
    {
      id: 'routing-check',
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
    messages
  )
}
