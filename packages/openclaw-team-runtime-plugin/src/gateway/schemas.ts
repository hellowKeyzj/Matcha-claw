export type TeamGatewayMethod =
  | 'matchaclaw.team.package.validate'
  | 'matchaclaw.team.run.create'
  | 'matchaclaw.team.run.start'
  | 'matchaclaw.team.run.snapshot'
  | 'matchaclaw.team.run.diagnostics'
  | 'matchaclaw.team.run.decision.submit'
  | 'matchaclaw.team.stage.complete'
  | 'matchaclaw.team.run.tick'
  | 'matchaclaw.team.dispatch.prepare'
  | 'matchaclaw.team.dispatch.execute'
  | 'matchaclaw.team.approval.resolve'
  | 'matchaclaw.team.run.cancel'
  | 'matchaclaw.team.gate.evaluate'

type FieldSchema =
  | { kind: 'string'; required: boolean }
  | { kind: 'number'; required: boolean }
  | { kind: 'stringArray'; required: boolean }
  | { kind: 'enum'; required: true; values: readonly string[] }

type ParamsSchema = Record<string, FieldSchema>

const requiredString = { kind: 'string', required: true } as const
const optionalString = { kind: 'string', required: false } as const
const optionalNumber = { kind: 'number', required: false } as const
const optionalStringArray = { kind: 'stringArray', required: false } as const

export const TEAM_GATEWAY_PARAM_SCHEMAS: Record<TeamGatewayMethod, ParamsSchema> = {
  'matchaclaw.team.package.validate': {
    packagePath: requiredString,
  },
  'matchaclaw.team.run.create': {
    packagePath: requiredString,
    runId: optionalString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.run.start': {
    runId: requiredString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.run.snapshot': {
    runId: requiredString,
    eventCursor: optionalNumber,
    eventLimit: optionalNumber,
  },
  'matchaclaw.team.run.diagnostics': {
    runId: requiredString,
  },
  'matchaclaw.team.run.decision.submit': {
    runId: requiredString,
    decision: { kind: 'enum', required: true, values: ['retry', 'proceed_degraded', 'abort'] },
    note: optionalString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.stage.complete': {
    runId: requiredString,
    stageId: requiredString,
    outputArtifactIds: optionalStringArray,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.run.tick': {
    runId: requiredString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.dispatch.prepare': {
    runId: requiredString,
    stageId: requiredString,
    roleId: optionalString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.dispatch.execute': {
    runId: requiredString,
    dispatchId: requiredString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.approval.resolve': {
    runId: requiredString,
    approvalId: requiredString,
    decision: { kind: 'enum', required: true, values: ['approve', 'deny', 'abort'] },
    note: optionalString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.run.cancel': {
    runId: requiredString,
    reason: optionalString,
    idempotencyKey: requiredString,
  },
  'matchaclaw.team.gate.evaluate': {
    runId: requiredString,
    artifactId: requiredString,
    gateType: requiredString,
    idempotencyKey: requiredString,
  },
}

export function parseTeamGatewayParams(method: TeamGatewayMethod, params: unknown): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new Error('Gateway params must be an object')
  }

  const schema = TEAM_GATEWAY_PARAM_SCHEMAS[method]
  const allowedKeys = new Set(Object.keys(schema))
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected parameter: ${key}`)
    }
  }

  const parsed: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema)) {
    const value = params[key]
    if (value === undefined) {
      if (field.required) {
        throw new Error(`${key} is required`)
      }
      continue
    }
    parsed[key] = parseField(key, value, field)
  }
  return parsed
}

function parseField(key: string, value: unknown, field: FieldSchema): unknown {
  if (field.kind === 'string') {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${key} is required`)
    }
    return value.trim()
  }
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${key} must be a finite number`)
    }
    return value
  }
  if (field.kind === 'stringArray') {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
      throw new Error(`${key} must be an array of non-empty strings`)
    }
    return value.map((item) => item.trim())
  }

  const parsed = parseField(key, value, requiredString) as string
  if (!field.values.includes(parsed)) {
    throw new Error(`Unsupported ${key}: ${parsed}`)
  }
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
