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
// This is a bounded, opt-in real-model evaluation, not browser/DSH/OAuth E2E.
import { mkdir, writeFile } from 'node:fs/promises'

import { AGENT_TOOL_PROMPT, LYCO_DEFAULT_SYSTEM_PROMPT } from '../src/features/agent/agent-prompts'
import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../src/features/playground/constants'
import { buildChatCompletionPayload } from '../src/features/playground/lib/streaming/payload-builder'
import type { ChatCompletionResponse, Message } from '../src/features/playground/types'

const key = process.env.LAIN42_AGENT_EVAL_API_KEY?.trim()
const model = process.env.LAIN42_AGENT_EVAL_MODEL?.trim()
if (!key || !model) throw new Error('Evaluation requires a model and a configured credential; it cannot self-skip.')
if (!['nvidia/nemotron-3-super-120b-a12b', 'meta/llama-3.2-11b-vision-instruct'].includes(model)) {
  throw new Error('Model is outside the bounded evaluation allowlist.')
}

function message(key: string, from: Message['from'], content: string): Message {
  return { key, from, versions: [{ id: key, content }], status: 'complete' }
}

const cases = [
  {
    id: 'workflow-clarification',
    initial: '修复 merchant/image-workflow 的 workflow。暂不执行写操作。',
    previous: '你说的是哪种 workflow 服务？',
    current: 'github action',
    accepts: (answer: string) => /merchant\/image-workflow/iu.test(answer) &&
      /(?:修复|失败|错误|报错|诊断|日志|排查)/u.test(answer),
    criterion: 'Continue the repository repair task rather than give only an Actions encyclopedia entry.',
  },
  {
    id: 'query-source-follow-up',
    initial: '查看我的 GitHub 仓库',
    previous: '本轮通过本站 GitHub OAuth 接口读取了 merchant/image-workflow。没有调用本机 gh。',
    current: '你怎么查询的?',
    accepts: (answer: string) => /oauth/iu.test(answer) &&
      !/(?:需要|必须|请先).{0,15}(?:gh auth login|登录.{0,8}(?:CLI|gh))/iu.test(answer),
    criterion: 'Explain the recorded OAuth source without demanding CLI login or summarizing the system prompt.',
  },
  {
    id: 'latest-question-after-old-topic',
    initial: 'DeepSeek 是什么？',
    previous: 'DeepSeek 是知识图谱检索工具。',
    current: '刚才答偏了。现在只用一句话解释 Rust 的所有权。',
    accepts: (answer: string) => /(?:所有权|ownership)/iu.test(answer) &&
      /(?:内存|memory|变量|值|value)/iu.test(answer) && !/deepseek/iu.test(answer),
    criterion: 'Answer the latest Rust question, not the earlier DeepSeek topic.',
  },
]

const results: Array<Record<string, unknown>> = []
for (const entry of cases) {
  const payload = buildChatCompletionPayload([
    message('system', 'system', `${LYCO_DEFAULT_SYSTEM_PROMPT}${AGENT_TOOL_PROMPT}`),
    message('initial', 'user', entry.initial),
    message('previous', 'assistant', entry.previous),
    message('current', 'user', entry.current),
  ], { ...DEFAULT_CONFIG, model, stream: false, max_tokens: 1024 },
  { ...DEFAULT_PARAMETER_ENABLED, max_tokens: true, temperature: false,
    top_p: false, frequency_penalty: false, presence_penalty: false }, true)
  const started = Date.now()
  try {
    const response = await fetch('https://api.lain42.top/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      results.push({ id: entry.id, passed: false, error: `HTTP ${response.status}`, elapsed_ms: Date.now() - started })
      continue
    }
    const body = await response.json() as ChatCompletionResponse
    const answer = body.choices?.[0]?.message?.content
    if (typeof answer !== 'string' || !answer.trim() || answer.includes(key)) {
      results.push({ id: entry.id, passed: false, error: 'Missing or unsafe text response', elapsed_ms: Date.now() - started })
      continue
    }
    results.push({ id: entry.id, passed: entry.accepts(answer), criterion: entry.criterion,
      answer: answer.slice(0, 8000), elapsed_ms: Date.now() - started,
      finish_reason: body.choices[0]?.finish_reason, returned_model: body.model, usage: body.usage })
  } catch {
    results.push({ id: entry.id, passed: false, error: 'Network, timeout or response parsing failure', elapsed_ms: Date.now() - started })
  }
}
await mkdir('evaluation-results', { recursive: true })
await writeFile('evaluation-results/agent-context.json', JSON.stringify({
  candidate_sha: process.env.GITHUB_SHA, model, created_at: new Date().toISOString(),
  scope: 'Actual candidate prompt and payload builder, live website model, synthetic prior conversation. No DSH, OAuth, tool execution, mobile or isolation E2E claim.',
  max_requests: cases.length, max_output_tokens_per_request: 1024, results,
}, null, 2))
for (const result of results) console.log(`${result.id}: ${result.passed ? 'pass' : 'FAIL'}`)
if (results.some((result) => !result.passed)) process.exitCode = 1
