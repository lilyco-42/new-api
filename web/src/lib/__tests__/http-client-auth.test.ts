import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearAuthentication, refreshAuthentication } from '../auth-session'
import { api } from '../http-client'

vi.mock('../auth-session', () => ({
  applyAuthRotation: vi.fn(),
  clearAuthentication: vi.fn(),
  refreshAuthentication: vi.fn(),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ auth: { accessToken: 'synthetic-site-access-token' } }) },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('website session and connected GitHub authorization', () => {
  beforeEach(() => {
    vi.mocked(refreshAuthentication).mockResolvedValue({ kind: 'authenticated', bundle: {
      access_token: 'synthetic-site-access-token', token_type: 'Bearer',
      access_expires_at: Math.floor(Date.now() / 1000) + 600,
      user: { id: 42, username: 'fixture-user', role: 1 },
      session: { sid: 'fixture-session', current: true, login_method: 'password',
        ip: '127.0.0.1', user_agent: 'fixture', created_at: 100, last_active_at: 100, expires_at: 1000 },
    } })
  })

  afterEach(() => { vi.clearAllMocks() })

  it.each(['AGENT_GITHUB_NOT_CONNECTED', 'AGENT_GITHUB_REQUEST_FAILED'])(
    'keeps the website session when a GitHub read returns 401 with %s', async (code) => {
      const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
        throw new AxiosError('Request failed with status code 401', AxiosError.ERR_BAD_REQUEST,
          config, undefined, { status: 401, statusText: 'Unauthorized', config,
            headers: {}, data: { success: false, code, message: 'GitHub authorization failed' } })
      })

      await expect(api.get('/api/agent/github/issues/search', {
        adapter, disableDuplicate: true, skipErrorHandler: true,
      })).rejects.toMatchObject({ response: { status: 401, data: { code } } })

      expect(adapter).toHaveBeenCalledOnce()
      expect(refreshAuthentication).not.toHaveBeenCalled()
      expect(clearAuthentication).not.toHaveBeenCalled()
    }
  )

  it.each([
    { path: '/api/agent/github/issues/search', code: 'AUTH_TOKEN_EXPIRED' },
    { path: '/api/user/self', code: 'AGENT_GITHUB_NOT_CONNECTED' },
    { path: '/api/agent/github/issues/search', code: undefined },
  ])('still refreshes a website session for $path with $code', async ({ path, code }) => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (!config.authRetry) {
        throw new AxiosError('Request failed with status code 401', AxiosError.ERR_BAD_REQUEST,
          config, undefined, { status: 401, statusText: 'Unauthorized', config,
            headers: {}, data: { success: false, code } })
      }
      return { status: 200, statusText: 'OK', config, headers: {}, data: { success: true } }
    })

    const result = await api.get(path, {
      adapter, disableDuplicate: true, skipErrorHandler: true,
    })

    expect(result.data.success).toBe(true)
    expect(adapter).toHaveBeenCalledTimes(2)
    expect(refreshAuthentication).toHaveBeenCalledOnce()
    expect(clearAuthentication).not.toHaveBeenCalled()
  })
})
