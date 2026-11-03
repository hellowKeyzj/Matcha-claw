/**
 * CDP command routing errors and their wire contract.
 *
 * Lives apart from dispatch.js so the relay connection can serialize these without
 * importing the whole dispatcher, mirroring how deadline.js carries
 * CommandDeadlineExceededError + serializeCommandDeadlineError.
 */

export const CDP_COMMAND_ROUTE_ERROR_CODE = 'CDP_COMMAND_ROUTE_ERROR'

export class CdpCommandRouteError extends Error {
  constructor({ code, method, sessionId, targetId }) {
    super(
      code === 'stale_session'
        ? `Stale CDP session for method ${method} [cdpRouteError code=${code}]`
        : `No attached tab for method ${method} [cdpRouteError code=${code}]`,
    )
    this.name = 'CdpCommandRouteError'
    this.code = `cdp_command_route.${code}`
    this.routeCode = code
    this.method = method
    this.sessionId = sessionId
    this.targetId = targetId
  }
}

/**
 * The `[cdpRouteError code=…]` suffix in the message is what older SDKs see; this payload
 * is the structured channel so the SDK can classify without parsing message text.
 */
export function serializeCommandRouteError(error, { requestId }) {
  if (!(error instanceof CdpCommandRouteError)) {
    throw new TypeError('CdpCommandRouteError is required')
  }
  return {
    code: CDP_COMMAND_ROUTE_ERROR_CODE,
    message: error.message,
    requestId,
    method: error.method,
    routeCode: error.routeCode,
    ...(typeof error.sessionId === 'string' ? { sessionId: error.sessionId } : {}),
    ...(typeof error.targetId === 'string' ? { targetId: error.targetId } : {}),
  }
}
