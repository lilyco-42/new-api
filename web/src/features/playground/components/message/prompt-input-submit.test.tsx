import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'

import {
  PromptInput,
  PromptInputAttachments,
} from '@/components/ai-elements/prompt-input'

function TestPromptInput({ onSubmit }: { onSubmit: Mock }) {
  return (
    <PromptInput onSubmit={onSubmit}>
      <PromptInputAttachments>
        {(file) => <span>{file.filename}</span>}
      </PromptInputAttachments>
      <input aria-label='Message' defaultValue='Inspect this file' name='message' />
      <button type='submit'>Send</button>
    </PromptInput>
  )
}

describe('PromptInput attachment preparation', () => {
  let originalCreateObjectUrl: PropertyDescriptor | undefined
  let originalRevokeObjectUrl: PropertyDescriptor | undefined

  beforeEach(() => {
    originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
      URL,
      'createObjectURL'
    )
    originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
      URL,
      'revokeObjectURL'
    )
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:test-attachment'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl)
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL')
    }
    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl)
    } else {
      Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
    vi.unstubAllGlobals()
  })

  it('blocks duplicate sends, allows cancellation, and keeps attachments retryable', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    let fetchCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        fetchCount += 1
        if (fetchCount === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true }
            )
          })
        }
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(['fn main() {}'], { type: 'text/plain' }),
        } as Response)
      })
    )

    const { container } = render(<TestPromptInput onSubmit={onSubmit} />)
    const form = container.querySelector('form')!
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]'
    )!
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['fn main() {}'], 'main.rs', { type: 'text/plain' })],
      },
    })

    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(fetchCount).toBe(1)
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(
        screen.queryByText('Preparing attachments...')
      ).not.toBeInTheDocument()
    )
    expect(screen.getByText('main.rs')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.submit(form)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(fetchCount).toBe(2)
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Inspect this file',
        files: [
          expect.objectContaining({
            filename: 'main.rs',
            url: expect.stringContaining('data:text/plain;base64,'),
          }),
        ],
        signal: expect.any(AbortSignal),
      }),
      expect.anything()
    )
    expect(screen.queryByText('main.rs')).not.toBeInTheDocument()
  })
})
