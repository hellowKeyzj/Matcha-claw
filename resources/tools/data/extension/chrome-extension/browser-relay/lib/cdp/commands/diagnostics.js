// Slow CDP command stages are kept in the extension's short in-memory log.
// Only allowlisted timing fields are recorded; CDP params and page data never enter it.
const MAX_ENTRIES = 200
const entries = []
const workerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const numeric = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined

export function recordCommandDiagnostic(input) {
  const fields = {
    workerId,
    requestId: input.requestId,
    tabId: input.tabId,
    lane: input.lane,
    outcome: input.outcome,
    stage: input.stage,
    preQueueMs: numeric(input.preQueueMs),
    queueWaitMs: numeric(input.queueWaitMs),
    attachMs: numeric(input.attachMs),
    chromeCommandMs: numeric(input.chromeCommandMs),
    runtimeEnableMs: numeric(input.runtimeEnableMs),
    failureDiagnosisMs: numeric(input.failureDiagnosisMs),
    extensionTotalMs: numeric(input.extensionTotalMs),
    lateSettlementMs: numeric(input.lateSettlementMs),
    deadlineSource: input.deadlineSource,
    timeoutSource: input.timeoutSource,
  }
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  const entry = { ts: Date.now(), dir: '·', method: input.method, detail, fields }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.shift()
  return entry
}

export function getCommandDiagnostics(limit = 100) {
  const count = Math.max(0, Math.min(MAX_ENTRIES, limit))
  return count ? entries.slice(-count) : []
}
