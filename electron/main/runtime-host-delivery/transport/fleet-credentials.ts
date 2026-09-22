import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from './client';

const CREDENTIAL_NAMES = new Set<RemoteFleetCredentialName>([
  'sshPassword',
  'sshPrivateKey',
  'dockerBearerToken',
  'kubeBearerToken',
]);
const PATH = '/api/fleet/credentials/write';
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

export type FleetCredentialsTransport = Readonly<{
  write(input: unknown): Promise<RemoteFleetCredentialWriteReceipt>;
}>;

export type RemoteFleetCredentialWriteAdapter = (
  input: unknown,
) => Promise<RemoteFleetCredentialWriteReceipt>;

export function createFleetCredentialsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): FleetCredentialsTransport {
  return {
    async write(input): Promise<RemoteFleetCredentialWriteReceipt> {
      return await writeFleetCredential({ issuer, runtimeHostTransportPort, fetcher }, input);
    },
  };
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
  transport: Readonly<{
    issuer: RuntimeHostDeliveryIssuer;
    runtimeHostTransportPort: number;
    fetcher: typeof fetch;
  }>,
  input: unknown,
): Promise<RemoteFleetCredentialWriteReceipt> {
  if (!isRemoteFleetCredentialWriteInput(input)) {
    throw invalidRequestError();
  }

  const response = await sendLoopbackJson({
    port: transport.runtimeHostTransportPort,
    path: PATH,
    issuer: transport.issuer,
    decision: {
      endpoint: PATH,
      scope: 'fleet:credentials:write',
      capability: 'fleet.credentials.write',
      subject: 'fleet.credentials',
    },
    method: 'POST',
    fetcher: transport.fetcher,
    body: input,
  });

  if (!response) {
    throw unavailableError();
  }
  if (response.status === 400) {
    throw invalidRequestError();
  }
  if (response.status === 409) {
    throw conflictError();
  }
  if (response.status !== 200) {
    throw unavailableError();
  }

  const receipt = decodeReceipt(response.body, input);
  if (!receipt) {
    throw new RemoteFleetCredentialWriteError(
      'unavailable',
      503,
      INVALID_RECEIPT_MESSAGE,
    );
  }
  return receipt;
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
