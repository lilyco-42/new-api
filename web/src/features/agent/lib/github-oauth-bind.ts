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
import { OAUTH_BIND_CALLBACK_MESSAGE } from '@/features/auth/constants'

export interface GitHubOAuthBindCallback {
  type: typeof OAUTH_BIND_CALLBACK_MESSAGE
  provider: 'github'
  state: string
  code?: string
  error?: string
  errorDescription?: string
}

export function parseGitHubOAuthBindCallback(
  value: unknown,
  expectedState: string,
  actualSource: MessageEventSource | null,
  expectedSource: MessageEventSource
): GitHubOAuthBindCallback | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<GitHubOAuthBindCallback>
  if (
    message.type !== OAUTH_BIND_CALLBACK_MESSAGE ||
    message.provider !== 'github' ||
    message.state !== expectedState ||
    actualSource !== expectedSource ||
    (typeof message.code !== 'string' && typeof message.error !== 'string')
  ) {
    return null
  }
  return message as GitHubOAuthBindCallback
}
