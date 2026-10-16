import { AsyncLocalStorage } from 'async_hooks'
import { SEALED_REDACTION } from './reference.js'

const requestContext = new AsyncLocalStorage<true>()
const protectedTelemetry = new WeakSet<object>()

export function markSealedTelemetry(owner: object): void {
  protectedTelemetry.add(owner)
}

export function sealedModelContext(): boolean {
  return requestContext.getStore() === true
}

export function withSealedModelContext<T>(sealed: boolean, call: () => T): T {
  return sealed ? requestContext.run(true, call) : call()
}

export function sealedTelemetryValue(value: unknown, owner?: object): unknown {
  return sealedModelContext() ||
    (owner !== undefined && protectedTelemetry.has(owner))
    ? SEALED_REDACTION
    : value
}
