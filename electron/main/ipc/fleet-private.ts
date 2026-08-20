import { ipcMain } from 'electron';
import type { DirectRuntimeHost } from '../runtime-host-delivery/direct-host';

const CREDENTIAL_NAMES = new Set<RemoteFleetCredentialName>([
  'sshPassword',
  'sshPrivateKey',
  'dockerBearerToken',
  'kubeBearerToken',
]);
const CONFLICT_MESSAGE = 'Fleet credential operation conflicts with an existing receipt.';
const INVALID_MESSAGE = 'Fleet credential request is invalid';
const UNAVAILABLE_MESSAGE = 'Fleet credential writer is unavailable';
const INVALID_RECEIPT_MESSAGE = 'Fleet credential writer returned an invalid receipt';
const MAX_IDENTIFIER_BYTES = 128;
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_TIMESTAMP_BYTES = 128;

export type RemoteFleetCredentialName =
  | 'sshPassword'
  | 'sshPrivateKey'
  | 'dockerBearerToken'
  | 'kubeBearerToken';

export type RemoteFleetCredentialWriteInput = Readonly<{
  operationId: string;
  credentialId: string;
  credentialName: RemoteFleetCredentialName;
  plaintextValue: string;
}>;

export type RemoteFleetCredentialRef = Readonly<{
  kind: 'secret-ref';
  ref: string;
}>;

export type RemoteFleetCredentialWriteReceipt = Readonly<{
  operationId: string;
  credentialName: RemoteFleetCredentialName;
  credentialRef: RemoteFleetCredentialRef;
  writtenAt: string;
}>;

export type RemoteFleetCredentialWriteErrorKind = 'invalid' | 'conflict' | 'unavailable';
export type RemoteFleetCredentialWriteErrorStatus = 400 | 409 | 503;

export class RemoteFleetCredentialWriteError extends Error {
  readonly name = 'RemoteFleetCredentialWriteError';

  constructor(
    readonly kind: RemoteFleetCredentialWriteErrorKind,
    readonly status: RemoteFleetCredentialWriteErrorStatus,
    message: string,
  ) {
    super(message);
  }
}

export type RemoteFleetCredentialRuntimeHost = Pick<DirectRuntimeHost, 'command'>;
export type RemoteFleetCredentialWriteAdapter = (
  input: unknown,
) => Promise<RemoteFleetCredentialWriteReceipt>;

export function createFleetCredentialWriteAdapter(
  runtimeHost: RemoteFleetCredentialRuntimeHost,
): RemoteFleetCredentialWriteAdapter {
  return (input) => writeFleetCredential(runtimeHost, input);
}

export function isRemoteFleetCredentialWriteError(
  value: unknown,
): value is RemoteFleetCredentialWriteError {
  return value instanceof RemoteFleetCredentialWriteError;
}

export function isRemoteFleetCredentialWriteInput(
  value: unknown,
): value is RemoteFleetCredentialWriteInput {
  if (!isRecord(value) || !hasExactKeys(value, ['operationId', 'credentialId', 'credentialName', 'plaintextValue'])) {
    return false;
  }
  return isIdentifier(value.operationId)
    && isIdentifier(value.credentialId)
    && isCredentialName(value.credentialName)
    && isPlaintext(value.plaintextValue);
}

export async function writeFleetCredential(
  runtimeHost: RemoteFleetCredentialRuntimeHost,
  input: unknown,
): Promise<RemoteFleetCredentialWriteReceipt> {
  if (!isRemoteFleetCredentialWriteInput(input)) {
    throw invalidRequestError();
  }

  let outcome;
  try {
    outcome = await runtimeHost.command({
      name: 'fleet.credentials.write',
      input,
    });
  } catch {
    throw unavailableError();
  }

  if (outcome.kind === 'timed-out') {
    throw unavailableError();
  }
  if (outcome.kind === 'rejected') {
    throw errorForRejection(outcome.error.code, outcome.error.message);
  }
  const receipt = decodeReceipt(outcome.result, input);
  if (!receipt) {
    throw new RemoteFleetCredentialWriteError(
      'unavailable',
      503,
      INVALID_RECEIPT_MESSAGE,
    );
  }
  return receipt;
}

export function registerFleetPrivateHandlers(runtimeHost: RemoteFleetCredentialRuntimeHost): void {
  ipcMain.handle('fleet:writeCredential', async (_, input: unknown) => {
    return await writeFleetCredential(runtimeHost, input);
  });
}

function errorForRejection(
  code: 'INVALID_INPUT' | 'CAPACITY_EXHAUSTED' | 'UNAVAILABLE' | 'FAILED',
  message: string,
): RemoteFleetCredentialWriteError {
  if (code === 'INVALID_INPUT') return invalidRequestError();
  if (code === 'FAILED' && message === CONFLICT_MESSAGE) return conflictError();
  return unavailableError();
}

function decodeReceipt(
  value: unknown,
  input: RemoteFleetCredentialWriteInput,
): RemoteFleetCredentialWriteReceipt | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['credentialRef', 'operationId', 'credentialName', 'writtenAt'])) {
    return undefined;
  }
  const operationId = value.operationId;
  const credentialName = value.credentialName;
  const credentialRef = value.credentialRef;
  const writtenAt = value.writtenAt;
  if (operationId !== input.operationId
    || !isCredentialName(credentialName)
    || credentialName !== input.credentialName
    || typeof credentialRef !== 'string'
    || credentialRef !== expectedCredentialRef(input)
    || !isTimestamp(writtenAt)) {
    return undefined;
  }
  return {
    operationId,
    credentialName,
    credentialRef: { kind: 'secret-ref', ref: credentialRef },
    writtenAt,
  };
}

function expectedCredentialRef(input: RemoteFleetCredentialWriteInput): string {
  return `remote-fleet://credentials/${input.credentialId}/${input.credentialName}`;
}

function invalidRequestError(): RemoteFleetCredentialWriteError {
  return new RemoteFleetCredentialWriteError('invalid', 400, INVALID_MESSAGE);
}

function conflictError(): RemoteFleetCredentialWriteError {
  return new RemoteFleetCredentialWriteError('conflict', 409, CONFLICT_MESSAGE);
}

function unavailableError(): RemoteFleetCredentialWriteError {
  return new RemoteFleetCredentialWriteError('unavailable', 503, UNAVAILABLE_MESSAGE);
}

function isCredentialName(value: unknown): value is RemoteFleetCredentialName {
  return typeof value === 'string' && CREDENTIAL_NAMES.has(value as RemoteFleetCredentialName);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function isPlaintext(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_PLAINTEXT_BYTES
    && !value.includes('\0');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_TIMESTAMP_BYTES
    && !Number.isNaN(Date.parse(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
