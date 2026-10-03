import type { ChatCompletionMessage } from '@/features/playground/types'

import {
  explicitlyRequestsBrowserWebSearch,
  explicitlyTargetsLocalGitHub,
  getGitHubReadIntent,
  latestUserRequestText,
  shouldRunWebResearchTool,
  targetsAccountRepositories,
} from './agent-tool-routing'

export type AgentDSHToolScope = 'account-read' | 'public-only' | 'evidence-only'

/** Only the current user instruction grants reads; preparation can narrow them. */
export function deriveAgentDSHToolScope(
  messages: ChatCompletionMessage[],
  hasPreparedContext: boolean
): AgentDSHToolScope {
  // Includes failed-read notices: answer honestly, without retrying the read.
  if (hasPreparedContext) return 'evidence-only'
  const request = latestUserRequestText(messages)
  const githubIntent = getGitHubReadIntent(request)
  if (githubIntent === 'repository_search' && !targetsAccountRepositories(request) &&
    !explicitlyTargetsLocalGitHub(request)) return 'public-only'
  if (githubIntent && !explicitlyTargetsLocalGitHub(request) &&
    (!explicitlyRequestsBrowserWebSearch(request) || targetsAccountRepositories(request))) {
    return 'account-read'
  }
  const publicReadAllowed = ['web.search', 'web.fetch', 'web.crawl'].some((name) =>
    shouldRunWebResearchTool({ id: 'permission-check', type: 'function',
      function: { name, arguments: '{}' } }, messages)
  )
  return publicReadAllowed ? 'public-only' : 'evidence-only'
}
