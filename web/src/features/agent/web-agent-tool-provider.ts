import type {
  ChatCompletionTool,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'
import { api } from '@/lib/api'

import {
  crawlClientSite,
  fetchClientPage,
  searchClientSources,
} from './client-crawler/client-crawler'
import { combineLocalToolProviders } from './mcp-tool-provider'

const WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web.search',
    description:
      'Search public GitHub repositories, Hugging Face models, and scholarly works directly from the user’s browser. Search requests are not sent to the Lain42 server.',
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
      'Read a public HTTPS page from the user’s browser with the client-side WASM parser. No cookies are sent and no page fetch is proxied by Lain42; the site must allow browser cross-origin access (CORS).',
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
    name: 'github.auth.status',
    description:
      'Check the browser GitHub OAuth connection without exposing its token.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
}

const GITHUB_REPOSITORY_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.repositories.search',
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
    name: 'github.issues.list',
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
    name: 'github.pull_requests.list',
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
  GITHUB_REPOSITORY_SEARCH_TOOL,
  GITHUB_ISSUES_TOOL,
  GITHUB_PULL_REQUESTS_TOOL,
]

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
      const allowed = new Set(['query', 'limit'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error('Unsupported web.search argument.')
      }
      return {
        query: queryString(params.query, 'Search query'),
        limit: boundedLimit(params.limit, 5, 8),
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
    case 'github.auth.status':
      if (Object.keys(params).length > 0) {
        throw new Error('GitHub auth status does not accept arguments.')
      }
      return {}
    case 'github.repositories.search': {
      const allowed = new Set(['query', 'limit'])
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        throw new Error('Unsupported GitHub repository argument.')
      }
      return {
        query: queryString(params.query, 'Repository query'),
        limit: boundedLimit(params.limit, 10, 20),
      }
    }
    case 'github.issues.list':
    case 'github.pull_requests.list': {
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
            signal
          )
        )
      case 'web.fetch':
        return JSON.stringify(
          await fetchClientPage(params.url as string, signal)
        )
      case 'web.crawl':
        return JSON.stringify(
          await crawlClientSite(
            params.url as string,
            params.query as string,
            params.max_pages as number,
            signal
          )
        )
      case 'github.auth.status':
        return invokeApi('/api/agent/github/status', {}, signal)
      case 'github.repositories.search':
        return invokeApi(
          '/api/agent/github/repositories/search',
          { q: params.query, limit: params.limit },
          signal
        )
      case 'github.issues.list':
        return invokeApi('/api/agent/github/issues', params, signal)
      case 'github.pull_requests.list':
        return invokeApi('/api/agent/github/pull-requests', params, signal)
      default:
        throw new Error(
          `Tool is not available in the browser: ${call.function.name}.`
        )
    }
  },
}

/**
 * In a browser, account-backed web tools must take precedence over same-named
 * device tools. This keeps GitHub OAuth/API reads available when a paired
 * Radxa or desktop is offline, while device-only tools still use the bridge.
 */
export function createBrowserAgentToolProvider(
  bridgeProvider?: LocalToolProvider
): LocalToolProvider {
  return bridgeProvider
    ? combineLocalToolProviders(webAgentToolProvider, bridgeProvider)
    : webAgentToolProvider
}
