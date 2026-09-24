import type {
  ChatCompletionMessage,
  ChatCompletionToolCall,
} from '@/features/playground/types'

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

export function getGitHubReadIntent(
  value: string
): GitHubReadIntent | null {
  const text = value.trim()
  if (!text || isQuestionAboutToolBehavior(text)) {
    return null
  }

  if (
    /(?:检查|查看|查询|确认|显示|check|show|tell me).{0,30}(?:github|gh|oauth).{0,24}(?:登录|连接|授权|状态|status|auth|connected|logged in|signed in)|(?:github|gh|oauth).{0,24}(?:登录|连接|授权|状态|status|auth|connected|logged in|signed in).{0,24}(?:吗|么|没|是否|check|show|status)?/iu.test(
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
  const mentionsRepositories =
    /(?:github\s*)?(?:仓库|repositories|repository|repos?\b)/iu.test(text)
  if (mentionsRepositories) {
    if (/(?:搜索|搜一下|搜寻|查找|search|find|look up)/iu.test(text)) {
      return 'repository_search'
    }
    if (/(?:查看|列出|浏览|获取|show|list|view|browse|get)/iu.test(text)) {
      return 'repositories'
    }
  }
  return null
}

export function explicitlyTargetsLocalGitHub(text: string): boolean {
  return /(?:在|使用|通过|让|调用|运行|交给|use|via|run|on).{0,24}(?:本机|本地|我的设备|配对设备|Radxa|A7A|gh\s*CLI|GitHub\s*CLI|terminal|local\s+(?:device|cli|gh)|paired\s+device|desktop)/iu.test(
    text
  )
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
  if (intent === 'repositories' && call.function.name === 'github.oauth.repositories.list') {
    return true
  }
  const localRequested = explicitlyTargetsLocalGitHub(request)
  return source === 'local' ? localRequested : !localRequested
}

export function shouldAdvertiseBrowserGitHubTool(
  name: string,
  messages: ChatCompletionMessage[],
  bridgeConnected: boolean
): boolean {
  const request = latestUserText(messages)
  const intent = getGitHubReadIntent(request)
  if (!intent || toolIntent(name) !== intent) return false
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
  if (isQuestionAboutToolBehavior(text) || getGitHubReadIntent(text)) return false
  switch (call.function.name) {
    case 'web.search':
      return /(?:搜索|搜一下|查找资料|网上查|网页搜索|研究一下|调研|找项目|探索项目|发现项目|research|web search|search the web|search online|look up online|find interesting|discover projects|latest|current|recent|today|right now|price|release notes|最新|近期|当前版本|当前价格|今天|今日|实时|现在的价格)/iu.test(
        text
      )
    case 'web.fetch':
      return /https:\/\//iu.test(text) &&
        /(?:阅读|读取|打开看看|总结|概括|分析|提取|read|open|summari[sz]e|analy[sz]e|fetch|inspect)/iu.test(
          text
        )
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

export function shouldAdvertiseWebAgentTool(
  name: string,
  messages: ChatCompletionMessage[]
): boolean {
  return shouldRunWebAgentTool(
    {
      id: 'routing-check',
      type: 'function',
      function: { name, arguments: '{}' },
    },
    messages
  )
}
