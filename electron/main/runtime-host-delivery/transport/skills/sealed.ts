import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isBoundedText, isRecord, isSafeNonNegativeInteger as isTimestamp, sendLoopbackJson } from '../client';
import { isSkillsCallReceipt, type SkillsCallReceipt } from './management';
import { isCallId } from '../../../../../src/types/call-log/decode';

export const SEALED_SKILLS_ENDPOINTS = Object.freeze({
  status: '/api/sealed-skills/status',
  export: '/api/sealed-skills/export',
  exportCloud: '/api/sealed-skills/export-cloud',
  install: '/api/sealed-skills/install',
  uninstall: '/api/sealed-skills/uninstall',
});

type SealedSkillsEndpoint = typeof SEALED_SKILLS_ENDPOINTS[keyof typeof SEALED_SKILLS_ENDPOINTS];
type SealedSkillsStatus = 200 | 202 | 400 | 404 | 409 | 503;

export type SealedSkillsTransportFailure = Readonly<{
  outcome: 'rejected' | 'unknown';
  reason?: string;
  error?: string;
}>;

export type SealedSkillPackageEntry = Readonly<{
  skillKey: string;
  name: string;
  description?: string;
  version?: string;
  installed: boolean;
  publishable?: boolean;
  source?: string;
  runtimes?: string[];
  updatedAt?: number | null;
}>;

export type SealedSkillsStatusResult = Readonly<{
  skills: SealedSkillPackageEntry[];
  ready?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}>;

export type SealedSkillExportRequest = Readonly<{ skillKey: string }>;
export type SealedSkillCloudExportRequest = Readonly<{
  skillKey: string;
  cloudPublicKey: string;
  cloudKeyId: string;
}>;
export type SealedSkillInstallRequest = Readonly<{
  packagePath: string;
  cloudMetadata?: CloudPackageInstallMetadata;
}>;

export type CloudPackageInstallMetadata = Readonly<{
  packageVersionId: string;
  packageType: string;
  packageSha256: string;
  fileName: string;
}>;
export type SealedSkillUninstallRequest = Readonly<{ skillKey: string }>;

export type SealedSkillPackageMutationResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown' | 'notFound';
  skillKey?: string;
  reason?: string;
  error?: string;
}>;

export type SealedSkillCloudExportResult = Readonly<{
  callId: string;
  command: 'sealedSkills.exportCloud';
  result: Readonly<{
    kind: 'sealedCloudExport';
    skillKey: string;
    fileName: string;
    packageSha256: string;
    packageBase64: string;
  }>;
}>;

export type SealedSkillUninstallResult = Readonly<{
  outcome: 'removed' | 'notFound' | 'rejected' | 'unknown';
  skillKey?: string;
}>;

export type SealedSkillsTransportResponse<T> = Readonly<{
  status: Exclude<SealedSkillsStatus, 202 | 404>;
  body: T | SealedSkillsTransportFailure;
}> | Readonly<{ status: 202; body: SkillsCallReceipt }>
  | Readonly<{ status: 404; body: Readonly<{ outcome: 'notFound' }> }>;

export interface SealedSkillsTransport {
  readStatus(): Promise<SealedSkillsTransportResponse<SealedSkillsStatusResult>>;
  export(request: unknown): Promise<SealedSkillsTransportResponse<SealedSkillPackageMutationResult>>;
  exportCloud(request: unknown): Promise<SealedSkillsTransportResponse<SealedSkillPackageMutationResult>>;
  exportCloudResult(callId: string): Promise<SealedSkillsTransportResponse<SealedSkillCloudExportResult>>;
  install(request: unknown): Promise<SealedSkillsTransportResponse<SealedSkillPackageMutationResult>>;
  uninstall(request: unknown): Promise<SealedSkillsTransportResponse<SealedSkillUninstallResult>>;
}

export function createSealedSkillsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SealedSkillsTransport {
  return {
    readStatus: () => get(issuer, runtimeHostTransportPort, fetcher, SEALED_SKILLS_ENDPOINTS.status, 'sealed-skills:read', 'sealedSkills.status', 'sealed-skills-status', isSealedSkillsStatusResult),
    export: (request) => post(issuer, runtimeHostTransportPort, fetcher, SEALED_SKILLS_ENDPOINTS.export, request, 'sealed-skills:package', 'sealedSkills.export', 'sealed-skills-export', isSealedSkillExportRequest, isSealedSkillPackageMutationResult),
    exportCloud: (request) => post(issuer, runtimeHostTransportPort, fetcher, SEALED_SKILLS_ENDPOINTS.exportCloud, request, 'sealed-skills:package', 'sealedSkills.exportCloud', 'sealed-skills-export-cloud', isSealedSkillCloudExportRequest, isSealedSkillPackageMutationResult),
    async exportCloudResult(callId) {
      if (!isCallId(callId)) return rejectedResponse();
      const endpoint = '/api/sealed-skills/export-cloud/result';
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort, path: endpoint, issuer, method: 'POST', fetcher, body: { callId }, timeoutMs: 30_000,
        decision: { endpoint, scope: 'sealed-skills:package', capability: 'sealedSkills.exportCloud', subject: 'sealed-skills-export-cloud' },
      });
      if (response?.status === 200 && isSealedSkillCloudExportResult(response.body) && response.body.callId === callId) return { status: 200, body: response.body };
      if (response?.status === 404 && isNotFoundResult(response.body)) return { status: 404, body: response.body };
      return unknownResponse();
    },
    install: (request) => post(issuer, runtimeHostTransportPort, fetcher, SEALED_SKILLS_ENDPOINTS.install, request, 'sealed-skills:package', 'sealedSkills.install', 'sealed-skills-install', isSealedSkillInstallRequest, isSealedSkillPackageMutationResult),
    uninstall: (request) => post(issuer, runtimeHostTransportPort, fetcher, SEALED_SKILLS_ENDPOINTS.uninstall, request, 'sealed-skills:package', 'sealedSkills.uninstall', 'sealed-skills-uninstall', isSealedSkillUninstallRequest, isSealedSkillUninstallResult),
  };
}

async function get<T>(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  endpoint: SealedSkillsEndpoint,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SealedSkillsTransportResponse<T>> {
  return send(issuer, runtimeHostTransportPort, fetcher, endpoint, 'GET', undefined, scope, capability, subject, isSuccess);
}

async function post<T>(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  endpoint: SealedSkillsEndpoint,
  request: unknown,
  scope: string,
  capability: string,
  subject: string,
  isRequest: (value: unknown) => boolean,
  isSuccess: (value: unknown) => value is T,
): Promise<SealedSkillsTransportResponse<T>> {
  if (!isRequest(request)) {
    if (endpoint === SEALED_SKILLS_ENDPOINTS.export) traceExportTransport('request-invalid', request);
    return rejectedResponse();
  }
  if (endpoint === SEALED_SKILLS_ENDPOINTS.export) traceExportTransport('request-valid', request);
  return send(issuer, runtimeHostTransportPort, fetcher, endpoint, 'POST', request, scope, capability, subject, isSuccess);
}

async function send<T>(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  endpoint: SealedSkillsEndpoint,
  method: 'GET' | 'POST',
  request: unknown,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SealedSkillsTransportResponse<T>> {
  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path: endpoint,
    issuer,
    decision: { endpoint, scope, capability, subject },
    method,
    fetcher,
    ...(method === 'POST' ? { body: request } : {}),
    ...(endpoint === SEALED_SKILLS_ENDPOINTS.install ? { timeoutMs: 30_000 } : {}),
  });
  if (endpoint !== SEALED_SKILLS_ENDPOINTS.status && response?.status === 202 && isSkillsCallReceipt(response.body)) {
    return { status: 202, body: response.body };
  }
  if (endpoint === SEALED_SKILLS_ENDPOINTS.status && response?.status === 200 && isSuccess(response.body)) {
    return { status: 200, body: response.body };
  }
  if (response?.status === 404 && isSealedSkillsNotFoundEndpoint(endpoint) && isNotFoundResult(response.body)) {
    if (endpoint === SEALED_SKILLS_ENDPOINTS.export) traceExportTransportResponse('not-found', response.status, response.body);
    return { status: 404, body: response.body };
  }
  if (response !== null && isRejectedStatus(response.status) && isRejectedResult(response.body)) {
    if (endpoint === SEALED_SKILLS_ENDPOINTS.export) traceExportTransportResponse('rejected', response.status, response.body);
    return { status: response.status, body: response.body };
  }
  if (endpoint === SEALED_SKILLS_ENDPOINTS.export) traceExportTransportResponse(response === null ? 'no-response' : 'schema-mismatch', response?.status ?? 0, response?.body);
  return unknownResponse();
}

function traceExportTransport(detail: string, request: unknown): void {
  console.info('[startup-trace]', {
    source: 'sealed-skills-export',
    phase: 'transport',
    detail,
    skillKey: skillKeyFromRequest(request),
  });
}

function traceExportTransportResponse(detail: string, status: number, body: unknown): void {
  console.info('[startup-trace]', {
    source: 'sealed-skills-export',
    phase: 'transport',
    detail,
    status,
    outcome: outcomeFromResponse(body),
  });
}

function skillKeyFromRequest(request: unknown): string {
  if (!isRecord(request) || typeof request.skillKey !== 'string') return 'invalid';
  return request.skillKey.trim() || 'invalid';
}

function outcomeFromResponse(body: unknown): string {
  if (!isRecord(body) || typeof body.outcome !== 'string') return 'unknown';
  return body.outcome;
}

function isSealedSkillsStatusResult(value: unknown): value is SealedSkillsStatusResult {
  return hasOnlyKeys(value, ['skills', 'ready', 'updatedAt', 'error'])
    && hasRequiredKeys(value, ['skills'])
    && Array.isArray(value.skills)
    && value.skills.every(isSealedSkillPackageEntry)
    && (value.ready === undefined || typeof value.ready === 'boolean')
    && (value.updatedAt === undefined || value.updatedAt === null || isTimestamp(value.updatedAt))
    && (value.error === undefined || value.error === null || isBoundedText(value.error, 1_024));
}

function isSealedSkillPackageEntry(value: unknown): value is SealedSkillPackageEntry {
  return hasOnlyKeys(value, ['skillKey', 'name', 'description', 'version', 'installed', 'publishable', 'source', 'runtimes', 'updatedAt'])
    && hasRequiredKeys(value, ['skillKey', 'name', 'installed'])
    && isOpenClawSkillKey(value.skillKey)
    && isText(value.name, 256)
    && (value.description === undefined || isBoundedText(value.description, 8_192))
    && (value.version === undefined || isText(value.version, 128))
    && typeof value.installed === 'boolean'
    && (value.publishable === undefined || typeof value.publishable === 'boolean')
    && (value.source === undefined || isText(value.source, 128))
    && (value.runtimes === undefined || isRuntimeList(value.runtimes))
    && (value.updatedAt === undefined || value.updatedAt === null || isTimestamp(value.updatedAt));
}

function isSealedSkillExportRequest(value: unknown): value is SealedSkillExportRequest {
  return isRecord(value) && hasExactKeys(value, ['skillKey']) && isOpenClawSkillKey(value.skillKey);
}

function isSealedSkillCloudExportRequest(value: unknown): value is SealedSkillCloudExportRequest {
  return isRecord(value)
    && hasExactKeys(value, ['skillKey', 'cloudPublicKey', 'cloudKeyId'])
    && isOpenClawSkillKey(value.skillKey)
    && isText(value.cloudPublicKey, 8192)
    && isText(value.cloudKeyId, 512);
}

function isSealedSkillInstallRequest(value: unknown): value is SealedSkillInstallRequest {
  return isRecord(value)
    && hasAllowedKeys(value, ['packagePath', 'cloudMetadata'], ['packagePath'])
    && isPackagePath(value.packagePath)
    && (value.cloudMetadata === undefined || isCloudPackageInstallMetadata(value.cloudMetadata));
}

function isCloudPackageInstallMetadata(value: unknown): value is CloudPackageInstallMetadata {
  return isRecord(value)
    && hasAllowedKeys(value, ['packageVersionId', 'packageType', 'packageSha256', 'fileName'], ['packageVersionId', 'packageType', 'packageSha256', 'fileName'])
    && isText(value.packageVersionId, 512)
    && isText(value.packageType, 128)
    && isPackageSha256(value.packageSha256)
    && isText(value.fileName, 512);
}

function isPackageSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isSealedSkillUninstallRequest(value: unknown): value is SealedSkillUninstallRequest {
  return isRecord(value) && hasExactKeys(value, ['skillKey']) && isOpenClawSkillKey(value.skillKey);
}

function isSealedSkillPackageMutationResult(value: unknown): value is SealedSkillPackageMutationResult {
  return hasOnlyKeys(value, ['outcome', 'skillKey', 'reason', 'error'])
    && hasRequiredKeys(value, ['outcome'])
    && isPackageOutcome(value.outcome)
    && (value.skillKey === undefined || isOpenClawSkillKey(value.skillKey))
    && (value.reason === undefined || isText(value.reason, 128))
    && (value.error === undefined || isBoundedText(value.error, 512));
}

function isSealedSkillCloudExportResult(value: unknown): value is SealedSkillCloudExportResult {
  if (!isRecord(value) || !hasExactKeys(value, ['callId', 'command', 'result'])
    || !isCallId(value.callId) || value.command !== 'sealedSkills.exportCloud' || !isRecord(value.result)) return false;
  const result = value.result;
  return hasExactKeys(result, ['kind', 'skillKey', 'fileName', 'packageSha256', 'packageBase64'])
    && result.kind === 'sealedCloudExport' && isOpenClawSkillKey(result.skillKey)
    && isText(result.fileName, 512) && !/[\\/\\\\\0]/.test(result.fileName) && result.fileName.endsWith('.matcha-skillpkg')
    && isPackageSha256(result.packageSha256)
    && typeof result.packageBase64 === 'string' && result.packageBase64.length > 0
    && result.packageBase64.length <= 13_981_016 && result.packageBase64.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(result.packageBase64);
}

function isSealedSkillUninstallResult(value: unknown): value is SealedSkillUninstallResult {
  return hasOnlyKeys(value, ['outcome', 'skillKey'])
    && hasRequiredKeys(value, ['outcome'])
    && (value.outcome === 'removed' || value.outcome === 'notFound' || value.outcome === 'rejected' || value.outcome === 'unknown')
    && (value.skillKey === undefined || isOpenClawSkillKey(value.skillKey));
}

function isRejectedResult(value: unknown): value is SealedSkillsTransportFailure {
  return isRecord(value)
    && hasOnlyKeys(value, ['outcome', 'reason', 'error'])
    && value.outcome === 'rejected'
    && (value.reason === undefined || isText(value.reason, 128))
    && (value.error === undefined || isBoundedText(value.error, 512));
}

function isNotFoundResult(value: unknown): value is Readonly<{ outcome: 'notFound' }> {
  return isRecord(value) && hasExactKeys(value, ['outcome']) && value.outcome === 'notFound';
}

function isSealedSkillsNotFoundEndpoint(endpoint: SealedSkillsEndpoint): boolean {
  return endpoint === SEALED_SKILLS_ENDPOINTS.export
    || endpoint === SEALED_SKILLS_ENDPOINTS.exportCloud
    || endpoint === SEALED_SKILLS_ENDPOINTS.install
    || endpoint === SEALED_SKILLS_ENDPOINTS.uninstall;
}

function isRejectedStatus(value: number): value is 400 | 409 {
  return value === 400 || value === 409;
}

function isPackageOutcome(value: unknown): value is SealedSkillPackageMutationResult['outcome'] {
  return value === 'accepted' || value === 'rejected' || value === 'unknown';
}

function isOpenClawSkillKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');
}

function isPackagePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4 * 1024
    && !value.includes('\0')
    && value.endsWith('.matcha-skillpkg');
}

function isRuntimeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isText(item, 128));
}

function isText(value: unknown, maxLength: number): value is string {
  return isBoundedText(value, maxLength) && value.length > 0;
}

function rejectedResponse<T>(): SealedSkillsTransportResponse<T> {
  return { status: 400, body: { outcome: 'rejected' } };
}

function unknownResponse<T>(): SealedSkillsTransportResponse<T> {
  return { status: 503, body: { outcome: 'unknown' } };
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  return hasOnlyKeys(value, allowed) && required.every((key) => Object.hasOwn(value, key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}
