import type { ChatCompletionMessage } from '@/features/playground/types'

import { latestUserRequestText } from './agent-tool-routing'
import { explainWorkflowReceipt } from './agent-workflow-evidence'

/** Explain platform execution from records, never reconstruct it from model prose. */
export function explainPreviousRead(messages: ChatCompletionMessage[]): { answer: string; executionContext?: string } | undefined {
  const request = latestUserRequestText(messages)
  if (!/^(?:(?:你|刚才|刚刚|上次|这次)\s*)*(?:是)?(?:怎么|如何)(?:查询|查|检索)(?:到的|的)?[?？。!！\s]*$/u.test(request) &&
    !/^(?:how did you (?:query|look up|search)(?: (?:that|this|it))?)[?!.\s]*$/iu.test(request)) return undefined
  const chinese = /[\u3400-\u9fff]/u.test(request)
  let latest = messages.length - 1
  while (latest >= 0 && messages[latest]?.role !== 'user') latest -= 1
  let previous = latest - 1
  while (previous >= 0 && messages[previous]?.role !== 'assistant') previous -= 1
  const entry = messages[previous + 1]
  const missing = chinese
    ? '当前对话没有可核验的查询执行记录。上一条回答提到的工具或参数不能证明它实际执行过；我无法确认查询方式，不应编造步骤。'
    : 'This conversation has no verifiable record of the previous query. Tool names or parameters in an assistant reply do not prove execution; I cannot confirm how the read happened.'
  if (previous < 0 || entry?.role !== 'system' || entry.name !== 'lain42_execution_record' ||
    typeof entry.content !== 'string' || new TextEncoder().encode(entry.content).byteLength > 4608) return { answer: missing }
  const json = entry.content.split('\n').find((line) => line.startsWith('{'))
  if (!json || new TextEncoder().encode(json).byteLength > 4096) return { answer: missing }
  try {
    const record = JSON.parse(json) as Record<string, unknown>
    const workflow = explainWorkflowReceipt(record, chinese)
    if (workflow) return { answer: workflow, executionContext: json }
    const parameters = record.parameters as Record<string, unknown> | undefined
    if (record.source !== 'website GitHub OAuth' || !['repositories', 'issues', 'pull requests'].includes(String(record.resource)) ||
      record.scope !== 'this page only' || record.local_gh_used !== false ||
      typeof record.fetched_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(record.fetched_at) ||
      !parameters || !Number.isSafeInteger(parameters.limit) || Number(parameters.limit) < 1 || Number(parameters.limit) > 20 ||
      (record.returned_count !== null && (!Number.isSafeInteger(record.returned_count) || Number(record.returned_count) < 0 || Number(record.returned_count) > 20)) ||
      !['read completed', 'read failed or unconfirmed'].includes(String(record.outcome))) return { answer: missing }
    if (parameters.repo !== undefined && (typeof parameters.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(parameters.repo))) return { answer: missing }
    if (parameters.state !== undefined && parameters.state !== 'open') return { answer: missing }
    if (parameters.sort !== undefined && parameters.sort !== 'updated') return { answer: missing }
    if ((record.outcome === 'read completed') !== (record.returned_count !== null)) return { answer: missing }
    const fields = [parameters.repo ? `repo=${parameters.repo}` : '',
      parameters.state ? 'state=open' : '', parameters.sort ? 'sort=updated' : '', `limit=${parameters.limit}`].filter(Boolean).join(' · ')
    let outcome: string
    if (record.returned_count === null) outcome = chinese ? '读取失败或尚未确认，不能当作零条结果。' : 'The read failed or is unconfirmed; this is not a confirmed empty result.'
    else outcome = chinese ? `本次实际返回 ${record.returned_count} 条。` : `${record.returned_count} items actually returned on this page.`
    const answer = chinese
      ? `根据上一轮的执行记录，通过网站 GitHub OAuth 读取 ${record.resource}。\n实际参数：${fields}。\n${outcome}\n读取时间：${record.fetched_at}。范围仅为本次分页，不代表完整集合；未调用本机 gh。`
      : `The previous execution record shows a website GitHub OAuth read of ${record.resource}.\nActual parameters: ${fields}.\n${outcome}\nRead at ${record.fetched_at}. This page does not represent the complete collection; no local gh CLI ran.`
    return { answer, executionContext: json }
  } catch {
    return { answer: missing }
  }
}
