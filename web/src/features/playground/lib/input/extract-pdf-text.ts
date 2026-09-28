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
import type { PDFDocumentProxy } from 'pdfjs-dist'

export const MAX_PDF_FILE_SIZE = 8 * 1024 * 1024
export const MAX_PDF_PAGES = 40

export type PdfTextExtraction = {
  text: string
  totalPages: number
  processedPages: number
  truncated: boolean
}

type PdfJsModule = Pick<typeof import('pdfjs-dist'), 'getDocument'>

async function loadPdfJs(): Promise<PdfJsModule> {
  const pdfjs = await import('pdfjs-dist')
  if (typeof Worker !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL('./pdf-worker.ts', import.meta.url),
      { type: 'module' }
    )
  }
  return pdfjs
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

async function readLocalPdfBytes(
  url: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  throwIfAborted(signal)
  if (url.startsWith('blob:')) {
    const blobUrl = new URL(url)
    if (blobUrl.origin !== window.location.origin) {
      throw new Error('PDF must be read from this browser session.')
    }

    const response = await fetch(url, { credentials: 'omit', signal })
    if (!response.ok) throw new Error('PDF could not be read.')
    const blob = await response.blob()
    throwIfAborted(signal)
    if (blob.size > MAX_PDF_FILE_SIZE) {
      throw new Error('PDF exceeds the file size limit.')
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    throwIfAborted(signal)
    return bytes
  }

  if (
    url.startsWith('data:application/pdf') ||
    url.startsWith('data:application/octet-stream')
  ) {
    const comma = url.indexOf(',')
    if (comma < 0) throw new Error('PDF data is invalid.')
    const metadata = url.slice(0, comma)
    const payload = url.slice(comma + 1)
    const isBase64 = /;base64/i.test(metadata)
    const estimatedSize = isBase64
      ? Math.floor((payload.length * 3) / 4)
      : payload.length
    if (estimatedSize > MAX_PDF_FILE_SIZE) {
      throw new Error('PDF exceeds the file size limit.')
    }

    let bytes: Uint8Array
    if (isBase64) {
      const binary = atob(payload)
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    } else {
      const values: number[] = []
      for (let index = 0; index < payload.length; index += 1) {
        if (payload[index] === '%') {
          const hex = payload.slice(index + 1, index + 3)
          if (!/^[\da-f]{2}$/i.test(hex)) {
            throw new Error('PDF data is invalid.')
          }
          values.push(Number.parseInt(hex, 16))
          index += 2
        } else {
          values.push(payload.charCodeAt(index))
        }
      }
      bytes = Uint8Array.from(values)
    }

    return bytes
  }

  throw new Error('PDF must be read from this browser session.')
}

function appendTextWithinLimit(
  chunks: string[],
  text: string,
  currentLength: number,
  maxChars: number
): number {
  const available = Math.max(0, maxChars - currentLength)
  if (available === 0 || text.length === 0) return currentLength

  const boundedText = text.slice(0, available)
  chunks.push(boundedText)
  return currentLength + boundedText.length
}

export async function extractPdfText(
  url: string,
  maxChars: number,
  signal?: AbortSignal
): Promise<PdfTextExtraction> {
  const data = await readLocalPdfBytes(url, signal)
  const { getDocument } = await loadPdfJs()
  throwIfAborted(signal)
  const loadingTask = getDocument({
    data,
    stopAtErrors: true,
    useSystemFonts: true,
    wasmUrl: new URL('/pdfjs/wasm/', window.location.origin).href,
  })
  let destroyPromise: Promise<void> | undefined
  const destroyLoadingTask = () =>
    (destroyPromise ??= loadingTask.destroy())
  const abortLoadingTask = () => {
    void destroyLoadingTask().catch(() => undefined)
  }
  signal?.addEventListener('abort', abortLoadingTask, { once: true })

  let document: PDFDocumentProxy | undefined
  try {
    document = await loadingTask.promise
    throwIfAborted(signal)
    const chunks: string[] = []
    let textLength = 0
    let processedPages = 0
    let truncated = document.numPages > MAX_PDF_PAGES
    const pageLimit = Math.min(document.numPages, MAX_PDF_PAGES)

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      throwIfAborted(signal)
      if (textLength >= maxChars) {
        truncated = true
        break
      }

      const prefix = `${textLength > 0 ? '\n\n' : ''}[Page ${pageNumber}]\n`
      const pageTextLimit = maxChars - textLength - prefix.length
      if (pageTextLimit <= 0) {
        truncated = true
        break
      }

      const page = await document.getPage(pageNumber)
      processedPages += 1
      try {
        throwIfAborted(signal)
        const textContent = await page.getTextContent()
        throwIfAborted(signal)
        const pageChunks: string[] = []
        let pageLength = 0

        for (const item of textContent.items) {
          if (!('str' in item) || !item.str) continue
          const before = pageLength
          pageLength = appendTextWithinLimit(
            pageChunks,
            item.str,
            pageLength,
            pageTextLimit
          )
          if (pageLength === before + item.str.length && item.hasEOL) {
            if (pageLength >= pageTextLimit) {
              truncated = true
              break
            }
            pageChunks.push('\n')
            pageLength += 1
          }
          if (pageLength >= pageTextLimit) {
            truncated = true
            break
          }
        }

        const pageText = pageChunks.join('').trim()
        if (pageText) {
          chunks.push(prefix, pageText)
          textLength += prefix.length + pageText.length
        }
      } finally {
        page.cleanup()
      }
    }

    return {
      text: chunks.join(''),
      totalPages: document.numPages,
      processedPages,
      truncated,
    }
  } finally {
    signal?.removeEventListener('abort', abortLoadingTask)
    await destroyLoadingTask()
  }
}
