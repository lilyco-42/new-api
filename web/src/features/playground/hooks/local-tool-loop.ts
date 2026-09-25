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
import { sendChatCompletion } from '../api'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionTool,
  ChatCompletionToolCall,
  LocalToolProvider,
} from '../types'

const MAX_STEPS = 8
const MAX_TOOL_CALLS = 8
const MAX_ARGUMENT_BYTES = 16 * 1024
const MAX_RESULT_BYTES = 128 * 1024

export type LocalToolLoopEvent =
  | { type: 'requested'; call: ChatCompletionToolCall }
  | { type: 'running'; call: ChatCompletionToolCall }
  | { type: 'completed'; call: ChatCompletionToolCall; result: string }
  | { type: 'unavailable'; call: ChatCompletionToolCall }

function availableTools(
  provider: LocalToolProvider,
  messages: ChatCompletionMessage[]
) {
  return provider.availableTools?.(messages) ?? provider.tools
}

function unavailableToolResult(): string {
  return JSON.stringify({
    error:
      'The paired desktop or Radxa device is offline. This local tool was not run. Continue with available context and do not retry local-only tools.',
  })
}

export class LocalToolLoopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalToolLoopError'
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedResult(value: string): string {
  if (byteLength(value) <= MAX_RESULT_BYTES) return value
  const bytes = new TextEncoder().encode(value).slice(0, MAX_RESULT_BYTES)
  return `${new TextDecoder().decode(bytes)}\n[tool result truncated]`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function formatGitHubRepositoryList(result: string): string | null {
  try {
    const parsed: unknown = JSON.parse(result)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const outer = parsed as Record<string, unknown>
    if (typeof outer.error === 'string') return null
    const data =
      outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
        ? (outer.data as Record<string, unknown>)
        : outer
    if (typeof data.error === 'string' || !Array.isArray(data.items)) return null

    const repositories = data.items.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const repository = value as Record<string, unknown>
      const fullName = repository.full_name
      if (
        typeof fullName !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName)
      ) {
        return []
      }
      const rawURL = repository.html_url
      let link = fullName
      if (typeof rawURL === 'string') {
        try {
          const url = new URL(rawURL)
          if (
            url.protocol === 'https:' &&
            url.hostname === 'github.com' &&
            url.pathname.toLowerCase() === `/${fullName}`.toLowerCase()
          ) {
            link = `[${fullName}](${url.toString()})`
          }
        } catch {
          // Use the repository name as plain text for malformed URLs.
        }
      }
      const visibility = repository.private === true ? '私有' : '公开'
      const stars =
        typeof repository.stargazers_count === 'number' &&
        Number.isFinite(repository.stargazers_count)
          ? ` · ★ ${Math.max(0, Math.trunc(repository.stargazers_count))}`
          : ''
      return [`- ${link}（${visibility}${stars}）`]
    })

    if (repositories.length === 0) {
      return 'GitHub OAuth 已连接，仓库列表请求成功；当前返回 0 个可访问仓库。'
    }
    return [
      `已通过连接的 GitHub OAuth 获取到 ${repositories.length} 个仓库：`,
      '',
      ...repositories,
    ].join('\n')
  } catch {
    return null
  }
}

function formatBrowserSearchResults(result: string): string | null {
  try {
    const parsed: unknown = JSON.parse(result)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const data = parsed as Record<string, unknown>
    if (data.execution !== 'browser-wasm' || typeof data.query !== 'string') {
      return null
    }

    const lines = [
      '### 浏览器搜索来源',
      `查询：${data.query.slice(0, 200)}`,
    ]
    const items = Array.isArray(data.items) ? data.items : []
    let resultCount = 0
    for (const value of items) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const item = value as Record<string, unknown>
      if (typeof item.title !== 'string' || typeof item.url !== 'string') {
        continue
      }
      let url: URL
      try {
        url = new URL(item.url)
      } catch {
        continue
      }
      if (url.protocol !== 'https:' || url.username || url.password) continue

      const title = item.title.trim().slice(0, 240).replace(/[\[\]\\]/gu, '\\$&')
      if (!title) continue
      const source =
        typeof item.source === 'string' ? item.source.trim().slice(0, 60) : ''
      const snippet =
        typeof item.snippet === 'string' ? item.snippet.trim().slice(0, 400) : ''
      lines.push(
        `- [${title}](${url.toString()})${source ? ` · ${source}` : ''}${snippet ? `\n  ${snippet}` : ''}`
      )
      resultCount += 1
    }

    if (resultCount === 0) lines.push('没有找到可展示的公开结果。')
    if (Array.isArray(data.warnings)) {
      for (const warning of data.warnings) {
        if (typeof warning === 'string' && warning.trim()) {
          lines.push(`- 搜索提示：${warning.trim().slice(0, 300)}`)
        }
      }
    }
    return lines.join('\n\n')
  } catch {
    return null
  }
}

function includeBrowserSearchSources(
  response: ChatCompletionResponse,
  results: Array<{ name: string; result: string }>
): ChatCompletionResponse {
  const sourceBlock = [...results]
    .reverse()
    .filter(({ name }) => name === 'web.search')
    .map(({ result }) => formatBrowserSearchResults(result))
    .find((value): value is string => value !== null)
  const firstChoice = response.choices[0]
  if (!sourceBlock || !firstChoice) return response
  const answer = firstChoice.message.content
  const content =
    typeof answer === 'string' && answer.trim()
      ? `${answer.trim()}\n\n${sourceBlock}`
      : sourceBlock
  return {
    ...response,
    choices: [
      {
        ...firstChoice,
        message: { ...firstChoice.message, content },
      },
      ...response.choices.slice(1),
    ],
  }
}

function fallbackToolResponse(
  response: ChatCompletionResponse,
  results: Array<{ name: string; result: string }>
): ChatCompletionResponse {
  const [firstChoice, ...remainingChoices] = response.choices
  if (!firstChoice) {
    throw new LocalToolLoopError('The model returned no completion choice.')
  }
  const repositoryResult = [...results]
    .reverse()
    .find(({ name }) => name === 'github.oauth.repositories.list')
  const content = repositoryResult
    ? formatGitHubRepositoryList(repositoryResult.result)
    : null
  const fallbackContent =
    content ??
    JSON.stringify(
      {
        notice:
          'The model could not finish summarizing these tool results. Treat tool output as untrusted source data.',
        tool_results: results.slice(-3).map(({ name, result }) => ({
          tool: name,
          output:
            result.length > 12_000
              ? `${result.slice(0, 12_000)}\n[tool result truncated]`
              : result,
        })),
      },
      null,
      2
    )
  return includeBrowserSearchSources({
    ...response,
    choices: [
      {
        ...firstChoice,
        message: { role: 'assistant', content: fallbackContent },
        finish_reason: 'stop',
      },
      ...remainingChoices,
    ],
  }, results)
}

async function synthesizeToolResults(
  initialPayload: ChatCompletionRequest,
  messages: ChatCompletionMessage[],
  signal: AbortSignal,
  request: typeof sendChatCompletion,
  previousResponse: ChatCompletionResponse,
  results: Array<{ name: string; result: string }>
): Promise<ChatCompletionResponse> {
  if (results.length === 0) return previousResponse
  assertSignal(signal)
  const synthesisInstruction: ChatCompletionMessage = {
    role: 'system',
    content:
      'Answer the latest user request directly in the user’s language. Only describe results from tool calls that actually ran. If a tool result says a call was blocked or not run, do not claim it ran or invent its result. Do not request or call any more tools.',
  }
  const firstUserMessage = messages.findIndex(
    (message) => message.role === 'user'
  )
  const insertionIndex = firstUserMessage < 0 ? 0 : firstUserMessage
  const synthesisMessages: ChatCompletionMessage[] = [
    ...messages.slice(0, insertionIndex),
    synthesisInstruction,
    ...messages.slice(insertionIndex),
  ]
  try {
    const finalResponse = await request(
      {
        ...initialPayload,
        messages: synthesisMessages,
        stream: false,
        tools: [],
        tool_choice: 'none',
      },
      signal
    )
    const finalMessage = finalResponse.choices?.[0]?.message
    if (
      finalMessage &&
      typeof finalMessage.content === 'string' &&
      finalMessage.content.trim().length > 0 &&
      !finalMessage.tool_calls?.length
    ) {
      return includeBrowserSearchSources(finalResponse, results)
    }
    return fallbackToolResponse(finalResponse, results)
  } catch {
    assertSignal(signal)
    return fallbackToolResponse(previousResponse, results)
  }
}

function parseArguments(call: ChatCompletionToolCall): Record<string, unknown> {
  if (!call.id || call.id.length > 128) {
    throw new LocalToolLoopError('Tool call id is missing or too long.')
  }
  if (call.type !== 'function' || !call.function?.name) {
    throw new LocalToolLoopError('Only function tool calls are supported.')
  }
  if (typeof call.function.arguments !== 'string') {
    throw new LocalToolLoopError('Tool arguments must be a JSON string.')
  }
  if (byteLength(call.function.arguments) > MAX_ARGUMENT_BYTES) {
    throw new LocalToolLoopError('Tool arguments exceed the allowed size.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(call.function.arguments)
  } catch {
    throw new LocalToolLoopError(
      `Tool arguments for ${call.function.name} are not valid JSON.`
    )
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalToolLoopError(
      `Tool arguments for ${call.function.name} must be a JSON object.`
    )
  }
  return parsed as Record<string, unknown>
}

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('The tool loop was cancelled.', 'AbortError')
  }
}

function assistantMessageFromResponse(
  response: ChatCompletionResponse
): ChatCompletionMessage {
  const message = response.choices?.[0]?.message
  if (!message) throw new LocalToolLoopError('The model returned no message.')
  return {
    role: 'assistant',
    content: message.content ?? null,
    ...(message.reasoning_content
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  } as ChatCompletionMessage
}

/**
 * Some OpenAI-compatible models ignore the structured tool-call protocol and
 * print a JSON-shaped request in the assistant content instead. Recover only
 * the narrowly-scoped public browser search form, and still pass it through
 * the normal provider allowlist, intent, and approval checks below.
 */
function parseTextWebSearchToolCall(
  content: ChatCompletionMessage['content'],
  tools: ChatCompletionTool[],
  step: number
): ChatCompletionToolCall | null {
  if (typeof content !== 'string' || byteLength(content) > MAX_ARGUMENT_BYTES) {
    return null
  }
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)
  const serialized = (fenced?.[1] ?? trimmed)
    .replace(/[“”]/gu, '"')
    .replaceAll('：', ':')
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const envelope = parsed as Record<string, unknown>
  if (
    Object.keys(envelope).some((key) => !['name', 'parameters'].includes(key)) ||
    envelope.name !== 'web.search' ||
    !tools.some((tool) => tool.function.name === 'web.search') ||
    !envelope.parameters ||
    typeof envelope.parameters !== 'object' ||
    Array.isArray(envelope.parameters)
  ) {
    return null
  }

  const raw = envelope.parameters as Record<string, unknown>
  if (
    Object.keys(raw).some(
      (key) => !['query', 'q', 'limit', 'scope', 'source'].includes(key)
    ) ||
    (raw.query !== undefined && raw.q !== undefined) ||
    (raw.scope !== undefined && raw.source !== undefined)
  ) {
    return null
  }
  const query = raw.query ?? raw.q
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
    return null
  }

  const args: Record<string, unknown> = { query: query.trim() }
  if (raw.limit !== undefined) {
    const limit =
      typeof raw.limit === 'number'
        ? raw.limit
        : typeof raw.limit === 'string' && /^\d+$/u.test(raw.limit.trim())
          ? Number(raw.limit)
          : Number.NaN
    if (!Number.isSafeInteger(limit)) return null
    args.limit = Math.max(1, Math.min(8, limit))
  }

  const rawScope = raw.scope ?? raw.source
  if (rawScope !== undefined) {
    if (typeof rawScope !== 'string') return null
    const scope = rawScope.trim().toLocaleLowerCase().replace(/[ _-]+/gu, '')
    const normalizedScope: Record<string, string> = {
      auto: 'auto',
      github: 'github',
      huggingface: 'huggingface',
      hf: 'huggingface',
      papers: 'papers',
      openalex: 'papers',
      all: 'all',
    }
    if (!normalizedScope[scope]) return null
    args.scope = normalizedScope[scope]
  }

  return {
    id: `browser-text-web-search-${step}`,
    type: 'function',
    function: { name: 'web.search', arguments: JSON.stringify(args) },
  }
}

function assistantMessageForToolLoop(
  response: ChatCompletionResponse,
  tools: ChatCompletionTool[],
  step: number
): ChatCompletionMessage {
  const message = assistantMessageFromResponse(response)
  if (message.tool_calls?.length) return message
  const textCall = parseTextWebSearchToolCall(message.content, tools, step)
  return textCall
    ? { ...message, content: null, tool_calls: [textCall] }
    : message
}

export async function runLocalToolLoop(
  initialPayload: ChatCompletionRequest,
  provider: LocalToolProvider,
  signal: AbortSignal,
  onEvent?: (event: LocalToolLoopEvent) => void,
  request = sendChatCompletion
): Promise<ChatCompletionResponse> {
  assertSignal(signal)
  const preflightResponse = provider.preflight?.(initialPayload.messages)
  if (preflightResponse) return preflightResponse
  const beforeModelResponse = await provider.beforeModel?.(
    initialPayload.messages,
    signal
  )
  assertSignal(signal)
  if (beforeModelResponse) return beforeModelResponse
  if (!provider.isAvailable()) return request(initialPayload, signal)

  const messages: ChatCompletionMessage[] = [...initialPayload.messages]
  const preparedContext = await provider.prepareContext?.(
    initialPayload.messages,
    signal
  )
  assertSignal(signal)
  if (preparedContext?.length) {
    let latestUserIndex = -1
    messages.forEach((message, index) => {
      if (message.role === 'user') latestUserIndex = index
    })
    messages.splice(
      latestUserIndex < 0 ? messages.length : latestUserIndex,
      0,
      ...preparedContext
    )
  }
  const tools = availableTools(provider, messages)
  if (tools.length === 0) {
    const response = await request(
      {
        ...initialPayload,
        messages,
        stream: false,
        tools: [],
        tool_choice: 'none',
      },
      signal
    )
    const assistantMessage = assistantMessageFromResponse(response)
    const calls = assistantMessage.tool_calls ?? []
    if (calls.length === 0) return response

    const messagesWithoutTools: ChatCompletionMessage[] = [
      ...messages,
      assistantMessage,
    ]
    const rejectedResults: Array<{ name: string; result: string }> = []
    for (const [index, call] of calls.entries()) {
      const name =
        typeof call.function?.name === 'string'
          ? call.function.name.slice(0, 128)
          : 'unknown'
      const result = JSON.stringify({
        error:
          'No local tools are available for this request. The proposed call was not run; answer the user directly without claiming it ran.',
      })
      messagesWithoutTools.push({
        role: 'tool',
        tool_call_id:
          typeof call.id === 'string' && call.id
            ? call.id
            : `blocked-local-tool-${index}`,
        content: result,
      })
      rejectedResults.push({ name, result })
    }
    return synthesizeToolResults(
      initialPayload,
      messagesWithoutTools,
      signal,
      request,
      response,
      rejectedResults
    )
  }
  let response = await request(
    {
      ...initialPayload,
      messages,
      stream: false,
      tools,
      tool_choice: provider.getToolChoice?.(messages, tools) ?? 'auto',
    },
    signal
  )
  let totalCalls = 0
  const seenCallIds = new Set<string>()
  const seenSearchCalls = new Set<string>()
  const completedResults: Array<{ name: string; result: string }> = []

  for (let step = 0; step < MAX_STEPS; step += 1) {
    assertSignal(signal)
    const assistantMessage = assistantMessageForToolLoop(
      response,
      availableTools(provider, messages),
      step
    )
    const calls = assistantMessage.tool_calls ?? []
    if (calls.length === 0) {
      return includeBrowserSearchSources(response, completedResults)
    }

    const currentToolNames = new Set(
      availableTools(provider, messages).map((tool) => tool.function.name)
    )
    const declaredToolNames = new Set(
      provider.tools.map((tool) => tool.function.name)
    )
    const parsedCalls = calls.map((call) => ({
      call,
      args: parseArguments(call),
    }))
    for (const { call } of parsedCalls) {
      if (seenCallIds.has(call.id)) {
        throw new LocalToolLoopError(`Duplicate tool call id: ${call.id}.`)
      }
      seenCallIds.add(call.id)
      if (!declaredToolNames.has(call.function.name)) {
        throw new LocalToolLoopError(
          `Tool is not allowed: ${call.function.name}.`
        )
      }
    }

    messages.push(assistantMessage)
    if (totalCalls + calls.length > MAX_TOOL_CALLS) {
      for (const { call } of parsedCalls) {
        onEvent?.({ type: 'requested', call })
        const result = JSON.stringify({
          error:
            'The tool call budget was reached. Summarize results already returned; do not retry this call.',
        })
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
        completedResults.push({ name: call.function.name, result })
      }
      return synthesizeToolResults(
        initialPayload,
        messages,
        signal,
        request,
        response,
        completedResults
      )
    }

    let mustSynthesize = false
    for (const { call, args } of parsedCalls) {
      assertSignal(signal)
      onEvent?.({ type: 'requested', call })
      if (mustSynthesize) {
        const result = JSON.stringify({
          error:
            'This tool was not run because another proposed tool did not match the latest user request. Answer the latest request without claiming this tool ran.',
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        })
        completedResults.push({ name: call.function.name, result })
        totalCalls += 1
        continue
      }
      if (provider.shouldRunTool && !provider.shouldRunTool(call, messages)) {
        mustSynthesize = true
        const result = JSON.stringify({
          error:
            'This tool call does not match the latest user request and was not run. Answer the latest request directly; do not claim this tool ran.',
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        })
        completedResults.push({ name: call.function.name, result })
        totalCalls += 1
        continue
      }
      const signature = stableJson(args)
      if (
        call.function.name === 'web.search' &&
        seenSearchCalls.has(signature)
      ) {
        mustSynthesize = true
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            error:
              'This exact web.search request already completed. Use its earlier results and answer without searching again.',
          }),
        })
        totalCalls += 1
        continue
      }
      if (call.function.name === 'web.search') {
        seenSearchCalls.add(signature)
      }
      if (!currentToolNames.has(call.function.name)) {
        onEvent?.({ type: 'unavailable', call })
        const result = unavailableToolResult()
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
        completedResults.push({ name: call.function.name, result })
        totalCalls += 1
        continue
      }
      if (provider.requiresApproval) {
        const approved = await provider.requiresApproval(call, signal)
        assertSignal(signal)
        if (!approved) {
          throw new LocalToolLoopError(
            `Tool call ${call.function.name} was not approved.`
          )
        }
      }
      onEvent?.({ type: 'running', call })
      let result: string
      let wasUnavailable = false
      try {
        result = boundedResult(await provider.invoke(call, signal))
      } catch (error) {
        assertSignal(signal)
        const stillAvailable = availableTools(provider, messages).some(
          (tool) => tool.function.name === call.function.name
        )
        if (stillAvailable) throw error
        onEvent?.({ type: 'unavailable', call })
        wasUnavailable = true
        result = unavailableToolResult()
      }
      if (!wasUnavailable) onEvent?.({ type: 'completed', call, result })
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      completedResults.push({ name: call.function.name, result })
      totalCalls += 1
    }

    if (
      completedResults.some(
        ({ name, result }) =>
          name === 'github.oauth.repositories.list' &&
          formatGitHubRepositoryList(result) !== null
      )
    ) {
      return fallbackToolResponse(response, completedResults)
    }

    if (mustSynthesize) {
      return synthesizeToolResults(
        initialPayload,
        messages,
        signal,
        request,
        response,
        completedResults
      )
    }

    try {
      const nextTools = availableTools(provider, messages)
      response = await request(
        {
          ...initialPayload,
          messages,
          stream: false,
          tools: nextTools,
          tool_choice:
            provider.getToolChoice?.(messages, nextTools) ?? 'auto',
        },
        signal
      )
    } catch {
      assertSignal(signal)
      return fallbackToolResponse(response, completedResults)
    }
  }

  return synthesizeToolResults(
    initialPayload,
    messages,
    signal,
    request,
    response,
    completedResults
  )
}
