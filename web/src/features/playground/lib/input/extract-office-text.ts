/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import type { FileUIPart } from 'ai'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const MAX_OFFICE_ENTRY_BYTES = 1024 * 1024
const MAX_OFFICE_UNCOMPRESSED_BYTES = 4 * 1024 * 1024
const MAX_OFFICE_ENTRIES = 32
const MAX_OFFICE_ARCHIVE_ENTRIES = 2048
const MAX_WORKSHEETS = 12
const MAX_WORKSHEET_ROWS = 2000
const MAX_WORKSHEET_CELLS_PER_ROW = 100

type OfficeKind = 'docx' | 'xlsx'

export interface OfficeTextExtraction {
  readonly text: string
  readonly truncated: boolean
}

export function officeKind(file: FileUIPart): OfficeKind | null {
  const name = file.filename?.toLowerCase() ?? ''
  const mediaType = file.mediaType?.toLowerCase() ?? ''
  if (
    name.endsWith('.docx') ||
    mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) return 'docx'
  if (
    name.endsWith('.xlsx') ||
    mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) return 'xlsx'
  return null
}

export async function extractOfficeText(
  input: Uint8Array,
  kind: OfficeKind,
  maxCharacters: number,
): Promise<OfficeTextExtraction> {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error('Office text limit must be a positive integer.')
  }
  const { strFromU8, unzipSync } = await import('fflate/browser')
  let remainingBytes = MAX_OFFICE_UNCOMPRESSED_BYTES
  let selectedEntries = 0
  let visitedEntries = 0
  let truncated = false
  const files = unzipSync(input, {
    filter: (file) => {
      visitedEntries += 1
      if (visitedEntries > MAX_OFFICE_ARCHIVE_ENTRIES) {
        truncated = true
        return false
      }
      if (!isOfficeXmlEntry(file.name, kind)) return false
      if (
        selectedEntries >= MAX_OFFICE_ENTRIES ||
        !Number.isSafeInteger(file.originalSize) ||
        file.originalSize < 0 ||
        file.originalSize > MAX_OFFICE_ENTRY_BYTES ||
        file.originalSize > remainingBytes
      ) {
        truncated = true
        return false
      }
      selectedEntries += 1
      remainingBytes -= file.originalSize
      return true
    },
  })

  const lines = kind === 'docx'
    ? extractWordParagraphs(files, strFromU8)
    : extractWorkbookRows(files, strFromU8)
  let text = ''
  for (const line of lines) {
    const prefix = text.length === 0 ? '' : '\n'
    const available = maxCharacters - text.length - prefix.length
    if (available <= 0) {
      truncated = true
      break
    }
    if (line.length > available) {
      text += prefix + line.slice(0, available)
      truncated = true
      break
    }
    text += prefix + line
  }
  return { text, truncated }
}

function isOfficeXmlEntry(name: string, kind: OfficeKind): boolean {
  if (kind === 'docx') return name === 'word/document.xml'
  return name === 'xl/workbook.xml'
    || name === 'xl/_rels/workbook.xml.rels'
    || name === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)
}

function extractWordParagraphs(
  files: Record<string, Uint8Array>,
  decode: (data: Uint8Array) => string,
): string[] {
  const document = parseXml(files['word/document.xml'], decode)
  const paragraphs = Array.from(document.getElementsByTagNameNS(WORD_NS, 'p'))
    .map((paragraph) => Array.from(paragraph.getElementsByTagNameNS(WORD_NS, 't'))
      .map((node) => node.textContent ?? '')
      .join(''))
    .filter((paragraph) => paragraph.trim() !== '')
  if (paragraphs.length === 0) throw new Error('The DOCX document contains no readable text.')
  return paragraphs
}

function extractWorkbookRows(
  files: Record<string, Uint8Array>,
  decode: (data: Uint8Array) => string,
): string[] {
  const workbookBytes = files['xl/workbook.xml']
  const relationshipsBytes = files['xl/_rels/workbook.xml.rels']
  if (!workbookBytes || !relationshipsBytes) throw new Error('The XLSX workbook structure is incomplete.')

  const workbook = parseXml(workbookBytes, decode)
  const relationships = parseXml(relationshipsBytes, decode)
  const targetById = new Map<string, string | undefined>()
  for (const relationship of Array.from(relationships.getElementsByTagNameNS(PACKAGE_REL_NS, 'Relationship'))) {
    const id = relationship.getAttribute('Id')
    const target = relationship.getAttribute('Target')
    if (id && target) targetById.set(id, resolveWorkbookTarget(target))
  }

  const sharedStrings = files['xl/sharedStrings.xml']
    ? extractSharedStrings(parseXml(files['xl/sharedStrings.xml'], decode))
    : []
  const sheetNodes = Array.from(workbook.getElementsByTagNameNS(SHEET_NS, 'sheet'))
  const sheets = sheetNodes
    .map((sheet, index) => {
      const relationshipId = sheet.getAttributeNS(OFFICE_REL_NS, 'id') ?? sheet.getAttribute('r:id')
      const path = relationshipId ? targetById.get(relationshipId) : undefined
      return {
        name: sheet.getAttribute('name') || 'Sheet ' + (index + 1),
        path,
      }
    })
    .filter((sheet): sheet is { name: string; path: string } => sheet.path !== undefined && files[sheet.path] !== undefined)
  if (sheets.length === 0) throw new Error('The XLSX workbook contains no readable worksheets.')

  const lines: string[] = []
  for (const [sheetIndex, sheet] of sheets.slice(0, MAX_WORKSHEETS).entries()) {
    if (sheetIndex > 0) lines.push('')
    lines.push('Worksheet: ' + sheet.name)
    const worksheet = parseXml(files[sheet.path], decode)
    const rows = Array.from(worksheet.getElementsByTagNameNS(SHEET_NS, 'row'))
    for (const [rowIndex, row] of rows.slice(0, MAX_WORKSHEET_ROWS).entries()) {
      const cells = Array.from(row.getElementsByTagNameNS(SHEET_NS, 'c'))
      const values = cells.slice(0, MAX_WORKSHEET_CELLS_PER_ROW).flatMap((cell) => {
        const value = cellValue(cell, sharedStrings)
        if (value === '') return []
        const address = cell.getAttribute('r') || 'row ' + (rowIndex + 1)
        return [address + '=' + value]
      })
      if (values.length > 0) lines.push('Row ' + (row.getAttribute('r') || (rowIndex + 1)) + ': ' + values.join(' | '))
      if (cells.length > MAX_WORKSHEET_CELLS_PER_ROW) lines.push('[Remaining cells in this row were omitted.]')
    }
    if (rows.length > MAX_WORKSHEET_ROWS) lines.push('[Remaining worksheet rows were omitted.]')
  }
  if (sheets.length > MAX_WORKSHEETS) lines.push('[Remaining worksheets were omitted.]')
  lines.push('[Formula expressions are not calculated; only values saved in the workbook are included.]')
  lines.push('[Cell formatting is not applied; date or currency values may appear as raw stored values.]')
  return lines
}

function extractSharedStrings(document: Document): string[] {
  return Array.from(document.getElementsByTagNameNS(SHEET_NS, 'si'))
    .map((item) => Array.from(item.getElementsByTagNameNS(SHEET_NS, 't'))
      .map((node) => node.textContent ?? '')
      .join(''))
}

function cellValue(cell: Element, sharedStrings: readonly string[]): string {
  const type = cell.getAttribute('t')
  if (type === 'inlineStr') {
    return Array.from(cell.getElementsByTagNameNS(SHEET_NS, 't'))
      .map((node) => node.textContent ?? '')
      .join('')
  }
  const value = cell.getElementsByTagNameNS(SHEET_NS, 'v')[0]?.textContent ?? ''
  if (type === 's') {
    const index = Number(value)
    return Number.isSafeInteger(index) && index >= 0 ? sharedStrings[index] ?? '' : ''
  }
  if (type === 'b') return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value
  return value
}

function resolveWorkbookTarget(target: string): string | undefined {
  if (target.includes('\\') || /^[a-z]+:/iu.test(target)) return undefined
  const isPackagePath = target.startsWith('/xl/')
  if (target.startsWith('/') && !isPackagePath) return undefined
  const normalized = isPackagePath ? target.slice(1) : target
  const parts = normalized.startsWith('xl/') ? [] : ['xl']
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return undefined
    parts.push(part)
  }
  const path = parts.join('/')
  return path.startsWith('xl/') ? path : undefined
}

function parseXml(bytes: Uint8Array | undefined, decode: (data: Uint8Array) => string): Document {
  if (!bytes) throw new Error('The Office document is missing a required XML part.')
  const document = new DOMParser().parseFromString(decode(bytes), 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new Error('The Office document contains invalid XML.')
  }
  return document
}
