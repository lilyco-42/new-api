/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { describe, expect, test } from 'vitest'

import { parseGitHubOAuthBindCallback } from './github-oauth-bind'

describe('GitHub Agent OAuth callback validation', () => {
  const popup = {} as MessageEventSource

  test('accepts a callback from the expected popup and flow', () => {
    expect(
      parseGitHubOAuthBindCallback(
        {
          type: 'oauth:binding:callback',
          provider: 'github',
          state: 'flow-state',
          code: 'one-time-code',
        },
        'flow-state',
        popup,
        popup
      )
    ).toMatchObject({ provider: 'github', state: 'flow-state' })
  })

  test('rejects messages from another window, provider, flow, or without a result', () => {
    const message = {
      type: 'oauth:binding:callback',
      provider: 'github',
      state: 'flow-state',
      code: 'one-time-code',
    }
    expect(
      parseGitHubOAuthBindCallback(
        message,
        'flow-state',
        {} as MessageEventSource,
        popup
      )
    ).toBeNull()
    expect(
      parseGitHubOAuthBindCallback(message, 'other-state', popup, popup)
    ).toBeNull()
    expect(
      parseGitHubOAuthBindCallback(
        { ...message, provider: 'discord' },
        'flow-state',
        popup,
        popup
      )
    ).toBeNull()
    expect(
      parseGitHubOAuthBindCallback(
        { ...message, code: undefined },
        'flow-state',
        popup,
        popup
      )
    ).toBeNull()
  })
})
