import { describe, expect, it } from 'vitest'

import type {
  ChatCompletionMessage,
  ChatCompletionToolCall,
} from '@/features/playground/types'

import {
  explicitlyTargetsLocalGitHub,
  getGitHubReadIntent,
  shouldRunWebAgentTool,
} from '../agent-tool-routing'

function userMessage(content: string): ChatCompletionMessage[] {
  return [{ role: 'user', content }]
}

function toolCall(name: string): ChatCompletionToolCall {
  return {
    id: 'routing-test',
    type: 'function',
    function: { name, arguments: '{}' },
  }
}

describe('Agent tool intent routing', () => {
  it('routes a request to view my GitHub repositories to browser OAuth', () => {
    const messages = userMessage('查看我的 GitHub 仓库')

    expect(getGitHubReadIntent(messages[0]?.content as string)).toBe(
      'repositories'
    )
    expect(explicitlyTargetsLocalGitHub(messages[0]?.content as string)).toBe(
      false
    )
    expect(
      shouldRunWebAgentTool(
        toolCall('github.oauth.repositories.list'),
        messages
      )
    ).toBe(true)
    expect(
      shouldRunWebAgentTool(
        toolCall('github.oauth.repositories.search'),
        messages
      )
    ).toBe(false)
    expect(
      shouldRunWebAgentTool(toolCall('github.oauth.auth.status'), messages)
    ).toBe(false)
  })

  it('does not execute a tool just because the user asks why OAuth still needs CLI login', () => {
    const complaint =
      'GitHub access · OAuth connected · lilyco-42。连接了，怎么还这样？我想这是因为 GitHub CLI 还没有登录，才能搜索仓库。'
    const messages = userMessage(complaint)

    expect(getGitHubReadIntent(complaint)).toBeNull()
    expect(explicitlyTargetsLocalGitHub(complaint)).toBe(false)
    expect(
      shouldRunWebAgentTool(
        toolCall('github.oauth.repositories.search'),
        messages
      )
    ).toBe(false)
  })

  it('uses local GitHub tools only when the user explicitly chooses the device CLI', () => {
    const messages = userMessage(
      '请在我的 Radxa A7A 上用本机 gh CLI 查看 lilyco-42/new-api 的 issues。'
    )
    const request = messages[0]?.content as string

    expect(getGitHubReadIntent(request)).toBe('issues')
    expect(explicitlyTargetsLocalGitHub(request)).toBe(true)
    expect(
      shouldRunWebAgentTool(toolCall('github.oauth.issues.list'), messages)
    ).toBe(false)
  })

  it('keeps ordinary knowledge questions away from web search', () => {
    const messages = userMessage('DeepSeek 是什么？')

    expect(
      shouldRunWebAgentTool(toolCall('web.search'), messages)
    ).toBe(false)
    expect(
      shouldRunWebAgentTool(
        toolCall('github.oauth.repositories.search'),
        messages
      )
    ).toBe(false)
  })

  it('allows web search for an explicit current-information request', () => {
    const messages = userMessage('搜索一下 Rust 最近流行的项目')

    expect(
      shouldRunWebAgentTool(toolCall('web.search'), messages)
    ).toBe(true)
  })

  it('routes an explicit repository search to the search tool instead of the account list', () => {
    const messages = userMessage('搜索一下 Rust 的 GitHub 仓库')

    expect(getGitHubReadIntent(messages[0]?.content as string)).toBe(
      'repository_search'
    )
    expect(
      shouldRunWebAgentTool(
        toolCall('github.oauth.repositories.search'),
        messages
      )
    ).toBe(true)
    expect(
      shouldRunWebAgentTool(
        toolCall('github.oauth.repositories.list'),
        messages
      )
    ).toBe(false)
  })
})
