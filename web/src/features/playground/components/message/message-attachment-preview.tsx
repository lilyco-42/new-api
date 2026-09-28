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
import { FileText, Image as ImageIcon, Paperclip } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import type { ContentPart } from '../../types'
import { parseEmbeddedTextAttachment } from './message-attachment-preview-utils'

type MessageAttachmentPreviewProps = {
  parts?: ContentPart[]
}

type AttachmentItem =
  | { kind: 'image'; name: string; url: string }
  | { kind: 'file'; name: string }
  | { kind: 'text'; name: string; text: string }

function attachmentName(text: string, kind: 'file' | 'image'): string | null {
  const prefix = kind === 'image' ? '[Attached image: ' : '[Attached file: '
  if (!text.startsWith(prefix) || !text.endsWith(']')) return null
  const name = text.slice(prefix.length, -1).trim()
  return name || null
}

function collectAttachments(parts: ContentPart[]): AttachmentItem[] {
  const result: AttachmentItem[] = []
  let pendingImageName: string | null = null

  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      const textAttachment = parseEmbeddedTextAttachment(part.text)
      if (textAttachment) {
        result.push({ kind: 'text', ...textAttachment })
        continue
      }

      const imageName = attachmentName(part.text, 'image')
      if (imageName) {
        pendingImageName = imageName
        continue
      }
      const fileName = attachmentName(part.text, 'file')
      if (fileName) {
        result.push({ kind: 'file', name: fileName })
      }
      continue
    }

    if (part.type === 'image_url' && part.image_url?.url) {
      result.push({
        kind: 'image',
        name: pendingImageName || 'image',
        url: part.image_url.url,
      })
      pendingImageName = null
    }
  }

  return result
}

export function MessageAttachmentPreview({
  parts = [],
}: MessageAttachmentPreviewProps) {
  const { t } = useTranslation()
  const attachments = collectAttachments(parts)
  if (attachments.length === 0) return null

  return (
    <div
      aria-label={t('Attached files')}
      className='mb-2 flex max-w-full flex-wrap gap-2'
    >
      {attachments.map((attachment) =>
        attachment.kind === 'image' ? (
          <figure
            className='bg-muted/40 overflow-hidden rounded-xl border'
            key={attachment.url}
          >
            <img
              alt={attachment.name}
              className='max-h-44 max-w-64 object-contain'
              loading='lazy'
              src={attachment.url}
            />
            <figcaption className='text-muted-foreground flex items-center gap-1.5 truncate px-2 py-1 text-[10px]'>
              <ImageIcon className='size-3 shrink-0' aria-hidden='true' />
              <span className='truncate'>{attachment.name}</span>
            </figcaption>
          </figure>
        ) : attachment.kind === 'text' ? (
          <details
            className='bg-muted/40 max-w-full overflow-hidden rounded-xl border'
            key={`${attachment.kind}:${attachment.name}`}
          >
            <summary className='text-muted-foreground flex max-w-80 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs'>
              <FileText
                className='text-primary size-3.5 shrink-0'
                aria-hidden='true'
              />
              <span className='truncate'>{attachment.name}</span>
              <span className='shrink-0'>{t('Preview')}</span>
            </summary>
            <pre className='border-t px-3 py-2 text-xs whitespace-pre-wrap break-words max-h-72 overflow-auto'>
              {attachment.text}
            </pre>
          </details>
        ) : (
          <div
            className={cn(
              'bg-muted/40 text-muted-foreground flex max-w-64 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs'
            )}
            key={`${attachment.kind}:${attachment.name}`}
            title={attachment.name}
          >
            <FileText
              className='text-primary size-3.5 shrink-0'
              aria-hidden='true'
            />
            <span className='truncate'>{attachment.name}</span>
            <Paperclip
              className='size-3 shrink-0 opacity-60'
              aria-hidden='true'
            />
          </div>
        )
      )}
    </div>
  )
}
