/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { AgentBridgeCard } from './agent-bridge-card'

const { clipboardWriteTextMock } = vi.hoisted(() => ({
  clipboardWriteTextMock: vi.fn(),
}))

describe('AgentBridgeCard Radxa onboarding', () => {
  beforeEach(() => {
    clipboardWriteTextMock.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    })
  })

  test('offers restart for an already paired offline device without creating a duplicate', async () => {
    const user = userEvent.setup()
    const createPairing = vi.fn()

    render(
      <AgentBridgeCard
        isDesktop={false}
        status='offline'
        deviceName='radxa-a7a'
        onCreatePairing={createPairing}
      />
    )

    expect(
      screen.getByText(
        'This device is already paired. Run the command below on Radxa to restart its private service.'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create Radxa pairing ticket' })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy restart command' }))

    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      'sudo systemctl restart "lain42-agent-companion@$(id -un).service"'
    )
    expect(createPairing).not.toHaveBeenCalled()
  })

  test('offers pairing for a device that has not been linked', async () => {
    const user = userEvent.setup()
    const createPairing = vi.fn().mockResolvedValue(undefined)

    render(
      <AgentBridgeCard
        isDesktop={false}
        status='unavailable'
        onCreatePairing={createPairing}
      />
    )

    await user.click(
      screen.getByRole('button', { name: 'Create Radxa pairing ticket' })
    )

    expect(createPairing).toHaveBeenCalledOnce()
  })
})
