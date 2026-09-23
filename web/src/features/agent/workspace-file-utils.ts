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

import { MAX_ATTACHMENT_FILE_SIZE_BYTES } from '@/features/playground/lib/input/input-tool-utils'

export const MAX_WORKSPACE_FILES = 10
export const MAX_WORKSPACE_FILE_SIZE = MAX_ATTACHMENT_FILE_SIZE_BYTES
export const MAX_WORKSPACE_TEXT_PREVIEW_BYTES = 120_000

export type WorkspaceFileSelection = {
  accepted: File[]
  oversized: File[]
  overLimit: File[]
}

export function selectWorkspaceFiles(files: File[]): WorkspaceFileSelection {
  const accepted: File[] = []
  const oversized: File[] = []
  const overLimit: File[] = []

  for (const file of files) {
    if (file.size > MAX_WORKSPACE_FILE_SIZE) {
      oversized.push(file)
    } else if (accepted.length < MAX_WORKSPACE_FILES) {
      accepted.push(file)
    } else {
      overLimit.push(file)
    }
  }

  return { accepted, oversized, overLimit }
}

export async function readWorkspaceTextPreview(
  file: Pick<File, 'name' | 'size' | 'type' | 'slice'>
): Promise<string | undefined> {
  const textLike =
    file.type.startsWith('text/') ||
    /\.(c|cc|cpp|css|csv|go|h|hpp|html?|java|js|json|md|py|rs|sql|toml|ts|tsx|txt|vue|xml|ya?ml)$/i.test(
      file.name
    )
  if (!textLike) return undefined

  const text = await file.slice(0, MAX_WORKSPACE_TEXT_PREVIEW_BYTES).text()
  if (file.size <= MAX_WORKSPACE_TEXT_PREVIEW_BYTES) return text
  return `${text}\n\n[Text preview limited to the first 120 KB.]`
}
