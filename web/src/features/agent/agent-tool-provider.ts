/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type {
  ChatCompletionTool,
  LocalToolProvider,
} from '@/features/playground/types'

type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>

type TauriWindow = Window & {
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke
    }
  }
}

type CliExecResult = {
  operation?: string
  tool_id?: string
  stdout?: string
  stderr?: string
  truncated?: boolean
  status?: string
}

const AUTH_STATUS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.auth.status',
    description:
      'Check whether the local GitHub CLI profile is authenticated without exposing its token.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
}

const ISSUES_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.issues.list',
    description:
      'Read the most recently updated GitHub issues from an authorized repository using the local gh CLI.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: {
          type: 'string',
          description: 'Repository in owner/name form.',
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          default: 'open',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
        },
        sort: {
          type: 'string',
          enum: ['updated', 'created'],
          default: 'updated',
        },
      },
      required: ['repo'],
    },
  },
}

const REPOSITORY_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.repositories.search',
    description:
      'Search public GitHub repositories by a text query using the local gh CLI.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'GitHub repository search text.',
          minLength: 1,
          maxLength: 200,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      required: ['query'],
    },
  },
}

const PULL_REQUESTS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'github.pull_requests.list',
    description:
      'Read pull requests from an authorized repository using the local gh CLI.',
    parameters: ISSUES_TOOL.function.parameters,
  },
}

const TOOLS: ChatCompletionTool[] = [
  AUTH_STATUS_TOOL,
  ISSUES_TOOL,
  REPOSITORY_SEARCH_TOOL,
  PULL_REQUESTS_TOOL,
]

function getInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null
  return (window as TauriWindow).__TAURI__?.core?.invoke ?? null
}

function parseJsonObject(
  argumentsText: string,
  name: string
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    throw new Error(`Arguments for ${name} must be valid JSON.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Arguments for ${name} must be a JSON object.`)
  }

  return parsed as Record<string, unknown>
}

function parseToolArguments(
  name: string,
  argumentsText: string
): Record<string, unknown> {
  const params = parseJsonObject(argumentsText, name)
  if (name === AUTH_STATUS_TOOL.function.name) {
    if (Object.keys(params).length > 0) {
      throw new Error('GitHub auth status does not accept arguments.')
    }
    return {}
  }

  const allowed =
    name === REPOSITORY_SEARCH_TOOL.function.name
      ? new Set(['query', 'limit'])
      : new Set(['repo', 'state', 'limit', 'sort'])
  if (Object.keys(params).some((key) => !allowed.has(key))) {
    throw new Error(`Arguments for ${name} contain an unsupported field.`)
  }

  if (name === REPOSITORY_SEARCH_TOOL.function.name) {
    if (
      typeof params.query !== 'string' ||
      params.query.trim().length < 1 ||
      params.query.length > 200
    ) {
      throw new Error(
        'The repository search query must contain 1–200 characters.'
      )
    }
    const limit = params.limit ?? 10
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new Error(
        'The repository search limit must be an integer between 1 and 50.'
      )
    }
    return { query: params.query.trim(), limit }
  }

  if (
    typeof params.repo !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(params.repo)
  ) {
    throw new Error(`The repository for ${name} must use owner/name form.`)
  }

  const state = params.state ?? 'open'
  if (state !== 'open' && state !== 'closed' && state !== 'all') {
    throw new Error(`The state for ${name} is not supported.`)
  }
  const sort = params.sort ?? 'updated'
  if (sort !== 'updated' && sort !== 'created') {
    throw new Error(`The sort for ${name} is not supported.`)
  }
  const limit = params.limit ?? 10
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new Error(
      `The limit for ${name} must be an integer between 1 and 50.`
    )
  }

  return { repo: params.repo, state, sort, limit }
}

async function invokeWithAbort(
  invoke: TauriInvoke,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  if (signal.aborted) {
    throw new DOMException('The tool was cancelled.', 'AbortError')
  }

  let removeAbortListener: () => void = () => {}
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(new DOMException('The tool was cancelled.', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    return await Promise.race([invoke('cli_exec', args), abort])
  } finally {
    removeAbortListener()
  }
}

function readCliResult(value: unknown): CliExecResult {
  if (!value || typeof value !== 'object') {
    throw new Error('The desktop tool returned an invalid result.')
  }
  return value as CliExecResult
}

export const localAgentToolProvider: LocalToolProvider = {
  tools: TOOLS,
  isAvailable: () => getInvoke() !== null,
  invoke: async (call, signal) => {
    if (!TOOLS.some((tool) => tool.function.name === call.function.name)) {
      throw new Error(`Tool is not allowed: ${call.function.name}.`)
    }
    const invoke = getInvoke()
    if (!invoke) throw new Error('The desktop CLI bridge is unavailable.')
    const params = parseToolArguments(
      call.function.name,
      call.function.arguments
    )
    const result = readCliResult(
      await invokeWithAbort(
        invoke,
        {
          request: {
            operation: call.function.name,
            params,
            timeout_ms: 30_000,
          },
        },
        signal
      )
    )

    if (
      call.function.name !== AUTH_STATUS_TOOL.function.name &&
      (result.status !== 'succeeded' || typeof result.stdout !== 'string')
    ) {
      const detail = result.stderr?.trim()
      throw new Error(detail || 'GitHub CLI could not complete the request.')
    }

    let data: unknown = result.stdout ?? ''
    if (call.function.name === AUTH_STATUS_TOOL.function.name) {
      data = {
        authenticated: result.status === 'succeeded',
        status: result.status,
        output: result.stdout || result.stderr || '',
      }
    } else {
      try {
        data = JSON.parse(result.stdout ?? '')
      } catch {
        throw new Error('GitHub CLI returned invalid JSON.')
      }
    }

    return JSON.stringify({
      source: 'local gh cli',
      operation: result.operation ?? call.function.name,
      truncated: Boolean(result.truncated),
      data,
      ...(result.stderr?.trim() ? { stderr: result.stderr.trim() } : {}),
    })
  },
}
