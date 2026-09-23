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
import {
  CameraIcon,
  FileIcon,
  ImageIcon,
  ScreenShareIcon,
  type LucideIcon,
} from 'lucide-react'

import type { ContentPart } from '../../types'
import { MAX_PDF_PAGES, extractPdfText } from './extract-pdf-text'

type AttachmentAction = {
  action: string
  icon: LucideIcon
  label: string
}

export const ATTACHMENT_ACTIONS = [
  { action: 'upload-file', icon: FileIcon, label: 'Upload file' },
  { action: 'upload-photo', icon: ImageIcon, label: 'Upload photo' },
  {
    action: 'take-screenshot',
    icon: ScreenShareIcon,
    label: 'Take screenshot',
  },
  { action: 'take-photo', icon: CameraIcon, label: 'Take photo' },
] satisfies AttachmentAction[]

export const PROMPT_INPUT_ATTACH_FILES_EVENT =
  'lain42:prompt-input-attach-files'

export const MAX_ATTACHMENT_FILE_SIZE_BYTES = 8 * 1024 * 1024

export function attachFilesToCurrentPromptInput(files: File[]) {
  if (typeof window === 'undefined' || files.length === 0) return
  window.dispatchEvent(
    new CustomEvent(PROMPT_INPUT_ATTACH_FILES_EVENT, {
      detail: { files },
    })
  )
}

const TEXT_ATTACHMENT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/toml',
  'application/xml',
  'application/yaml',
  'text/css',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/x-c',
  'text/x-c++',
  'text/x-java',
  'text/x-python',
  'text/x-rust',
  'text/yaml',
])

const MAX_ATTACHMENT_TEXT_CHARS = 120_000

function decodeDataUrl(url: string): string | null {
  const match = url.match(/^data:[^,]*,([\s\S]*)$/i)
  if (!match) return null

  try {
    const metadata = url.slice(5, url.indexOf(','))
    const encoded = match[1]
    if (/;base64/i.test(metadata)) {
      const binary = atob(encoded)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function isTextAttachment(file: FileUIPart): boolean {
  if (file.mediaType?.startsWith('text/')) return true
  if (file.mediaType && TEXT_ATTACHMENT_TYPES.has(file.mediaType)) return true
  return /\.(c|cc|cpp|css|csv|go|h|hpp|html?|java|js|json|md|py|rs|sql|toml|ts|tsx|txt|vue|xml|ya?ml)$/i.test(
    file.filename ?? ''
  )
}

function isPdfAttachment(file: FileUIPart): boolean {
  return (
    file.mediaType?.toLowerCase() === 'application/pdf' ||
    file.filename?.toLowerCase().endsWith('.pdf') === true
  )
}

/** Convert PromptInput files into OpenAI-compatible request content parts. */
export async function filePartsToContentParts(
  files: FileUIPart[]
): Promise<ContentPart[]> {
  const parts: ContentPart[] = []
  let remainingTextChars = MAX_ATTACHMENT_TEXT_CHARS

  for (const file of files) {
    const filename = file.filename || 'attachment'
    const mediaType = file.mediaType || 'application/octet-stream'
    const url = file.url || ''

    if (mediaType.startsWith('image/') && url.startsWith('data:image/')) {
      parts.push(
        { type: 'text', text: `[Attached image: ${filename}]` },
        { type: 'image_url', image_url: { url } }
      )
      continue
    }

    if (isPdfAttachment(file)) {
      if (remainingTextChars <= 0) {
        parts.push({
          type: 'text',
          text: `[Attached PDF: ${filename}]\n[PDF text omitted because the attachment text limit was reached.]`,
        })
        continue
      }

      try {
        const pdf = await extractPdfText(url, remainingTextChars)
        let status = ''
        if (!pdf.text.trim()) {
          status =
            '\n[No selectable text was found. This may be a scanned PDF; OCR is not available.]'
        } else if (pdf.truncated) {
          status = `\n[PDF text was limited to ${MAX_PDF_PAGES} pages or the attachment text limit.]`
        }
        const pageLabel = pdf.totalPages === 1 ? 'page' : 'pages'
        const text = `[Attached PDF: ${filename}; ${pdf.totalPages} ${pageLabel}]\n${pdf.text}${status}\n[End attached PDF]`
        parts.push({ type: 'text', text })
        remainingTextChars = Math.max(
          0,
          remainingTextChars - pdf.text.length - status.length
        )
      } catch {
        throw new Error(
          'Unable to read this PDF. Check that it is not encrypted or damaged.'
        )
      }
      continue
    }

    if (isTextAttachment(file)) {
      const text = decodeDataUrl(url)
      if (text !== null) {
        const boundedText = text.slice(0, remainingTextChars)
        const truncated = boundedText.length < text.length
        const status = truncated ? '\n[File text was truncated.]' : ''
        parts.push({
          type: 'text',
          text: `[Attached file: ${filename}]\n${boundedText}${status}\n[End attached file]`,
        })
        remainingTextChars = Math.max(
          0,
          remainingTextChars - boundedText.length - status.length
        )
        continue
      }
    }

    parts.push({
      type: 'text',
      text: `[Attached file: ${filename} (${mediaType})]`,
    })
  }

  return parts
}
