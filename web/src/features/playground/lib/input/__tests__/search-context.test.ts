import { describe, expect, it } from 'vitest'

import {
  containsPublicPageUrlReference,
  extractPublicPageUrlReferences,
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
    expect(containsPublicPageUrlReference('deepseek ai models')).toBe(false)
  })

  it('returns normalized URLs so page reads can stay tied to the user request', () => {
    expect(
      extractPublicPageUrlReferences(
        'Read https://docs.example.com/guide#intro and https://docs.example.com/guide#faq.'
      )
    ).toEqual(['https://docs.example.com/guide'])
  })

  it('strips common CJK sentence punctuation from a pasted URL', () => {
    expect(
      extractPublicPageUrlReferences('请读取 https://docs.example.com/guide。')
    ).toEqual(['https://docs.example.com/guide'])
  })

  it('stops a URL at CJK punctuation before the rest of a sentence', () => {
    expect(
      extractPublicPageUrlReferences(
        '请阅读 https://docs.example.com/guide，说明页面用途并给出来源。'
      )
    ).toEqual(['https://docs.example.com/guide'])
  })

  it('preserves query commas before a CJK sentence boundary', () => {
    expect(
      extractPublicPageUrlReferences(
        '请阅读 https://docs.example.com/search?q=rust,wasm，说明结果。'
      )
    ).toEqual(['https://docs.example.com/search?q=rust,wasm'])
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
