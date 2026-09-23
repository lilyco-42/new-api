/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { ERROR_MESSAGES } from '../../constants'

type RequestErrorLike = {
  message?: string
  response?: {
    data?: {
      error?: {
        code?: string
        message?: string
      }
      message?: string
    }
  }
}

export type RequestErrorDetails = {
  errorCode?: string
  errorMessage: string
}

export function parseRequestErrorDetails(error: unknown): RequestErrorDetails {
  const requestError = error as RequestErrorLike
  const payload = requestError?.response?.data

  return {
    errorCode: payload?.error?.code || undefined,
    errorMessage:
      payload?.error?.message ||
      payload?.message ||
      requestError?.message ||
      ERROR_MESSAGES.API_REQUEST_ERROR,
  }
}

export function getActionableRequestErrorKey(message: string): string | null {
  if (
    /(?:status\s*code\s*)?429\b|rate.?limit|temporarily\s+rate.?limited/i.test(
      message
    )
  ) {
    return 'The selected model is temporarily rate limited. Retry shortly or choose another model.'
  }
  if (
    /\b(?:502|503|504)\b|temporarily unavailable|service unavailable/i.test(
      message
    )
  ) {
    return 'The selected model or API channel is temporarily unavailable. Retry or choose another model; if all models fail, check channel and server health.'
  }
  return null
}
