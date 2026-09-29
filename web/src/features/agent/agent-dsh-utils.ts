import type {
  ChatCompletionMessage,
  ChatCompletionResponse,
  Message,
} from '@/features/playground/types'

export const MAX_TURN_TEXT_BYTES = 24 * 1024
export const MAX_TURN_BODY_BYTES = 12 * 1024 * 1024
export const MAX_DSH_IMAGES = 4
export const MAX_DSH_IMAGE_BYTES = 8 * 1024 * 1024
export const DSH_REQUEST_TIMEOUT_MS = 130_000
export const DSH_SESSION_KEY_SUFFIX = ':dsh-session-id'
export const DSH_LAST_TURN_KEY_SUFFIX = ':dsh-last-turn'
export const DSH_REQUEST_KEY_SUFFIX = ':dsh-request:'
export const SESSION_ID_PATTERN = /^[A-Fa-f0-9]{64}$/u
export const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const memoryStorage = new Map<string, string>()

export function hasAccountScopedNamespace(namespace: string): boolean {
  return /^agent-user-[1-9]\d*-[a-z-]+-chat-\d+$/u.test(namespace)
}

export function hasOtherPendingRequest(
  storageNamespace: string,
  currentRequestKey: string,
  storage: Pick<Storage, 'length' | 'key'> | null
): boolean {
  const prefix = `${storageNamespace}${DSH_REQUEST_KEY_SUFFIX}`
  const keys = new Set(
    [...memoryStorage.keys()].filter((key) => key.startsWith(prefix))
  )
  if (storage) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key?.startsWith(prefix)) keys.add(key)
      }
    } catch {
      // In-memory request records are still enough when browser storage is blocked.
    }
  }
  return [...keys].some((key) => key !== currentRequestKey)
}

export async function fingerprintText(value: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('A secure browser context is required for Agent requests.')
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}

export function parseRequestRecord(
  value: string | null
): { requestId: string; fingerprint: string } | null {
  if (!value) return null
  try {
    const record = asRecord(JSON.parse(value))
    if (
      typeof record?.requestId === 'string' &&
      REQUEST_ID_PATTERN.test(record.requestId) &&
      typeof record.fingerprint === 'string'
    ) {
      return { requestId: record.requestId, fingerprint: record.fingerprint }
    }
  } catch {
    // An invalid or old record must not be reused as an idempotency key.
  }
  return null
}

export function parseLastTurn(
  value: string | null
): { messageKey: string; fingerprint: string } | null {
  if (!value) return null
  try {
    const record = asRecord(JSON.parse(value))
    if (
      typeof record?.messageKey === 'string' &&
      typeof record.fingerprint === 'string'
    ) {
      return { messageKey: record.messageKey, fingerprint: record.fingerprint }
    }
  } catch {
    // A damaged marker is safely ignored; the server still validates ownership.
  }
  return null
}

export function latestUserMessage(
  messages: ChatCompletionMessage[]
): ChatCompletionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index]
  }
  return undefined
}

export function latestUserMessageKey(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.from === 'user') return messages[index].key
  }
  return null
}

export function contentHasImage(content: ChatCompletionMessage['content']): boolean {
  return Array.isArray(content) && content.some((part) => part.type === 'image_url')
}

export type DSHImage = {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
}

export type DSHImageParts = {
  images: DSHImage[]
  error?: 'unsupported' | 'invalid' | 'too_many' | 'too_large'
}

/** Accept only bounded inline raster data; the server and DSH revalidate bytes before model admission. */
export function imagesFromContent(content: ChatCompletionMessage['content']): DSHImageParts {
  if (!Array.isArray(content)) return { images: [] }
  const parts = content.filter((part) => part.type === 'image_url')
  if (parts.length > MAX_DSH_IMAGES) return { images: [], error: 'too_many' }

  const images: DSHImage[] = []
  let totalBytes = 0
  for (const part of parts) {
    const url = part.image_url?.url
    const match = typeof url === 'string'
      ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(url)
      : null
    if (!match) return { images: [], error: 'unsupported' }
    const mediaType = match[1]?.toLowerCase()
    const data = match[2]
    if (!mediaType || !data) return { images: [], error: 'invalid' }
    if (data.length > Math.ceil(MAX_DSH_IMAGE_BYTES / 3) * 4 + 4) {
      return { images: [], error: 'too_large' }
    }

    let decoded: string
    try {
      decoded = atob(data)
      if (btoa(decoded) !== data) return { images: [], error: 'invalid' }
    } catch {
      return { images: [], error: 'invalid' }
    }
    if (decoded.length === 0) return { images: [], error: 'invalid' }
    if (decoded.length > MAX_DSH_IMAGE_BYTES) return { images: [], error: 'too_large' }
    totalBytes += decoded.length
    if (totalBytes > MAX_DSH_IMAGE_BYTES) return { images: [], error: 'too_large' }
    images.push({ mediaType: mediaType as DSHImage['mediaType'], data })
  }
  return { images }
}

export function textFromContent(content: ChatCompletionMessage['content']): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  return content
    .flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
    .join('\n')
}

export function buildTurnText(
  messages: ChatCompletionMessage[],
  latest: ChatCompletionMessage,
  browserContext: string,
  seedHistory: boolean
): string | null {
  const currentRequest = textFromContent(latest.content)?.trim() ?? ''
  if (!currentRequest && !contentHasImage(latest.content)) return null
  const effectiveRequest = currentRequest || '[The user attached image content for analysis.]'
  const evidence = browserContext.trim()
  const latestText = [
    evidence ? `Browser-prepared context:\n${evidence}` : '',
    `Current user request:\n${effectiveRequest}`,
  ].filter(Boolean).join('\n\n')
  if (byteLength(latestText) > MAX_TURN_TEXT_BYTES) return null
  if (!seedHistory) return latestText

  const latestIndex = messages.lastIndexOf(latest)
  if (latestIndex <= 0) return latestText
  const history = messages
    .slice(0, latestIndex)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .flatMap((message) => {
      const content = textFromContent(message.content)?.trim()
      if (!content) return []
      return [`${message.role === 'user' ? 'User' : 'Assistant'}:\n${content}`]
    })
  while (history.length > 0) {
    const text = `Previous visible conversation for context only:\n${history.join('\n\n')}\n\n${latestText}`
    if (byteLength(text) <= MAX_TURN_TEXT_BYTES) return text
    history.shift()
  }
  return latestText
}

export function readEnvelopeData<T>(value: unknown): T {
  const envelope = asRecord(value)
  if (envelope?.success !== true || !envelope.data || typeof envelope.data !== 'object') {
    throw new Error(
      typeof envelope?.message === 'string'
        ? envelope.message
        : 'The hosted Agent returned an invalid response.'
    )
  }
  return envelope.data as T
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function localCompletion(model: string, content: string): ChatCompletionResponse {
  return {
    id: `lain42-agent-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  }
}

export function statusFromError(error: unknown): number | undefined {
  const record = asRecord(error)
  const response = asRecord(record?.response)
  return typeof response?.status === 'number' ? response.status : undefined
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function createRequestId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('A secure browser context is required for Agent requests.')
  }
  return crypto.randomUUID()
}
