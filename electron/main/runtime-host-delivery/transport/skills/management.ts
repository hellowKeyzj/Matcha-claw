import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isBoundedText, isRecord, isSafeNonNegativeInteger as isTimestamp, sendLoopbackJson } from '../client';

export const SKILLS_ENDPOINTS = Object.freeze({
  status: '/api/skills/status',
  detail: '/api/skills/detail',
  config: '/api/skills/config',
  clawHubInstall: '/api/skills/clawhub/install',
  clawHubUpdate: '/api/skills/clawhub/update',
  uploadBegin: '/api/skills/upload/begin',
  uploadChunk: '/api/skills/upload/chunk',
  uploadCommit: '/api/skills/upload/commit',
  uninstall: '/api/skills/uninstall',
  importMarkdown: '/api/skills/import/markdown',
  importBundle: '/api/skills/import/bundle',
  readme: '/api/skills/readme',
});

type SkillsEndpoint = typeof SKILLS_ENDPOINTS[keyof typeof SKILLS_ENDPOINTS];
type SkillsStatus = 200 | 400 | 404 | 503;
type SkillCapabilityOperation =
  | 'skills.refreshStatus'
  | 'skills.updateConfig'
  | 'skills.updateState'
  | 'skills.updateBatchState'
  | 'skills.exportBundles'
  | 'skills.importBundles'
  | 'clawhub.openReadme'
  | 'clawhub.openPath';

type SkillCapabilityRequest = Readonly<{
  id: 'skill.management';
  operationId: SkillCapabilityOperation;
  scope: Record<string, unknown>;
  target: Record<string, unknown>;
  input: Record<string, unknown>;
}>;

export type SkillsTransportFailure = Readonly<{
  outcome: 'rejected' | 'unknown';
}>;

const CAPABILITY_EXECUTE_ENDPOINT = '/api/skills/capability/execute';
const CAPABILITY_REJECTED = { outcome: 'rejected' } as const;
const SKILL_MANAGEMENT_UNAVAILABLE = { outcome: 'unknown' } as const;

export type SkillsSafeSource = string;

export type SkillMissingCategory = 'binaries' | 'anyBinaries' | 'environment' | 'configuration' | 'operatingSystem';

export type SkillUnavailableReason = 'disabled' | 'missingRequirements' | 'ineligible';

export type NativeSkillStatusEntry = Readonly<{
  key: string;
  slug?: string;
  name: string;
  description: string;
  enabled: boolean;
  selectable: boolean;
  unavailableReason: SkillUnavailableReason | null;
  missingCategories: SkillMissingCategory[];
  eligible: boolean;
  uninstallable?: boolean;
  bundled?: boolean;
  always?: boolean;
  emoji?: string;
  source?: SkillsSafeSource;
  baseDir?: string;
  filePath?: string;
}>;

export type NativeSkillsStatusResult = Readonly<{
  skills: NativeSkillStatusEntry[];
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}>;

type SkillMissingProjection = Readonly<Partial<{
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}>>;

export type SkillStatusEntry = Readonly<{
  skillKey: string;
  slug?: string;
  name: string;
  description: string;
  disabled: boolean;
  selectable: boolean;
  unavailableReason: SkillUnavailableReason | null;
  eligible: boolean;
  missingCategories: SkillMissingCategory[];
  missing?: SkillMissingProjection;
  uninstallable?: boolean;
  bundled?: boolean;
  always?: boolean;
  emoji?: string;
  source?: SkillsSafeSource;
  baseDir?: string;
  filePath?: string;
}>;

export type SkillsStatusResult = Readonly<{
  skills: SkillStatusEntry[];
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}>;
export type SkillsDetailRequest = Readonly<{ slug: string }>;
export type SkillsDetailResult = Readonly<{
  skill: Readonly<{
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  }> | null;
  latestVersion?: Readonly<{
    version: string;
    createdAt: number;
    changelog?: string;
  }> | null;
  metadata?: Readonly<{
    os?: string[] | null;
    systems?: string[] | null;
  }> | null;
  owner?: Readonly<{
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  }> | null;
}>;
export type SkillsConfigMutationRequest = Readonly<{
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}>;
export type ClawHubSkillInstallRequest = Readonly<{
  slug: string;
  version?: string;
  force?: boolean;
}>;
export type ClawHubSkillUpdateRequest = Readonly<{
  slug?: string;
  all?: boolean;
}>;
export type SkillsUploadBeginRequest = Readonly<{
  kind: 'skill-archive';
  slug: string;
  sizeBytes: number;
  sha256: string;
  idempotencyKey?: string;
}>;
export type SkillsUploadChunkRequest = Readonly<{
  uploadId: string;
  offset: number;
  dataBase64: string;
}>;
export type SkillsUploadCommitRequest = Readonly<{
  uploadId: string;
  sha256?: string;
}>;
export type SkillsMutationResult = Readonly<{ outcome: 'accepted' | 'rejected' | 'unknown' }>;
export type SkillsUploadBeginResult = Readonly<{
  uploadId: string;
  receivedBytes: number;
  expiresAt: number;
}>;
export type SkillsUploadChunkResult = Readonly<{
  uploadId: string;
  receivedBytes: number;
  expiresAt: number;
}>;
export type SkillsUploadCommitResult = Readonly<{
  uploadId: string;
  receivedBytes: number;
  sha256: string;
  expiresAt: number;
}>;
export type SkillsUninstallRequest = Readonly<{ skillKey: string; slug?: string }>;
export type SkillsUninstallResult = Readonly<{ outcome: 'removed' | 'notFound' | 'rejected' | 'unknown' }>;
export type SkillsImportMarkdownRequest = Readonly<{ content: string }>;
export type SkillsImportBundleRequest = Readonly<{ skillKey: string; files: Array<Readonly<{ path: string; content: string }>> }>;
export type SkillsReadmeRequest = Readonly<{
  skillKey: string;
  slug?: string;
  filePath?: string;
  baseDir?: string;
}>;
export type SkillsReadmeResult = Readonly<{
  success: true;
  content: string;
  filePath: string;
}>;

export type SkillsTransportResponse<T> = Readonly<{
  status: SkillsStatus;
  body: T | SkillsTransportFailure;
}>;
export type SkillsStatusTransportResponse = SkillsTransportResponse<SkillsStatusResult>;
export type SkillsDetailTransportResponse = SkillsTransportResponse<SkillsDetailResult>;
export type SkillsConfigMutationTransportResponse = SkillsTransportResponse<SkillsMutationResult>;
export type ClawHubSkillInstallTransportResponse = SkillsTransportResponse<SkillsMutationResult>;
export type ClawHubSkillUpdateTransportResponse = SkillsTransportResponse<SkillsMutationResult>;
export type SkillsUploadBeginTransportResponse = SkillsTransportResponse<SkillsUploadBeginResult>;
export type SkillsUploadChunkTransportResponse = SkillsTransportResponse<SkillsUploadChunkResult>;
export type SkillsUploadCommitTransportResponse = SkillsTransportResponse<SkillsUploadCommitResult>;
export type SkillsReadmeTransportResponse = SkillsTransportResponse<SkillsReadmeResult>;
export type SkillCapabilityTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: unknown;
}>;

export interface SkillsManagementTransport {
  execute(request: unknown): Promise<SkillCapabilityTransportResponse>;
  readStatus(): Promise<SkillsStatusTransportResponse>;
  detail(request: unknown): Promise<SkillsDetailTransportResponse>;
  mutateConfig(request: unknown): Promise<SkillsConfigMutationTransportResponse>;
  installClawHub(request: unknown): Promise<ClawHubSkillInstallTransportResponse>;
  updateClawHub(request: unknown): Promise<ClawHubSkillUpdateTransportResponse>;
  beginUpload(request: unknown): Promise<SkillsUploadBeginTransportResponse>;
  appendUploadChunk(request: unknown): Promise<SkillsUploadChunkTransportResponse>;
  commitUpload(request: unknown): Promise<SkillsUploadCommitTransportResponse>;
  uninstall(request: unknown): Promise<SkillsTransportResponse<SkillsUninstallResult>>;
  importMarkdown(request: unknown): Promise<SkillsTransportResponse<SkillsMutationResult>>;
  importBundle(request: unknown): Promise<SkillsTransportResponse<SkillsMutationResult>>;
  readme(request: unknown): Promise<SkillsReadmeTransportResponse>;
}

export function createSkillsManagementTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SkillsManagementTransport {
  return {
    execute: (request) => executeCapability(issuer, runtimeHostTransportPort, fetcher, request),
    readStatus: () => readStatus(issuer, runtimeHostTransportPort, fetcher),
    detail: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.detail, request, 'skills:read', 'skills.detail', 'skills-detail', isSkillsDetailRequest, isSkillsDetailResult),
    mutateConfig: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.config, request, 'skills:config:write', 'skills.config.update', 'skills-config', isSkillsConfigMutationRequest, isSkillsMutationResult),
    installClawHub: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.clawHubInstall, request, 'skills:install', 'skills.install', 'skills-clawhub-install', isClawHubSkillInstallRequest, isSkillsMutationResult),
    updateClawHub: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.clawHubUpdate, request, 'skills:update', 'skills.update', 'skills-clawhub-update', isClawHubSkillUpdateRequest, isSkillsMutationResult),
    beginUpload: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.uploadBegin, request, 'skills:upload', 'skills.upload.begin', 'skills-upload-begin', isSkillsUploadBeginRequest, isSkillsUploadBeginResult),
    appendUploadChunk: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.uploadChunk, request, 'skills:upload', 'skills.upload.chunk', 'skills-upload-chunk', isSkillsUploadChunkRequest, isSkillsUploadChunkResult),
    commitUpload: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.uploadCommit, request, 'skills:upload', 'skills.upload.commit', 'skills-upload-commit', isSkillsUploadCommitRequest, isSkillsUploadCommitResult),
    uninstall: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.uninstall, request, 'skills:uninstall', 'skills.uninstall', 'skills-uninstall', isSkillsUninstallRequest, isSkillsUninstallResult),
    importMarkdown: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.importMarkdown, request, 'skills:import', 'skills.import.markdown', 'skills-import-markdown', isSkillsImportMarkdownRequest, isSkillsMutationResult),
    importBundle: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.importBundle, request, 'skills:import', 'skills.import.bundle', 'skills-import-bundle', isSkillsImportBundleRequest, isSkillsMutationResult),
    readme: (request) => post(issuer, runtimeHostTransportPort, fetcher, SKILLS_ENDPOINTS.readme, request, 'skills:read', 'skills.readme', 'skills-readme', isSkillsReadmeRequest, isSkillsReadmeResult),
  };
}

async function executeCapability(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  request: unknown,
): Promise<SkillCapabilityTransportResponse> {
  if (!isSkillCapabilityRequest(request)) return { status: 400, body: CAPABILITY_REJECTED };
  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path: CAPABILITY_EXECUTE_ENDPOINT,
    issuer,
    decision: {
      endpoint: CAPABILITY_EXECUTE_ENDPOINT,
      scope: 'skill.management',
      capability: request.operationId,
      subject: 'skill-management',
    },
    method: 'POST',
    fetcher,
    body: request,
  });
  if (response?.status === 401) return { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  if (response?.status === 400) return { status: 400, body: CAPABILITY_REJECTED };
  if (response?.status === 200) return projectSkillCapabilityResult(request.operationId, response.body);
  return { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
}

async function readStatus(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
): Promise<SkillsStatusTransportResponse> {
  const response = await get<NativeSkillsStatusResult>(
    issuer,
    runtimeHostTransportPort,
    fetcher,
    SKILLS_ENDPOINTS.status,
    'skills:read',
    'skills.status',
    'skills-status',
    isNativeSkillsStatusResult,
  );
  if (response.status !== 200) return unknownResponse();

  const nativeStatus = decodeSkillsStatus(response.body);
  if (nativeStatus === null) return unknownResponse();
  return { status: 200, body: projectSkillsStatus(nativeStatus) };
}

function projectSkillCapabilityResult(
  operation: SkillCapabilityOperation,
  body: unknown,
): SkillCapabilityTransportResponse {
  if (!isRecord(body)) return { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  if (operation === 'skills.refreshStatus') {
    const native = decodeSkillsStatus(body);
    return native
      ? { status: 200, body: projectSkillsStatus(native) }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  if (operation === 'skills.exportBundles') {
    return hasExactKeys(body, ['skillBundles']) && Array.isArray(body.skillBundles)
      ? { status: 200, body: body.skillBundles }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  if (operation === 'skills.importBundles') {
    return hasExactKeys(body, ['ok']) && body.ok === true
      ? { status: 200, body: { ok: true } }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  if (operation === 'clawhub.openReadme') {
    return hasExactKeys(body, ['success', 'content', 'filePath'])
      && body.success === true
      && typeof body.content === 'string'
      && isSkillReferencePath(body.filePath)
      && isManifestPath(body.filePath)
      ? { status: 200, body }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  if (operation === 'clawhub.openPath') {
    return body.success === true
      ? { status: 200, body: { success: true } }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  return body.success === true
    ? { status: 200, body: { success: true } }
    : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
}

export function decodeSkillsStatus(value: unknown): NativeSkillsStatusResult | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['skills', 'ready', 'refreshing', 'updatedAt', 'error'])
    || !Array.isArray(value.skills)
    || (value.ready !== undefined && typeof value.ready !== 'boolean')
    || (value.refreshing !== undefined && typeof value.refreshing !== 'boolean')
    || (value.updatedAt !== undefined && value.updatedAt !== null && !isTimestamp(value.updatedAt))
    || (value.error !== undefined && value.error !== null && !isText(value.error, 1_024))) {
    return null;
  }
  const skills = value.skills.map(normalizeSkillStatusEntry);
  if (skills.some((entry) => entry === null)) return null;
  return {
    skills: skills as NativeSkillStatusEntry[],
    ...(value.ready === undefined ? {} : { ready: value.ready }),
    ...(value.refreshing === undefined ? {} : { refreshing: value.refreshing }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

export function projectSkillsStatus(value: NativeSkillsStatusResult): SkillsStatusResult {
  return {
    skills: value.skills.map((entry) => ({
      skillKey: entry.key,
      ...(entry.slug === undefined ? {} : { slug: entry.slug }),
      name: entry.name,
      description: entry.description,
      disabled: !entry.enabled,
      selectable: entry.selectable,
      unavailableReason: entry.unavailableReason,
      eligible: entry.eligible,
      missingCategories: entry.missingCategories,
      ...(entry.missingCategories.length > 0 ? { missing: projectMissing(entry.missingCategories) } : {}),
      ...(entry.uninstallable === undefined ? {} : { uninstallable: entry.uninstallable }),
      ...(entry.bundled === undefined ? {} : { bundled: entry.bundled }),
      ...(entry.always === undefined ? {} : { always: entry.always }),
      ...(entry.emoji === undefined ? {} : { emoji: entry.emoji }),
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.baseDir === undefined ? {} : { baseDir: entry.baseDir }),
      ...(entry.filePath === undefined ? {} : { filePath: entry.filePath }),
    })),
    ...(value.ready === undefined ? {} : { ready: value.ready }),
    ...(value.refreshing === undefined ? {} : { refreshing: value.refreshing }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

function projectMissing(categories: readonly SkillMissingCategory[]): SkillMissingProjection {
  const missing: Record<string, string[]> = {};
  for (const category of categories) {
    if (category === 'binaries') missing.bins = [];
    else if (category === 'anyBinaries') missing.anyBins = [];
    else if (category === 'environment') missing.env = [];
    else if (category === 'configuration') missing.config = [];
    else if (category === 'operatingSystem') missing.os = [];
  }
  return missing;
}

function isNativeSkillsStatusResult(value: unknown): value is NativeSkillsStatusResult {
  return decodeSkillsStatus(value) !== null;
}

function isSkillCapabilityRequest(value: unknown): value is SkillCapabilityRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'skill.management'
    || !isSkillCapabilityOperation(value.operationId)
    || !isNativeRuntimeScope(value.scope)
    || !isRecord(value.target)
    || !isRecord(value.input)) {
    return false;
  }
  return targetMatchesSkillOperation(value.target, value.input, value.operationId);
}

function isSkillCapabilityOperation(value: unknown): value is SkillCapabilityOperation {
  return value === 'skills.refreshStatus'
    || value === 'skills.updateConfig'
    || value === 'skills.updateState'
    || value === 'skills.updateBatchState'
    || value === 'skills.exportBundles'
    || value === 'skills.importBundles'
    || value === 'clawhub.openReadme'
    || value === 'clawhub.openPath';
}

function targetMatchesSkillOperation(target: Record<string, unknown>, input: Record<string, unknown>, operation: SkillCapabilityOperation): boolean {
  if (operation === 'skills.refreshStatus') return hasExactKeys(target, ['kind']) && target.kind === 'none' && hasExactKeys(input, []);
  if (operation === 'skills.exportBundles') return hasExactKeys(target, ['kind']) && target.kind === 'skill-bundle' && hasExactKeys(input, ['skillKeys']) && isOpenClawSkillKeyArray(input.skillKeys);
  if (operation === 'skills.importBundles') return hasExactKeys(target, ['kind']) && target.kind === 'skill-bundle' && hasExactKeys(input, ['skillBundles']) && Array.isArray(input.skillBundles);
  if (operation === 'skills.updateBatchState') return hasExactKeys(target, ['kind']) && target.kind === 'skill' && hasExactKeys(input, ['skillKeys', 'enabled']) && isOpenClawSkillKeyArray(input.skillKeys) && typeof input.enabled === 'boolean';
  const skillId = skillTargetId(target);
  if (skillId === null) return false;
  if (operation === 'skills.updateConfig') return hasExactKeys(input, ['skillKey', 'apiKey', 'env']) && input.skillKey === skillId && typeof input.apiKey === 'string' && isCapabilityStringRecord(input.env);
  if (operation === 'skills.updateState') return hasExactKeys(input, ['skillKey', 'enabled']) && input.skillKey === skillId && typeof input.enabled === 'boolean';
  return input.skillKey === skillId
    && (input.slug === undefined || input.slug === target.slug)
    && (input.baseDir === undefined || isSkillReferencePath(input.baseDir))
    && (input.filePath === undefined || (isSkillReferencePath(input.filePath) && isManifestPath(input.filePath)))
    && hasOnlyKeys(input, ['skillKey', 'slug', 'baseDir', 'filePath']);
}

function skillTargetId(target: Record<string, unknown>): string | null {
  if (!hasOnlyKeys(target, ['kind', 'skillId', 'slug'])
    || target.kind !== 'skill'
    || !isOpenClawSkillKey(target.skillId)
    || (target.slug !== undefined && !isOpenClawSkillKey(target.slug))) {
    return null;
  }
  return target.skillId;
}

function isNativeRuntimeScope(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'runtime-instance'
    && isRecord(value.endpoint)
    && hasExactKeys(value.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.endpoint.kind === 'native-runtime'
    && value.endpoint.runtimeAdapterId === 'openclaw'
    && value.endpoint.runtimeInstanceId === 'local';
}

function isCapabilityStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function normalizeSkillStatusEntry(value: unknown): NativeSkillStatusEntry | null {
  if (isProjectedSkillStatusEntry(value)) return normalizeProjectedSkillStatusEntry(value);
  return null;
}


type ProjectedSkillStatusEntry = Readonly<{
  key: string;
  slug?: string;
  name: string;
  description: string;
  enabled: boolean;
  selectable: boolean;
  unavailableReason: SkillUnavailableReason | null;
  missingCategories: SkillMissingCategory[];
  eligible: boolean;
  uninstallable?: boolean;
  bundled?: boolean;
  always?: boolean;
  emoji?: string;
  source?: SkillsSafeSource;
  baseDir?: string;
  filePath?: string;
}>;

function normalizeProjectedSkillStatusEntry(entry: ProjectedSkillStatusEntry): NativeSkillStatusEntry {
  return {
    key: entry.key,
    ...(entry.slug === undefined ? {} : { slug: entry.slug }),
    name: entry.name,
    description: entry.description,
    enabled: entry.enabled,
    selectable: entry.selectable,
    unavailableReason: entry.unavailableReason,
    missingCategories: entry.missingCategories,
    eligible: entry.eligible,
    ...(entry.uninstallable === undefined ? {} : { uninstallable: entry.uninstallable }),
    ...(entry.bundled === undefined ? {} : { bundled: entry.bundled }),
    ...(entry.always === undefined ? {} : { always: entry.always }),
    ...(entry.emoji === undefined ? {} : { emoji: entry.emoji }),
    ...(entry.source === undefined ? {} : { source: entry.source }),
    ...(entry.baseDir === undefined ? {} : { baseDir: entry.baseDir }),
    ...(entry.filePath === undefined ? {} : { filePath: entry.filePath }),
  };
}

function isProjectedSkillStatusEntry(value: unknown): value is ProjectedSkillStatusEntry {
  return hasOnlyKeys(value, ['key', 'slug', 'name', 'description', 'enabled', 'selectable', 'unavailableReason', 'missingCategories', 'eligible', 'uninstallable', 'bundled', 'always', 'emoji', 'source', 'baseDir', 'filePath'])
    && hasRequiredKeys(value, ['key', 'name', 'description', 'enabled', 'selectable', 'unavailableReason', 'missingCategories', 'eligible'])
    && isOpenClawSkillKey(value.key)
    && (value.slug === undefined || isSlug(value.slug))
    && isText(value.name, 256)
    && isBoundedText(value.description, 8_192)
    && typeof value.enabled === 'boolean'
    && typeof value.selectable === 'boolean'
    && (value.unavailableReason === null || isSkillUnavailableReason(value.unavailableReason))
    && Array.isArray(value.missingCategories)
    && value.missingCategories.every(isSkillMissingCategory)
    && typeof value.eligible === 'boolean'
    && (value.uninstallable === undefined || typeof value.uninstallable === 'boolean')
    && (value.bundled === undefined || typeof value.bundled === 'boolean')
    && (value.always === undefined || typeof value.always === 'boolean')
    && (value.emoji === undefined || isText(value.emoji, 32))
    && (value.source === undefined || isSafeSource(value.source))
    && (value.baseDir === undefined || isSkillReferencePath(value.baseDir))
    && (value.filePath === undefined || (isSkillReferencePath(value.filePath) && isManifestPath(value.filePath)));
}

function isSafeSource(value: unknown): value is SkillsSafeSource {
  return isText(value, 4 * 1024);
}

function isSkillUnavailableReason(value: unknown): value is SkillUnavailableReason {
  return value === 'disabled'
    || value === 'missingRequirements'
    || value === 'ineligible';
}

function isSkillMissingCategory(value: unknown): value is SkillMissingCategory {
  return value === 'binaries'
    || value === 'anyBinaries'
    || value === 'environment'
    || value === 'configuration'
    || value === 'operatingSystem';
}

async function get<T>(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  endpoint: SkillsEndpoint,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SkillsTransportResponse<T>> {
  return send(issuer, runtimeHostTransportPort, fetcher, endpoint, 'GET', undefined, scope, capability, subject, isSuccess);
}

async function post<T>(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  endpoint: SkillsEndpoint,
  request: unknown,
  scope: string,
  capability: string,
  subject: string,
  isRequest: (value: unknown) => boolean,
  isSuccess: (value: unknown) => value is T,
): Promise<SkillsTransportResponse<T>> {
  if (!isRequest(request)) return rejectedResponse();
  return send(issuer, runtimeHostTransportPort, fetcher, endpoint, 'POST', request, scope, capability, subject, isSuccess);
}

async function send<T>(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  endpoint: SkillsEndpoint,
  method: 'GET' | 'POST',
  request: unknown,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SkillsTransportResponse<T>> {
  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path: endpoint,
    issuer,
    decision: { endpoint, scope, capability, subject },
    method,
    fetcher,
    ...(method === 'POST' ? { body: request } : {}),
  });
  if (response?.status === 200 && isSuccess(response.body)) return { status: 200, body: response.body };
  if (endpoint === SKILLS_ENDPOINTS.uninstall && response?.status === 404 && isSkillsUninstallNotFoundResult(response.body)) {
    return { status: 404, body: response.body };
  }
  if (response?.status === 400 && isRejectedResult(response.body)) return { status: 400, body: response.body };
  return unknownResponse();
}

function rejectedResponse<T>(): SkillsTransportResponse<T> {
  return { status: 400, body: { outcome: 'rejected' } };
}

function unknownResponse<T>(): SkillsTransportResponse<T> {
  return { status: 503, body: { outcome: 'unknown' } };
}

function isSkillsDetailRequest(value: unknown): value is SkillsDetailRequest {
  return isRecord(value) && hasExactKeys(value, ['slug']) && isSlug(value.slug);
}

function isSkillsDetailResult(value: unknown): value is SkillsDetailResult {
  return hasOnlyKeys(value, ['skill', 'latestVersion', 'metadata', 'owner'])
    && Object.hasOwn(value, 'skill')
    && (value.skill === null || isSkillsDetailSkill(value.skill))
    && (value.latestVersion === undefined || value.latestVersion === null || isSkillsDetailLatestVersion(value.latestVersion))
    && (value.metadata === undefined || value.metadata === null || isSkillsDetailMetadata(value.metadata))
    && (value.owner === undefined || value.owner === null || isSkillsDetailOwner(value.owner));
}

function isSkillsDetailSkill(value: unknown): boolean {
  return hasOnlyKeys(value, ['slug', 'displayName', 'summary', 'tags', 'createdAt', 'updatedAt'])
    && hasRequiredKeys(value, ['slug', 'displayName', 'createdAt', 'updatedAt'])
    && isSlug(value.slug)
    && isText(value.displayName, 256)
    && (value.summary === undefined || isText(value.summary, 8_192))
    && (value.tags === undefined || isStringRecord(value.tags, 64, 256))
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt);
}

function isSkillsDetailLatestVersion(value: unknown): boolean {
  return hasOnlyKeys(value, ['version', 'createdAt', 'changelog'])
    && hasRequiredKeys(value, ['version', 'createdAt'])
    && isText(value.version, 128)
    && isTimestamp(value.createdAt)
    && (value.changelog === undefined || isText(value.changelog, 16_384));
}

function isSkillsDetailMetadata(value: unknown): boolean {
  return hasOnlyKeys(value, ['os', 'systems'])
    && (value.os === undefined || value.os === null || isIdentifierArray(value.os))
    && (value.systems === undefined || value.systems === null || isIdentifierArray(value.systems));
}

function isSkillsDetailOwner(value: unknown): boolean {
  return hasOnlyKeys(value, ['handle', 'displayName', 'image'])
    && (value.handle === undefined || value.handle === null || isText(value.handle, 256))
    && (value.displayName === undefined || value.displayName === null || isText(value.displayName, 256))
    && (value.image === undefined || value.image === null || isText(value.image, 2_048));
}

function isSkillsConfigMutationRequest(value: unknown): value is SkillsConfigMutationRequest {
  return hasOnlyKeys(value, ['skillKey', 'enabled', 'apiKey', 'env'])
    && hasRequiredKeys(value, ['skillKey'])
    && isOpenClawSkillKey(value.skillKey)
    && (value.enabled === undefined || typeof value.enabled === 'boolean')
    && (value.apiKey === undefined || isText(value.apiKey, 4_096))
    && (value.env === undefined || isStringRecord(value.env, 128, 4_096))
    && Object.keys(value).length > 1;
}

function isClawHubSkillInstallRequest(value: unknown): value is ClawHubSkillInstallRequest {
  return hasOnlyKeys(value, ['slug', 'version', 'force'])
    && hasRequiredKeys(value, ['slug'])
    && isSlug(value.slug)
    && (value.version === undefined || isText(value.version, 128))
    && (value.force === undefined || typeof value.force === 'boolean');
}

function isClawHubSkillUpdateRequest(value: unknown): value is ClawHubSkillUpdateRequest {
  return hasOnlyKeys(value, ['slug', 'all'])
    && ((hasExactKeys(value, ['slug']) && isSlug(value.slug))
      || (hasExactKeys(value, ['all']) && value.all === true));
}

function isSkillsUploadBeginRequest(value: unknown): value is SkillsUploadBeginRequest {
  return hasOnlyKeys(value, ['kind', 'slug', 'sizeBytes', 'sha256', 'idempotencyKey'])
    && hasRequiredKeys(value, ['kind', 'slug', 'sizeBytes', 'sha256'])
    && value.kind === 'skill-archive'
    && isSlug(value.slug)
    && isBoundedInteger(value.sizeBytes, 1, 100 * 1024 * 1024)
    && isSha256(value.sha256)
    && (value.idempotencyKey === undefined || isText(value.idempotencyKey, 2_048));
}

function isSkillsUploadChunkRequest(value: unknown): value is SkillsUploadChunkRequest {
  return isRecord(value)
    && hasExactKeys(value, ['uploadId', 'offset', 'dataBase64'])
    && isIdentifier(value.uploadId)
    && isBoundedInteger(value.offset, 0, 100 * 1024 * 1024)
    && isBase64(value.dataBase64, 1024 * 1024);
}

function isSkillsUploadCommitRequest(value: unknown): value is SkillsUploadCommitRequest {
  return hasOnlyKeys(value, ['uploadId', 'sha256'])
    && hasRequiredKeys(value, ['uploadId'])
    && isIdentifier(value.uploadId)
    && (value.sha256 === undefined || isSha256(value.sha256));
}

function isSkillsUninstallRequest(value: unknown): value is SkillsUninstallRequest {
  return hasOnlyKeys(value, ['skillKey', 'slug'])
    && hasRequiredKeys(value, ['skillKey'])
    && isOpenClawSkillKey(value.skillKey)
    && (value.slug === undefined || isSlug(value.slug));
}

function isSkillsImportMarkdownRequest(value: unknown): value is SkillsImportMarkdownRequest {
  return isRecord(value) && hasExactKeys(value, ['content']) && isText(value.content, 48 * 1024);
}

function isSkillsImportBundleRequest(value: unknown): value is SkillsImportBundleRequest {
  return isRecord(value) && hasExactKeys(value, ['skillKey', 'files']) && isOpenClawSkillKey(value.skillKey)
    && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 256
    && value.files.every((file) => isRecord(file) && hasExactKeys(file, ['path', 'content']) && isText(file.path, 240) && isText(file.content, 48 * 1024));
}

function isSkillsReadmeRequest(value: unknown): value is SkillsReadmeRequest {
  return hasOnlyKeys(value, ['skillKey', 'slug', 'filePath', 'baseDir'])
    && hasRequiredKeys(value, ['skillKey'])
    && isOpenClawSkillKey(value.skillKey)
    && (value.slug === undefined || isOpenClawSkillKey(value.slug))
    && (value.filePath === undefined || (isSkillReferencePath(value.filePath) && isManifestPath(value.filePath)))
    && (value.baseDir === undefined || isSkillReferencePath(value.baseDir));
}

function isSkillsReadmeResult(value: unknown): value is SkillsReadmeResult {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'content', 'filePath'])
    && value.success === true
    && isBoundedText(value.content, 48 * 1024)
    && isSkillReferencePath(value.filePath)
    && isManifestPath(value.filePath);
}

function isSkillsUninstallResult(value: unknown): value is SkillsUninstallResult {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'removed' || value.outcome === 'notFound' || value.outcome === 'rejected' || value.outcome === 'unknown');
}

function isSkillsUninstallNotFoundResult(value: unknown): value is Readonly<{ outcome: 'notFound' }> {
  return isRecord(value) && hasExactKeys(value, ['outcome']) && value.outcome === 'notFound';
}

function isSkillsMutationResult(value: unknown): value is SkillsMutationResult {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'accepted' || value.outcome === 'rejected' || value.outcome === 'unknown');
}

function isRejectedResult(value: unknown): value is SkillsTransportFailure {
  return isRecord(value) && hasExactKeys(value, ['outcome']) && value.outcome === 'rejected';
}

function isSkillsUploadBeginResult(value: unknown): value is SkillsUploadBeginResult {
  return isSkillsUploadProgressResult(value);
}

function isSkillsUploadChunkResult(value: unknown): value is SkillsUploadChunkResult {
  return isSkillsUploadProgressResult(value);
}

function isSkillsUploadProgressResult(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['uploadId', 'receivedBytes', 'expiresAt'])
    && isIdentifier(value.uploadId)
    && isBoundedInteger(value.receivedBytes, 0, 100 * 1024 * 1024)
    && isTimestamp(value.expiresAt);
}

function isSkillsUploadCommitResult(value: unknown): value is SkillsUploadCommitResult {
  return isRecord(value)
    && hasExactKeys(value, ['uploadId', 'receivedBytes', 'sha256', 'expiresAt'])
    && isIdentifier(value.uploadId)
    && isBoundedInteger(value.receivedBytes, 0, 100 * 1024 * 1024)
    && isSha256(value.sha256)
    && isTimestamp(value.expiresAt);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isSkillReferencePath(value: unknown): value is string {
  return isAbsolutePath(value, 4 * 1024) || isMatchaSkillUri(value);
}

function isAbsolutePath(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    return false;
  }
  return /^[A-Za-z]:[\\/]|^\\\\|^\//.test(value);
}

function isMatchaSkillUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4 * 1024 || value.includes('\0')) {
    return false;
  }
  const match = /^matcha-skill:\/\/([^/]+)\/(.+)$/.exec(value);
  return match !== null && match[1].length > 0 && match[2].length > 0;
}

function isManifestPath(value: string): boolean {
  return /(?:^|[\\/])SKILL\.md$/i.test(value);
}

function isOpenClawSkillKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');
}

function isOpenClawSkillKeyArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isOpenClawSkillKey);
}

function isSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 128;
}

function isText(value: unknown, maxLength: number): value is string {
  return isBoundedText(value, maxLength) && value.length > 0;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isBase64(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function isIdentifierArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isIdentifier);
}

function isStringRecord(value: unknown, keyMaxLength: number, valueMaxLength: number): value is Record<string, string> {
  return isRecord(value)
    && Object.keys(value).every((key) => isText(key, keyMaxLength) && isText(value[key], valueMaxLength));
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}
