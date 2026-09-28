import { defaultHighlightStyle, ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree } from '@lezer/highlight'
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
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { CodeBlock, getCodeMirrorLanguageExtension } from '../code-block'

afterEach(() => {
  cleanup()
})

describe('CodeBlock display', () => {
  test('normalizes Rust fences and shows the Rust icon and language label', () => {
    const { container, getByRole } = render(
      <CodeBlock
        code='fn main() { let answer: i32 = 42; }'
        language='rs'
        showToolbar
      />
    )

    expect(getByRole('textbox', { name: 'rust' })).toBeInTheDocument()
    const languageLabel = container.querySelector('[data-code-language="rust"]')
    expect(languageLabel).toHaveTextContent('rust')
    expect(languageLabel?.querySelector('svg')).toBeInTheDocument()
  })

  test('highlights Rust keywords for the rs code-fence alias', () => {
    const code = 'fn main() { let answer: i32 = 42; }'
    const state = EditorState.create({
      doc: code,
      extensions: [getCodeMirrorLanguageExtension('rs')],
    })
    const syntax = ensureSyntaxTree(state, state.doc.length, 1000)
    expect(syntax).not.toBeNull()
    if (!syntax) {
      throw new Error('Rust syntax parsing did not finish.')
    }

    let keywordClasses: string | undefined
    highlightTree(syntax, defaultHighlightStyle, (from, to, classes) => {
      if (code.slice(from, to) === 'fn') {
        keywordClasses = classes
      }
    })

    expect(keywordClasses?.trim()).not.toBe('')
  })
})
