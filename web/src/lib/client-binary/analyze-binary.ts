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

export const MAX_BINARY_ANALYSIS_BYTES = 64 * 1024

const BINARY_ANALYZER_WASM_URL = '/agent/binary_analyzer.wasm'
const BINARY_ANALYSIS_OUTPUT_BYTES = 16 * 1024
const WASM_PAGE_BYTES = 65_536

type BinaryAnalyzerWasm = {
  memory: WebAssembly.Memory
  __heap_base: WebAssembly.Global
  analyze_binary: (
    inputPointer: number,
    inputLength: number,
    outputPointer: number,
    outputCapacity: number,
    totalLength: number
  ) => number
}

type BinaryAnalyzerFacts = {
  format: string
  recognized: boolean
  architecture?: string
  bitness?: number
  endianness?: string
  objectType?: number
  version?: number
  sections?: Array<{ id: number; name: string; bytes: number }>
  sectionCount?: number
  architectureCount?: number
  sectionsTruncated?: boolean
  malformed?: boolean
  sectionsIncomplete?: boolean
  note?: string
}

export type BinaryAnalysisResult = BinaryAnalyzerFacts & {
  bytesAnalyzed: number
  totalBytes: number
  prefixTruncated: boolean
}

let analyzerPromise: Promise<BinaryAnalyzerWasm> | undefined

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

function isBinaryAnalyzerWasm(value: unknown): value is BinaryAnalyzerWasm {
  if (!value || typeof value !== 'object') return false
  const exports = value as Partial<BinaryAnalyzerWasm>
  return (
    exports.memory instanceof WebAssembly.Memory &&
    exports.__heap_base instanceof WebAssembly.Global &&
    typeof exports.analyze_binary === 'function'
  )
}

async function loadBinaryAnalyzer(): Promise<BinaryAnalyzerWasm> {
  analyzerPromise ??= (async () => {
    const response = await fetch(BINARY_ANALYZER_WASM_URL, {
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!response.ok) {
      throw new Error('The local WASM binary analyzer could not be loaded.')
    }
    const { instance } = await WebAssembly.instantiate(
      await response.arrayBuffer()
    )
    if (!isBinaryAnalyzerWasm(instance.exports)) {
      throw new Error('The local WASM binary analyzer is invalid.')
    }
    return instance.exports
  })().catch((error: unknown) => {
    analyzerPromise = undefined
    throw error
  })
  return analyzerPromise
}

function parseAnalyzerFacts(value: string): BinaryAnalyzerFacts {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The local WASM binary analyzer returned invalid data.')
  }
  const facts = parsed as Partial<BinaryAnalyzerFacts>
  if (typeof facts.format !== 'string' || typeof facts.recognized !== 'boolean') {
    throw new Error('The local WASM binary analyzer returned invalid data.')
  }
  return {
    format: facts.format,
    recognized: facts.recognized,
    ...(typeof facts.architecture === 'string'
      ? { architecture: facts.architecture }
      : {}),
    ...(typeof facts.bitness === 'number' ? { bitness: facts.bitness } : {}),
    ...(typeof facts.endianness === 'string'
      ? { endianness: facts.endianness }
      : {}),
    ...(typeof facts.objectType === 'number'
      ? { objectType: facts.objectType }
      : {}),
    ...(typeof facts.version === 'number' ? { version: facts.version } : {}),
    ...(Array.isArray(facts.sections)
      ? {
          sections: facts.sections.filter(
            (section): section is { id: number; name: string; bytes: number } =>
              !!section &&
              Number.isInteger(section.id) &&
              typeof section.name === 'string' &&
              Number.isInteger(section.bytes)
          ),
        }
      : {}),
    ...(typeof facts.sectionCount === 'number'
      ? { sectionCount: facts.sectionCount }
      : {}),
    ...(typeof facts.architectureCount === 'number'
      ? { architectureCount: facts.architectureCount }
      : {}),
    ...(typeof facts.sectionsTruncated === 'boolean'
      ? { sectionsTruncated: facts.sectionsTruncated }
      : {}),
    ...(typeof facts.malformed === 'boolean'
      ? { malformed: facts.malformed }
      : {}),
    ...(typeof facts.sectionsIncomplete === 'boolean'
      ? { sectionsIncomplete: facts.sectionsIncomplete }
      : {}),
    ...(typeof facts.note === 'string' ? { note: facts.note } : {}),
  }
}

async function analyzeBinaryPrefix(
  prefix: Uint8Array,
  totalBytes: number,
  signal?: AbortSignal
): Promise<BinaryAnalysisResult> {
  throwIfAborted(signal)
  const analyzer = await loadBinaryAnalyzer()
  throwIfAborted(signal)

  const inputPointer = Math.ceil(Number(analyzer.__heap_base.value) / 8) * 8
  const outputPointer = Math.ceil((inputPointer + prefix.byteLength) / 8) * 8
  const requiredBytes = outputPointer + BINARY_ANALYSIS_OUTPUT_BYTES
  const missingBytes = requiredBytes - analyzer.memory.buffer.byteLength
  if (missingBytes > 0) {
    analyzer.memory.grow(Math.ceil(missingBytes / WASM_PAGE_BYTES))
  }
  const memory = new Uint8Array(analyzer.memory.buffer)
  memory.set(prefix, inputPointer)
  const outputLength = analyzer.analyze_binary(
    inputPointer,
    prefix.byteLength,
    outputPointer,
    BINARY_ANALYSIS_OUTPUT_BYTES,
    totalBytes
  )
  if (outputLength <= 0 || outputLength > BINARY_ANALYSIS_OUTPUT_BYTES) {
    throw new Error('The local WASM binary analyzer could not finish safely.')
  }

  throwIfAborted(signal)
  return {
    ...parseAnalyzerFacts(
      new TextDecoder('utf-8', { fatal: true }).decode(
        memory.slice(outputPointer, outputPointer + outputLength)
      )
    ),
    bytesAnalyzed: prefix.byteLength,
    totalBytes,
    prefixTruncated: totalBytes > prefix.byteLength,
  }
}

export async function analyzeBinaryFile(
  file: Pick<File, 'size' | 'slice'>,
  signal?: AbortSignal
): Promise<BinaryAnalysisResult> {
  throwIfAborted(signal)
  const prefix = new Uint8Array(
    await file.slice(0, MAX_BINARY_ANALYSIS_BYTES).arrayBuffer()
  )
  throwIfAborted(signal)
  return analyzeBinaryPrefix(prefix, file.size, signal)
}

function readBase64Prefix(dataUrl: string): {
  bytes: Uint8Array
  totalBytes: number
} {
  const comma = dataUrl.indexOf(',')
  if (
    !dataUrl.startsWith('data:') ||
    comma < 0 ||
    !/;base64$/iu.test(dataUrl.slice(0, comma))
  ) {
    throw new Error('The selected binary attachment is not readable locally.')
  }

  const payloadLength = dataUrl.length - comma - 1
  const paddedLength = Math.ceil(payloadLength / 4) * 4
  const encodedPrefixLength = Math.min(
    paddedLength,
    Math.ceil(MAX_BINARY_ANALYSIS_BYTES / 3) * 4
  )
  const encodedPrefix = dataUrl.slice(comma + 1, comma + 1 + encodedPrefixLength)
  const decoded = atob(encodedPrefix)
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  const totalBytes = Math.max(0, Math.floor(payloadLength * 3 / 4) - padding)
  return {
    bytes: bytes.slice(0, MAX_BINARY_ANALYSIS_BYTES),
    totalBytes,
  }
}

export async function analyzeBinaryDataUrl(
  dataUrl: string,
  signal?: AbortSignal
): Promise<BinaryAnalysisResult> {
  throwIfAborted(signal)
  const { bytes, totalBytes } = readBase64Prefix(dataUrl)
  return analyzeBinaryPrefix(bytes, totalBytes, signal)
}

export function formatBinaryAnalysisForModel(
  analysis: BinaryAnalysisResult
): string {
  const lines = [
    'Client-side WebAssembly binary metadata analysis.',
    `Format: ${analysis.format}.`,
    `Bytes inspected locally: ${analysis.bytesAnalyzed} of ${analysis.totalBytes}.`,
    'Raw binary bytes were not sent to the model.',
  ]
  if (analysis.architecture) lines.push(`Architecture: ${analysis.architecture}.`)
  if (analysis.bitness) lines.push(`Bitness: ${analysis.bitness}-bit.`)
  if (analysis.endianness) lines.push(`Endianness: ${analysis.endianness}.`)
  if (analysis.objectType !== undefined) {
    lines.push(`ELF object type: ${analysis.objectType}.`)
  }
  if (analysis.version !== undefined) lines.push(`Version: ${analysis.version}.`)
  if (analysis.sectionCount !== undefined) {
    lines.push(`Sections found: ${analysis.sectionCount}.`)
  }
  if (analysis.sections?.length) {
    lines.push(
      `WASM sections: ${analysis.sections.map(({ name, bytes }) => `${name} (${bytes} bytes)`).join(', ')}.`
    )
  }
  if (analysis.architectureCount !== undefined) {
    lines.push(`Universal binary architectures: ${analysis.architectureCount}.`)
  }
  if (analysis.sectionsTruncated) {
    lines.push('Only the first 16 sections are listed.')
  }
  if (analysis.sectionsIncomplete) {
    lines.push('The local prefix ends inside a section; remaining bytes were not read.')
  }
  if (analysis.malformed) {
    lines.push('The inspected file header or section table is malformed or incomplete.')
  }
  if (analysis.note) lines.push(analysis.note)
  if (analysis.prefixTruncated) {
    lines.push('The parser inspected only the first 64 KiB of this file.')
  }
  return lines.join('\n')
}
