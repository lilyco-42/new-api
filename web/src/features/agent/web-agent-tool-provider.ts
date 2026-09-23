import type {
  ChatCompletionTool,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'
import { api } from '@/lib/api'

const WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web.search',
    description:
      'Search the public web and return bounded results with titles, snippets, and source links.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'The public web search query.',
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
      'Fetch a public web page and return bounded readable text with its final URL and retrieval time. Only public HTTP(S) text documents are supported.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description: 'The public HTTP(S) page URL to read.',
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

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
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
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.trim())) {
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
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.port !== '' && parsed.port !== '80' && parsed.port !== '443')
  ) {
    throw new Error('Page URL must use public HTTP(S) on a default port.')
  }
  parsed.hash = ''
  return parsed.toString()
}

function parseToolArguments(call: ChatCompletionToolCall): Record<string, unknown> {
  const params = parseArguments(call)
  switch (call.function.name) {
    case 'web.search': {
      const allowed = new Set(['query', 'limit'])
      if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error('Unsupported web.search argument.')
      return {
        query: queryString(params.query, 'Search query'),
        limit: boundedLimit(params.limit, 5, 8),
      }
    }
    case 'web.fetch': {
      const allowed = new Set(['url'])
      if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error('Unsupported web.fetch argument.')
      return { url: readPublicPageURL(params.url) }
    }
    case 'github.auth.status':
      if (Object.keys(params).length > 0) throw new Error('GitHub auth status does not accept arguments.')
      return {}
    case 'github.repositories.search': {
      const allowed = new Set(['query', 'limit'])
      if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error('Unsupported GitHub repository argument.')
      return {
        query: queryString(params.query, 'Repository query'),
        limit: boundedLimit(params.limit, 10, 20),
      }
    }
    case 'github.issues.list':
    case 'github.pull_requests.list': {
      const allowed = new Set(['repo', 'state', 'limit', 'sort'])
      if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error(`Unsupported ${call.function.name} argument.`)
      const state = params.state ?? 'open'
      if (state !== 'open' && state !== 'closed' && state !== 'all') throw new Error('GitHub state must be open, closed, or all.')
      const sort = params.sort ?? 'updated'
      if (sort !== 'updated' && sort !== 'created') throw new Error('GitHub sort must be updated or created.')
      return {
        repo: readRepository(params.repo),
        state,
        sort,
        limit: boundedLimit(params.limit, 10, 20),
      }
    }
    default:
      throw new Error(`Tool is not available in the browser: ${call.function.name}.`)
  }
}

async function invokeApi(path: string, params: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException('The tool was cancelled.', 'AbortError')
  const response = await api.get(path, { params, signal, skipErrorHandler: true })
  return JSON.stringify(readResponseData(response.data))
}

export const webAgentToolProvider: LocalToolProvider = {
  tools: WEB_AGENT_TOOLS,
  isAvailable: () => true,
  invoke: async (call, signal) => {
    const params = parseToolArguments(call)
    switch (call.function.name) {
      case 'web.search':
        return invokeApi('/api/agent/search', { q: params.query, limit: params.limit }, signal)
      case 'web.fetch':
        return invokeApi('/api/agent/fetch', { url: params.url }, signal)
      case 'github.auth.status':
        return invokeApi('/api/agent/github/status', {}, signal)
      case 'github.repositories.search':
        return invokeApi('/api/agent/github/repositories/search', { q: params.query, limit: params.limit }, signal)
      case 'github.issues.list':
        return invokeApi('/api/agent/github/issues', params, signal)
      case 'github.pull_requests.list':
        return invokeApi('/api/agent/github/pull-requests', params, signal)
      default:
        throw new Error(`Tool is not available in the browser: ${call.function.name}.`)
    }
  },
}
