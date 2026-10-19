const stages = [
  'admission', 'runtime', 'session_lookup', 'task_request', 'native_start',
  'native_control', 'native_read', 'response', 'transport',
] as const;
const deliveries = ['notSent', 'sent', 'unknown', 'responseReceived'] as const;

export const TASK_FAILURE_MESSAGES = {
  admission_closed: 'Task requests are not being admitted',
  unsupported: 'Task management is not supported by this runtime',
  runtime_not_ready: 'The task runtime is not ready',
  owner_unavailable: 'The task manager owner is unavailable',
  invalid_identity: 'The task session identity is invalid',
  ownership_mismatch: 'The task session ownership does not match',
  not_found: 'The requested task or session was not found',
  connect_failed: 'The task runtime connection failed',
  connection_closed: 'The task runtime connection closed',
  upgrade_failed: 'The task runtime connection upgrade failed',
  deadline: 'The task request timed out',
  cancelled: 'The task request was cancelled',
  authentication_failed: 'Task runtime authentication failed',
  unsupported_protocol: 'The task runtime protocol is not supported',
  method_not_found: 'The task runtime method was not found',
  invalid_params: 'The task request parameters are invalid',
  native_start_failed: 'Native task process startup could not be confirmed',
  native_instance_absent: 'The native task process is absent',
  native_instance_changed: 'The native task process changed during the request',
  native_cleanup_unconfirmed: 'Native task process cleanup is unconfirmed',
  session_closed: 'The task session is closed',
  native_control_error: 'Native task control failed',
  native_response_lost: 'The native task response was lost',
  task_io: 'Task data could not be read or saved',
  todo_io: 'Todo data could not be read or saved',
  task_native_schema: 'The native task data format is invalid',
  task_lock_conflict: 'Task data is locked by another operation',
  todo_conflict: 'Todo data changed before the update',
  todo_session_busy: 'The todo session is busy',
  task_dependency_missing: 'A task dependency was not found',
  todo_owner_inactive: 'The todo owner is inactive',
  todo_persistence_disabled: 'Todo persistence is disabled',
  receipt_invalid: 'The task operation receipt is invalid',
  protocol: 'The task response format is invalid',
  transport: 'Task request delivery could not be confirmed',
  request_rejected: 'The task request was rejected',
  remote_error: 'The task runtime reported an error',
} as const;

export type TaskFailure = Readonly<{
  stage: typeof stages[number];
  code: keyof typeof TASK_FAILURE_MESSAGES;
  rpcCode?: number;
  delivery?: typeof deliveries[number];
}>;

export type TaskFailureResponse = Readonly<{
  success: false;
  error: string;
  failure: TaskFailure;
}>;

export function decodeTaskFailure(value: unknown): TaskFailure | null {
  if (!isRecord(value)
    || !Object.hasOwn(value, 'stage') || !Object.hasOwn(value, 'code')
    || !Object.keys(value).every((key) => ['stage', 'code', 'rpcCode', 'delivery'].includes(key))
    || !stages.includes(value.stage as TaskFailure['stage'])
    || typeof value.code !== 'string' || !Object.hasOwn(TASK_FAILURE_MESSAGES, value.code)
    || (Object.hasOwn(value, 'rpcCode') && (typeof value.rpcCode !== 'number' || !Number.isSafeInteger(value.rpcCode)))
    || (Object.hasOwn(value, 'delivery') && !deliveries.includes(value.delivery as NonNullable<TaskFailure['delivery']>))) {
    return null;
  }
  return {
    stage: value.stage as TaskFailure['stage'],
    code: value.code as TaskFailure['code'],
    ...(value.rpcCode === undefined ? {} : { rpcCode: value.rpcCode as number }),
    ...(value.delivery === undefined ? {} : { delivery: value.delivery as TaskFailure['delivery'] }),
  };
}

export function taskFailureResponse(failure: TaskFailure): TaskFailureResponse {
  return { success: false, error: TASK_FAILURE_MESSAGES[failure.code], failure };
}

export function decodeTaskFailureResponse(value: unknown): TaskFailureResponse | null {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || !Object.keys(value).every((key) => ['success', 'error', 'failure'].includes(key))
    || value.success !== false || typeof value.error !== 'string') return null;
  const failure = decodeTaskFailure(value.failure);
  return failure ? taskFailureResponse(failure) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
