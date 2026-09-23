import { describe, expect, it } from 'vitest'

import {
  createBrowserBridgeProvider,
  type AgentBridgeClient,
} from '../agent-bridge'

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
