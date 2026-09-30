import { describe, expect, it } from 'vitest'

import {
  getActionableRequestErrorKey,
  parseRequestErrorDetails,
} from './request-error-utils'

describe('parseRequestErrorDetails', () => {
  it('keeps the useful nested model error instead of Axios status boilerplate', () => {
    expect(
      parseRequestErrorDetails({
        message: 'Request failed with status code 503',
        response: {
          data: {
            error: {
              code: 'upstream_unavailable',
              message: 'The selected model is temporarily unavailable.',
            },
          },
        },
      })
    ).toEqual({
      errorCode: 'upstream_unavailable',
      errorMessage: 'The selected model is temporarily unavailable.',
    })
  })

  it('uses the standard Axios message when the response has no error body', () => {
    expect(
      parseRequestErrorDetails({
        message: 'Request failed with status code 503',
        response: { data: {} },
      })
    ).toEqual({
      errorCode: undefined,
      errorMessage: 'Request failed with status code 503',
    })
  })
})

describe('getActionableRequestErrorKey', () => {
  it('maps generic OpenAI errors to a user-facing recovery message', () => {
    expect(getActionableRequestErrorKey('openai_error', 'openai_error')).toBe(
      'The AI request could not be completed. Please retry or choose another model. If this continues, contact support.'
    )
  })

  it('maps inference connection failures to a retryable connection message', () => {
    expect(
      getActionableRequestErrorKey(
        'Inference connection error while making inference request'
      )
    ).toBe(
      'The connection to the AI service was interrupted. Please retry or choose another model.'
    )
  })

  it('explains server resource overloads without exposing diagnostic details', () => {
    expect(
      getActionableRequestErrorKey(
        'system disk overloaded (current: 96.2%, threshold: 95%)',
        'system_disk_overloaded'
      )
    ).toBe(
      'The AI service is temporarily paused because server storage is nearly full. Please retry later.'
    )
    expect(
      getActionableRequestErrorKey(
        'system memory overloaded (current: 97.0%, threshold: 95%)',
        'system_memory_overloaded'
      )
    ).toBe(
      'The AI service is temporarily paused because the server is under heavy load. Please retry later.'
    )
  })

  it('maps rate limits and transient gateway failures to recovery guidance', () => {
    expect(
      getActionableRequestErrorKey('Request failed with status code 429')
    ).toContain('rate limited')
    expect(
      getActionableRequestErrorKey('Request failed with status code 503')
    ).toContain('API channel')
    expect(
      getActionableRequestErrorKey('HTTP 504: Connection closed')
    ).toContain('server health')
    expect(getActionableRequestErrorKey('invalid prompt')).toBeNull()
  })
})
