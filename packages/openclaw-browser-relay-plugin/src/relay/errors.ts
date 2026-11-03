const DETAIL_MARKER = /\n\[matcha-relay-error-detail:([A-Za-z0-9_-]+)\]/

type RelayError = {
  message: string
  errorDetail?: Record<string, unknown>
}

// Playwright reconstructs CDP errors from message alone.
export function formatRelayErrorMessage(error: unknown): string {
  const { message, errorDetail } = readRelayError(error)
  return errorDetail
    ? `${message}\n[matcha-relay-error-detail:${Buffer.from(JSON.stringify(errorDetail)).toString('base64url')}]`
    : message
}

export function readRelayError(error: unknown): RelayError {
  const message = error instanceof Error ? error.message : String(error)
  const detail = error && typeof error === 'object' && 'errorDetail' in error ? error.errorDetail : undefined
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    return { message: message.replace(DETAIL_MARKER, ''), errorDetail: detail as Record<string, unknown> }
  }
  const match = DETAIL_MARKER.exec(message)
  if (match) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        return { message: message.replace(DETAIL_MARKER, ''), errorDetail: decoded as Record<string, unknown> }
      }
    } catch {
      // An unrelated browser error can contain arbitrary text.
    }
  }
  return { message }
}
