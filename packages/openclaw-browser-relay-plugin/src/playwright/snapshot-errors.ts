/**
 * Snapshot-specific error types for better agent feedback.
 */

/** Page contains no addressable ARIA content (likely about:blank or data: URL). */
export class PageBlankError extends Error {
  readonly code = 'page.blank'
  constructor(message = 'page contains no addressable ARIA content (likely about:blank or data: URL)') {
    super(message)
    this.name = 'PageBlankError'
  }
}

/** Scope resolved to zero elements. */
export class ScopeEmptyError extends Error {
  readonly code = 'scope.empty'
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'ScopeEmptyError'
    this.reason = reason
  }
}

/** scope.frame selector matched multiple iframes — must match exactly one. */
export class ScopeFrameMultiMatchError extends Error {
  readonly code = 'scope.frame.multi_match'
  readonly count: number
  constructor(selector: string, count: number) {
    super(`scope.frame selector ${JSON.stringify(selector)} matched ${count} iframes — must match exactly one. Use a tighter selector.`)
    this.name = 'ScopeFrameMultiMatchError'
    this.count = count
  }
}
