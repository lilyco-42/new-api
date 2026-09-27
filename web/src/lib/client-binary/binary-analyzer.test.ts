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
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import {
  MAX_BINARY_ANALYSIS_BYTES,
  analyzeBinaryFile,
  formatBinaryAnalysisForModel,
} from './analyze-binary'

const WASM_OUTPUT_BYTES = 16 * 1024
const wasmPath = path.resolve('public/agent/binary_analyzer.wasm')
let wasmBytes: Uint8Array<ArrayBuffer>
let wasmExports: {
  memory: WebAssembly.Memory
  analyze_binary: (
    inputPointer: number,
    inputLength: number,
    outputPointer: number,
    outputCapacity: number,
    totalLength: number
  ) => number
} = {
  memory: new WebAssembly.Memory({ initial: 4 }),
  analyze_binary: () => -1,
}

function inspect(bytes: Uint8Array, totalLength = bytes.byteLength) {
  const inputPointer = 1024
  const outputPointer = Math.ceil((inputPointer + bytes.byteLength + 8) / 8) * 8
  const memory = new Uint8Array(wasmExports.memory.buffer)
  memory.set(bytes, inputPointer)
  const length = wasmExports.analyze_binary(
    inputPointer,
    bytes.byteLength,
    outputPointer,
    WASM_OUTPUT_BYTES,
    totalLength
  )
  expect(length).toBeGreaterThan(0)
  return JSON.parse(
    new TextDecoder().decode(
      memory.slice(outputPointer, outputPointer + length)
    )
  ) as Record<string, unknown>
}

function wasmHeader(...body: number[]) {
  return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...body])
}

describe('client binary analyzer WASM', () => {
  beforeAll(async () => {
    wasmBytes = new Uint8Array(await readFile(wasmPath))
    const module = new WebAssembly.Module(wasmBytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    const instance = await WebAssembly.instantiate(module)
    wasmExports = instance.exports as unknown as typeof wasmExports
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => wasmBytes.slice().buffer,
      })
    )
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  test('reads WASM version and section names', () => {
    const result = inspect(wasmHeader(1, 4, 1, 0x60, 0, 0))

    expect(result).toMatchObject({
      format: 'WebAssembly',
      recognized: true,
      version: 1,
      sectionCount: 1,
      malformed: false,
      sections: [{ id: 1, name: 'type', bytes: 4 }],
    })
  })

  test('reports a prefix cut separately from malformed section lengths', () => {
    const prefix = wasmHeader(1, 100)

    expect(inspect(prefix, prefix.byteLength + 100)).toMatchObject({
      malformed: false,
      sectionsIncomplete: true,
    })
    expect(inspect(prefix, prefix.byteLength + 20)).toMatchObject({
      malformed: true,
      sectionsIncomplete: false,
    })
  })

  test('identifies ELF architecture from the machine header', () => {
    const elf = new Uint8Array(20)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0)
    elf.set([2, 0, 0x3e, 0], 16)

    expect(inspect(elf)).toMatchObject({
      format: 'ELF executable',
      architecture: 'x86_64',
      bitness: 64,
      endianness: 'little',
      objectType: 2,
    })
  })

  test('reads big-endian Mach-O architecture correctly', () => {
    const macho = new Uint8Array(28)
    macho.set([0xfe, 0xed, 0xfa, 0xce, 1, 0, 0, 7])

    expect(inspect(macho)).toMatchObject({
      format: 'Mach-O executable',
      architecture: 'x86_64',
      bitness: 32,
      endianness: 'big',
    })
  })

  test('reads PE machine and section count from a bounded header', () => {
    const pe = new Uint8Array(88)
    pe.set([0x4d, 0x5a])
    new DataView(pe.buffer).setUint32(0x3c, 0x40, true)
    pe.set([0x50, 0x45, 0, 0, 0x64, 0x86, 3, 0], 0x40)

    expect(inspect(pe)).toMatchObject({
      format: 'PE executable',
      architecture: 'x86_64',
      sectionCount: 3,
    })
  })

  test('limits File reads to 64 KiB and describes the truncated prefix', async () => {
    const contents = new Uint8Array(MAX_BINARY_ANALYSIS_BYTES + 128)
    contents.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0)
    contents.set([2, 0, 0x3e, 0], 16)
    const file = new File([contents], 'large.elf', {
      type: 'application/octet-stream',
    })
    const slice = vi.spyOn(file, 'slice')

    const result = await analyzeBinaryFile(file)
    const summary = formatBinaryAnalysisForModel(result)

    expect(slice).toHaveBeenCalledWith(0, MAX_BINARY_ANALYSIS_BYTES)
    expect(result).toMatchObject({
      bytesAnalyzed: MAX_BINARY_ANALYSIS_BYTES,
      totalBytes: MAX_BINARY_ANALYSIS_BYTES + 128,
      prefixTruncated: true,
    })
    expect(summary).toContain('The parser inspected only the first 64 KiB')
    expect(summary).not.toContain('7f454c46')
  })

  test('does not export file data in a model summary for unknown formats', () => {
    const unknown = inspect(Uint8Array.from([1, 2, 3, 4]))
    const summary = formatBinaryAnalysisForModel({
      ...(unknown as {
        format: string
        recognized: boolean
        note?: string
      }),
      bytesAnalyzed: 4,
      totalBytes: 4,
      prefixTruncated: false,
    })

    expect(unknown).toMatchObject({
      format: 'Unknown binary',
      recognized: false,
    })
    expect(summary).toContain('Raw binary bytes were not sent to the model.')
    expect(summary).not.toContain('data:')
  })
})
