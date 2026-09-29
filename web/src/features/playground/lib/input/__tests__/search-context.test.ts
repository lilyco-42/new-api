import { describe, expect, it } from 'vitest'

import {
  containsPublicPageUrlReference,
  firstPublicPageUrlReference,
  formatSearchResultsForPrompt,
  normalizePublicPageUrlInput,
} from '../search-context'

describe('browser search context', () => {
  it('recognizes a URL pasted without a scheme as a page to read', () => {
    expect(normalizePublicPageUrlInput('deepseek.com')).toBe(
      'https://deepseek.com/'
    )
  })

  it('keeps a public HTTPS path and query when reading a URL', () => {
    expect(
      normalizePublicPageUrlInput('https://docs.example.com/guide?q=rust')
    ).toBe('https://docs.example.com/guide?q=rust')
  })

  it('does not treat a normal search phrase or HTTP URL as a page URL', () => {
    expect(normalizePublicPageUrlInput('deepseek ai models')).toBeNull()
    expect(normalizePublicPageUrlInput('http://example.com')).toBeNull()
  })

  it('finds a public page URL inside a natural-language request', () => {
    expect(
      containsPublicPageUrlReference('Please explain deepseek.com for me.')
    ).toBe(true)
    expect(
      firstPublicPageUrlReference(
        'Please explain https://deepseek.com/research?tab=1.'
      )
    ).toBe('https://deepseek.com/research?tab=1')
    expect(containsPublicPageUrlReference('deepseek ai models')).toBe(false)
  })

  it('skips non-HTTPS candidates and returns the first safe page URL', () => {
    expect(
      firstPublicPageUrlReference(
        'http://example.com then read https://docs.example.com/guide'
      )
    ).toBe('https://docs.example.com/guide')
  })

  it('formats search results as bounded source context for the model', () => {
    const context = formatSearchResultsForPrompt('rust ai', [
      {
        title: 'Rust agents',
        url: 'https://example.com/rust',
        snippet: 'An agent framework for Rust.',
      },
      {
        title: 'Unsafe result',
        url: 'javascript:alert(1)',
        snippet: 'This is not a safe source.',
      },
    ])

    expect(context).toContain('rust ai')
    expect(context).toContain('https://example.com/rust')
    expect(context).toContain('An agent framework for Rust.')
    expect(context).not.toContain('javascript:')
  })
})
