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
import { describe, expect, test, vi } from 'vitest'

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LocalToolProvider,
} from '../../types'
import { LocalToolLoopError, runLocalToolLoop } from '../local-tool-loop'

const tool = {
  type: 'function' as const,
  function: {
    name: 'github.issues.list',
    parameters: { type: 'object' },
  },
}

const webTool = {
  type: 'function' as const,
  function: {
    name: 'web.search',
    parameters: { type: 'object' },
  },
}

const webFetchTool = {
  type: 'function' as const,
  function: {
    name: 'web.fetch',
    parameters: { type: 'object' },
  },
}

const initialPayload: ChatCompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'show the latest issues' }],
  stream: true,
}

function response(
  message: ChatCompletionResponse['choices'][number]['message']
): ChatCompletionResponse {
  return {
    id: 'test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  }
}

function provider(invoke: LocalToolProvider['invoke']): LocalToolProvider {
  return { tools: [tool], isAvailable: () => true, invoke }
}

describe('local structured tool loop', () => {
  test('returns a provider preflight answer without calling the model or tools', async () => {
    const localAnswer = response({
      role: 'assistant',
      content: 'Please add context for this number.',
    })
    const request = async () => {
      throw new Error('The model must not be called for this input.')
    }
    const invoke = async () => {
      throw new Error('A tool must not run for this input.')
    }
    const guardedProvider: LocalToolProvider = {
      ...provider(invoke),
      preflight: (messages) =>
        messages.at(-1)?.content === '1123' ? localAnswer : null,
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [{ role: 'user', content: '1123' }],
      },
      guardedProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(result).toBe(localAnswer)
  })

  test('resolves async provider work before making a model request', async () => {
    const localAnswer = response({
      role: 'assistant',
      content: 'OAuth repository result.',
    })
    const request = vi.fn(async () => {
      throw new Error('The model must not be called after a handled request.')
    })
    const providerWithBeforeModel: LocalToolProvider = {
      ...provider(async () => 'tool result'),
      beforeModel: async () => localAnswer,
    }

    const result = await runLocalToolLoop(
      initialPayload,
      providerWithBeforeModel,
      new AbortController().signal,
      undefined,
      request
    )

    expect(request).not.toHaveBeenCalled()
    expect(result).toBe(localAnswer)
  })

  test('executes a structured call and gives the result back to the model', async () => {
    const requests: ChatCompletionRequest[] = []
    const events: string[] = []
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'github.issues.list',
                arguments: '{"repo":"lilyco-42/new-api"}',
              },
            },
          ],
        })
      }
      return response({ role: 'assistant', content: 'Issue #42 is open.' })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      provider(async () => '{"number":42,"state":"OPEN"}'),
      new AbortController().signal,
      (event) => events.push(event.type),
      request
    )

    expect(result.choices[0]?.message.content).toBe('Issue #42 is open.')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.stream).toBe(false)
    expect(requests[0]?.tools?.[0]?.function.name).toBe('github.issues.list')
    expect(requests[1]?.messages.at(-2)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-1' }],
    })
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
    })
    expect(events).toEqual(['requested', 'running', 'completed'])
  })

  test('forces a required browser search once, then returns to automatic tool choice', async () => {
    const requests: ChatCompletionRequest[] = []
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'deepseek-search',
              type: 'function',
              function: {
                name: 'web.search',
                arguments: '{"query":"deepseek","scope":"auto"}',
              },
            },
          ],
        })
      }
      return response({
        role: 'assistant',
        content: 'DeepSeek develops large language models.',
      })
    }
    const groundedProvider: LocalToolProvider = {
      tools: [webTool],
      isAvailable: () => true,
      getToolChoice: (messages, tools) => {
        const searchWasRequested = messages.some((message) =>
          message.tool_calls?.some(
            (call) => call.function.name === 'web.search'
          )
        )
        return !searchWasRequested &&
          tools.some((item) => item.function.name === 'web.search')
          ? 'required'
          : 'auto'
      },
      invoke: async () =>
        JSON.stringify({
          items: [
            {
              title: 'DeepSeek official model information',
              url: 'https://huggingface.co/deepseek-ai',
            },
          ],
        }),
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [{ role: 'user', content: 'deepseek' }],
      },
      groundedProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(requests.map((item) => item.tool_choice)).toEqual([
      'required',
      'auto',
    ])
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'deepseek-search',
    })
    expect(result.choices[0]?.message.content).toContain(
      'DeepSeek develops large language models.'
    )
  })

  test('formats OAuth repository results without a model follow-up', async () => {
    const repositoryTool = {
      type: 'function' as const,
      function: {
        name: 'github.oauth.repositories.list',
        parameters: { type: 'object' },
      },
    }
    const request = vi.fn(async (_payload: ChatCompletionRequest) => {
      if (request.mock.calls.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'repo-list',
              type: 'function',
              function: {
                name: 'github.oauth.repositories.list',
                arguments: '{}',
              },
            },
          ],
        })
      }
      throw new Error('openai_error')
    })
    const invoke = vi.fn(async () =>
      JSON.stringify({
        items: [
          {
            full_name: 'lilyco-42/rembg-ui',
            html_url: 'https://github.com/lilyco-42/rembg-ui',
            private: false,
            stargazers_count: 15,
          },
        ],
      })
    )
    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [{ role: 'user', content: '查看我的 GitHub 仓库' }],
      },
      {
        tools: [repositoryTool],
        isAvailable: () => true,
        invoke,
      },
      new AbortController().signal,
      undefined,
      request
    )

    expect(result.choices[0]?.message.content).toContain(
      '已通过连接的 GitHub OAuth 获取到 1 个仓库'
    )
    expect(result.choices[0]?.message.content).toContain(
      '[lilyco-42/rembg-ui](https://github.com/lilyco-42/rembg-ui)'
    )
    expect(result.choices[0]?.message.content).not.toContain('openai_error')
    expect(invoke).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  test('blocks a tool call that does not match the latest user request', async () => {
    const requests: ChatCompletionRequest[] = []
    const invoke = vi.fn(async () => 'this must not be read')
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'stale-call',
              type: 'function',
              function: {
                name: 'github.issues.list',
                arguments: '{"repo":"lilyco-42/new-api"}',
              },
            },
          ],
        })
      }
      return response({ role: 'assistant', content: 'DeepSeek is an AI model.' })
    }
    const guardedProvider: LocalToolProvider = {
      ...provider(invoke),
      shouldRunTool: () => false,
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [{ role: 'user', content: 'DeepSeek 是什么？' }],
      },
      guardedProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(result.choices[0]?.message.content).toBe('DeepSeek is an AI model.')
    expect(invoke).not.toHaveBeenCalled()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.tools).toEqual([])
    expect(requests[1]?.tool_choice).toBe('none')
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('does not match'),
    })
  })

  test('does not repeat the same web search and asks for a final answer', async () => {
    const requests: ChatCompletionRequest[] = []
    const invoke = vi.fn(async () => '{"items":[{"title":"Rust blog"}]}')
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'search-1',
              type: 'function',
              function: {
                name: 'web.search',
                arguments: '{"query":"rust async","limit":5}',
              },
            },
          ],
        })
      }
      if (requests.length === 2) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'search-2',
              type: 'function',
              function: {
                name: 'web.search',
                arguments: '{"limit":5,"query":"rust async"}',
              },
            },
          ],
        })
      }
      return response({ role: 'assistant', content: 'Here is the Rust blog.' })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      {
        tools: [webTool],
        isAvailable: () => true,
        invoke,
      },
      new AbortController().signal,
      undefined,
      request
    )

    expect(result.choices[0]?.message.content).toBe('Here is the Rust blog.')
    expect(invoke).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(3)
    expect(requests[2]?.tools).toEqual([])
    expect(requests[2]?.tool_choice).toBe('none')
    expect(requests[2]?.messages[0]).toMatchObject({ role: 'system' })
    expect(requests[2]?.messages[1]).toMatchObject({ role: 'user' })
  })

  test('sends requested page content back to the model', async () => {
    const requests: ChatCompletionRequest[] = []
    const invoke = vi.fn(async () =>
      JSON.stringify({ title: 'ast-grep', text: 'An AST-based code tool.' })
    )
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'fetch-1',
              type: 'function',
              function: {
                name: 'web.fetch',
                arguments: '{"url":"https://docs.example.com/guide#intro"}',
              },
            },
          ],
        })
      }
      if (requests.length === 2) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'fetch-2',
              type: 'function',
              function: {
                name: 'web.fetch',
                arguments: '{"url":"https://docs.example.com/guide"}',
              },
            },
          ],
        })
      }
      return response({
        role: 'assistant',
        content: 'The page describes ast-grep as an AST-based code tool.',
      })
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [
          {
            role: 'user',
            content: 'Read https://docs.example.com/guide#intro and summarize it.',
          },
        ],
      },
      {
        tools: [webFetchTool],
        isAvailable: () => true,
        invoke,
      },
      new AbortController().signal,
      undefined,
      request
    )

    expect(result.choices[0]?.message.content).toContain('ast-grep')
    expect(invoke).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(3)
    expect(
      requests[1]?.messages.find(
        (message) =>
          message.role === 'tool' && message.tool_call_id === 'fetch-1'
      )
    ).toMatchObject({
      role: 'tool',
      tool_call_id: 'fetch-1',
      content: expect.stringContaining('An AST-based code tool.'),
    })
    expect(requests[2]?.tools).toEqual([])
    expect(requests[2]?.tool_choice).toBe('none')
    expect(requests[2]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'fetch-2',
      content: expect.stringContaining('already completed'),
    })
  })

  test('shows browser search source links even when the model omits citations', async () => {
    const requests: ChatCompletionRequest[] = []
    const searchResult = JSON.stringify({
      execution: 'browser-wasm',
      query: 'ast-grep GitHub',
      fetched_at: '2026-09-24T10:00:00.000Z',
      sources: ['GitHub'],
      warnings: [],
      items: [
        {
          title: 'ast-grep',
          url: 'https://github.com/ast-grep/ast-grep',
          snippet: 'AST-based code search and rewriting.',
          source: 'GitHub',
        },
        {
          title: 'Unsafe link',
          url: 'javascript:alert(1)',
          source: 'GitHub',
        },
      ],
    })
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'search-source-links',
              type: 'function',
              function: {
                name: 'web.search',
                arguments: '{"query":"ast-grep GitHub","scope":"github"}',
              },
            },
          ],
        })
      }
      return response({ role: 'assistant', content: '搜索已完成。' })
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [
          { role: 'user', content: '请搜索 GitHub 上的 ast-grep 并给出来源链接。' },
        ],
      },
      {
        tools: [webTool],
        isAvailable: () => true,
        invoke: async () => searchResult,
      },
      new AbortController().signal,
      undefined,
      request
    )

    const answer = result.choices[0]?.message.content ?? ''
    expect(answer).toContain('[ast-grep](https://github.com/ast-grep/ast-grep)')
    expect(answer).toContain('AST-based code search and rewriting.')
    expect(answer).not.toContain('javascript:alert(1)')
    expect(requests).toHaveLength(2)
  })

  test('executes the supported text-encoded browser search format', async () => {
    const requests: ChatCompletionRequest[] = []
    const searchResult = JSON.stringify({
      execution: 'browser-wasm',
      query: 'ast-grep',
      fetched_at: '2026-09-24T10:00:00.000Z',
      sources: ['GitHub'],
      warnings: [],
      items: [
        {
          title: 'ast-grep/ast-grep',
          url: 'https://github.com/ast-grep/ast-grep',
          snippet: 'AST-based code search and rewriting.',
          source: 'GitHub',
        },
      ],
    })
    const invoke = vi.fn(
      async (call: Parameters<LocalToolProvider['invoke']>[0]) => {
        expect(call.function.name).toBe('web.search')
        expect(JSON.parse(call.function.arguments)).toEqual({
          query: 'ast-grep',
          scope: 'github',
        })
        return searchResult
      }
    )
    const approvals = vi.fn(async () => true)
    const events: string[] = []
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      return requests.length === 1
        ? response({
            role: 'assistant',
            content:
              '{“name”: “web.search”, “parameters”: {“q”: “ast-grep”, “source”: “GitHub”}}',
          })
        : response({ role: 'assistant', content: '找到了官方仓库。' })
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [
          {
            role: 'user',
            content:
              '请用浏览器搜索 GitHub 上 ast-grep 的官方仓库，并给出来源链接。',
          },
        ],
      },
      {
        tools: [webTool],
        isAvailable: () => true,
        shouldRunTool: (call, messages) =>
          call.function.name === 'web.search' &&
          messages.some(
            (message) =>
              message.role === 'user' &&
              typeof message.content === 'string' &&
              message.content.includes('请用浏览器搜索')
          ),
        requiresApproval: approvals,
        invoke,
      },
      new AbortController().signal,
      (event) => events.push(event.type),
      request
    )

    expect(invoke).toHaveBeenCalledOnce()
    expect(approvals).toHaveBeenCalledOnce()
    expect(events).toEqual(['requested', 'running', 'completed'])
    expect(requests).toHaveLength(2)
    expect(requests[0]?.tool_choice).toBe('auto')
    expect(requests[1]?.messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          function: {
            name: 'web.search',
            arguments: '{"query":"ast-grep","scope":"github"}',
          },
        },
      ],
    })
    expect(result.choices[0]?.message.content).toContain(
      '[ast-grep/ast-grep](https://github.com/ast-grep/ast-grep)'
    )
    expect(result.choices[0]?.message.content).toContain('浏览器搜索来源')
  })

  test('does not run a text-encoded search unless the latest request authorizes it', async () => {
    const invoke = vi.fn(async () => 'must not run')
    const requests: ChatCompletionRequest[] = []
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      return requests.length === 1
        ? response({
            role: 'assistant',
            content:
              '{"name":"web.search","parameters":{"q":"ast-grep","source":"GitHub"}}',
          })
        : response({ role: 'assistant', content: '这只是格式说明。' })
    }

    const result = await runLocalToolLoop(
      {
        ...initialPayload,
        messages: [{ role: 'user', content: '请解释这个 JSON 调用格式。' }],
      },
      {
        tools: [webTool],
        isAvailable: () => true,
        shouldRunTool: () => false,
        invoke,
      },
      new AbortController().signal,
      undefined,
      request
    )

    expect(invoke).not.toHaveBeenCalled()
    expect(requests).toHaveLength(2)
    expect(result.choices[0]?.message.content).toBe('这只是格式说明。')
  })

  test('recovers from the step limit with a tool-free final synthesis', async () => {
    const requests: ChatCompletionRequest[] = []
    const invoke = vi.fn(async () => 'issue list')
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (payload.tool_choice === 'none') {
        return response({
          role: 'assistant',
          content: 'Collected eight results.',
        })
      }
      const callNumber = requests.length
      return response({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call-${callNumber}`,
            type: 'function',
            function: {
              name: 'github.issues.list',
              arguments: JSON.stringify({ repo: `owner/repo-${callNumber}` }),
            },
          },
        ],
      })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      provider(invoke),
      new AbortController().signal,
      undefined,
      request
    )

    expect(result.choices[0]?.message.content).toBe('Collected eight results.')
    expect(invoke).toHaveBeenCalledTimes(8)
    expect(requests).toHaveLength(10)
    expect(requests.at(-1)?.tools).toEqual([])
    expect(requests.at(-1)?.tool_choice).toBe('none')
  })

  test('returns bounded raw tool output if the model keeps requesting tools', async () => {
    const invoke = vi.fn(async () => '{"items":[{"title":"Rust blog"}]}')
    let callId = 0
    const request = async () => {
      callId += 1
      return response({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `search-${callId}`,
            type: 'function',
            function: {
              name: 'web.search',
              arguments: '{"query":"rust async","limit":5}',
            },
          },
        ],
      })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      {
        tools: [webTool],
        isAvailable: () => true,
        invoke,
      },
      new AbortController().signal,
      undefined,
      request
    )

    expect(invoke).toHaveBeenCalledOnce()
    expect(result.choices[0]?.message.content).toContain('tool_results')
    expect(result.choices[0]?.message.content).toContain('Rust blog')
    expect(result.choices[0]?.finish_reason).toBe('stop')
  })

  test('continues the answer when a paired device disconnects during a tool call', async () => {
    let deviceOnline = true
    const events: string[] = []
    const requests: ChatCompletionRequest[] = []
    const remoteProvider: LocalToolProvider = {
      tools: [tool, webTool],
      availableTools: () => (deviceOnline ? [tool, webTool] : [webTool]),
      isAvailable: () => true,
      invoke: async () => {
        deviceOnline = false
        throw new Error('agent device is offline')
      },
    }
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-device',
              type: 'function',
              function: {
                name: 'github.issues.list',
                arguments: '{"repo":"lilyco-42/new-api"}',
              },
            },
          ],
        })
      }
      return response({
        role: 'assistant',
        content: 'DeepSeek is an AI model family.',
      })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      remoteProvider,
      new AbortController().signal,
      (event) => events.push(event.type),
      request
    )

    expect(result.choices[0]?.message.content).toBe(
      'DeepSeek is an AI model family.'
    )
    expect(requests).toHaveLength(2)
    expect(requests[1]?.tools?.map((item) => item.function.name)).toEqual([
      'web.search',
    ])
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-device',
      content: expect.stringContaining('device is offline'),
    })
    expect(events).toContain('unavailable')
    expect(events).not.toContain('completed')
  })

  test('does not invoke a device tool if the device goes offline before its call runs', async () => {
    let deviceOnline = true
    const invoke = vi.fn(async () => 'must not run')
    const requests: ChatCompletionRequest[] = []
    const remoteProvider: LocalToolProvider = {
      tools: [tool, webTool],
      availableTools: () => (deviceOnline ? [tool, webTool] : [webTool]),
      isAvailable: () => true,
      invoke,
    }
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        deviceOnline = false
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-device',
              type: 'function',
              function: {
                name: 'github.issues.list',
                arguments: '{"repo":"lilyco-42/new-api"}',
              },
            },
          ],
        })
      }
      return response({
        role: 'assistant',
        content: 'Here is a general answer.',
      })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      remoteProvider,
      new AbortController().signal,
      undefined,
      request
    )

    expect(result.choices[0]?.message.content).toBe('Here is a general answer.')
    expect(invoke).not.toHaveBeenCalled()
    expect(requests[1]?.tools?.map((item) => item.function.name)).toEqual([
      'web.search',
    ])
  })

  test('rejects malformed and unknown calls before invoking a tool', async () => {
    let invoked = false
    const request = async () =>
      response({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'unknown', arguments: '{not-json' },
          },
        ],
      })

    await expect(
      runLocalToolLoop(
        initialPayload,
        provider(async () => {
          invoked = true
          return 'should not run'
        }),
        new AbortController().signal,
        undefined,
        request
      )
    ).rejects.toBeInstanceOf(LocalToolLoopError)
    expect(invoked).toBe(false)
  })

  test('stops before another request when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const request = async () =>
      response({ role: 'assistant', content: 'unused' })

    await expect(
      runLocalToolLoop(
        initialPayload,
        provider(async () => 'unused'),
        controller.signal,
        undefined,
        request
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('does not abort the conversation when the user declines a guarded tool', async () => {
    let invoked = false
    const requests: ChatCompletionRequest[] = []
    const events: string[] = []
    const guarded: LocalToolProvider = {
      tools: [tool],
      isAvailable: () => true,
      requiresApproval: () => false,
      invoke: async () => {
        invoked = true
        return 'should not run'
      },
    }
    const request = async (payload: ChatCompletionRequest) => {
      requests.push(payload)
      if (requests.length === 1) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-approval',
              type: 'function',
              function: {
                name: 'github.issues.list',
                arguments: '{"repo":"lilyco-42/new-api"}',
              },
            },
          ],
        })
      }
      return response({
        role: 'assistant',
        content: 'I did not run the tool because permission was declined.',
      })
    }

    const result = await runLocalToolLoop(
      initialPayload,
      guarded,
      new AbortController().signal,
      (event) => events.push(event.type),
      request
    )

    expect(invoked).toBe(false)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.tools).toEqual([])
    expect(requests[1]?.tool_choice).toBe('none')
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-approval',
      content: expect.stringContaining('declined permission'),
    })
    expect(events).toContain('approval-denied')
    expect(result.choices[0]?.message.content).toContain(
      'permission was declined'
    )
  })
})
