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

export type PromptInputFilePolicy = {
  accept?: string
  maxFiles?: number
  maxFileSize?: number
  currentFiles?: number
}

export type PromptInputFileFilterResult = {
  accepted: File[]
  rejectedTypes: number
  rejectedSizes: number
  rejectedCount: number
}

export function matchesAcceptedFileType(file: File, accept?: string): boolean {
  const rules = accept
    ?.split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)

  if (!rules?.length) return true

  const fileName = file.name.toLowerCase()
  const mediaType = file.type.toLowerCase()

  return rules.some((rule) => {
    if (rule === '*/*') return true
    if (rule.startsWith('.')) return fileName.endsWith(rule)
    if (rule.endsWith('/*')) return mediaType.startsWith(rule.slice(0, -1))
    return mediaType === rule
  })
}

export function filterPromptInputFiles(
  incoming: File[] | FileList,
  policy: PromptInputFilePolicy = {}
): PromptInputFileFilterResult {
  const files = [...incoming]
  const matching = files.filter((file) =>
    matchesAcceptedFileType(file, policy.accept)
  )
  const withinSize = matching.filter(
    (file) => policy.maxFileSize === undefined || file.size <= policy.maxFileSize
  )
  const capacity =
    policy.maxFiles === undefined
      ? withinSize.length
      : Math.max(0, policy.maxFiles - (policy.currentFiles ?? 0))
  const accepted = withinSize.slice(0, capacity)

  return {
    accepted,
    rejectedTypes: files.length - matching.length,
    rejectedSizes: matching.length - withinSize.length,
    rejectedCount: withinSize.length - accepted.length,
  }
}
