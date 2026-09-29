import { describe, expect, it, vi } from 'vitest'

import type {
  ChatCompletionMessage,
  ChatCompletionResponse,
  HostedTurnProvider,
  LocalToolProvider,
} from '../../types'
import { resolveLocalToolPreflight } from '../hosted-turn-routing'

const messages: ChatCompletionMessage[] = [
  { role: 'user', content: 'Search the web for current Rust tools.' },
]

const preflightResponse: ChatCompletionResponse = {
  id: 'local-preflight',
  object: 'chat.completion',
  created: 0,
  model: 'test',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Local preflight response.' },
    finish_reason: 'stop',
  }],
}

describe('hosted Agent turn routing', () => {
  it('leaves search preflight to the hosted model and its account-scoped tools', () => {
    const localToolProvider: LocalToolProvider = {
      tools: [],
      preflight: vi.fn(() => preflightResponse),
    }
    const hostedTurnProvider: HostedTurnProvider = {
      send: vi.fn(async () => null),
      reset: vi.fn(),
    }

    expect(resolveLocalToolPreflight(localToolProvider, messages, hostedTurnProvider))
      .toBeNull()
    expect(localToolProvider.preflight).not.toHaveBeenCalled()
  })

  it('keeps local preflight behavior when no hosted Agent owns the turn', () => {
    const localToolProvider: LocalToolProvider = {
      tools: [],
      preflight: vi.fn(() => preflightResponse),
    }

    expect(resolveLocalToolPreflight(localToolProvider, messages, undefined))
      .toBe(preflightResponse)
    expect(localToolProvider.preflight).toHaveBeenCalledWith(messages)
  })
})
