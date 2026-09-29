import { useAuthStore } from '@/stores/auth-store'

export function getAgentAccountId(): number {
  const userId = useAuthStore.getState().auth.user?.id
  if (!Number.isSafeInteger(userId) || userId === undefined || userId <= 0) {
    throw new Error('Sign in to use account-scoped desktop tools.')
  }
  return userId
}
