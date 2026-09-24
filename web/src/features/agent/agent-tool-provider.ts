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
  ChatCompletionMessage,
  ChatCompletionTool,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'

import { shouldRunLocalAgentTool } from './agent-tool-routing'

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

const DEVELOPER_STATUS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'developer.tools.status',
    description:
      'Check which approved developer CLIs are installed on the paired desktop or Radxa node. Tokens and command output are not exposed.',
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

const HISTORY_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'vcs.history',
    description:
      'Read a bounded recent change history from the explicitly configured workspace using jj. This operation is read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 20 },
      },
    },
  },
}

const AST_GREP_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'elixir',
  'go',
  'haskell',
  'hcl',
  'html',
  'java',
  'javascript',
  'json',
  'kotlin',
  'lua',
  'nix',
  'php',
  'python',
  'ruby',
  'rust',
  'scala',
  'solidity',
  'swift',
  'tsx',
  'typescript',
  'yaml',
] as const

const CODE_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'code.search',
    description:
      'Search source code structurally with an ast-grep pattern in the configured workspace. Search only; never rewrite files.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: 512 },
        language: {
          type: 'string',
          enum: [...AST_GREP_LANGUAGES],
        },
      },
      required: ['pattern'],
    },
  },
}

const CODE_GRAPH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'code.graph',
    description:
      'Explore symbols and code relationships in the configured workspace with CodeGraph. This operation is read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['query'],
    },
  },
}

const FILES_BROWSE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'files.browse',
    description:
      'List files and directories under the node administrator configured workspace. Paths are workspace-relative and symlinks are omitted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', maxLength: 1024, default: '.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
  },
}

const FILES_PREVIEW_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'files.preview',
    description:
      'Read a small UTF-8 text file under the configured workspace after the user confirms sending its contents to the selected model. Credential files and binary files are blocked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
      required: ['path'],
    },
  },
}

const TOOLS: ChatCompletionTool[] = [
  DEVELOPER_STATUS_TOOL,
  AUTH_STATUS_TOOL,
  ISSUES_TOOL,
  REPOSITORY_SEARCH_TOOL,
  PULL_REQUESTS_TOOL,
  HISTORY_TOOL,
  CODE_SEARCH_TOOL,
  CODE_GRAPH_TOOL,
  FILES_BROWSE_TOOL,
  FILES_PREVIEW_TOOL,
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
  if (
    name === AUTH_STATUS_TOOL.function.name ||
    name === DEVELOPER_STATUS_TOOL.function.name
  ) {
    if (Object.keys(params).length > 0) {
      throw new Error(`${name} does not accept arguments.`)
    }
    return {}
  }

  if (name === HISTORY_TOOL.function.name) {
    if (Object.keys(params).some((key) => key !== 'limit')) {
      throw new Error(`Arguments for ${name} contain an unsupported field.`)
    }
    const limit = params.limit ?? 20
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 30
    ) {
      throw new Error('History limit must be an integer between 1 and 30.')
    }
    return { limit }
  }

  if (name === CODE_SEARCH_TOOL.function.name) {
    if (
      Object.keys(params).some((key) => key !== 'pattern' && key !== 'language')
    ) {
      throw new Error(`Arguments for ${name} contain an unsupported field.`)
    }
    if (
      typeof params.pattern !== 'string' ||
      !params.pattern.trim() ||
      params.pattern.length > 512
    ) {
      throw new Error('The code search pattern must contain 1–512 characters.')
    }
    const language = params.language
    if (
      language !== undefined &&
      (typeof language !== 'string' ||
        !AST_GREP_LANGUAGES.includes(
          language as (typeof AST_GREP_LANGUAGES)[number]
        ))
    ) {
      throw new Error('The code search language is not supported.')
    }
    return { pattern: params.pattern.trim(), ...(language ? { language } : {}) }
  }

  if (name === CODE_GRAPH_TOOL.function.name) {
    if (Object.keys(params).some((key) => key !== 'query')) {
      throw new Error(`Arguments for ${name} contain an unsupported field.`)
    }
    if (
      typeof params.query !== 'string' ||
      !params.query.trim() ||
      params.query.length > 500
    ) {
      throw new Error('The code graph query must contain 1–500 characters.')
    }
    return { query: params.query.trim() }
  }

  if (
    name === FILES_BROWSE_TOOL.function.name ||
    name === FILES_PREVIEW_TOOL.function.name
  ) {
    const allowed =
      name === FILES_BROWSE_TOOL.function.name
        ? new Set(['path', 'limit'])
        : new Set(['path'])
    if (Object.keys(params).some((key) => !allowed.has(key))) {
      throw new Error(`Arguments for ${name} contain an unsupported field.`)
    }
    const path = params.path ?? '.'
    if (typeof path !== 'string' || path.length > 1024 || path.includes('\0')) {
      throw new Error('Workspace path is invalid or too long.')
    }
    if (
      path.startsWith('/') ||
      path.startsWith('\\\\') ||
      /^[A-Za-z]:/.test(path) ||
      path.split(/[\\/]/).some((part) => part === '..')
    ) {
      throw new Error(
        'Workspace paths must stay inside the configured directory.'
      )
    }
    if (name === FILES_PREVIEW_TOOL.function.name && !path.trim()) {
      throw new Error('A workspace-relative file path is required.')
    }
    if (name === FILES_BROWSE_TOOL.function.name) {
      const limit = params.limit ?? 50
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        throw new Error('File list limit must be an integer between 1 and 100.')
      }
      return { path: path.trim() || '.', limit }
    }
    return { path: path.trim() }
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
  shouldRunTool: (
    call: ChatCompletionToolCall,
    messages: ChatCompletionMessage[]
  ) => shouldRunLocalAgentTool(call.function.name, messages),
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
    if (call.function.name === FILES_PREVIEW_TOOL.function.name) {
      const confirmation =
        typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(
              `Read ${String(params.path)} and send its contents to the selected AI model? Credential and key files are blocked.`
            )
          : false
      if (!confirmation) {
        throw new Error('File preview was not approved.')
      }
    }
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
      throw new Error(
        detail || 'The approved local tool could not complete the request.'
      )
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
        if (
          call.function.name === HISTORY_TOOL.function.name ||
          call.function.name === CODE_GRAPH_TOOL.function.name
        ) {
          data = { text: result.stdout ?? '' }
        } else {
          throw new Error('The approved local tool returned invalid JSON.')
        }
      }
    }

    return JSON.stringify({
      source:
        result.tool_id === 'gh'
          ? 'local gh cli'
          : `local ${result.tool_id ?? 'approved'} tool`,
      operation: result.operation ?? call.function.name,
      truncated: Boolean(result.truncated),
      data,
      ...(result.stderr?.trim() ? { stderr: result.stderr.trim() } : {}),
    })
  },
}
