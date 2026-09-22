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
import { describe, expect, it } from 'vitest'

import { filePartsToContentParts } from './input-tool-utils'

describe('filePartsToContentParts', () => {
  it('turns text files into bounded prompt text', () => {
    const [part] = filePartsToContentParts([
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

  it('keeps images as OpenAI-compatible image parts', () => {
    const parts = filePartsToContentParts([
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

  it('describes unsupported binary files without sending binary data', () => {
    expect(
      filePartsToContentParts([
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
