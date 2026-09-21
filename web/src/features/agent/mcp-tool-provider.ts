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
*/
import type {
  ChatCompletionTool,
  ChatCompletionToolCall,
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

export type McpTransport = 'stdio' | 'streamable_http'

export type McpConnectRequest = {
  server_id: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  bearer_token?: string
}

export type McpToolDescriptor = {
  server_id: string
  server_name: string
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type McpServerDescriptor = {
  server_id: string
  name: string
  transport: McpTransport
  tools: McpToolDescriptor[]
}

export type McpToolProviderController = LocalToolProvider & {
  connect: (request: McpConnectRequest) => Promise<McpServerDescriptor>
  disconnect: (serverId: string) => Promise<void>
  refresh: () => Promise<McpServerDescriptor[]>
  servers: () => McpServerDescriptor[]
}

export type McpBridgeRequester = {
  request: (
    operation: string,
    params: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<unknown>
}

const MAX_SERVERS = 16
const MAX_TOOLS = 128
const MAX_RESULT_BYTES = 128 * 1024
const MCP_CALL_TIMEOUT_MS = 45_000

function getInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null
  return (window as TauriWindow).__TAURI__?.core?.invoke ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function bounded(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= MAX_RESULT_BYTES) return value
  return `${new TextDecoder().decode(bytes.slice(0, MAX_RESULT_BYTES))}\n[mcp result truncated]`
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  fallback = ''
): string {
  return typeof value[key] === 'string' ? (value[key] as string) : fallback
}

function readTool(
  value: unknown,
  server: McpServerDescriptor
): McpToolDescriptor | null {
  const item = asRecord(value)
  if (!item) return null
  const name = stringField(item, 'name').trim()
  if (!name || name.length > 128) return null
  const schema = asRecord(item.input_schema ?? item.inputSchema) ?? {
    type: 'object',
    additionalProperties: true,
  }
  return {
    server_id: server.server_id,
    server_name: server.name,
    name,
    ...(stringField(item, 'description')
      ? { description: stringField(item, 'description').slice(0, 1000) }
      : {}),
    input_schema: schema,
  }
}

function readServer(value: unknown): McpServerDescriptor | null {
  const item = asRecord(value)
  if (!item) return null
  const serverId = stringField(item, 'server_id', stringField(item, 'serverId'))
  const name = stringField(item, 'name', serverId)
  const transport = stringField(item, 'transport')
  if (
    !serverId ||
    !name ||
    (transport !== 'stdio' && transport !== 'streamable_http')
  ) {
    return null
  }
  const server: McpServerDescriptor = {
    server_id: serverId,
    name,
    transport,
    tools: [],
  }
  const tools = Array.isArray(item.tools) ? item.tools : []
  server.tools = tools
    .slice(0, MAX_TOOLS)
    .map((tool) => readTool(tool, server))
    .filter((tool): tool is McpToolDescriptor => tool !== null)
  return server
}

function readServers(value: unknown): McpServerDescriptor[] {
  const root = asRecord(value)
  let raw: unknown[] = []
  if (Array.isArray(value)) {
    raw = value
  } else if (root && Array.isArray(root.servers)) {
    raw = root.servers
  } else if (root?.server) {
    raw = [root.server]
  }
  return raw
    .slice(0, MAX_SERVERS)
    .map(readServer)
    .filter((server): server is McpServerDescriptor => server !== null)
}

export function readMcpServers(value: unknown): McpServerDescriptor[] {
  return readServers(value)
}

function toolName(serverId: string, name: string): string {
  return `mcp.${serverId}.${name}`
}

function toChatTool(tool: McpToolDescriptor): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: toolName(tool.server_id, tool.name),
      description: `${tool.server_name}: ${tool.description || tool.name}`,
      parameters: tool.input_schema,
    },
  }
}

function parseToolName(
  name: string
): { serverId: string; toolName: string } | null {
  if (!name.startsWith('mcp.')) return null
  const separator = name.indexOf('.', 4)
  if (separator < 5 || separator === name.length - 1) return null
  return {
    serverId: name.slice(4, separator),
    toolName: name.slice(separator + 1),
  }
}

function asJsonObject(argumentsText: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(argumentsText)
  } catch {
    throw new Error('MCP tool arguments must be valid JSON.')
  }
  const object = asRecord(value)
  if (!object) throw new Error('MCP tool arguments must be a JSON object.')
  return object
}

function approvalMessage(call: ChatCompletionToolCall): string {
  let formatted = call.function.arguments
  try {
    formatted = JSON.stringify(JSON.parse(formatted), null, 2)
  } catch {
    // The loop validates JSON before this gate; keep the original for clarity.
  }
  return `Allow MCP tool ${call.function.name} with these exact parameters?\n\n${formatted.slice(0, 4000)}`
}

async function raceWithAbort<T>(
  task: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<T> {
  if (signal.aborted) throw new DOMException(message, 'AbortError')
  let removeAbortListener = () => {}
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new DOMException(message, 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([task, abort])
  } finally {
    removeAbortListener()
  }
}

export function createMcpToolProvider(): McpToolProviderController {
  const connected = new Map<string, McpServerDescriptor>()
  const provider: McpToolProviderController = {
    tools: [],
    isAvailable: () => getInvoke() !== null,
    servers: () => [...connected.values()],
    refresh: async () => {
      const invoke = getInvoke()
      if (!invoke) return []
      const result = await invoke('mcp_list')
      const servers = readServers(result)
      connected.clear()
      for (const server of servers) connected.set(server.server_id, server)
      provider.tools = servers.flatMap((server) => server.tools.map(toChatTool))
      return servers
    },
    connect: async (request) => {
      const invoke = getInvoke()
      if (!invoke) {
        throw new Error('MCP connections are available in the desktop app.')
      }
      if (connected.size >= MAX_SERVERS && !connected.has(request.server_id)) {
        throw new Error('The MCP server limit has been reached.')
      }
      const result = await invoke('mcp_connect', { request })
      const server = readServers(result)[0]
      if (!server) throw new Error('The MCP server returned no valid tools.')
      connected.set(server.server_id, server)
      provider.tools = [...connected.values()].flatMap((item) =>
        item.tools.map(toChatTool)
      )
      return server
    },
    disconnect: async (serverId) => {
      const invoke = getInvoke()
      if (!invoke) {
        throw new Error('MCP connections are available in the desktop app.')
      }
      await invoke('mcp_disconnect', { server_id: serverId })
      connected.delete(serverId)
      provider.tools = [...connected.values()].flatMap((item) =>
        item.tools.map(toChatTool)
      )
    },
    requiresApproval: async (call, signal) => {
      if (signal.aborted) return false
      asJsonObject(call.function.arguments)
      if (
        typeof window === 'undefined' ||
        typeof window.confirm !== 'function'
      ) {
        return false
      }
      return window.confirm(approvalMessage(call))
    },
    invoke: async (call, signal) => {
      const invoke = getInvoke()
      if (!invoke) {
        throw new Error('The desktop MCP bridge is unavailable.')
      }
      const parsedName = parseToolName(call.function.name)
      if (!parsedName || !connected.has(parsedName.serverId)) {
        throw new Error(`MCP tool is not connected: ${call.function.name}.`)
      }
      const argumentsValue = asJsonObject(call.function.arguments)
      if (signal.aborted) {
        throw new DOMException('The MCP call was cancelled.', 'AbortError')
      }
      const result = await raceWithAbort(
        invoke('mcp_call', {
          request: {
            server_id: parsedName.serverId,
            tool_name: parsedName.toolName,
            arguments: argumentsValue,
            timeout_ms: MCP_CALL_TIMEOUT_MS,
          },
        }),
        signal,
        'The MCP call was cancelled.'
      )
      if (typeof result === 'string') return bounded(result)
      return bounded(JSON.stringify(result))
    },
  }
  return provider
}

/**
 * MCP tools exposed by a paired desktop. The browser never receives the
 * desktop's bearer token or process details; it only sees bounded tool
 * descriptors and sends an authenticated, user-approved call over the bridge.
 */
export function createBrowserMcpToolProvider(
  bridge: McpBridgeRequester
): LocalToolProvider & { refresh: (signal: AbortSignal) => Promise<void> } {
  let servers: McpServerDescriptor[] = []
  const provider: LocalToolProvider & {
    refresh: (signal: AbortSignal) => Promise<void>
  } = {
    tools: [],
    isAvailable: () => true,
    refresh: async (signal) => {
      const result = await bridge.request('mcp.list', {}, signal)
      servers = readServers(result)
      provider.tools = servers.flatMap((server) => server.tools.map(toChatTool))
    },
    requiresApproval: async (call, signal) => {
      if (signal.aborted) return false
      asJsonObject(call.function.arguments)
      if (
        typeof window === 'undefined' ||
        typeof window.confirm !== 'function'
      ) {
        return false
      }
      return window.confirm(approvalMessage(call))
    },
    invoke: async (call, signal) => {
      const parsedName = parseToolName(call.function.name)
      if (
        !parsedName ||
        !servers.some((server) => server.server_id === parsedName.serverId)
      ) {
        throw new Error(`MCP tool is not connected: ${call.function.name}.`)
      }
      const argumentsValue = asJsonObject(call.function.arguments)
      const result = await bridge.request(
        'mcp.call',
        {
          server_id: parsedName.serverId,
          tool_name: parsedName.toolName,
          arguments: argumentsValue,
          timeout_ms: MCP_CALL_TIMEOUT_MS,
        },
        signal
      )
      if (typeof result === 'string') return bounded(result)
      return bounded(JSON.stringify(result))
    },
  }
  return provider
}

export function combineLocalToolProviders(
  ...providers: LocalToolProvider[]
): LocalToolProvider {
  const findProvider = (name: string) =>
    providers.find((provider) =>
      provider.tools.some((tool) => tool.function.name === name)
    )
  return {
    tools: providers.flatMap((provider) => provider.tools),
    isAvailable: () => providers.some((provider) => provider.isAvailable()),
    requiresApproval: async (call, signal) => {
      const provider = findProvider(call.function.name)
      if (!provider) {
        throw new Error(`Tool is not allowed: ${call.function.name}.`)
      }
      return provider.requiresApproval
        ? provider.requiresApproval(call, signal)
        : true
    },
    invoke: async (call, signal) => {
      const provider = findProvider(call.function.name)
      if (!provider) {
        throw new Error(`Tool is not allowed: ${call.function.name}.`)
      }
      return provider.invoke(call, signal)
    },
  }
}
