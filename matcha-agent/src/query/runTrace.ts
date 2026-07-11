export type RunTraceValue = string | number | boolean | null | undefined

export type RunTraceDetails = Record<string, RunTraceValue>

export type QueryRunTraceStage =
  | 'worker.query.submit.started'
  | 'worker.query.sdk_result'
  | 'worker.query.iterator.completed_without_result'
  | 'worker.query.cancelled'
  | 'worker.query.error'
  | 'query_engine.system_prompt.start'
  | 'query_engine.system_prompt.end'
  | 'query_engine.process_user_input.start'
  | 'query_engine.process_user_input.end'
  | 'query_engine.transcript.start'
  | 'query_engine.transcript.end'
  | 'query_engine.skills_plugins.start'
  | 'query_engine.skills_plugins.end'
  | 'query_engine.query_loop.start'
  | 'query_engine.query_loop.end'
  | 'query.api.loop.start'
  | 'query.api.streaming.start'
  | 'query.api.streaming.end'
  | 'api.client.creation.start'
  | 'api.client.creation.end'
  | 'api.request.sent'
  | 'api.response.headers'
  | 'api.stream.watchdog.configured'
  | 'api.stream.first_chunk'
  | 'api.stream.message_start'
  | 'api.stream.message_delta.stop_reason'
  | 'api.stream.message_stop'
  | 'api.stream.watchdog.timeout'
  | 'api.stream.loop.end'
  | 'api.stream.loop.exited_after_watchdog'
  | 'api.stream.error'
  | 'api.nonstreaming_fallback.started'

export type RunTraceSink = (
  stage: QueryRunTraceStage,
  details?: RunTraceDetails,
) => void

export function sanitizeRunTraceDetails(
  details: RunTraceDetails | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined

  const sanitized: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    sanitized[key] = value
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

export function isRunTraceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTruthyEnvValue(env.MATCHA_AGENT_RUN_TRACE)
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false
  switch (value.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    default:
      return false
  }
}
