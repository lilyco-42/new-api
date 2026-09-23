import { describe, expect, it } from 'vitest'

import { buildOAuthCallbackUrl } from './oauth-callback-url'

describe('buildOAuthCallbackUrl', () => {
  it('uses the registered API route for GitHub OAuth', () => {
    expect(
      buildOAuthCallbackUrl(
        'https://api.lain42.top',
        'github',
        'https://fallback.example'
      )
    ).toBe('https://api.lain42.top/api/oauth/github')
  })

  it('does not duplicate an existing API base path', () => {
    expect(
      buildOAuthCallbackUrl(
        'https://api.lain42.top/api/',
        '/github/',
        'https://fallback.example'
      )
    ).toBe('https://api.lain42.top/api/oauth/github')
  })

  it('preserves reverse-proxy base paths', () => {
    expect(
      buildOAuthCallbackUrl(
        'https://example.com/new-api',
        'github',
        'https://fallback.example'
      )
    ).toBe('https://example.com/new-api/api/oauth/github')
  })
})
