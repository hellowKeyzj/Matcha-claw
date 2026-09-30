import type { CallReceipt } from './call-log';
import { decodeCallReceipt } from './call-log/receipt';
import type { CloudPackageVersion } from './cloud-package';

export type CloudPackageOperationKind = 'download' | 'install' | 'uploadSealedAgent' | 'confirmSealedSkillUpload';
export type CloudPackageDownloadInput = Readonly<{
  packageVersionId: string;
  packageType?: string;
  filename?: string;
  clientVersion?: string;
  installId?: string;
  source?: string;
}>;
export type CloudPackageOperationRequests = {
  download: CloudPackageDownloadInput;
  install: CloudPackageDownloadInput;
  uploadSealedAgent: Readonly<{ agentId: string }>;
  confirmSealedSkillUpload: Readonly<{ callId: string }>;
};
export type CloudPackageDownloadResult = Readonly<{
  packageVersionId: string;
  filename: string;
  contentType?: string;
  bytes: number;
  packageSha256: string;
}>;
export type CloudPackageOperationResults = {
  download: CloudPackageDownloadResult;
  install: CloudPackageDownloadResult & Readonly<{ install: CallReceipt }>;
  uploadSealedAgent: CloudPackageVersion;
  confirmSealedSkillUpload: CloudPackageVersion;
};
export type CloudPackageOperationReceipt = Readonly<{ operationId: string; accepted: true }>;
export type CloudPackageOperationErrorCode = 'unauthenticated' | 'sessionChanged' | 'queueFull'
  | 'exportUnconfirmed' | 'artifactUnavailable' | 'artifactInvalid' | 'nativeRejected'
  | 'outcomeUnknown' | 'cloudRejected' | 'unavailable';
export type CloudPackageOperationError = Readonly<{
  code: CloudPackageOperationErrorCode;
  message: string;
  status: number;
}>;
export type CloudPackageOperationResult<K extends CloudPackageOperationKind = CloudPackageOperationKind> =
  K extends CloudPackageOperationKind ? Readonly<{ operationId: string; kind: K }> & (
    | Readonly<{ state: 'pending' }>
    | Readonly<{ state: 'succeeded'; result: CloudPackageOperationResults[K] }>
    | Readonly<{ state: 'failed'; error: CloudPackageOperationError }>
  ) : never;

export function isCloudPackageOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^cloud-package:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

export function decodeCloudPackageOperationReceipt(value: unknown): CloudPackageOperationReceipt {
  if (!record(value) || !keys(value, ['operationId', 'accepted'])
    || !isCloudPackageOperationId(value.operationId) || value.accepted !== true) throw new Error('Invalid cloud package operation receipt');
  return { operationId: value.operationId, accepted: true };
}

export function decodeCloudPackageOperationResult<K extends CloudPackageOperationKind>(
  value: unknown, operationId: string, kind: K,
): CloudPackageOperationResult<K> {
  if (!record(value) || value.operationId !== operationId || value.kind !== kind) throw new Error('Cloud package operation identity mismatch');
  if (value.state === 'pending' && keys(value, ['operationId', 'kind', 'state'])) return value as CloudPackageOperationResult<K>;
  if (value.state === 'failed' && keys(value, ['operationId', 'kind', 'state', 'error']) && validError(value.error)) return value as CloudPackageOperationResult<K>;
  if (value.state !== 'succeeded' || !keys(value, ['operationId', 'kind', 'state', 'result']) || !record(value.result)) throw new Error('Invalid cloud package operation result');
  const result = value.result;
  if (kind === 'download' || kind === 'install') {
    if (!allowedKeys(result, ['packageVersionId', 'filename', 'bytes', 'packageSha256', ...(kind === 'install' ? ['install'] : [])], ['contentType'])
      || !text(result.packageVersionId) || !text(result.filename) || !integer(result.bytes)
      || typeof result.packageSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(result.packageSha256)
      || (result.contentType !== undefined && !text(result.contentType))) throw new Error('Invalid cloud package download result');
    if (kind === 'install') decodeCallReceipt(result.install);
  } else if (!validVersion(result)) throw new Error('Invalid cloud package upload result');
  return value as CloudPackageOperationResult<K>;
}

function validError(value: unknown): value is CloudPackageOperationError {
  return record(value) && keys(value, ['code', 'message', 'status'])
    && ['unauthenticated', 'sessionChanged', 'queueFull', 'exportUnconfirmed', 'artifactUnavailable', 'artifactInvalid', 'nativeRejected', 'outcomeUnknown', 'cloudRejected', 'unavailable'].includes(String(value.code))
    && text(value.message) && integer(value.status) && value.status >= 400 && value.status <= 599;
}
function validVersion(value: Record<string, unknown>): boolean {
  return allowedKeys(value, ['packageId', 'packageVersionId', 'name', 'packageType', 'version', 'status', 'downloadable'], ['displayName', 'description', 'entitlementStatus', 'meteringBinding', 'downloadCount', 'createdAt', 'updatedAt'])
    && ['packageId', 'packageVersionId', 'name', 'packageType', 'version', 'status'].every((key) => text(value[key]))
    && typeof value.downloadable === 'boolean'
    && ['displayName', 'description', 'entitlementStatus', 'createdAt', 'updatedAt'].every((key) => value[key] === undefined || typeof value[key] === 'string')
    && (value.downloadCount === undefined || integer(value.downloadCount))
    && (value.meteringBinding === undefined || validMeteringBinding(value.meteringBinding));
}
function validMeteringBinding(value: unknown): boolean {
  return record(value) && allowedKeys(value, [], ['id', 'type', 'unit', 'amount', 'currency'])
    && ['id', 'type', 'unit', 'currency'].every((key) => value[key] === undefined || typeof value[key] === 'string')
    && (value.amount === undefined || (typeof value.amount === 'number' && Number.isFinite(value.amount)));
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: string[]): boolean { return Object.keys(value).length === required.length && required.every((key) => Object.hasOwn(value, key)); }
function allowedKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean { return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !value.includes('\0'); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
