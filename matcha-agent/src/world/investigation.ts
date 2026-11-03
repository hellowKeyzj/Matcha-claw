import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import {
  SyntheticOutputTool,
  SYNTHETIC_OUTPUT_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { FileReadTool } from '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.js'

const integer = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(value => BigInt(value) <= 18446744073709551615n)
const effect = z.enum([
  'pure',
  'source_read',
  'clock_read',
  'probabilistic',
  'external_write',
])
export const AcceptedCorrelationSchema = z.strictObject({
  bindingId: z.string().min(1),
  acceptedRequestId: z.string().min(1),
  acceptedRunId: z.uuid(),
  acceptedInputId: z.uuid(),
  contentBudgetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  nativeAttemptId: z.uuid(),
  nativeInstanceId: z.uuid(),
})
export type AcceptedCorrelation = Readonly<
  z.infer<typeof AcceptedCorrelationSchema>
>

export const InvestigationUsageSchema = z.strictObject({
  steps: integer,
  sourceReads: integer,
  rows: integer,
  bytes: integer,
  modelCalls: integer,
  inputTokens: integer,
  outputTokens: integer,
})
export type InvestigationUsage = z.infer<typeof InvestigationUsageSchema>
export const AcceptedInputScopeSchema = z.strictObject({
  correlation: AcceptedCorrelationSchema,
  allowedEffects: z.array(effect),
  budget: z.strictObject({
    maxWallTime: integer,
    maxSteps: integer,
    maxSourceReads: integer,
    maxRows: integer,
    maxBytes: integer,
    maxModelCalls: integer,
    maxInputTokens: integer,
    maxOutputTokens: integer,
    maxCost: z
      .strictObject({ amount: z.string(), currency: z.string() })
      .nullish(),
    deadline: z.string().nullish(),
  }),
  deadlineMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})
export type AcceptedInputScope = Readonly<
  z.infer<typeof AcceptedInputScopeSchema>
>
export type InvestigationEffect = AcceptedInputScope['allowedEffects'][number]
export type InvestigationIoAdmission = {
  ioId?: string
  kind: 'model' | 'loop' | 'tool' | 'source'
  preparedRequestDigest: string
  reservation: InvestigationUsage
  proof: Record<string, unknown>
}
export type InvestigationIoObservation = {
  status: 'complete' | 'unknown' | 'not_sent'
  usage?: InvestigationUsage
  rawUsage?: Record<string, unknown>
  reason?: string
}
export type InvestigationPermit = Readonly<{
  ioId: string
  correlation: AcceptedCorrelation
  admissionDigest: string
}>
export type InvestigationControlRequest =
  | ({
      subtype: 'native_io_admit'
      correlation: AcceptedCorrelation
    } & Required<InvestigationIoAdmission>)
  | {
      subtype: 'native_io_observe'
      correlation: AcceptedCorrelation
      ioId: string
      observation: InvestigationIoObservation
    }
export type InvestigationControls = {
  request(
    request: InvestigationControlRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>
  signal: AbortSignal
}

type InputExecution = {
  scope: AcceptedInputScope
  controls: InvestigationControls
  abort: AbortController
  pending: Map<string, InvestigationPermit>
  operations: Set<Promise<unknown>>
  closing: boolean
  failures: string[]
  remaining: Readonly<InvestigationUsage>
}
const inputs = new AsyncLocalStorage<InputExecution>()

export class InvestigationAdmissionError extends Error {
  constructor(
    public readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(reason, options)
    this.name = 'InvestigationAdmissionError'
  }
}

export function rethrowInvestigationAdmission(error: unknown): void {
  if (error instanceof InvestigationAdmissionError) throw error
  const visited = new Set<object>()
  const pending: unknown[] = [error]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current instanceof InvestigationAdmissionError) {
      throw new InvestigationAdmissionError(current.reason, { cause: error })
    }
    if (current === null || typeof current !== 'object' || visited.has(current))
      continue
    visited.add(current)
    const nested = current as { cause?: unknown; originalError?: unknown }
    if (current instanceof AggregateError) pending.push(...current.errors)
    pending.push(nested.cause, nested.originalError)
  }
  const input = inputs.getStore()
  if (
    input &&
    (input.abort.signal.aborted || Date.now() >= input.scope.deadlineMs)
  ) {
    throw new InvestigationAdmissionError(
      'investigation_deadline_or_cancellation',
      { cause: error },
    )
  }
}

export function currentInvestigation(): AcceptedCorrelation | undefined {
  return inputs.getStore()?.scope.correlation
}
export function currentInvestigationScope(): AcceptedInputScope | undefined {
  return inputs.getStore()?.scope
}
export function investigationRemaining():
  | Readonly<InvestigationUsage>
  | undefined {
  return inputs.getStore()?.remaining
}
export function investigationSignal(): AbortSignal | undefined {
  return inputs.getStore()?.abort.signal
}
export function investigationAbortController(): AbortController | undefined {
  return inputs.getStore()?.abort
}
export function investigationDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, value]) => [key, canonical(value)]),
      )
    return item
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`
}

function activeInput(): InputExecution | undefined {
  const input = inputs.getStore()
  if (input?.closing)
    throw new InvestigationAdmissionError('investigation_input_sealed')
  if (
    input &&
    (input.abort.signal.aborted || Date.now() >= input.scope.deadlineMs)
  ) {
    throw new InvestigationAdmissionError(
      'investigation_deadline_or_cancellation',
    )
  }
  return input
}

export function requireInvestigationEffects(
  effects: readonly InvestigationEffect[],
): void {
  const input = activeInput()
  if (
    input &&
    effects.some(required => !input.scope.allowedEffects.includes(required))
  ) {
    throw new InvestigationAdmissionError('investigation_effect_denied')
  }
}

async function drainInput(input: InputExecution): Promise<void> {
  while (input.operations.size > 0)
    await Promise.allSettled([...input.operations])
  input.closing = true
}

export async function withInvestigation<T>(
  scope: AcceptedInputScope | undefined,
  controls: InvestigationControls,
  body: () => Promise<T>,
): Promise<T> {
  if (!scope) return body()
  const parsed = AcceptedInputScopeSchema.parse(scope)
  const correlation = Object.freeze(parsed.correlation)
  Object.freeze(parsed.allowedEffects)
  if (parsed.budget.maxCost) Object.freeze(parsed.budget.maxCost)
  Object.freeze(parsed.budget)
  const input: InputExecution = {
    scope: Object.freeze({ ...parsed, correlation }),
    controls,
    abort: new AbortController(),
    pending: new Map(),
    operations: new Set(),
    closing: false,
    failures: [],
    remaining: Object.freeze({
      steps: parsed.budget.maxSteps,
      sourceReads: parsed.budget.maxSourceReads,
      rows: parsed.budget.maxRows,
      bytes: parsed.budget.maxBytes,
      modelCalls: parsed.budget.maxModelCalls,
      inputTokens: parsed.budget.maxInputTokens,
      outputTokens: parsed.budget.maxOutputTokens,
    }),
  }
  const cancel = () => input.abort.abort(controls.signal.reason)
  controls.signal.addEventListener('abort', cancel, { once: true })
  if (controls.signal.aborted) cancel()
  let timer: ReturnType<typeof setTimeout> | undefined
  const armDeadline = () => {
    const remaining = parsed.deadlineMs - Date.now()
    if (remaining <= 0)
      input.abort.abort(
        new InvestigationAdmissionError('investigation_deadline_exceeded'),
      )
    else {
      timer = setTimeout(armDeadline, Math.min(remaining, 2147483647))
      timer.unref()
    }
  }
  armDeadline()
  try {
    return await inputs.run(input, body)
  } finally {
    await drainInput(input)
    clearTimeout(timer)
    controls.signal.removeEventListener('abort', cancel)
  }
}

export function trackInvestigationOperation<T>(
  operation: Promise<T>,
): Promise<T> {
  const input = inputs.getStore()
  if (!input) return operation
  input.operations.add(operation)
  void operation.then(
    () => input.operations.delete(operation),
    () => input.operations.delete(operation),
  )
  return operation
}

async function requestControl(
  input: InputExecution,
  request: InvestigationControlRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    const response = await input.controls.request(request, signal)
    const remaining = InvestigationUsageSchema.safeParse(response.remaining)
    if (!remaining.success)
      throw new InvestigationAdmissionError(
        'investigation_remaining_ack_invalid',
      )
    input.remaining = Object.freeze(remaining.data)
    return response
  } catch (error) {
    if (error instanceof InvestigationAdmissionError) throw error
    throw new InvestigationAdmissionError(
      error instanceof Error
        ? error.message
        : 'investigation_io_outcome_unknown',
    )
  }
}

export async function admitInvestigationIo(
  admission: InvestigationIoAdmission,
): Promise<InvestigationPermit | undefined> {
  const input = activeInput()
  if (!input) return undefined
  InvestigationUsageSchema.parse(admission.reservation)
  const ioId = admission.ioId ?? randomUUID()
  const response = await requestControl(
    input,
    {
      subtype: 'native_io_admit',
      ...admission,
      ioId,
      correlation: input.scope.correlation,
    },
    input.abort.signal,
  )
  if (response.ioId !== ioId || typeof response.admissionDigest !== 'string') {
    throw new InvestigationAdmissionError('investigation_admission_ack_invalid')
  }
  const permit = Object.freeze({
    ioId,
    correlation: input.scope.correlation,
    admissionDigest: response.admissionDigest,
  })
  input.pending.set(ioId, permit)
  activeInput()
  return permit
}

export async function observeInvestigationIo(
  permit: InvestigationPermit | undefined,
  observation: InvestigationIoObservation,
): Promise<void> {
  if (!permit) return
  const input = inputs.getStore()
  if (
    !input ||
    investigationDigest(permit.correlation) !==
      investigationDigest(input.scope.correlation) ||
    input.pending.get(permit.ioId) !== permit
  ) {
    throw new InvestigationAdmissionError(
      'investigation_observation_scope_invalid',
    )
  }
  if (observation.usage) InvestigationUsageSchema.parse(observation.usage)
  // Settlement is still sent after cancellation; it cannot admit another paid operation.
  const response = await requestControl(input, {
    subtype: 'native_io_observe',
    correlation: permit.correlation,
    ioId: permit.ioId,
    observation,
  })
  if (response.ioId !== permit.ioId || response.observed !== true) {
    throw new InvestigationAdmissionError(
      'investigation_observation_ack_invalid',
    )
  }
  if (observation.status === 'unknown')
    input.failures.push(observation.reason ?? 'native_io_unknown')
  else input.pending.delete(permit.ioId)
}

export function investigationUsage(
  values: Partial<InvestigationUsage> = {},
): InvestigationUsage {
  return {
    steps: '0',
    sourceReads: '0',
    rows: '0',
    bytes: '0',
    modelCalls: '0',
    inputTokens: '0',
    outputTokens: '0',
    ...values,
  }
}

export async function admitInvestigationStep(): Promise<void> {
  if (!currentInvestigation()) return
  const usage = investigationUsage({ steps: '1' })
  const permit = await admitInvestigationIo({
    kind: 'loop',
    preparedRequestDigest: investigationDigest({ kind: 'loop' }),
    reservation: usage,
    proof: { producer: 'query_loop' },
  })
  await observeInvestigationIo(permit, { status: 'complete', usage })
}

// World tools still enforce their complete dynamic impact in the native peer.
const toolEffects: Readonly<Record<string, InvestigationEffect>> = {
  Read: 'source_read',
  world_discover: 'source_read',
  world_query: 'source_read',
  world_explain: 'source_read',
  world_observe: 'pure',
  world_action_status: 'source_read',
  world_action_propose: 'source_read',
  world_action_submit: 'external_write',
  world_change_propose: 'pure',
  world_branch_test: 'pure',
  [SYNTHETIC_OUTPUT_TOOL_NAME]: 'pure',
}

type InvestigationTool = {
  name: string
  call?: unknown
  checkPermissions?: unknown
}

export function assertInvestigationToolEffects(tool: InvestigationTool): void {
  const input = activeInput()
  if (!input) return
  const required = toolEffects[tool.name]
  if (
    !required ||
    !input.scope.allowedEffects.includes(required) ||
    (tool.name === 'world_action_propose' &&
      !input.scope.allowedEffects.includes('pure')) ||
    (tool.name === 'Read' &&
      (tool.call !== FileReadTool.call ||
        tool.checkPermissions !== FileReadTool.checkPermissions)) ||
    (tool.name === SYNTHETIC_OUTPUT_TOOL_NAME &&
      (tool.call !== SyntheticOutputTool.call ||
        tool.checkPermissions !== SyntheticOutputTool.checkPermissions))
  ) {
    throw new InvestigationAdmissionError('investigation_tool_effect_denied')
  }
}

export async function admitInvestigationTool(
  tool: InvestigationTool,
  inputValue: unknown,
): Promise<void> {
  if (!currentInvestigation()) return
  assertInvestigationToolEffects(tool)
  const usage = investigationUsage({ steps: '1' })
  const permit = await admitInvestigationIo({
    kind: 'tool',
    preparedRequestDigest: investigationDigest({
      tool: tool.name,
      input: inputValue,
    }),
    reservation: usage,
    proof: {
      toolName: tool.name,
      effect: toolEffects[tool.name],
      ...(tool.name === 'Read'
        ? { producer: 'matcha_builtin_read' }
        : tool.name === SYNTHETIC_OUTPUT_TOOL_NAME
          ? { producer: 'matcha_structured_output' }
          : {}),
    },
  })
  await observeInvestigationIo(permit, { status: 'complete', usage })
}

export async function investigationInputReceipt(): Promise<
  Record<string, unknown> | undefined
> {
  const input = inputs.getStore()
  if (!input) return undefined
  await drainInput(input)
  return {
    scope: 'accepted_input',
    coverage: 'native_exclusive',
    correlation: input.scope.correlation,
    childrenJoined: input.closing && input.operations.size === 0,
    pendingIo: input.pending.size.toString(),
    unavailable: [...input.failures],
  }
}
