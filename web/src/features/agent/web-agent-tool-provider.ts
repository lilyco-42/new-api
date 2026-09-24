import type {
  ChatCompletionMessage,
  ChatCompletionResponse,
  ChatCompletionTool,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'
import { api } from '@/lib/api'

import {
  crawlClientSite,
  fetchClientPage,
  searchClientSources,
  type ClientSearchScope,
} from './client-crawler/client-crawler'
import {
  explicitlyTargetsLocalGitHub,
  getGitHubReadIntent,
  latestUserRequestText,
  shouldAdvertiseBrowserGitHubTool,
  shouldAdvertiseWebAgentTool,
  shouldRunGitHubTool,
  shouldRunLocalAgentTool,
  shouldRunWebAgentTool,
} from './agent-tool-routing'
import { combineLocalToolProviders } from './mcp-tool-provider'

const WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web.search',
    description:
      'Search supported public indexes directly from the user’s browser. Use this to ground definitions of named AI providers/models (including a bare provider name such as “DeepSeek”) and general technical discovery. Auto mode searches GitHub repositories and Hugging Face models; OpenAlex is used only for explicit paper/research queries. Use returned sources to answer, and do not invent details when results are missing or unrelated. This is not general web search; RustCC, CodeReset, GHFind, blogs, and community pages are not indexed. Search requests are not sent to the Lain42 server.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'A public-source search query.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          default: 5,
        },
        scope: {
          type: 'string',
          enum: ['auto', 'github', 'huggingface', 'papers', 'all'],
          default: 'auto',
          description:
            'Choose auto for intent-based routing; use papers only for scholarly material, or all when the user asks to search every supported index.',
        },
      },
      required: ['query'],
    },
  },
}

const WEB_FETCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web.fetch',
    description:
      'Read a public HTTPS page from the user’s browser with the client-side WASM parser. Use this when the user pastes a URL alone or asks to inspect a URL; the extracted page text is returned to the selected model. No cookies are sent and no page fetch is proxied by Lain42; the site must allow browser cross-origin access (CORS).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description: 'The public HTTPS page URL to read.',
        },
      },
      required: ['url'],
    },
  },
}

const WEB_CRAWL_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web.crawl',
    description:
      'Run a bounded crawl on the user’s browser using the client-side WASM parser. Start from a public HTTPS URL, follow only same-origin links, read at most five pages, send no cookies, and do not route page requests through the Lain42 server. The site must allow browser cross-origin access (CORS).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description:
            'The public HTTPS URL where the client-side crawl starts.',
        },
        query: {
          type: 'string',
          maxLength: 200,
          description: 'Optional terms used to rank matching excerpts.',
        },
        max_pages: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          default: 3,
        },
      },
      required: ['url'],
    },
  },
}

const GITHUB_STATUS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.oauth.auth.status',
    description:
      'Check the browser GitHub OAuth connection without exposing its token.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
}

const GITHUB_REPOSITORY_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.oauth.repositories.search',
    description:
      'Search public and authorized GitHub repositories from the linked account.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
      required: ['query'],
    },
  },
}

const GITHUB_REPOSITORY_LIST_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.oauth.repositories.list',
    description:
      'List repositories accessible to the connected GitHub account, including private repositories allowed by its OAuth scope.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
    },
  },
}

const GITHUB_ACTIVITY_PROPERTIES = {
  repo: {
    type: 'string',
    pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
    description: 'Repository in owner/name form.',
  },
  state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
  limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
  sort: { type: 'string', enum: ['updated', 'created'], default: 'updated' },
}

const GITHUB_ISSUES_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.oauth.issues.list',
    description:
      'Read recently updated issues from a public or authorized GitHub repository.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: GITHUB_ACTIVITY_PROPERTIES,
      required: ['repo'],
    },
  },
}

const GITHUB_PULL_REQUESTS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.oauth.pull_requests.list',
    description:
      'Read pull requests from a public or authorized GitHub repository.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: GITHUB_ACTIVITY_PROPERTIES,
      required: ['repo'],
    },
  },
}

export const WEB_AGENT_TOOLS: ChatCompletionTool[] = [
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  WEB_CRAWL_TOOL,
  GITHUB_STATUS_TOOL,
  GITHUB_REPOSITORY_LIST_TOOL,
  GITHUB_REPOSITORY_SEARCH_TOOL,
  GITHUB_ISSUES_TOOL,
  GITHUB_PULL_REQUESTS_TOOL,
]

function localPreflightResponse(
  id: string,
  content: string
): ChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created: Date.now(),
    model: 'local-preflight',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  }
}

function formatGitHubRepositories(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'GitHub OAuth 返回了无法识别的仓库列表，请稍后重试。'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'GitHub OAuth 返回了无法识别的仓库列表，请稍后重试。'
  }
  const outer = parsed as Record<string, unknown>
  const data =
    outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
      ? (outer.data as Record<string, unknown>)
      : outer
  const values = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.repositories)
      ? data.repositories
      : null
  if (!values) {
    return 'GitHub OAuth 没有返回仓库列表，请稍后重试。'
  }
  const repositories = values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const repository = value as Record<string, unknown>
    const fullName = repository.full_name
    if (
      typeof fullName !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) ||
      fullName.split('/').some((part) => part === '.' || part === '..')
    ) {
      return []
    }
    const visibility = repository.private === true ? '私有' : '公开'
    const stars =
      typeof repository.stargazers_count === 'number' &&
      Number.isFinite(repository.stargazers_count)
        ? ` · ★ ${Math.max(0, Math.trunc(repository.stargazers_count))}`
        : ''
    return [`- [${fullName}](https://github.com/${fullName})（${visibility}${stars}）`]
  })
  if (repositories.length === 0) {
    return 'GitHub OAuth 读取成功，但当前账号没有可访问的仓库。'
  }
  return [
    `已通过连接的 GitHub OAuth 获取到 ${repositories.length} 个仓库：`,
    '',
    ...repositories,
  ].join('\n')
}

function hasConnectedOAuthCliLoginConfusion(text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ')
  const oauthConnected =
    /oauth.{0,48}(?:connected|已连接|连接成功)|(?:已连接|连接成功).{0,24}oauth/iu.test(
      normalized
    )
  const cliLoginClaim =
    /(?:gh\s*cli|github\s*cli|github命令行).{0,48}(?:not\s+(?:logged|signed)\s+in|not authenticated|未登录|没(?:有)?登录|还没(?:有)?登录|尚未登录)/iu.test(
      normalized
    )
  const repositoryContext =
    /(?:repository|repositories|\brepos?\b|仓库|代码库)/iu.test(normalized)
  return oauthConnected && cliLoginClaim && repositoryContext
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function parseArguments(call: ChatCompletionToolCall): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(call.function.arguments)
  } catch {
    throw new Error(`Arguments for ${call.function.name} must be valid JSON.`)
  }
  return asRecord(value)
}

function readResponseData<T>(value: unknown): T {
  if (!value || typeof value !== 'object') {
    throw new Error('Agent tool returned an invalid response.')
  }
  const response = value as { success?: boolean; data?: T; message?: string }
  if (response.success === false) {
    throw new Error(response.message || 'Agent tool request failed.')
  }
  return response.data as T
}

function boundedLimit(
  value: unknown,
  fallback: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return fallback
  }
  return Math.max(1, Math.min(maximum, value))
}

function queryString(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`${label} must contain 1–${max} characters.`)
  }
  return value.trim()
}

function readRepository(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.trim())
  ) {
    throw new Error('Repository must use owner/name form.')
  }
  return value.trim()
}

function readPublicPageURL(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2048) {
    throw new Error('Page URL must contain 1–2048 characters.')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Page URL must be an absolute HTTP(S) URL.')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.port !== '' && parsed.port !== '443')
  ) {
    throw new Error('Page URL must use public HTTPS on the default port.')
  }
  parsed.hash = ''
  return parsed.toString()
}

function parseToolArguments(
  call: ChatCompletionToolCall
): Record<string, unknown> {
  const params = parseArguments(call)
  switch (call.function.name) {
    case 'web.search': {
      const allowed = new Set(['query', 'limit', 'scope'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error('Unsupported web.search argument.')
      }
      const scope = params.scope ?? 'auto'
      if (
        typeof scope !== 'string' ||
        !['auto', 'github', 'huggingface', 'papers', 'all'].includes(scope)
      ) {
        throw new Error(
          'Search scope must be auto, github, huggingface, papers, or all.'
        )
      }
      return {
        query: queryString(params.query, 'Search query'),
        limit: boundedLimit(params.limit, 5, 8),
        scope,
      }
    }
    case 'web.fetch': {
      const allowed = new Set(['url'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error('Unsupported web.fetch argument.')
      }
      return { url: readPublicPageURL(params.url) }
    }
    case 'web.crawl': {
      const allowed = new Set(['url', 'query', 'max_pages'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error('Unsupported web.crawl argument.')
      }
      if (params.query !== undefined && typeof params.query !== 'string') {
        throw new Error('Crawl query must be text.')
      }
      const query = (params.query as string | undefined)?.trim() || ''
      if (query.length > 200) {
        throw new Error('Crawl query must contain at most 200 characters.')
      }
      return {
        url: readPublicPageURL(params.url),
        query,
        max_pages: boundedLimit(params.max_pages, 3, 5),
      }
    }
    case 'github.oauth.auth.status':
      if (Object.keys(params).length > 0) {
        throw new Error('GitHub auth status does not accept arguments.')
      }
      return {}
    case 'github.oauth.repositories.list': {
      const allowed = new Set(['limit'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error('Unsupported GitHub repository list argument.')
      }
      return { limit: boundedLimit(params.limit, 10, 20) }
    }
    case 'github.oauth.repositories.search': {
      const allowed = new Set(['query', 'limit'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error('Unsupported GitHub repository argument.')
      }
      return {
        query: queryString(params.query, 'Repository query'),
        limit: boundedLimit(params.limit, 10, 20),
      }
    }
    case 'github.oauth.issues.list':
    case 'github.oauth.pull_requests.list': {
      const allowed = new Set(['repo', 'state', 'limit', 'sort'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error(`Unsupported ${call.function.name} argument.`)
      }
      const state = params.state ?? 'open'
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        throw new Error('GitHub state must be open, closed, or all.')
      }
      const sort = params.sort ?? 'updated'
      if (sort !== 'updated' && sort !== 'created') {
        throw new Error('GitHub sort must be updated or created.')
      }
      return {
        repo: readRepository(params.repo),
        state,
        sort,
        limit: boundedLimit(params.limit, 10, 20),
      }
    }
    default:
      throw new Error(
        `Tool is not available in the browser: ${call.function.name}.`
      )
  }
}

async function invokeApi(
  path: string,
  params: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) {
    throw new DOMException('The tool was cancelled.', 'AbortError')
  }
  const response = await api.get(path, {
    params,
    signal,
    skipErrorHandler: true,
  })
  return JSON.stringify(readResponseData(response.data))
}

export const webAgentToolProvider: LocalToolProvider = {
  tools: WEB_AGENT_TOOLS,
  isAvailable: () => true,
  shouldRunTool: (call, messages) => shouldRunWebAgentTool(call, messages),
  preflight: (messages) => {
    let latestUserMessage: ChatCompletionMessage | undefined
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') {
        latestUserMessage = messages[index]
        break
      }
    }
    const content = latestUserMessage?.content
    let text = ''
    if (typeof content === 'string') {
      text = content.trim()
    } else if (
      Array.isArray(content) &&
      content.every((part) => part.type === 'text')
    ) {
      text = content
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()
    }
    if (hasConnectedOAuthCliLoginConfusion(text)) {
      const clarification = /[\u3400-\u9fff]/u.test(text)
        ? '按你贴出的状态，网站 GitHub OAuth 已连接。浏览器里的 GitHub 仓库列表和搜索应直接使用这个 OAuth 连接，不要求本机 gh CLI 登录。`gh auth login` 只用于你明确要求配对设备执行本地 GitHub CLI 命令时。之前把网站 OAuth 和本机 CLI 混为一谈的解释是错的；如果网站查询仍失败，应检查 OAuth 请求本身的错误，而不是让你去登录本机 CLI。'
        : 'Based on the status you shared, website GitHub OAuth is connected. Repository lists and searches in this browser should use that OAuth connection; they do not require signing in to the local gh CLI. `gh auth login` is only needed when you explicitly ask a paired device to run a local GitHub CLI command. The earlier explanation mixed up website OAuth with local CLI authentication. If a website query still fails, the OAuth request itself needs investigation; signing in to the local CLI is not the fix.'
      return localPreflightResponse(
        'local-github-oauth-cli-clarification',
        clarification
      )
    }

    if (/^\p{N}+$/u.test(text)) {
      return localPreflightResponse(
        'local-ambiguous-number',
        `你发来的是一个数字（${text}）。你希望我帮你做什么？可以补充计算、编号查询或相关背景。`
      )
    }

    const normalized = text.toLocaleLowerCase().replace(/\s+/gu, ' ')
    if (
      normalized.length <= 48 &&
      /(?:刚才|刚刚|之前).{0,18}(?:问候|问好|打招呼)|(?:我只是|我就只是|我刚才只是).{0,18}(?:问候|问好|打招呼)/u.test(
        normalized
      )
    ) {
      return localPreflightResponse(
        'local-greeting-correction',
        '抱歉，刚才答偏了。你好！我在这里，会先回应你当前这条消息。'
      )
    }

    if (
      /^(?:hi|hello|hey|hiya|你好|您好|嗨|哈喽|早安|早上好|晚上好|晚安|在吗)[!！,.，。?？~～]*$/iu.test(
        normalized
      )
    ) {
      const greeting = /^(?:hi|hello|hey|hiya)\b/iu.test(normalized)
        ? "Hi! I'm here. What would you like help with?"
        : '你好！我在这里，可以帮你查资料、看代码或处理其他问题。你想先做什么？'
      return localPreflightResponse('local-greeting', greeting)
    }

    if (/^[?？!！.,，。…~～\s]+$/u.test(text)) {
      return localPreflightResponse(
        'local-ambiguous-message',
        '我看到你发的是一个标点。你想继续刚才的话题，还是有新的问题？'
      )
    }

    if (
      normalized.length <= 64 &&
      /(?:你在干嘛|你在干什么|我问你话|答非所问|回答跑题)/u.test(normalized)
    ) {
      return localPreflightResponse(
        'local-conversation-repair',
        '抱歉，刚才没有接住你当前的问题。我会以你最新发来的内容为准；你可以直接告诉我想继续哪件事。'
      )
    }

    return null
  },
  beforeModel: async (messages, signal) => {
    const request = latestUserRequestText(messages)
    if (
      getGitHubReadIntent(request) !== 'repositories' ||
      explicitlyTargetsLocalGitHub(request)
    ) {
      return null
    }
    try {
      const result = await webAgentToolProvider.invoke(
        {
          id: 'github-repository-preflight',
          type: 'function',
          function: {
            name: 'github.oauth.repositories.list',
            arguments: '{"limit":10}',
          },
        },
        signal
      )
      return localPreflightResponse(
        'browser-github-oauth-repositories',
        formatGitHubRepositories(result)
      )
    } catch (error) {
      if (signal.aborted) throw error
      const detail = safeErrorMessage(error)
      const response = /[\u3400-\u9fff]/u.test(request)
        ? `GitHub OAuth 仓库读取失败：${detail}。这与本机 GitHub CLI 是否登录无关。`
        : `GitHub OAuth repository lookup failed: ${detail}. This is unrelated to whether the local GitHub CLI is signed in.`
      return localPreflightResponse(
        'browser-github-oauth-repositories-error',
        response
      )
    }
  },
  requiresApproval: async (call, signal) => {
    if (signal.aborted) return false
    if (
      call.function.name !== 'web.fetch' &&
      call.function.name !== 'web.crawl'
    ) {
      return true
    }
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
      return false
    }
    const params = parseToolArguments(call)
    const url = new URL(params.url as string)
    const pageCount = call.function.name === 'web.crawl' ? params.max_pages : 1
    return window.confirm(
      `Read ${pageCount} public page(s) from ${url.hostname} using this device's network? No cookies are sent. The extracted text will be included in this conversation and sent to the selected AI model.`
    )
  },
  invoke: async (call, signal) => {
    const params = parseToolArguments(call)
    switch (call.function.name) {
      case 'web.search':
        return JSON.stringify(
          await searchClientSources(
            params.query as string,
            params.limit as number,
            signal,
            params.scope as ClientSearchScope
          )
        )
      case 'web.fetch':
        try {
          return JSON.stringify(
            await fetchClientPage(params.url as string, signal)
          )
        } catch (error) {
          if (signal.aborted) throw error
          return JSON.stringify({
            error: safeErrorMessage(error),
          })
        }
      case 'web.crawl':
        return JSON.stringify(
          await crawlClientSite(
            params.url as string,
            params.query as string,
            params.max_pages as number,
            signal
          )
        )
      case 'github.oauth.auth.status':
        return invokeApi('/api/agent/github/status', {}, signal)
      case 'github.oauth.repositories.list':
        return invokeApi(
          '/api/agent/github/repositories',
          { limit: params.limit },
          signal
        )
      case 'github.oauth.repositories.search':
        return invokeApi(
          '/api/agent/github/repositories/search',
          { q: params.query, limit: params.limit },
          signal
        )
      case 'github.oauth.issues.list':
        return invokeApi('/api/agent/github/issues', params, signal)
      case 'github.oauth.pull_requests.list':
        return invokeApi('/api/agent/github/pull-requests', params, signal)
      default:
        throw new Error(
          `Tool is not available in the browser: ${call.function.name}.`
        )
    }
  },
}

const LOCAL_TO_OAUTH_GITHUB_TOOL: Record<string, string> = {
  'github.auth.status': 'github.oauth.auth.status',
  'github.repositories.search': 'github.oauth.repositories.search',
  'github.issues.list': 'github.oauth.issues.list',
  'github.pull_requests.list': 'github.oauth.pull_requests.list',
}

const OAUTH_TO_LOCAL_GITHUB_TOOL = Object.fromEntries(
  Object.entries(LOCAL_TO_OAUTH_GITHUB_TOOL).map(([local, oauth]) => [
    oauth,
    local,
  ])
)

function renameToolCall(
  call: ChatCompletionToolCall,
  name: string
): ChatCompletionToolCall {
  return {
    ...call,
    function: { ...call.function, name },
  }
}

function parseAuthenticatedCLIStatus(result: string): boolean {
  let value: unknown = result
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
        continue
      } catch {
        return false
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    const record = value as Record<string, unknown>
    if (typeof record.authenticated === 'boolean') {
      return record.authenticated
    }
    if (record.data !== undefined) {
      value = record.data
      continue
    }
    if (typeof record.stdout === 'string') {
      value = record.stdout
      continue
    }
    return false
  }
  return false
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.'
}

function toolMatchesIntent(
  name: string,
  intent: ReturnType<typeof getGitHubReadIntent>
): boolean {
  if (!intent) return false
  const canonicalName = LOCAL_TO_OAUTH_GITHUB_TOOL[name] ?? name
  const expectedName = {
    status: 'github.oauth.auth.status',
    repositories: 'github.oauth.repositories.list',
    repository_search: 'github.oauth.repositories.search',
    issues: 'github.oauth.issues.list',
    pull_requests: 'github.oauth.pull_requests.list',
  }[intent]
  return canonicalName === expectedName
}

/**
 * In a browser, account-backed web tools must take precedence over same-named
 * device tools. This keeps GitHub OAuth/API reads available when a paired
 * Radxa or desktop is offline, while device-only tools still use the bridge.
 */
export function createBrowserAgentToolProvider(
  bridgeProvider?: LocalToolProvider,
  bridgeConnected = true
): LocalToolProvider {
  let routedMessages: ChatCompletionMessage[] = []
  const isBridgeConnected = () =>
    Boolean(bridgeProvider && bridgeConnected && bridgeProvider.isAvailable())
  const browserWebProvider: LocalToolProvider = {
    ...webAgentToolProvider,
    shouldRunTool: (call, messages) => {
      const request = latestUserRequestText(messages)
      const intent = getGitHubReadIntent(request)
      if (
        call.function.name.startsWith('github.oauth.') &&
        intent &&
        explicitlyTargetsLocalGitHub(request) &&
        !isBridgeConnected()
      ) {
        return toolMatchesIntent(call.function.name, intent)
      }
      return webAgentToolProvider.shouldRunTool?.(call, messages) ?? true
    },
  }
  const combined = bridgeProvider
    ? combineLocalToolProviders(browserWebProvider, bridgeProvider)
    : browserWebProvider
  const bridgeToolNames = new Set(
    bridgeProvider?.tools.map((tool) => tool.function.name) ?? []
  )

  const invokeOAuthFallback = async (
    call: ChatCompletionToolCall,
    signal: AbortSignal,
    oauthName: string
  ): Promise<string> => {
    try {
      const raw = await webAgentToolProvider.invoke(
        renameToolCall(call, oauthName),
        signal
      )
      return JSON.stringify({
        source: 'browser GitHub OAuth',
        operation: oauthName,
        data: JSON.parse(raw),
      })
    } catch (error) {
      if (signal.aborted) throw error
      return JSON.stringify({
        source: 'browser GitHub OAuth',
        operation: oauthName,
        error: safeErrorMessage(error),
      })
    }
  }

  const invokeLocalGitHub = async (
    call: ChatCompletionToolCall,
    signal: AbortSignal,
    localName: string
  ): Promise<string> => {
    if (!bridgeProvider || !isBridgeConnected()) {
      if (localName === 'github.auth.status') {
        return JSON.stringify({ error: 'The local GitHub CLI is unavailable.' })
      }
      const oauthName = LOCAL_TO_OAUTH_GITHUB_TOOL[localName]
      return oauthName
        ? invokeOAuthFallback(call, signal, oauthName)
        : JSON.stringify({ error: 'The local GitHub CLI is unavailable.' })
    }

    if (localName !== 'github.auth.status') {
      const statusCall = renameToolCall(call, 'github.auth.status')
      statusCall.function.arguments = '{}'
      try {
        const status = await bridgeProvider.invoke(statusCall, signal)
        if (!parseAuthenticatedCLIStatus(status)) {
          const oauthName = LOCAL_TO_OAUTH_GITHUB_TOOL[localName]
          return oauthName
            ? invokeOAuthFallback(call, signal, oauthName)
            : JSON.stringify({ error: 'The local GitHub CLI is not signed in.' })
        }
      } catch (error) {
        if (signal.aborted) throw error
        const oauthName = LOCAL_TO_OAUTH_GITHUB_TOOL[localName]
        if (oauthName) return invokeOAuthFallback(call, signal, oauthName)
        return JSON.stringify({ error: safeErrorMessage(error) })
      }
    }

    try {
      return await bridgeProvider.invoke(renameToolCall(call, localName), signal)
    } catch (error) {
      if (signal.aborted) throw error
      if (localName === 'github.auth.status') {
        return JSON.stringify({ error: safeErrorMessage(error) })
      }
      const oauthName = LOCAL_TO_OAUTH_GITHUB_TOOL[localName]
      return oauthName
        ? invokeOAuthFallback(call, signal, oauthName)
        : JSON.stringify({ error: safeErrorMessage(error) })
    }
  }

  return {
    ...combined,
    isAvailable: () => true,
    availableTools: (messages = []) => {
      routedMessages = messages
      return (combined.availableTools?.(messages) ?? combined.tools).filter((tool) => {
        const name = tool.function.name
        if (!isBridgeConnected() && bridgeToolNames.has(name)) return false
        if (name.startsWith('github.oauth.')) {
          return shouldAdvertiseBrowserGitHubTool(
            name,
            messages,
            isBridgeConnected()
          )
        }
        if (name.startsWith('github.')) {
          return shouldAdvertiseBrowserGitHubTool(
            name,
            messages,
            isBridgeConnected()
          )
        }
        if (name.startsWith('web.')) {
          return shouldAdvertiseWebAgentTool(name, messages)
        }
        return shouldRunLocalAgentTool(name, messages)
      })
    },
    shouldRunTool: (call, messages) => {
      routedMessages = messages
      const name = call.function.name
      const intent = getGitHubReadIntent(latestUserRequestText(messages))
      if (!name.startsWith('github.')) {
        if (name.startsWith('web.')) {
          return webAgentToolProvider.shouldRunTool?.(call, messages) ?? false
        }
        return shouldRunLocalAgentTool(name, messages)
      }
      if (!intent) return false
      const localRequested = explicitlyTargetsLocalGitHub(
        latestUserRequestText(messages)
      )
      if (!localRequested) {
        if (name in LOCAL_TO_OAUTH_GITHUB_TOOL) {
          return shouldRunGitHubTool(
            renameToolCall(
              call,
              LOCAL_TO_OAUTH_GITHUB_TOOL[name] ?? name
            ),
            messages,
            'oauth'
          )
        }
        return shouldRunGitHubTool(call, messages, 'oauth')
      }
      if (!isBridgeConnected() || !bridgeProvider) {
        return toolMatchesIntent(name, intent)
      }
      if (name === 'github.oauth.repositories.list') {
        return shouldRunGitHubTool(call, messages, 'oauth')
      }
      if (name in OAUTH_TO_LOCAL_GITHUB_TOOL) {
        return shouldRunGitHubTool(
          renameToolCall(
            call,
            OAUTH_TO_LOCAL_GITHUB_TOOL[name] ?? name
          ),
          messages,
          'local'
        )
      }
      return shouldRunGitHubTool(call, messages, 'local')
    },
    invoke: async (call, signal) => {
      const name = call.function.name
      if (!name.startsWith('github.')) {
        return combined.invoke(call, signal)
      }
      const requestText = latestUserRequestText(routedMessages)
      if (!getGitHubReadIntent(requestText)) {
        return combined.invoke(call, signal)
      }
      const localRequested = explicitlyTargetsLocalGitHub(requestText)
      const oauthName = LOCAL_TO_OAUTH_GITHUB_TOOL[name]
      const localName = OAUTH_TO_LOCAL_GITHUB_TOOL[name]
      if (oauthName) {
        if (!localRequested) {
          return invokeOAuthFallback(call, signal, oauthName)
        }
        return invokeLocalGitHub(call, signal, name)
      }
      if (localName) {
        if (localRequested) {
          return invokeLocalGitHub(call, signal, localName)
        }
        return invokeOAuthFallback(call, signal, name)
      }
      return combined.invoke(call, signal)
    },
  }
}
