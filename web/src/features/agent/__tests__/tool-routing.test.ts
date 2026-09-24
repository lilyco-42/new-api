import { describe, expect, it } from 'vitest'

import type {
  ChatCompletionMessage,
  ChatCompletionToolCall,
} from '@/features/playground/types'

import {
  explicitlyTargetsLocalGitHub,
  getGitHubReadIntent,
  shouldAdvertiseBrowserGitHubTool,
  shouldAdvertiseWebAgentTool,
  shouldRunLocalAgentTool,
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

  it('routes the shorthand "gh repo 我的项目" to the connected browser OAuth', () => {
    const messages = userMessage('gh repo 我的项目')

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

  it('honors explicit requests not to search, even when the message mentions search', () => {
    const messages = userMessage(
      '用一句话解释 Rust 的所有权。普通问题请直接回答，不需要搜索或访问工作区。'
    )
    const englishMessages = userMessage(
      'Explain Rust ownership briefly. Do not search the web.'
    )

    expect(
      shouldRunWebAgentTool(toolCall('web.search'), messages)
    ).toBe(false)
    expect(
      shouldRunWebAgentTool(toolCall('web.search'), englishMessages)
    ).toBe(false)
  })

  it('keeps ordinary knowledge questions away from paired-device tools', () => {
    const messages = userMessage('用一句话解释 Rust 的所有权。')

    for (const name of [
      'files.browse',
      'files.preview',
      'vcs.history',
      'code.search',
      'code.graph',
      'developer.tools.status',
      'agent.workspace.list',
    ]) {
      expect(shouldRunLocalAgentTool(name, messages), name).toBe(false)
    }
  })

  it('allows paired workspace tools only for an explicit workspace request', () => {
    const messages = userMessage('请列出我的工作区根目录文件。')

    expect(shouldRunLocalAgentTool('files.browse', messages)).toBe(true)
    expect(shouldRunLocalAgentTool('agent.workspace.list', messages)).toBe(
      true
    )
    expect(shouldRunLocalAgentTool('files.preview', messages)).toBe(false)
  })

  it('requires an explicit file read request before previewing workspace data', () => {
    const browseOnly = userMessage('请浏览我的工作区文件目录。')
    const previewFile = userMessage('请读取工作区里的 README.md 并总结。')

    expect(shouldRunLocalAgentTool('files.preview', browseOnly)).toBe(false)
    expect(shouldRunLocalAgentTool('files.preview', previewFile)).toBe(true)
  })

  it('maps code and history tools only to matching requests', () => {
    const codeSearch = userMessage('在工作区搜索 parse_config 函数。')
    const history = userMessage('查看仓库最近的 git 提交历史。')

    expect(shouldRunLocalAgentTool('code.search', codeSearch)).toBe(true)
    expect(shouldRunLocalAgentTool('vcs.history', history)).toBe(true)
    expect(shouldRunLocalAgentTool('code.graph', codeSearch)).toBe(false)
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

  it('uses browser web search for public GitHub project discovery', () => {
    const messages = userMessage(
      '请用网页搜索功能，仅在浏览器端搜索 GitHub 上的 ast-grep 官方仓库，并返回来源链接。不要调用本地 CLI 或 Radxa。'
    )

    expect(
      shouldAdvertiseWebAgentTool('web.search', messages)
    ).toBe(true)
    expect(
      shouldAdvertiseBrowserGitHubTool(
        'github.oauth.repositories.search',
        messages,
        false
      )
    ).toBe(false)
    expect(
      shouldRunWebAgentTool(toolCall('web.search'), messages)
    ).toBe(true)
    expect(
      shouldRunWebAgentTool(
        toolCall('github.oauth.repositories.search'),
        messages
      )
    ).toBe(false)
  })

  it('keeps account-owned repository discovery on GitHub OAuth', () => {
    const messages = userMessage(
      '请用网页搜索功能查找我的 GitHub 仓库。'
    )

    expect(
      shouldAdvertiseBrowserGitHubTool(
        'github.oauth.repositories.search',
        messages,
        false
      )
    ).toBe(true)
    expect(
      shouldAdvertiseWebAgentTool('web.search', messages)
    ).toBe(false)
  })
})
