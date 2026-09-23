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
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const sourceDirectory = path.join(
  projectRoot,
  'node_modules',
  'pdfjs-dist',
  'wasm'
)
const targetDirectory = path.join(projectRoot, 'public', 'pdfjs', 'wasm')

await mkdir(targetDirectory, { recursive: true })
for (const file of await readdir(sourceDirectory, { withFileTypes: true })) {
  if (!file.isFile()) continue
  await copyFile(
    path.join(sourceDirectory, file.name),
    path.join(targetDirectory, file.name)
  )
}
