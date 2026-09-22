import type {
  ChatCompletionToolCall,
  LocalToolProvider,
} from '@/features/playground/types'
/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { api } from '@/lib/api'
import { getFreshAuthHeaders } from '@/lib/auth-session'

import { localAgentToolProvider } from './agent-tool-provider'
import { formatMcpApprovalArguments } from './mcp-tool-provider'

const REQUEST_TIMEOUT_MS = 45_000
export const AGENT_BRIDGE_PROTOCOL_VERSION = 1 as const
const AGENT_BRIDGE_CAPABILITIES = [
  'github.read',
  'mcp.list',
  'mcp.call',
] as const

export type AgentBridgeStatus =
  | 'unavailable'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'error'

type BridgeEnvelope = {
  type: string
  protocol_version?: number
  capabilities?: string[]
  request_id?: string
  device_id?: number
  credential?: string
  access_token?: string
  operation?: string
  params?: unknown
  result?: unknown
  error?: string
}

type AgentDevice = {
  id: number
  device_name: string
  created_at?: string
  revoked_at?: string | null
}

export type AgentRunEvent = {
  event_id: number
  device_id: number
  request_id: string
  type: string
  operation: string
  input_digest?: string
  output_digest?: string
  error_code?: string
  created_at: string
}

export type AgentPairingSession = {
  id: number
  pairing_ticket: string
  expires_at: string
}

type BridgeListener = (status: AgentBridgeStatus) => void
type EnvelopeListener = (envelope: BridgeEnvelope) => void

function bridgeUrl(role: 'browser' | 'desktop'): string {
  if (typeof window === 'undefined') return ''
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/agent/bridge/${role}`
}

function requestId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent-${random}`
}

function isBridgeEnvelope(value: unknown): value is BridgeEnvelope {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as BridgeEnvelope).type === 'string'
  )
}

function getTauriInvoke():
  | ((command: string, args?: Record<string, unknown>) => Promise<unknown>)
  | null {
  if (typeof window === 'undefined') return null
  const tauri = (
    window as Window & {
      __TAURI__?: {
        core?: {
          invoke?: (
            command: string,
            args?: Record<string, unknown>
          ) => Promise<unknown>
        }
      }
    }
  ).__TAURI__
  return tauri?.core?.invoke ?? null
}

function responseData<T>(value: unknown): T {
  if (!value || typeof value !== 'object') {
    throw new Error('The agent bridge returned an invalid response.')
  }
  const response = value as { success?: boolean; data?: T; message?: string }
  if (response.success === false) {
    throw new Error(response.message || 'The agent bridge request failed.')
  }
  return response.data as T
}

/** A single authenticated browser or desktop WebSocket session. */
export class AgentBridgeClient {
  private socket: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private heartbeat: number | null = null
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: number
    }
  >()
  private status: AgentBridgeStatus
  private readonly listeners = new Set<BridgeListener>()
  private readonly envelopeListeners = new Set<EnvelopeListener>()

  constructor(
    private readonly role: 'browser' | 'desktop',
    private readonly deviceId: number,
    private readonly credential?: string
  ) {
    this.status = typeof WebSocket === 'undefined' ? 'unavailable' : 'offline'
  }

  getStatus(): AgentBridgeStatus {
    return this.status
  }

  onStatus(listener: BridgeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onEnvelope(listener: EnvelopeListener): () => void {
    this.envelopeListeners.add(listener)
    return () => this.envelopeListeners.delete(listener)
  }

  private setStatus(status: AgentBridgeStatus): void {
    this.status = status
    for (const listener of this.listeners) listener(status)
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connecting) return this.connecting
    if (!bridgeUrl(this.role) || this.deviceId <= 0) {
      this.setStatus('unavailable')
      throw new Error('The agent bridge is unavailable in this environment.')
    }

    let browserAccessToken: string | undefined
    if (this.role === 'browser') {
      const headers = await getFreshAuthHeaders()
      browserAccessToken = headers.Authorization?.replace(/^Bearer\s+/i, '')
      if (!browserAccessToken) {
        this.setStatus('error')
        throw new Error('Sign in before connecting the agent bridge.')
      }
    }

    this.setStatus('connecting')
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(bridgeUrl(this.role))
      this.socket = socket
      let settled = false
      const fail = (error: Error) => {
        if (!settled) {
          settled = true
          this.setStatus('error')
          reject(error)
        }
      }
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'hello',
            protocol_version: AGENT_BRIDGE_PROTOCOL_VERSION,
            capabilities: AGENT_BRIDGE_CAPABILITIES,
            device_id: this.deviceId,
            ...(this.role === 'desktop' ? { credential: this.credential } : {}),
            ...(this.role === 'browser'
              ? { access_token: browserAccessToken }
              : {}),
          })
        )
      }
      socket.onmessage = (event) => {
        let envelope: unknown
        try {
          envelope = JSON.parse(String(event.data))
        } catch {
          fail(new Error('The agent bridge returned invalid JSON.'))
          return
        }
        if (!isBridgeEnvelope(envelope)) {
          fail(new Error('The agent bridge returned an invalid message.'))
          return
        }
        for (const listener of this.envelopeListeners) listener(envelope)
        if (envelope.type === 'hello_ack') {
          if (
            envelope.protocol_version !== undefined &&
            envelope.protocol_version !== AGENT_BRIDGE_PROTOCOL_VERSION
          ) {
            fail(
              new Error(
                `The agent bridge protocol is incompatible (server v${envelope.protocol_version}, client v${AGENT_BRIDGE_PROTOCOL_VERSION}).`
              )
            )
            socket.close()
            return
          }
          if (!settled) {
            settled = true
            this.setStatus('connected')
            this.heartbeat = window.setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping' }))
              }
            }, 30_000)
            resolve()
          }
          return
        }
        if (envelope.type === 'pong') return
        if (
          (envelope.type === 'tool_result' || envelope.type === 'tool_error') &&
          envelope.request_id
        ) {
          const pending = this.pending.get(envelope.request_id)
          if (!pending) return
          window.clearTimeout(pending.timer)
          this.pending.delete(envelope.request_id)
          if (envelope.type === 'tool_error') {
            pending.reject(
              new Error(envelope.error || 'The desktop tool failed.')
            )
          } else {
            pending.resolve(envelope.result)
          }
        }
      }
      socket.onerror = () =>
        fail(new Error('The agent bridge connection failed.'))
      socket.onclose = () => {
        this.socket = null
        if (this.heartbeat !== null) {
          window.clearInterval(this.heartbeat)
          this.heartbeat = null
        }
        this.setStatus('offline')
        const error = new Error('The paired desktop is offline.')
        for (const pending of this.pending.values()) {
          window.clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.pending.clear()
        fail(error)
      }
    }).finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  async request(
    operation: string,
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    if (signal.aborted) {
      throw new DOMException('The tool was cancelled.', 'AbortError')
    }
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('The paired desktop is offline.')
    }
    const id = requestId()
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The paired desktop tool timed out.'))
      }, REQUEST_TIMEOUT_MS)
      const abort = () => {
        window.clearTimeout(timer)
        this.pending.delete(id)
        reject(new DOMException('The tool was cancelled.', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
        timer,
      })
      socket.send(
        JSON.stringify({
          type: 'tool_request',
          request_id: id,
          device_id: this.deviceId,
          operation,
          params,
        })
      )
    })
  }

  async send(envelope: BridgeEnvelope): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('The paired desktop is offline.')
    }
    socket.send(JSON.stringify(envelope))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
    if (this.heartbeat !== null) {
      window.clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    this.setStatus('offline')
  }
}

export const BRIDGE_TOOLS = localAgentToolProvider.tools

export function createBrowserAgentBridge(
  deviceId: number
): AgentBridgeClient | null {
  if (getTauriInvoke()) return null
  return new AgentBridgeClient('browser', deviceId)
}

export async function listAgentDevices(): Promise<AgentDevice[]> {
  const response = await api.get('/api/agent/devices', {
    skipErrorHandler: true,
    skipAuthRefresh: true,
  })
  return responseData<AgentDevice[]>(response.data).filter(
    (device) => device && device.id > 0 && !device.revoked_at
  )
}

export async function listAgentRunEvents(
  deviceId: number,
  afterEventId = 0,
  limit = 100
): Promise<AgentRunEvent[]> {
  if (!Number.isInteger(deviceId) || deviceId <= 0) return []
  const response = await api.get('/api/agent/events', {
    params: {
      device_id: deviceId,
      after_event_id: Math.max(0, Math.trunc(afterEventId)),
      limit: Math.min(100, Math.max(1, Math.trunc(limit))),
    },
    skipErrorHandler: true,
  })
  return responseData<AgentRunEvent[]>(response.data).filter(
    (event) =>
      event &&
      Number.isInteger(event.event_id) &&
      event.event_id > 0 &&
      typeof event.request_id === 'string' &&
      typeof event.type === 'string'
  )
}

export async function createAgentPairing(): Promise<AgentPairingSession> {
  const response = await api.post('/api/agent/pairings', undefined, {
    skipErrorHandler: true,
  })
  return responseData<AgentPairingSession>(response.data)
}

export async function confirmAgentPairing(
  pairingId: number,
  confirmationTicket: string
): Promise<void> {
  if (!Number.isInteger(pairingId) || pairingId <= 0) {
    throw new Error('The pairing id is invalid.')
  }
  const ticket = confirmationTicket.trim()
  if (ticket.length < 16 || ticket.length > 256) {
    throw new Error('The confirmation ticket is invalid.')
  }
  await api.post(
    `/api/agent/pairings/${pairingId}/confirm`,
    { confirmation_ticket: ticket },
    { skipErrorHandler: true }
  )
}

export function createBrowserBridgeProvider(
  client: AgentBridgeClient
): LocalToolProvider {
  return {
    tools: BRIDGE_TOOLS,
    // Keep the provider visible while a reconnect is in progress so a user
    // request fails with a clear offline error instead of silently falling
    // back to a model response that pretends the local tool was unavailable.
    isAvailable: () => client.getStatus() !== 'unavailable',
    invoke: async (call: ChatCompletionToolCall, signal: AbortSignal) => {
      if (
        !BRIDGE_TOOLS.some((tool) => tool.function.name === call.function.name)
      ) {
        throw new Error(`Tool is not allowed: ${call.function.name}.`)
      }
      let params: unknown
      try {
        params = JSON.parse(call.function.arguments)
      } catch {
        throw new Error('GitHub issue arguments must be valid JSON.')
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('GitHub issue arguments must be a JSON object.')
      }
      const result = await client.request(
        call.function.name,
        params as Record<string, unknown>,
        signal
      )
      return JSON.stringify({
        source: 'paired desktop gh cli',
        operation: call.function.name,
        data: result,
      })
    },
  }
}

/**
 * Handles tool requests received by a desktop peer. The actual execution is
 * still performed by the existing typed Tauri provider; this module only
 * transports the request and result over the authenticated WebSocket.
 */
export async function startDesktopAgentBridge(
  onStatus?: BridgeListener
): Promise<(() => void) | null> {
  const invoke = getTauriInvoke()
  if (!invoke) return null
  const credential = await invoke('agent_device_credential_get')
  if (typeof credential !== 'string' || credential.trim() === '') return null
  const deviceIdValue = await invoke('agent_device_id_get')
  const deviceId = typeof deviceIdValue === 'number' ? deviceIdValue : 0
  if (deviceId <= 0) return null

  const client = new AgentBridgeClient('desktop', deviceId, credential)
  const removeListener = onStatus ? client.onStatus(onStatus) : () => {}
  await client.connect()
  const removeEnvelope = client.onEnvelope(async (envelope) => {
    if (envelope.type !== 'tool_request') return
    const operation = envelope.operation
    if (
      !operation ||
      ![
        'github.auth.status',
        'github.issues.list',
        'github.repositories.search',
        'github.pull_requests.list',
        'mcp.list',
        'mcp.call',
      ].includes(operation) ||
      !envelope.request_id
    ) {
      await client.send({
        type: 'tool_error',
        request_id: envelope.request_id,
        error: 'Tool is not allowed on this desktop.',
      })
      return
    }
    try {
      let structured: unknown
      if (operation === 'mcp.list') {
        structured = await invoke('mcp_list')
      } else if (operation === 'mcp.call') {
        const params = envelope.params ?? {}
        const display = formatMcpApprovalArguments(params)
        if (
          typeof window === 'undefined' ||
          typeof window.confirm !== 'function' ||
          !window.confirm(
            `Allow paired browser MCP call with these exact parameters?\n\n${display}`
          )
        ) {
          throw new Error('MCP call was not approved on the paired desktop.')
        }
        structured = await invoke('mcp_call', { request: params })
      } else {
        const call: ChatCompletionToolCall = {
          id: envelope.request_id,
          type: 'function',
          function: {
            name: operation,
            arguments: JSON.stringify(envelope.params ?? {}),
          },
        }
        const result = await localAgentToolProvider.invoke(
          call,
          new AbortController().signal
        )
        try {
          structured = JSON.parse(result)
        } catch {
          // A bounded string is still returned as an opaque tool result.
          structured = result
        }
      }
      await client.send({
        type: 'tool_result',
        request_id: envelope.request_id,
        device_id: deviceId,
        result: structured,
      })
    } catch (error) {
      await client.send({
        type: 'tool_error',
        request_id: envelope.request_id,
        error: error instanceof Error ? error.message : 'Desktop tool failed.',
      })
    }
  })
  return () => {
    removeListener()
    removeEnvelope()
    client.close()
  }
}

export async function pairCurrentDesktop(): Promise<{ deviceId: number }> {
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Pairing is available in the Lain42 desktop app.')
  }
  const publicKey = `tauri-${requestId()}`
  const created = responseData<{ id: number; pairing_ticket: string }>(
    (
      await api.post('/api/agent/pairings', undefined, {
        skipErrorHandler: true,
      })
    ).data
  )
  const claimed = responseData<{
    id: number
    confirmation_ticket: string
    redeem_ticket: string
  }>(
    (
      await api.post(
        '/api/agent/pairings/claim',
        {
          pairing_ticket: created.pairing_ticket,
          device_name: 'Lain42 desktop',
          device_public_key: publicKey,
        },
        { skipErrorHandler: true }
      )
    ).data
  )
  await api.post(
    `/api/agent/pairings/${claimed.id}/confirm`,
    { confirmation_ticket: claimed.confirmation_ticket },
    { skipErrorHandler: true }
  )
  const redeemed = responseData<{ device: AgentDevice; credential: string }>(
    (
      await api.post(
        '/api/agent/pairings/redeem',
        { pairing_id: claimed.id, redeem_ticket: claimed.redeem_ticket },
        { skipErrorHandler: true }
      )
    ).data
  )
  await invoke('agent_device_credential_set', {
    credential: redeemed.credential,
    deviceId: redeemed.device.id,
  })
  return { deviceId: redeemed.device.id }
}
