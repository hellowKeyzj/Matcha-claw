import type { RemoteFleetSecretRef } from './remote-fleet-model';

export const REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD = 'host.secret.write' as const;
export const REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE = 'host.secret.write.result' as const;
export const REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD = 'host.secret.write.status' as const;
export const REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE = 'host.secret.write.status.result' as const;

export type RemoteFleetWritableCredentialName = 'sshPassword' | 'sshPrivateKey' | 'dockerBearerToken' | 'kubeBearerToken';

export const REMOTE_FLEET_CREDENTIAL_TEXT_LIMIT = 256 * 1024;

export type RemoteFleetCredentialWriteRequestValidationResult =
  | {
      readonly resultType: 'valid';
      readonly request: RemoteFleetSecretWriteHostRpcRequest;
    }
  | {
      readonly resultType: 'invalidRequest';
      readonly message: string;
    };

export type RemoteFleetCredentialWriteStatusRequestValidationResult =
  | {
      readonly resultType: 'valid';
      readonly request: RemoteFleetSecretWriteStatusHostRpcRequest;
    }
  | {
      readonly resultType: 'invalidRequest';
      readonly message: string;
    };

export type RemoteFleetCredentialWriteRequestInput = {
  readonly operationId: string;
  readonly credentialId: string;
  readonly credentialName: RemoteFleetWritableCredentialName;
  /**
   * Plaintext is only allowed on host.secret.write. It must be written to the
   * private credential store and never returned, persisted in Remote Fleet
   * state, logged, or projected to renderer state.
   */
  readonly plaintextValue: string;
  readonly nowIso: string;
};

export type RemoteFleetSecretWriteHostRpcRequest = {
  readonly type: typeof REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD;
  readonly requestId: string;
  readonly input: RemoteFleetCredentialWriteRequestInput;
};

export type RemoteFleetSecretWriteStatusHostRpcRequest = {
  readonly type: typeof REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD;
  readonly requestId: string;
  readonly input: {
    readonly operationId: string;
    readonly credentialName: RemoteFleetWritableCredentialName;
    readonly credentialRef: RemoteFleetSecretRef;
  };
};

export type RemoteFleetSecretWriteHostRpcResponse =
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'written';
      readonly credentialName: RemoteFleetWritableCredentialName;
      readonly credentialRef: RemoteFleetSecretRef;
      readonly writtenAt: string;
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'unavailable';
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'invalidRequest';
      readonly message: string;
    };

export type RemoteFleetSecretWriteStatusHostRpcResponse =
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'completed';
      readonly credentialName: RemoteFleetWritableCredentialName;
      readonly credentialRef: RemoteFleetSecretRef;
      readonly writtenAt: string;
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'notFound' | 'operationConflict' | 'unavailable';
    }
  | {
      readonly type: typeof REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'invalidRequest';
      readonly message: string;
    };

const REMOTE_FLEET_WRITABLE_CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  'sshPassword',
  'sshPrivateKey',
  'dockerBearerToken',
  'kubeBearerToken',
]);
const HOST_RPC_REQUEST_FIELDS: ReadonlySet<string> = new Set(['type', 'requestId', 'input']);
const CREDENTIAL_WRITE_INPUT_FIELDS: ReadonlySet<string> = new Set(['operationId', 'credentialId', 'credentialName', 'plaintextValue', 'nowIso']);
const CREDENTIAL_WRITE_STATUS_INPUT_FIELDS: ReadonlySet<string> = new Set(['operationId', 'credentialName', 'credentialRef']);

export function validateCredentialWriteRequest(rawRequest: unknown): RemoteFleetCredentialWriteRequestValidationResult {
  if (!isRecord(rawRequest)) {
    return invalidCredentialWriteRequest('host.secret.write request must be an object.');
  }
  const hostFieldFailure = validateKnownFields(rawRequest, HOST_RPC_REQUEST_FIELDS, 'host.secret.write');
  if (hostFieldFailure) return hostFieldFailure;
  if (rawRequest.type !== REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD) {
    return invalidCredentialWriteRequest('host.secret.write request type is required.');
  }
  const requestId = readString(rawRequest, 'requestId', 128);
  if (!requestId) {
    return invalidCredentialWriteRequest('host.secret.write requestId is required.');
  }
  if (!isRecord(rawRequest.input)) {
    return invalidCredentialWriteRequest('host.secret.write input must be an object.');
  }
  const inputFieldFailure = validateKnownFields(rawRequest.input, CREDENTIAL_WRITE_INPUT_FIELDS, 'host.secret.write input');
  if (inputFieldFailure) return inputFieldFailure;

  const operationId = readString(rawRequest.input, 'operationId', 128);
  if (!operationId || !isValidRemoteFleetCredentialPathSegment(operationId)) {
    return invalidCredentialWriteRequest('Remote Fleet credential write operation id is not valid.');
  }
  const credentialId = readString(rawRequest.input, 'credentialId', 128);
  if (!credentialId || !isValidRemoteFleetCredentialPathSegment(credentialId)) {
    return invalidCredentialWriteRequest('Remote Fleet credential id is not valid.');
  }
  const credentialName = readString(rawRequest.input, 'credentialName', 64);
  if (!credentialName || !isRemoteFleetWritableCredentialName(credentialName)) {
    return invalidCredentialWriteRequest('Remote Fleet credential name is not supported.');
  }
  const plaintextValue = readPlaintextValue(rawRequest.input, 'plaintextValue', REMOTE_FLEET_CREDENTIAL_TEXT_LIMIT);
  if (plaintextValue === undefined) {
    return invalidCredentialWriteRequest('Remote Fleet credential value is required.');
  }
  const nowIso = readString(rawRequest.input, 'nowIso', 64);
  if (!nowIso || Number.isNaN(Date.parse(nowIso))) {
    return invalidCredentialWriteRequest('Remote Fleet credential timestamp is required.');
  }

  return {
    resultType: 'valid',
    request: {
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD,
      requestId,
      input: {
        operationId,
        credentialId,
        credentialName,
        plaintextValue,
        nowIso,
      },
    },
  };
}

export function validateCredentialWriteStatusRequest(rawRequest: unknown): RemoteFleetCredentialWriteStatusRequestValidationResult {
  if (!isRecord(rawRequest)) {
    return invalidCredentialWriteStatusRequest('host.secret.write.status request must be an object.');
  }
  const hostFieldFailure = validateKnownFields(rawRequest, HOST_RPC_REQUEST_FIELDS, 'host.secret.write.status');
  if (hostFieldFailure) return hostFieldFailure;
  if (rawRequest.type !== REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD) {
    return invalidCredentialWriteStatusRequest('host.secret.write.status request type is required.');
  }
  const requestId = readString(rawRequest, 'requestId', 128);
  if (!requestId) {
    return invalidCredentialWriteStatusRequest('host.secret.write.status requestId is required.');
  }
  if (!isRecord(rawRequest.input)) {
    return invalidCredentialWriteStatusRequest('host.secret.write.status input must be an object.');
  }
  const inputFieldFailure = validateKnownFields(
    rawRequest.input,
    CREDENTIAL_WRITE_STATUS_INPUT_FIELDS,
    'host.secret.write.status input',
  );
  if (inputFieldFailure) return inputFieldFailure;

  const operationId = readString(rawRequest.input, 'operationId', 128);
  if (!operationId || !isValidRemoteFleetCredentialPathSegment(operationId)) {
    return invalidCredentialWriteStatusRequest('Remote Fleet credential write operation id is not valid.');
  }
  const credentialName = readString(rawRequest.input, 'credentialName', 64);
  if (!credentialName || !isRemoteFleetWritableCredentialName(credentialName)) {
    return invalidCredentialWriteStatusRequest('Remote Fleet credential name is not supported.');
  }
  if (!isRecord(rawRequest.input.credentialRef)
    || rawRequest.input.credentialRef.kind !== 'secret-ref'
    || !isValidRemoteFleetCredentialRef(rawRequest.input.credentialRef.ref)) {
    return invalidCredentialWriteStatusRequest('Remote Fleet credential reference is not valid.');
  }

  return {
    resultType: 'valid',
    request: {
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD,
      requestId,
      input: {
        operationId,
        credentialName,
        credentialRef: {
          kind: 'secret-ref',
          ref: rawRequest.input.credentialRef.ref,
        },
      },
    },
  };
}

export function isRemoteFleetWritableCredentialName(value: string): value is RemoteFleetWritableCredentialName {
  return REMOTE_FLEET_WRITABLE_CREDENTIAL_NAMES.has(value);
}

export function isValidRemoteFleetCredentialPathSegment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value);
}

function invalidCredentialWriteRequest(message: string): RemoteFleetCredentialWriteRequestValidationResult {
  return { resultType: 'invalidRequest', message };
}

function invalidCredentialWriteStatusRequest(message: string): RemoteFleetCredentialWriteStatusRequestValidationResult {
  return { resultType: 'invalidRequest', message };
}

function validateKnownFields(
  record: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  label: string,
): { readonly resultType: 'invalidRequest'; readonly message: string } | undefined {
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      return invalidCredentialWriteRequest(`Unknown ${label} field "${field}".`);
    }
  }
  return undefined;
}

function readString(record: Record<string, unknown>, field: string, limit: number): string | undefined {
  const value = record[field];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= limit ? trimmed : undefined;
}

function readPlaintextValue(record: Record<string, unknown>, field: string, limit: number): string | undefined {
  const value = record[field];
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim().length > 0 && value.length <= limit ? value : undefined;
}

function isValidRemoteFleetCredentialRef(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = /^remote-fleet:\/\/credentials\/([^/]+)\/([^/]+)$/.exec(value);
  return match !== null
    && isValidRemoteFleetCredentialPathSegment(match[1]!)
    && isRemoteFleetWritableCredentialName(match[2]!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
