import { afterEach, describe, expect, it, vi } from 'vitest'

import { getFreshAuthHeaders } from '@/lib/auth-session'
import { useAuthStore } from '@/stores/auth-store'

import {
  getAgentAccountContext,
  getAgentAccountId,
} from '../agent-account-scope'

vi.mock('@/lib/auth-session', () => ({
  getFreshAuthHeaders: vi.fn(),
}))

const getFreshAuthHeadersMock = vi.mocked(getFreshAuthHeaders)

describe('Agent account scope', () => {
  afterEach(() => {
    useAuthStore.getState().auth.reset()
    vi.resetAllMocks()
  })

  it('returns the currently signed-in account id', () => {
    useAuthStore.getState().auth.setUser({ id: 42, username: 'user-42', role: 1 })

    expect(getAgentAccountId()).toBe(42)
  })

  it('does not allow local tools without a signed-in account', () => {
    expect(() => getAgentAccountId()).toThrow(
      'Sign in to use account-scoped desktop tools.'
    )
  })

  it('pairs the current account id with its refreshed bearer token', async () => {
    useAuthStore.getState().auth.setUser({ id: 42, username: 'user-42', role: 1 })
    getFreshAuthHeadersMock.mockResolvedValue({
      Authorization: 'Bearer account-session-token-42',
    })

    await expect(getAgentAccountContext()).resolves.toEqual({
      userId: 42,
      accessToken: 'account-session-token-42',
    })
  })

  it('rejects an account switch while refreshing the local tool session', async () => {
    useAuthStore.getState().auth.setUser({ id: 42, username: 'user-42', role: 1 })
    getFreshAuthHeadersMock.mockImplementation(async () => {
      useAuthStore
        .getState()
        .auth.setUser({ id: 43, username: 'user-43', role: 1 })
      return { Authorization: 'Bearer account-session-token-43' }
    })

    await expect(getAgentAccountContext()).rejects.toThrow(
      'The signed-in account changed. Retry the desktop action.'
    )
  })

  it('rejects refreshed headers without a bearer token', async () => {
    useAuthStore.getState().auth.setUser({ id: 42, username: 'user-42', role: 1 })
    getFreshAuthHeadersMock.mockResolvedValue({})

    await expect(getAgentAccountContext()).rejects.toThrow(
      'A valid signed-in session is required for desktop tools.'
    )
  })
})
