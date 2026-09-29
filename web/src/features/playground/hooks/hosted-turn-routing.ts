import type {
  ChatCompletionMessage,
  ChatCompletionResponse,
  HostedTurnProvider,
  LocalToolProvider,
} from '../types'

/** Local preflight must not steal a turn that the hosted Agent owns. */
export function resolveLocalToolPreflight(
  localToolProvider: LocalToolProvider | undefined,
  messages: ChatCompletionMessage[],
  hostedTurnProvider: HostedTurnProvider | undefined
): ChatCompletionResponse | null {
  if (hostedTurnProvider) return null
  return localToolProvider?.preflight?.(messages) ?? null
}
