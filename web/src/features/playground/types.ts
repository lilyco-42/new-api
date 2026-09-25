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
// Message types
export type MessageRole = 'user' | 'assistant' | 'system'
export type ChatCompletionMessageRole = MessageRole | 'tool'

export type MessageStatus = 'loading' | 'streaming' | 'complete' | 'error'

export type PlaygroundMessageLayoutMode = 'alternating' | 'left'

export interface MessageVersion {
  id: string
  content: string
  /**
   * Request-only content parts (for example image attachments). These are
   * deliberately omitted from localStorage by the storage schema because
   * data URLs can be much larger than a browser's durable storage budget.
   */
  parts?: ContentPart[]
}

export interface Message {
  key: string
  from: MessageRole
  versions: MessageVersion[]
  createdAt?: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
  sources?: { href: string; title: string }[]
  reasoning?: {
    content: string
    duration: number
    startedAt?: number
    completedAt?: number
    durationMs?: number
  }
  isReasoningStreaming?: boolean
  isReasoningComplete?: boolean
  isContentComplete?: boolean
  status?: MessageStatus
  errorCode?: string | null
}

// API payload types
export interface ChatCompletionMessage {
  role: ChatCompletionMessageRole
  content: string | ContentPart[] | null
  reasoning_content?: string
  name?: string
  tool_calls?: ChatCompletionToolCall[]
  tool_call_id?: string
}

export interface ChatCompletionToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface LocalToolProvider {
  tools: ChatCompletionTool[]
  /** Current tools may change while a request is in flight (for example, when a paired device disconnects). */
  availableTools?: (messages?: ChatCompletionMessage[]) => ChatCompletionTool[]
  /** Override automatic tool selection when an intent requires a deterministic read. */
  getToolChoice?: (
    messages: ChatCompletionMessage[],
    tools: ChatCompletionTool[]
  ) => ChatCompletionRequest['tool_choice']
  isAvailable: () => boolean
  /** Prevent a well-formed but intent-mismatched model tool call from running. */
  shouldRunTool?: (
    call: ChatCompletionToolCall,
    messages: ChatCompletionMessage[]
  ) => boolean
  /** Return a local answer before making a model or tool request, when needed. */
  preflight?: (
    messages: ChatCompletionMessage[]
  ) => ChatCompletionResponse | null
  /** Resolve deterministic read requests before asking the model to respond. */
  beforeModel?: (
    messages: ChatCompletionMessage[],
    signal: AbortSignal
  ) => ChatCompletionResponse | null | Promise<ChatCompletionResponse | null>
  /** Add supplemental messages before the latest user turn reaches the model. */
  prepareContext?: (
    messages: ChatCompletionMessage[],
    signal: AbortSignal
  ) => ChatCompletionMessage[] | Promise<ChatCompletionMessage[]>
  /** Finalize a model response with deterministic data from prepared local context. */
  finalizeResponse?: (
    response: ChatCompletionResponse,
    messages: ChatCompletionMessage[],
    preparedContext: ChatCompletionMessage[]
  ) => ChatCompletionResponse
  /**
   * Optional approval gate for tools that can affect external systems. The
   * loop must wait for a user decision before invoking the tool.
   */
  requiresApproval?: (
    call: ChatCompletionToolCall,
    signal: AbortSignal
  ) => boolean | Promise<boolean>
  invoke: (call: ChatCompletionToolCall, signal: AbortSignal) => Promise<string>
}

export interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
  }
}

export interface ChatCompletionRequest {
  model: string
  group?: string
  messages: ChatCompletionMessage[]
  stream: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  frequency_penalty?: number
  presence_penalty?: number
  seed?: number
  tools?: ChatCompletionTool[]
  tool_choice?: 'auto' | 'none' | 'required'
}

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: ChatCompletionMessageRole
      content?: string
      reasoning_content?: string
      tool_calls?: ChatCompletionToolCall[]
    }
    finish_reason: string | null
  }>
}

export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: ChatCompletionMessageRole
      content: string | null
      reasoning_content?: string
      tool_calls?: ChatCompletionToolCall[]
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// Configuration types
export interface PlaygroundConfig {
  model: string
  group: string
  temperature: number
  top_p: number
  max_tokens: number
  frequency_penalty: number
  presence_penalty: number
  seed: number | null
  stream: boolean
}

export interface ParameterEnabled {
  temperature: boolean
  top_p: boolean
  max_tokens: boolean
  frequency_penalty: boolean
  presence_penalty: boolean
  seed: boolean
}

// Model and group options
export interface ModelOption {
  label: string
  value: string
}

export interface GroupOption {
  label: string
  value: string
  ratio: number
  desc?: string
}
