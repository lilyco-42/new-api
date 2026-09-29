import { getFreshAuthHeaders } from '@/lib/auth-session'
import { useAuthStore } from '@/stores/auth-store'

export type AgentAccountContext = {
  userId: number
  accessToken: string
}

export function getAgentAccountId(): number {
  const userId = useAuthStore.getState().auth.user?.id
  if (
    typeof userId !== 'number' ||
    !Number.isSafeInteger(userId) ||
    userId <= 0
  ) {
    throw new Error('Sign in to use account-scoped desktop tools.')
  }
  return userId
}

export async function getAgentAccountContext(): Promise<AgentAccountContext> {
  const userId = getAgentAccountId()
  const headers = await getFreshAuthHeaders()
  const accessToken = headers.Authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!accessToken || accessToken.length > 4096) {
    throw new Error('A valid signed-in session is required for desktop tools.')
  }
  if (getAgentAccountId() !== userId) {
    throw new Error('The signed-in account changed. Retry the desktop action.')
  }
  return { userId, accessToken }
}
