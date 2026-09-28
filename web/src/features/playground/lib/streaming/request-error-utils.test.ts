import { describe, expect, it } from 'vitest'

import {
  formatActionableRequestError,
  getActionableRequestErrorKey,
  getRequestIdFromErrorMessage,
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

  it('formats New API upstream errors without dropping their request id', () => {
    const details = parseRequestErrorDetails({
      response: {
        data: {
          error: {
            message: 'openai_error (request id: 202609291234abcd87654321)',
          },
        },
      },
    })

    expect(details.errorMessage).toBe(
      'openai_error (request id: 202609291234abcd87654321)'
    )
    expect(
      formatActionableRequestError(details.errorMessage, (key) => key)
    ).toBe(
      'The model service returned an unspecified error. Retry or switch models; if it keeps happening, contact the site administrator. (Request ID: 202609291234abcd87654321)'
    )
  })
})

describe('getActionableRequestErrorKey', () => {
  it('maps bare upstream errors with a server request id to recovery guidance', () => {
    const message = 'openai_error (request id: 202609291234abcd87654321)'
    const guidance =
      'The model service returned an unspecified error. Retry or switch models; if it keeps happening, contact the site administrator.'

    expect(getActionableRequestErrorKey('openai_error')).toBe(guidance)
    expect(getActionableRequestErrorKey('  OPENAI_ERROR  ')).toBe(guidance)
    expect(getActionableRequestErrorKey(message)).toBe(guidance)
    expect(getRequestIdFromErrorMessage(message)).toBe('202609291234abcd87654321')
    expect(
      formatActionableRequestError(message, (key) => `translated:${key}`)
    ).toBe(`translated:${guidance} (translated:Request ID: 202609291234abcd87654321)`)
  })

  it('keeps status-based recovery guidance and request ids together', () => {
    const message = 'Request failed with status code 503 (request id: abc-123)'

    expect(getActionableRequestErrorKey(message)).toContain('API channel')
    expect(getRequestIdFromErrorMessage(message)).toBe('abc-123')
  })

  it('does not treat malformed request id suffixes as support references', () => {
    expect(
      getRequestIdFromErrorMessage('openai_error (request id: <script>)')
    ).toBeNull()
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
