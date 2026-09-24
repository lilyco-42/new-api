import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PromptInput } from '@/components/ai-elements/prompt-input'
import { api } from '@/lib/api'

import type { ParameterEnabled, PlaygroundConfig } from '../../../types'
import { PlaygroundInputTools } from '../playground-input-tools'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

const config: PlaygroundConfig = {
  model: 'test-model',
  group: 'default',
  temperature: 1,
  top_p: 1,
  max_tokens: 1024,
  frequency_penalty: 0,
  presence_penalty: 0,
  seed: null,
  stream: false,
}

const parameterEnabled: ParameterEnabled = {
  temperature: false,
  top_p: false,
  max_tokens: false,
  frequency_penalty: false,
  presence_penalty: false,
  seed: false,
}

function renderTools(onUseSearchContext: (context: string) => void) {
  return render(
    <PromptInput onSubmit={() => undefined}>
      <PlaygroundInputTools
        config={config}
        onUseSearchContext={onUseSearchContext}
        onConfigChange={() => undefined}
        onParameterEnabledChange={() => undefined}
        parameterEnabled={parameterEnabled}
      />
    </PromptInput>
  )
}

describe('PlaygroundInputTools search handoff', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.get).mockResolvedValue({
      data: {
        success: true,
        data: {
          items: [
            {
              title: 'Rust agent toolkit',
              url: 'https://example.com/rust-agent',
              snippet: 'A toolkit for building agents in Rust.',
            },
          ],
        },
      },
    } as never)
  })

  it('puts a pasted domain in the chat draft as a page-reading request', async () => {
    const user = userEvent.setup()
    const onUseSearchContext = vi.fn()
    renderTools(onUseSearchContext)

    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Search' }),
      'deepseek.com'
    )
    await user.click(screen.getByRole('button', { name: 'Read URL with Agent' }))

    expect(onUseSearchContext).toHaveBeenCalledWith(
      expect.stringContaining('https://deepseek.com/')
    )
    expect(api.get).not.toHaveBeenCalled()
  })

  it('adds visible web-search results to the chat context only after selection', async () => {
    const user = userEvent.setup()
    const onUseSearchContext = vi.fn()
    renderTools(onUseSearchContext)

    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'rust ai')
    const searchButtons = screen.getAllByRole('button', { name: 'Search' })
    await user.click(searchButtons.at(-1)!)
    await user.click(
      await screen.findByRole('button', { name: 'Add results to message' })
    )

    expect(onUseSearchContext).toHaveBeenCalledWith(
      expect.stringContaining('https://example.com/rust-agent')
    )
    expect(onUseSearchContext).toHaveBeenCalledWith(
      expect.stringContaining('A toolkit for building agents in Rust.')
    )
  })
})
