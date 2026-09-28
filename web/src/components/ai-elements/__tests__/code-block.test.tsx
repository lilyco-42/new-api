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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { CodeBlock } from '../code-block'

afterEach(() => {
  cleanup()
})

describe('CodeBlock syntax display', () => {
  test('renders Rust keywords with syntax highlighting and a readable language label', () => {
    render(
      <CodeBlock
        code={'fn main() {\n  let answer = 42;\n}'}
        language='rust'
        showToolbar
        title='rust'
      />
    )

    const highlightedKeyword = Array.from(
      document.querySelectorAll('.cm-content span')
    ).find((span) => span.textContent === 'fn')

    expect(highlightedKeyword).toBeDefined()
    const languageLabel = screen.getByText('Rust')
    expect(languageLabel).toBeInTheDocument()
    expect(languageLabel.parentElement?.querySelector('svg')).not.toBeNull()
  })
})
