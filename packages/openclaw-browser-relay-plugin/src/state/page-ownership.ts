import type { BrowserActionContext } from '../browser-action-contract.js'

export function browserPrincipalId(context: BrowserActionContext): string {
  return JSON.stringify([context.agentId, context.sessionKey])
}

export type PageOwnership = {
  createdBy: string | null
  retained: boolean
  claimedBy: string | null
  sessionGroupId: string | null
}

export function canAccessPage(ownership: PageOwnership, executorId: string, sessionGroupId = executorId): boolean {
  return Boolean(executorId) && (!ownership.claimedBy || ownership.claimedBy === executorId)
    && (ownership.sessionGroupId
      ? ownership.sessionGroupId === sessionGroupId || (!ownership.createdBy && ownership.sessionGroupId === executorId)
      : !ownership.createdBy || ownership.createdBy === executorId)
}

export function claimPage(ownership: PageOwnership, executorId: string, sessionGroupId = executorId): PageOwnership {
  if (!canAccessPage(ownership, executorId, sessionGroupId)) {
    throw new Error('The browser page belongs to another session group or is claimed by another executor.')
  }
  return { ...ownership, claimedBy: executorId, sessionGroupId }
}

export function releasePage(ownership: PageOwnership, executorId: string): PageOwnership {
  return ownership.claimedBy === executorId
    ? { ...ownership, claimedBy: null, sessionGroupId: ownership.createdBy ? ownership.sessionGroupId : null }
    : ownership
}

export function canClosePage(ownership: PageOwnership, executorId: string): boolean {
  return Boolean(executorId) && ownership.createdBy === executorId && !ownership.retained
    && (!ownership.claimedBy || ownership.claimedBy === executorId)
}
