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
import type { FileUIPart } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_PDF_PAGES, extractPdfText } from './extract-pdf-text'
import { filePartsToContentParts } from './input-tool-utils'

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))

vi.mock('pdfjs-dist', () => ({
  getDocument,
  GlobalWorkerOptions: { workerPort: null },
}))

describe('filePartsToContentParts', () => {
  beforeEach(() => {
    getDocument.mockReset()
  })

  it('turns text files into bounded prompt text', async () => {
    const [part] = await filePartsToContentParts([
      {
        type: 'file',
        filename: 'notes.txt',
        mediaType: 'text/plain',
        url: 'data:text/plain;base64,aGVsbG8=',
      } as FileUIPart,
    ])

    expect(part).toEqual({
      type: 'text',
      text: '[Attached file: notes.txt]\nhello\n[End attached file]',
    })
  })

  it('keeps images as OpenAI-compatible image parts', async () => {
    const parts = await filePartsToContentParts([
      {
        type: 'file',
        filename: 'product.png',
        mediaType: 'image/png',
        url: 'data:image/png;base64,AAAA',
      } as FileUIPart,
    ])

    expect(parts[0]).toEqual({
      type: 'text',
      text: '[Attached image: product.png]',
    })
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    })
  })

  it('extracts PDF text locally and includes page context', async () => {
    const page = {
      cleanup: vi.fn(),
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: 'Research notes', hasEOL: true }],
      }),
    }
    const document = {
      getPage: vi.fn().mockResolvedValue(page),
      numPages: 1,
    }
    const loadingTask = {
      destroy: vi.fn().mockResolvedValue(undefined),
      promise: Promise.resolve(document),
    }
    getDocument.mockReturnValue(loadingTask)

    const parts = await filePartsToContentParts([
      {
        type: 'file',
        filename: 'paper.pdf',
        mediaType: 'application/pdf',
        url: 'data:application/pdf;base64,JVBERi0xLjQK',
      } as FileUIPart,
    ])

    expect(parts).toEqual([
      {
        type: 'text',
        text: '[Attached PDF: paper.pdf; 1 page]\n[Page 1]\nResearch notes\n[End attached PDF]',
      },
    ])
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        stopAtErrors: true,
        wasmUrl: `${window.location.origin}/pdfjs/wasm/`,
      })
    )
    expect(document.getPage).toHaveBeenCalledWith(1)
    expect(page.cleanup).toHaveBeenCalledOnce()
    expect(loadingTask.destroy).toHaveBeenCalledOnce()
  })

  it('explains when a PDF has no selectable text', async () => {
    const document = {
      getPage: vi.fn().mockResolvedValue({
        cleanup: vi.fn(),
        getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      }),
      numPages: 1,
    }
    getDocument.mockReturnValue({
      destroy: vi.fn().mockResolvedValue(undefined),
      promise: Promise.resolve(document),
    })

    const [part] = await filePartsToContentParts([
      {
        type: 'file',
        filename: 'scan.pdf',
        mediaType: 'application/pdf',
        url: 'data:application/pdf;base64,JVBERi0xLjQK',
      } as FileUIPart,
    ])

    expect(part).toEqual({
      type: 'text',
      text: '[Attached PDF: scan.pdf; 1 page]\n\n[No selectable text was found. This may be a scanned PDF; OCR is not available.]\n[End attached PDF]',
    })
  })

  it('keeps attachments available when a PDF cannot be read', async () => {
    await expect(
      filePartsToContentParts([
        {
          type: 'file',
          filename: 'paper.pdf',
          mediaType: 'application/pdf',
          url: 'data:application/pdf;base64,not-valid%%%',
        } as FileUIPart,
      ])
    ).rejects.toThrow(
      'Unable to read this PDF. Check that it is not encrypted or damaged.'
    )
  })

  it('cancels client-side attachment parsing before reading any files', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      filePartsToContentParts(
        [
          {
            type: 'file',
            filename: 'notes.txt',
            mediaType: 'text/plain',
            url: 'data:text/plain;base64,aGVsbG8=',
          } as FileUIPart,
        ],
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('caps PDF extraction by both page count and text length', async () => {
    const page = {
      cleanup: vi.fn(),
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: 'x'.repeat(100), hasEOL: false }],
      }),
    }
    const loadingTask = {
      destroy: vi.fn().mockResolvedValue(undefined),
      promise: Promise.resolve({
        getPage: vi.fn().mockResolvedValue(page),
        numPages: MAX_PDF_PAGES + 5,
      }),
    }
    getDocument.mockReturnValue(loadingTask)

    const result = await extractPdfText(
      'data:application/pdf;base64,JVBERi0xLjQK',
      32
    )

    expect(result.totalPages).toBe(MAX_PDF_PAGES + 5)
    expect(result.processedPages).toBe(1)
    expect(result.text.length).toBeLessThanOrEqual(32)
    expect(result.truncated).toBe(true)
    expect(page.cleanup).toHaveBeenCalledOnce()
    expect(loadingTask.destroy).toHaveBeenCalledOnce()
  })

  it('describes unsupported binary files without sending binary data', async () => {
    expect(
      await filePartsToContentParts([
        {
          type: 'file',
          filename: 'archive.zip',
          mediaType: 'application/zip',
          url: 'data:application/zip;base64,AAAA',
        } as FileUIPart,
      ])
    ).toEqual([
      {
        type: 'text',
        text: '[Attached file: archive.zip (application/zip)]',
      },
    ])
  })
})
