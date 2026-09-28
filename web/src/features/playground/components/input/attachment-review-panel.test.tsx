import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PromptInput,
  PromptInputAttachments,
} from '@/components/ai-elements/prompt-input'

import {
  AttachmentReviewPanel,
  type AttachmentReview,
} from './playground-input'

function ReviewHarness({ onConfirm }: { onConfirm: () => void }) {
  const [review, setReview] = useState<AttachmentReview | null>(null)

  return (
    <PromptInput onSubmit={() => undefined} multiple>
      <PromptInputAttachments>
        {(file) => (
          <div key={file.id}>
            <span>{file.filename}</span>
            <button
              onClick={() =>
                setReview({
                  text: 'Inspect this file',
                  parts: [
                    {
                      type: 'text',
                      text: `[Attached file: ${file.filename}]\nfn main() {}\n[End attached file]`,
                    },
                  ],
                  fileIds: [file.id],
                })
              }
              type='button'
            >
              Review {file.filename}
            </button>
          </div>
        )}
      </PromptInputAttachments>
      {review && (
        <AttachmentReviewPanel
          disabled={false}
          onCancel={() => setReview(null)}
          onConfirm={() => {
            onConfirm()
            setReview(null)
          }}
          review={review}
        />
      )}
    </PromptInput>
  )
}

describe('AttachmentReviewPanel', () => {
  let originalCreateObjectUrl: PropertyDescriptor | undefined
  let originalRevokeObjectUrl: PropertyDescriptor | undefined
  let objectUrlCounter = 0

  beforeEach(() => {
    objectUrlCounter = 0
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
      value: vi.fn(() => `blob:test-${++objectUrlCounter}`),
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

  it('requires a fresh review if the selected files change', () => {
    const onConfirm = vi.fn()
    const { container } = render(<ReviewHarness onConfirm={onConfirm} />)
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]'
    )!

    fireEvent.change(fileInput, {
      target: { files: [new File(['one'], 'one.rs', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review one.rs' }))
    expect(
      screen.getByRole('button', { name: 'Send to model' })
    ).toBeEnabled()

    fireEvent.change(fileInput, {
      target: { files: [new File(['two'], 'two.rs', { type: 'text/plain' })] },
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Send to model' })
    ).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.queryByRole('region', { name: 'Review attachments before sending' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('one.rs')).toBeInTheDocument()
    expect(screen.getByText('two.rs')).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('sends only after the user confirms the current attachment review', () => {
    const onConfirm = vi.fn()
    const { container } = render(<ReviewHarness onConfirm={onConfirm} />)
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]'
    )!

    fireEvent.change(fileInput, {
      target: { files: [new File(['fn main() {}'], 'main.rs', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review main.rs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to model' }))

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.queryByText('main.rs')).not.toBeInTheDocument()
  })
})
