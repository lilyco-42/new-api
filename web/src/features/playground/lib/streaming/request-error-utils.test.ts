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
  it('explains server resource safety pauses using the structured error code', () => {
    const expected =
      'New requests are temporarily paused because server resource usage exceeded a safety threshold. Please try again later or contact the site administrator.'

    for (const errorCode of [
      'system_disk_overloaded',
      'system_memory_overloaded',
      'system_cpu_overloaded',
    ]) {
      expect(
        getActionableRequestErrorKey(
          'system resource overloaded (current: 96.2%, threshold: 95%)',
          errorCode
        )
      ).toBe(expected)
    }
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
