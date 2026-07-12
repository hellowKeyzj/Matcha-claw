export const REMOTE_FLEET_SECRET_HOST_RPC_METHOD = 'host.secret.resolve' as const;
export const REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE = 'host.secret.resolve.result' as const;
export const REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_WORKER_COMMAND_EXECUTION = 'worker-command-execution' as const;
export const REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION = 'terminal-session' as const;
export const REMOTE_FLEET_SECRET_RESOLVE_PURPOSE = REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_WORKER_COMMAND_EXECUTION;

export type RemoteFleetSecretResolvePurpose =
  | typeof REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_WORKER_COMMAND_EXECUTION
  | typeof REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION;

export type RemoteFleetSecretResolveRequestInput = {
  readonly secretRef: string;
  readonly purpose: RemoteFleetSecretResolvePurpose;
  readonly commandExecutionId: string;
  readonly workerId?: string;
};

export type RemoteFleetSecretResolveHostRpcRequest = {
  readonly type: typeof REMOTE_FLEET_SECRET_HOST_RPC_METHOD;
  readonly requestId: string;
  readonly input: RemoteFleetSecretResolveRequestInput;
};

/**
 * The resolved response is the only host.secret.resolve DTO branch allowed to
 * carry plaintext. Callers must treat plaintextSecretValue as ephemeral input
 * for worker command execution or terminal session setup and must not persist it
 * to snapshots, stores, or audit records. Use redactSecretResolveResponse before
 * any durable projection.
 */
export type RemoteFleetSecretResolveHostRpcResponse =
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'resolved';
      readonly secretRef: string;
      readonly plaintextSecretValue: string;
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'notFound';
      readonly secretRef: string;
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'accessDenied';
      readonly secretRef: string;
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'unavailable';
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'invalidRequest';
      readonly validationReason: RemoteFleetSecretResolveRequestValidationFailureReason;
    };

export type RemoteFleetSecretResolveHostRpcRequestRedacted = RemoteFleetSecretResolveHostRpcRequest;

export type RemoteFleetSecretResolveHostRpcResponseRedacted =
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'resolved';
      readonly secretRef: string;
      readonly plaintextSecretValueRedacted: true;
    }
  | Exclude<RemoteFleetSecretResolveHostRpcResponse, { readonly resultType: 'resolved' }>;

export type RemoteFleetSecretResolveRequestValidationFailureReason =
  | 'requestNotObject'
  | 'unknownField'
  | 'plaintextFieldNotAllowed'
  | 'requestTypeInvalid'
  | 'requestIdInvalid'
  | 'inputNotObject'
  | 'secretRefInvalid'
  | 'purposeInvalid'
  | 'commandExecutionIdInvalid'
  | 'workerIdInvalid';

export type RemoteFleetSecretResolveRequestValidationFailure = {
  readonly resultType: 'invalidRequest';
  readonly reason: RemoteFleetSecretResolveRequestValidationFailureReason;
  readonly message: string;
  readonly field?: string;
};

export type RemoteFleetSecretResolveRequestValidationResult =
  | {
      readonly resultType: 'valid';
      readonly request: RemoteFleetSecretResolveHostRpcRequest;
    }
  | RemoteFleetSecretResolveRequestValidationFailure;

type JsonRecord = Record<string, unknown>;
type StringFieldValidationResult =
  | { readonly resultType: 'valid'; readonly value: string }
  | RemoteFleetSecretResolveRequestValidationFailure;

const REQUEST_ID_TEXT_LIMIT = 128;
const SECRET_REF_TEXT_LIMIT = 512;
const COMMAND_EXECUTION_ID_TEXT_LIMIT = 256;
const WORKER_ID_TEXT_LIMIT = 256;

const HOST_RPC_REQUEST_FIELDS = new Set(['type', 'requestId', 'input']);
const SECRET_RESOLVE_INPUT_FIELDS = new Set(['secretRef', 'purpose', 'commandExecutionId', 'workerId']);
const PLAINTEXT_FIELD_NAMES = new Set([
  'authorization',
  'apikey',
  'password',
  'plaintext',
  'plaintextsecret',
  'plaintextsecretvalue',
  'secret',
  'secretvalue',
  'token',
  'value',
]);

export function validateSecretResolveRequest(rawRequest: unknown): RemoteFleetSecretResolveRequestValidationResult {
  if (!isJsonRecord(rawRequest)) {
    return invalidRequest('requestNotObject', 'host.secret.resolve request must be an object.');
  }

  const hostFieldFailure = validateKnownFields(rawRequest, HOST_RPC_REQUEST_FIELDS);
  if (hostFieldFailure) return hostFieldFailure;

  if (rawRequest.type !== REMOTE_FLEET_SECRET_HOST_RPC_METHOD) {
    return invalidRequest('requestTypeInvalid', 'host.secret.resolve request type is required.', 'type');
  }

  const requestId = readRequiredString(rawRequest, 'requestId', REQUEST_ID_TEXT_LIMIT, 'requestIdInvalid');
  if (requestId.resultType === 'invalidRequest') return requestId;

  if (!isJsonRecord(rawRequest.input)) {
    return invalidRequest('inputNotObject', 'host.secret.resolve input must be an object.', 'input');
  }

  const inputFieldFailure = validateKnownFields(rawRequest.input, SECRET_RESOLVE_INPUT_FIELDS);
  if (inputFieldFailure) return inputFieldFailure;

  const secretRef = readRequiredString(rawRequest.input, 'secretRef', SECRET_REF_TEXT_LIMIT, 'secretRefInvalid');
  if (secretRef.resultType === 'invalidRequest') return secretRef;

  if (!isSecretResolvePurpose(rawRequest.input.purpose)) {
    return invalidRequest(
      'purposeInvalid',
      'host.secret.resolve is only valid for worker command execution or terminal session setup.',
      'purpose',
    );
  }

  const commandExecutionId = readRequiredString(
    rawRequest.input,
    'commandExecutionId',
    COMMAND_EXECUTION_ID_TEXT_LIMIT,
    'commandExecutionIdInvalid',
  );
  if (commandExecutionId.resultType === 'invalidRequest') return commandExecutionId;

  const workerId = readOptionalString(rawRequest.input, 'workerId', WORKER_ID_TEXT_LIMIT, 'workerIdInvalid');
  if (workerId.resultType === 'invalidRequest') return workerId;

  const input: RemoteFleetSecretResolveRequestInput = {
    secretRef: secretRef.value,
    purpose: rawRequest.input.purpose,
    commandExecutionId: commandExecutionId.value,
    ...(workerId.value ? { workerId: workerId.value } : {}),
  };

  return {
    resultType: 'valid',
    request: {
      type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
      requestId: requestId.value,
      input,
    },
  };
}

export function redactSecretResolveRequest(
  request: RemoteFleetSecretResolveHostRpcRequest,
): RemoteFleetSecretResolveHostRpcRequestRedacted {
  return request;
}

export function redactSecretResolveResponse(
  response: RemoteFleetSecretResolveHostRpcResponse,
): RemoteFleetSecretResolveHostRpcResponseRedacted {
  if (response.resultType !== 'resolved') return response;

  return {
    type: response.type,
    requestId: response.requestId,
    resultType: 'resolved',
    secretRef: response.secretRef,
    plaintextSecretValueRedacted: true,
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecretResolvePurpose(value: unknown): value is RemoteFleetSecretResolvePurpose {
  return value === REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_WORKER_COMMAND_EXECUTION
    || value === REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION;
}

function validateKnownFields(
  record: JsonRecord,
  allowedFields: ReadonlySet<string>,
): RemoteFleetSecretResolveRequestValidationFailure | undefined {
  for (const field of Object.keys(record)) {
    if (allowedFields.has(field)) continue;
    const normalizedField = field.toLowerCase();
    if (PLAINTEXT_FIELD_NAMES.has(normalizedField)) {
      return invalidRequest(
        'plaintextFieldNotAllowed',
        'host.secret.resolve requests must carry a secret reference, not plaintext secret material.',
        field,
      );
    }
    return invalidRequest('unknownField', `Unknown host.secret.resolve field "${field}".`, field);
  }
  return undefined;
}

function readRequiredString(
  record: JsonRecord,
  field: string,
  maxLength: number,
  reason: RemoteFleetSecretResolveRequestValidationFailureReason,
): StringFieldValidationResult {
  if (typeof record[field] !== 'string') {
    return invalidRequest(reason, `host.secret.resolve field "${field}" must be a non-empty string.`, field);
  }

  const value = record[field].trim();
  if (value.length === 0 || value.length > maxLength) {
    return invalidRequest(reason, `host.secret.resolve field "${field}" must be 1-${maxLength} characters.`, field);
  }

  return { resultType: 'valid', value };
}

function readOptionalString(
  record: JsonRecord,
  field: string,
  maxLength: number,
  reason: RemoteFleetSecretResolveRequestValidationFailureReason,
): StringFieldValidationResult {
  if (record[field] === undefined) return { resultType: 'valid', value: '' };
  return readRequiredString(record, field, maxLength, reason);
}

function invalidRequest(
  reason: RemoteFleetSecretResolveRequestValidationFailureReason,
  message: string,
  field?: string,
): RemoteFleetSecretResolveRequestValidationFailure {
  return field === undefined
    ? { resultType: 'invalidRequest', reason, message }
    : { resultType: 'invalidRequest', reason, message, field };
}
