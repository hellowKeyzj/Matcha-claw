import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;

export const SEALED_SKILLS_ENDPOINTS = Object.freeze({
  status: '/api/sealed-skills/status',
  export: '/api/sealed-skills/export',
  install: '/api/sealed-skills/install',
  uninstall: '/api/sealed-skills/uninstall',
});

type SealedSkillsEndpoint = typeof SEALED_SKILLS_ENDPOINTS[keyof typeof SEALED_SKILLS_ENDPOINTS];
type SealedSkillsStatus = 200 | 400 | 404 | 409 | 503;

export type SealedSkillsTransportFailure = Readonly<{
  outcome: 'rejected' | 'unknown';
}>;

export type SealedSkillPackageEntry = Readonly<{
  skillKey: string;
  name: string;
  description?: string;
  version?: string;
  packagePath?: string;
  installed: boolean;
  enabled: boolean;
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
export type SealedSkillInstallRequest = Readonly<{ packagePath: string }>;
export type SealedSkillUninstallRequest = Readonly<{ skillKey: string }>;

export type SealedSkillPackageMutationResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown' | 'notFound';
  skillKey?: string;
  packagePath?: string;
}>;

export type SealedSkillUninstallResult = Readonly<{
  outcome: 'removed' | 'notFound' | 'rejected' | 'unknown';
  skillKey?: string;
}>;

export type SealedSkillsTransportResponse<T> = Readonly<{
  status: SealedSkillsStatus;
  body: T | SealedSkillsTransportFailure;
}>;

export interface SealedSkillsTransport {
  readStatus(): Promise<SealedSkillsTransportResponse<SealedSkillsStatusResult>>;
  export(request: unknown): Promise<SealedSkillsTransportResponse<SealedSkillPackageMutationResult>>;
  install(request: unknown): Promise<SealedSkillsTransportResponse<SealedSkillPackageMutationResult>>;
  uninstall(request: unknown): Promise<SealedSkillsTransportResponse<SealedSkillUninstallResult>>;
}

export function createSealedSkillsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): SealedSkillsTransport {
  return {
    readStatus: () => get(issuer, port, fetcher, SEALED_SKILLS_ENDPOINTS.status, 'sealed-skills:read', 'sealedSkills.status', 'sealed-skills-status', isSealedSkillsStatusResult),
    export: (request) => post(issuer, port, fetcher, SEALED_SKILLS_ENDPOINTS.export, request, 'sealed-skills:package', 'sealedSkills.export', 'sealed-skills-export', isSealedSkillExportRequest, isSealedSkillPackageMutationResult),
    install: (request) => post(issuer, port, fetcher, SEALED_SKILLS_ENDPOINTS.install, request, 'sealed-skills:package', 'sealedSkills.install', 'sealed-skills-install', isSealedSkillInstallRequest, isSealedSkillPackageMutationResult),
    uninstall: (request) => post(issuer, port, fetcher, SEALED_SKILLS_ENDPOINTS.uninstall, request, 'sealed-skills:package', 'sealedSkills.uninstall', 'sealed-skills-uninstall', isSealedSkillUninstallRequest, isSealedSkillUninstallResult),
  };
}

async function get<T>(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
  endpoint: SealedSkillsEndpoint,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SealedSkillsTransportResponse<T>> {
  return send(issuer, port, fetcher, endpoint, 'GET', undefined, scope, capability, subject, isSuccess);
}

async function post<T>(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
  endpoint: SealedSkillsEndpoint,
  request: unknown,
  scope: string,
  capability: string,
  subject: string,
  isRequest: (value: unknown) => boolean,
  isSuccess: (value: unknown) => value is T,
): Promise<SealedSkillsTransportResponse<T>> {
  if (!isRequest(request)) return rejectedResponse();
  return send(issuer, port, fetcher, endpoint, 'POST', request, scope, capability, subject, isSuccess);
}

async function send<T>(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
  endpoint: SealedSkillsEndpoint,
  method: 'GET' | 'POST',
  request: unknown,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SealedSkillsTransportResponse<T>> {
  try {
    const response = await fetcher(`http://127.0.0.1:${port}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint,
          scope,
          capability,
          subject,
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(request) } : {}),
    });
    const body: unknown = await response.json();
    if (response.status === 200 && isSuccess(body)) return { status: 200, body };
    if (response.status === 404 && isSealedSkillsNotFoundEndpoint(endpoint) && isNotFoundResult(body)) {
      return { status: 404, body };
    }
    if (isRejectedStatus(response.status) && isRejectedResult(body)) return { status: response.status, body };
  } catch {
    // Public Delivery never exposes loopback errors, native errors, plaintext, secrets, or paths.
  }
  return unknownResponse();
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
  return hasOnlyKeys(value, ['skillKey', 'name', 'description', 'version', 'packagePath', 'installed', 'enabled', 'publishable', 'source', 'runtimes', 'updatedAt'])
    && hasRequiredKeys(value, ['skillKey', 'name', 'installed', 'enabled'])
    && isOpenClawSkillKey(value.skillKey)
    && isText(value.name, 256)
    && (value.description === undefined || isBoundedText(value.description, 8_192))
    && (value.version === undefined || isText(value.version, 128))
    && (value.packagePath === undefined || isPackagePath(value.packagePath))
    && typeof value.installed === 'boolean'
    && typeof value.enabled === 'boolean'
    && (value.publishable === undefined || typeof value.publishable === 'boolean')
    && (value.source === undefined || isText(value.source, 128))
    && (value.runtimes === undefined || isRuntimeList(value.runtimes))
    && (value.updatedAt === undefined || value.updatedAt === null || isTimestamp(value.updatedAt));
}

function isSealedSkillExportRequest(value: unknown): value is SealedSkillExportRequest {
  return hasExactKeys(value, ['skillKey']) && isOpenClawSkillKey(value.skillKey);
}

function isSealedSkillInstallRequest(value: unknown): value is SealedSkillInstallRequest {
  return hasExactKeys(value, ['packagePath']) && isPackagePath(value.packagePath);
}

function isSealedSkillUninstallRequest(value: unknown): value is SealedSkillUninstallRequest {
  return hasExactKeys(value, ['skillKey']) && isOpenClawSkillKey(value.skillKey);
}

function isSealedSkillPackageMutationResult(value: unknown): value is SealedSkillPackageMutationResult {
  return hasOnlyKeys(value, ['outcome', 'skillKey', 'packagePath'])
    && hasRequiredKeys(value, ['outcome'])
    && isPackageOutcome(value.outcome)
    && (value.skillKey === undefined || isOpenClawSkillKey(value.skillKey))
    && (value.packagePath === undefined || isPackagePath(value.packagePath));
}

function isSealedSkillUninstallResult(value: unknown): value is SealedSkillUninstallResult {
  return hasOnlyKeys(value, ['outcome', 'skillKey'])
    && hasRequiredKeys(value, ['outcome'])
    && (value.outcome === 'removed' || value.outcome === 'notFound' || value.outcome === 'rejected' || value.outcome === 'unknown')
    && (value.skillKey === undefined || isOpenClawSkillKey(value.skillKey));
}

function isRejectedResult(value: unknown): value is SealedSkillsTransportFailure {
  return hasExactKeys(value, ['outcome']) && value.outcome === 'rejected';
}

function isNotFoundResult(value: unknown): value is Readonly<{ outcome: 'notFound' }> {
  return hasExactKeys(value, ['outcome']) && value.outcome === 'notFound';
}

function isSealedSkillsNotFoundEndpoint(endpoint: SealedSkillsEndpoint): boolean {
  return endpoint === SEALED_SKILLS_ENDPOINTS.export
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

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0');
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function rejectedResponse<T>(): SealedSkillsTransportResponse<T> {
  return { status: 400, body: { outcome: 'rejected' } };
}

function unknownResponse<T>(): SealedSkillsTransportResponse<T> {
  return { status: 503, body: { outcome: 'unknown' } };
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
