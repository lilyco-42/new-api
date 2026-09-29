import { afterEach, describe, expect, it } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { getAgentAccountId } from './agent-account-scope'

describe('getAgentAccountId', () => {
  afterEach(() => useAuthStore.getState().auth.setUser(null))

  it('returns the currently signed-in account id', () => {
    useAuthStore.getState().auth.setUser({ id: 42, username: 'user-42', role: 1 })
    expect(getAgentAccountId()).toBe(42)
  })

  it('does not allow local tools without a signed-in account', () => {
    expect(() => getAgentAccountId()).toThrow(
      'Sign in to use account-scoped desktop tools.'
    )
  })
})
