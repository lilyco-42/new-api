import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentBridgeClient, createBrowserBridgeProvider } from '../agent-bridge'

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readonly sentMessages: string[] = []
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sentMessages.push(data)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  acknowledge(): void {
    this.onmessage?.({
      data: JSON.stringify({ type: 'hello_ack', protocol_version: 1 }),
    } as MessageEvent)
  }

  disconnect(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new Event('close'))
  }

  fail(): void {
    this.onerror?.(new Event('error'))
  }

  close(): void {
    this.disconnect()
  }
}

function getFakeSocket(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index]
  if (!socket) throw new Error(`Expected WebSocket instance ${index + 1}.`)
  return socket
}

describe('browser CLI bridge availability', () => {
  it('exposes paired-device tools only while the device is connected', () => {
    let status: 'connected' | 'offline' = 'offline'
    const client = {
      getStatus: () => status,
    } as unknown as AgentBridgeClient
    const provider = createBrowserBridgeProvider(client)

    expect(provider.isAvailable()).toBe(false)

    status = 'connected'
    expect(provider.isAvailable()).toBe(true)
  })
})

describe('AgentBridgeClient reconnect lifecycle', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reconnects an active desktop bridge after its WebSocket closes', async () => {
    const client = new AgentBridgeClient('desktop', 42, 'credential')
    const initialConnection = client.connect()
    const initialSocket = getFakeSocket(0)

    initialSocket.open()
    initialSocket.acknowledge()
    await initialConnection
    expect(JSON.parse(initialSocket.sentMessages[0] ?? '{}')).toMatchObject({
      type: 'hello',
      protocol_version: 1,
    })
    initialSocket.disconnect()

    expect(client.getStatus()).toBe('offline')

    await vi.advanceTimersByTimeAsync(1_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(client.getStatus()).toBe('connecting')
    getFakeSocket(1).fail()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(FakeWebSocket.instances).toHaveLength(3)
    const recoveredSocket = getFakeSocket(2)
    recoveredSocket.open()
    recoveredSocket.acknowledge()

    expect(client.getStatus()).toBe('connected')
    client.close()
  })

  it('retries when the server accepts a socket but never acknowledges it', async () => {
    const client = new AgentBridgeClient('desktop', 42, 'credential')
    const initialConnection = client.connect()
    const initialSocket = getFakeSocket(0)
    const initialRejection = expect(initialConnection).rejects.toThrow(
      'The agent bridge handshake timed out.'
    )

    initialSocket.open()
    await vi.advanceTimersByTimeAsync(10_000)
    await initialRejection
    await vi.advanceTimersByTimeAsync(1_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    const retrySocket = getFakeSocket(1)
    retrySocket.open()
    retrySocket.acknowledge()

    expect(client.getStatus()).toBe('connected')
    client.close()
  })

  it('does not reconnect after the bridge is explicitly closed', async () => {
    const client = new AgentBridgeClient('desktop', 42, 'credential')
    const initialConnection = client.connect()
    const initialSocket = getFakeSocket(0)

    initialSocket.open()
    initialSocket.acknowledge()
    await initialConnection
    initialSocket.disconnect()
    client.close()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(client.getStatus()).toBe('offline')
  })

  it('cancels a pending handshake when the bridge is closed', async () => {
    const client = new AgentBridgeClient('desktop', 42, 'credential')
    const pendingConnection = client.connect()

    client.close()

    await expect(pendingConnection).rejects.toThrow(
      'The agent bridge was closed.'
    )

    const nextConnection = client.connect()
    const nextSocket = getFakeSocket(1)
    nextSocket.open()
    nextSocket.acknowledge()
    await nextConnection

    expect(client.getStatus()).toBe('connected')
    client.close()
  })
})
