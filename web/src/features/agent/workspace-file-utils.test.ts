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
import { describe, expect, test, vi } from 'vitest'

import {
  MAX_WORKSPACE_FILE_SIZE,
  MAX_WORKSPACE_FILES,
  MAX_WORKSPACE_TEXT_PREVIEW_BYTES,
  readWorkspaceTextPreview,
  selectWorkspaceFiles,
} from './workspace-file-utils'

function fileStub(name: string, size: number, type = 'text/plain') {
  return { name, size, type } as File
}

describe('workspace file limits', () => {
  test('rejects oversized files and caps the accepted count', () => {
    const files = [
      fileStub('too-large.txt', MAX_WORKSPACE_FILE_SIZE + 1),
      ...Array.from({ length: MAX_WORKSPACE_FILES + 1 }, (_, index) =>
        fileStub(`notes-${index}.txt`, 1)
      ),
    ]

    const selection = selectWorkspaceFiles(files)

    expect(selection.accepted).toHaveLength(MAX_WORKSPACE_FILES)
    expect(selection.oversized.map((file) => file.name)).toEqual([
      'too-large.txt',
    ])
    expect(selection.overLimit.map((file) => file.name)).toEqual([
      `notes-${MAX_WORKSPACE_FILES}.txt`,
    ])
  })

  test('reads only the bounded prefix of large text previews', async () => {
    const file = new File(
      ['a'.repeat(MAX_WORKSPACE_TEXT_PREVIEW_BYTES + 50)],
      'notes.txt',
      { type: 'text/plain' }
    )
    const slice = vi.spyOn(file, 'slice')

    const preview = await readWorkspaceTextPreview(file)

    expect(slice).toHaveBeenCalledWith(0, MAX_WORKSPACE_TEXT_PREVIEW_BYTES)
    expect(preview).toContain('[Text preview limited to the first 120 KB.]')
  })

  test('does not read binary data as text', async () => {
    const file = new File(['binary'], 'archive.zip', {
      type: 'application/zip',
    })
    const slice = vi.spyOn(file, 'slice')

    await expect(readWorkspaceTextPreview(file)).resolves.toBeUndefined()
    expect(slice).not.toHaveBeenCalled()
  })

  test('does not add a truncation notice for a small text file', async () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

    await expect(readWorkspaceTextPreview(file)).resolves.toBe('hello')
  })
})
