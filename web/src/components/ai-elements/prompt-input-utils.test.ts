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
import { describe, expect, it } from 'vitest'

import { filterPromptInputFiles } from './prompt-input-utils'

function mockFile(name: string, type: string, size: number): File {
  return { name, type, size } as File
}

describe('filterPromptInputFiles', () => {
  it('accepts matching images and text extensions from the same accept list', () => {
    const image = mockFile('screen.png', 'image/png', 100)
    const text = mockFile('notes.md', 'text/markdown', 100)
    const unsupported = mockFile('archive.zip', 'application/zip', 100)

    const result = filterPromptInputFiles([image, text, unsupported], {
      accept: 'image/*,.txt,.md,text/plain',
    })

    expect(result.accepted).toEqual([image, text])
    expect(result.rejectedTypes).toBe(1)
  })

  it('enforces file size and total attachment limits for external additions', () => {
    const small = mockFile('small.txt', 'text/plain', 100)
    const large = mockFile('large.txt', 'text/plain', 801)
    const extra = mockFile('extra.txt', 'text/plain', 100)

    const result = filterPromptInputFiles([small, large, extra], {
      accept: 'text/*,.txt',
      maxFileSize: 800,
      maxFiles: 5,
      currentFiles: 4,
    })

    expect(result.accepted).toEqual([small])
    expect(result.rejectedSizes).toBe(1)
    expect(result.rejectedCount).toBe(1)
  })

  it('accepts every file when no policy is specified', () => {
    const files = [mockFile('archive.zip', 'application/zip', 100)]
    expect(filterPromptInputFiles(files).accepted).toEqual(files)
  })
})
