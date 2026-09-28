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
import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const webDirectory = path.resolve(scriptDirectory, '..')
const modules = [
  {
    name: 'crawler_core',
    source: 'src/features/agent/client-crawler/crawler_core.c',
    exports: ['extract_html_text'],
    initialMemory: 131072,
    maxMemory: 8388608,
  },
  {
    name: 'binary_analyzer',
    source: 'src/lib/client-binary/binary_analyzer.c',
    exports: ['analyze_binary'],
    initialMemory: 262144,
    maxMemory: 1048576,
  },
]
const clang = process.env.CLANG || 'clang'
const wasmLd = process.env.WASM_LD || 'wasm-ld'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

for (const module of modules) {
  const source = path.join(webDirectory, module.source)
  const output = path.join(webDirectory, `public/agent/${module.name}.wasm`)
  const objectFile = path.join(
    tmpdir(),
    `lain42-${module.name}-${process.pid}.o`
  )
  try {
    run(clang, [
      '--target=wasm32-unknown-unknown',
      '-c',
      '-Oz',
      '-nostdlib',
      '-fno-builtin',
      '-o',
      objectFile,
      source,
    ])
    run(wasmLd, [
      '--no-entry',
      ...module.exports.map((name) => `--export=${name}`),
      '--export-memory',
      '--export=__heap_base',
      `--initial-memory=${module.initialMemory}`,
      `--max-memory=${module.maxMemory}`,
      objectFile,
      '-o',
      output,
    ])
  } finally {
    await rm(objectFile, { force: true })
  }
  console.log(`Built ${path.relative(webDirectory, output)}`)
}
