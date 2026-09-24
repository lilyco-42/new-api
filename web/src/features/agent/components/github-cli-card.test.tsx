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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { GithubCliCard } from './github-cli-card'

const { apiGetMock, createOAuthFlowMock, toastErrorMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  createOAuthFlowMock: vi.fn(),
  toastErrorMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { get: apiGetMock } }))
vi.mock('@/features/auth/api', () => ({
  createOAuthFlow: createOAuthFlowMock,
}))
vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, success: vi.fn() },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('GithubCliCard browser OAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    apiGetMock.mockReset()
    createOAuthFlowMock.mockReset()
    toastErrorMock.mockReset()
    apiGetMock.mockResolvedValue({
      data: {
        success: true,
        data: { enabled: true, connected: false, client_id: 'client-id' },
      },
    })
  })

  test('opens the popup before waiting for the browser OAuth status request', async () => {
    const user = userEvent.setup()
    const delayedStatus = deferred<{
      data: {
        success: boolean
        data: { enabled: boolean; connected: boolean; client_id?: string }
      }
    }>()
    const popupState = { closed: false }
    const popup = {
      get closed() {
        return popupState.closed
      },
      close: vi.fn(() => {
        popupState.closed = true
      }),
    } as unknown as Window
    const openPopup = vi.spyOn(window, 'open').mockReturnValue(popup)

    render(<GithubCliCard />)
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledTimes(1)
      expect(
        screen.getByRole('button', { name: 'Connect GitHub in browser' })
      ).toBeEnabled()
    })
    apiGetMock.mockImplementationOnce(() => delayedStatus.promise)

    await user.click(
      screen.getByRole('button', { name: 'Connect GitHub in browser' })
    )

    expect(openPopup).toHaveBeenCalledWith('', '_blank', 'width=520,height=720')
    expect(apiGetMock).toHaveBeenCalledTimes(2)

    delayedStatus.resolve({
      data: {
        success: true,
        data: { enabled: false, connected: false },
      },
    })
    await waitFor(() => expect(popup.close).toHaveBeenCalled())
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('GitHub OAuth is not configured')
    )
  })

  test('shows a status API failure instead of reporting OAuth as unconfigured', async () => {
    const user = userEvent.setup()
    const popupState = { closed: false }
    const popup = {
      get closed() {
        return popupState.closed
      },
      close: vi.fn(() => {
        popupState.closed = true
      }),
    } as unknown as Window
    const openPopup = vi.spyOn(window, 'open').mockReturnValue(popup)

    render(<GithubCliCard />)
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledTimes(1)
      expect(
        screen.getByRole('button', { name: 'Connect GitHub in browser' })
      ).toBeEnabled()
    })
    apiGetMock.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 503'), {
        isAxiosError: true,
        response: { status: 503 },
      })
    )

    await user.click(
      screen.getByRole('button', { name: 'Connect GitHub in browser' })
    )

    expect(openPopup).toHaveBeenCalled()
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not check GitHub OAuth status (HTTP 503).'
      )
    )
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringContaining('GitHub OAuth is not configured')
    )
    expect(popup.close).toHaveBeenCalled()
  })

  test('keeps the connect action disabled while initial OAuth status is loading', async () => {
    const user = userEvent.setup()
    const delayedStatus = deferred<{
      data: {
        success: boolean
        data: { enabled: boolean; connected: boolean; client_id?: string }
      }
    }>()
    const openPopup = vi.spyOn(window, 'open').mockReturnValue(null)
    apiGetMock.mockImplementationOnce(() => delayedStatus.promise)

    render(<GithubCliCard />)
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1))
    const checkingButton = screen.getByRole('button', { name: 'Checking…' })
    expect(checkingButton).toBeDisabled()
    await user.click(checkingButton)
    expect(openPopup).not.toHaveBeenCalled()

    delayedStatus.resolve({
      data: {
        success: true,
        data: { enabled: true, connected: false, client_id: 'client-id' },
      },
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Connect GitHub in browser' })
      ).toBeEnabled()
    )
  })

  test('does not start a second OAuth flow if status is already connected', async () => {
    const user = userEvent.setup()
    const popupState = { closed: false }
    const popup = {
      get closed() {
        return popupState.closed
      },
      close: vi.fn(() => {
        popupState.closed = true
      }),
    } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)

    render(<GithubCliCard />)
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledTimes(1)
      expect(
        screen.getByRole('button', { name: 'Connect GitHub in browser' })
      ).toBeEnabled()
    })
    apiGetMock.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          enabled: true,
          connected: true,
          login: 'lilyco-42',
          client_id: 'client-id',
        },
      },
    })

    await user.click(
      screen.getByRole('button', { name: 'Connect GitHub in browser' })
    )

    await waitFor(() => expect(popup.close).toHaveBeenCalled())
    expect(createOAuthFlowMock).not.toHaveBeenCalled()
    expect(screen.getByText('OAuth connected · lilyco-42')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Connect GitHub in browser' })
    ).not.toBeInTheDocument()
  })

  test('does not present local gh login instructions in a browser session', async () => {
    render(<GithubCliCard />)

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Connect GitHub in browser' })
      ).toBeEnabled()
    )

    expect(
      screen.queryByRole('button', { name: 'Check gh login' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', {
        name: 'How to connect your own GitHub token',
      })
    ).not.toBeInTheDocument()
  })
})
