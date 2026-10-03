import type { ChatCompletionResponse } from '../../types'

// Only a client executor can associate a response with its observations.
// An upstream model JSON field or generated text is not an execution record.
const contexts = new WeakMap<ChatCompletionResponse, string>()

export function retainResponseExecutionContext(response: ChatCompletionResponse, context: string): ChatCompletionResponse {
  if (new TextEncoder().encode(context).byteLength > 4096) {
    throw new Error('The execution context exceeds its storage budget.')
  }
  contexts.set(response, context)
  return response
}

export function responseExecutionContext(response: ChatCompletionResponse): string | undefined {
  return contexts.get(response)
}
