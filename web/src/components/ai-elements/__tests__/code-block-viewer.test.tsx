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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { CodeBlock } from '../code-block'

const rustSource = 'fn main() {\n    println!("CLIENT_FILE_FACT_42");\n}'

afterEach(() => {
  cleanup()
})

describe('CodeBlock viewer', () => {
  test.each(['rust', 'RS'])(
    'renders %s with a Rust label and distinct keyword/string tokens while remaining read-only',
    async (language) => {
      render(<CodeBlock code={rustSource} language={language} showToolbar />)

      const viewer = screen.getByRole('textbox', { name: 'rust' })
      expect(viewer.getAttribute('aria-readonly')).toBe('true')
      expect(viewer.querySelector('[contenteditable="true"]')).toBeNull()
      await waitFor(() => {
        expect(within(viewer).getByText('fn', { exact: true })).toBeTruthy()
        expect(
          within(viewer).getByText('"CLIENT_FILE_FACT_42"', { exact: true })
        ).toBeTruthy()
      })
      expect(viewer.textContent).toContain('main()')
      expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    }
  )

  test('renders unsupported language content as inert read-only text', () => {
    const source = '<img src="invalid" onerror="alert(1)">'
    render(<CodeBlock code={source} language='unsupported-language' />)

    const viewer = screen.getByRole('textbox', { name: 'unsupported-language' })
    expect(viewer.getAttribute('aria-readonly')).toBe('true')
    expect(viewer.textContent).toBe(source)
    expect(screen.queryByRole('img')).toBeNull()
  })
})
