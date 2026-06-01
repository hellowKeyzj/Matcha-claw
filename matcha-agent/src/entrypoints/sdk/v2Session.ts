import type { SDKResultMessage, SDKUserMessage } from './coreTypes.js'
import { query } from './query.js'
import type { SDKSession, SDKSessionOptions } from './runtimeTypes.js'

export function unstable_v2_createSession(
  options: SDKSessionOptions = {},
): SDKSession {
  return new MatchaSDKSession(undefined, options)
}

export function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions = {},
): SDKSession {
  return new MatchaSDKSession(sessionId, options)
}

class MatchaSDKSession implements SDKSession {
  sessionId: string
  private abortController: AbortController | undefined
  private queue = Promise.resolve()

  constructor(
    sessionId: string | undefined,
    private readonly options: SDKSessionOptions,
  ) {
    this.sessionId = sessionId ?? options.sessionId ?? ''
  }

  prompt(
    input: string | AsyncIterable<SDKUserMessage>,
  ): Promise<SDKResultMessage> {
    const run = this.queue.then(() => this.runPrompt(input))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  abort(): void {
    this.abortController?.abort()
  }

  private async runPrompt(
    input: string | AsyncIterable<SDKUserMessage>,
  ): Promise<SDKResultMessage> {
    this.abortController = new AbortController()
    const q = query({
      prompt: input,
      options: {
        ...this.options,
        resume: this.sessionId || this.options.resume,
        abortController: this.abortController,
      },
    })

    let result: SDKResultMessage | undefined
    try {
      for await (const message of q) {
        if (message.type === 'system') {
          const candidate = message.session_id ?? message.sessionId
          if (typeof candidate === 'string' && candidate)
            this.sessionId = candidate
        }
        if (message.type === 'result') {
          result = message as SDKResultMessage
          const candidate = message.session_id ?? message.sessionId
          if (typeof candidate === 'string' && candidate)
            this.sessionId = candidate
        }
      }
    } finally {
      await q.close()
      this.abortController = undefined
    }

    if (!result)
      throw new Error('SDK session prompt completed without a result')
    return result
  }
}
