import { describe, expect, it } from 'vitest'

import { parseEmbeddedTextAttachment } from './message-attachment-preview-utils'

describe('parseEmbeddedTextAttachment', () => {
  it('returns the text file content sent to the model', () => {
    expect(
      parseEmbeddedTextAttachment(
        '[Attached file: notes.rs]\nfn main() {}\n[End attached file]'
      )
    ).toEqual({ name: 'notes.rs', text: 'fn main() {}' })
  })

  it('keeps the PDF page labels and extracted text visible', () => {
    expect(
      parseEmbeddedTextAttachment(
        '[Attached PDF: paper.pdf; 2 pages]\n[Page 1]\nFirst page\n[Page 2]\nSecond page\n[End attached PDF]'
      )
    ).toEqual({
      name: 'paper.pdf; 2 pages',
      text: '[Page 1]\nFirst page\n[Page 2]\nSecond page',
    })
  })

  it('shows the explanation when a PDF text limit omits extraction', () => {
    expect(
      parseEmbeddedTextAttachment(
        '[Attached PDF: paper.pdf]\n[PDF text omitted because the attachment text limit was reached.]'
      )
    ).toEqual({
      name: 'paper.pdf',
      text: '[PDF text omitted because the attachment text limit was reached.]',
    })
  })

  it('does not treat unsupported binary files as extracted text', () => {
    expect(
      parseEmbeddedTextAttachment(
        '[Attached file: archive.zip (application/zip)]'
      )
    ).toBeNull()
  })
})
