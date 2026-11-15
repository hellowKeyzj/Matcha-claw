import { AsyncLocalStorage } from 'node:async_hooks'
import type { UUID } from 'crypto'

const requestMessageIds = new AsyncLocalStorage<UUID | undefined>()

export function withRequestExecution<T>(
  requestMessageId: UUID | undefined,
  body: () => Promise<T>,
): Promise<T> {
  return requestMessageIds.run(requestMessageId, body)
}

export function currentRequestMessageId(): UUID | undefined {
  return requestMessageIds.getStore()
}
