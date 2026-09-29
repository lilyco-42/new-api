/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Bot } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { AgentSidebar, type AgentPreset } from '../components/agent-sidebar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const generalPreset: AgentPreset = {
  id: 'general',
  title: 'General assistant',
  description: 'Everyday help',
  prompt: '',
  icon: Bot,
  tone: 'text-sky-500',
}

function writeChat(userId: number, chatId: number, content: string) {
  window.localStorage.setItem(
    `agent-user-${userId}-general-chat-${chatId}:playground_messages`,
    JSON.stringify({
      data: [
        {
          from: 'user',
          createdAt: chatId,
          versions: [{ content }],
        },
      ],
    })
  )
}

describe('AgentSidebar account-scoped conversation history', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useAuthStore.getState().auth.setUser({
      id: 42,
      username: 'account-a',
      role: 1,
    })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    useAuthStore.getState().auth.setUser(null)
  })

  test('shows only the active account history and refreshes it after account switch', async () => {
    const user = userEvent.setup()
    writeChat(42, 1, 'Account A conversation')
    writeChat(43, 2, 'Account B private conversation')
    const onSelectChat = vi.fn()

    render(
      <AgentSidebar
        activePresetId='general'
        onNewChat={vi.fn()}
        onSearchChats={vi.fn()}
        onOpenTools={vi.fn()}
        onSelectChat={onSelectChat}
        onPresetChange={vi.fn()}
        presets={[generalPreset]}
      />
    )

    expect(await screen.findByText('Account A conversation')).toBeInTheDocument()
    expect(
      screen.queryByText('Account B private conversation')
    ).not.toBeInTheDocument()

    act(() => {
      useAuthStore.getState().auth.setUser({
        id: 43,
        username: 'account-b',
        role: 1,
      })
    })

    await waitFor(() => {
      expect(
        screen.getByText('Account B private conversation')
      ).toBeInTheDocument()
      expect(screen.queryByText('Account A conversation')).not.toBeInTheDocument()
    })

    await user.click(
      screen.getByRole('button', { name: /Account B private conversation/ })
    )
    expect(onSelectChat).toHaveBeenCalledWith('general', 2)
  })
})
