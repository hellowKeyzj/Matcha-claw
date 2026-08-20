import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;

export const SKILLS_ENDPOINTS = Object.freeze({
  status: '/api/skills/status',
  search: '/api/skills/search',
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

export type SkillsTransportFailure = Readonly<{
  outcome: 'rejected' | 'unknown';
}>;

export type SkillsSafeSource =
  | 'bundled'
  | 'openclaw-bundled'
  | 'managed'
  | 'openclaw-managed'
  | 'openclaw-workspace'
  | 'openclaw-extra'
  | 'agents-skills-personal'
  | 'agents-skills-project';

export type NativeSkillStatusEntry = Readonly<{
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  selectable: boolean;
  unavailableReason: string | null;
  missingCategories: string[];
  installed: boolean;
  eligible: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter: boolean;
  bundled?: boolean;
  always?: boolean;
  emoji?: string;
  source?: SkillsSafeSource;
}>;

export type NativeSkillsStatusResult = Readonly<{
  skills: NativeSkillStatusEntry[];
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
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
  slug: string;
  name: string;
  description: string;
  disabled: boolean;
  selectable: boolean;
  unavailableReason: string | null;
  installed: boolean;
  eligible: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter: boolean;
  missingCategories: string[];
  missing?: SkillMissingProjection;
  bundled?: boolean;
  always?: boolean;
  emoji?: string;
  source?: SkillsSafeSource;
}>;

export type SkillsStatusResult = Readonly<{
  skills: SkillStatusEntry[];
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}>;
export type SkillsSearchRequest = Readonly<{ query?: string; limit?: number }>;
export type SkillsSearchResult = Readonly<{
  results: Array<Readonly<{
    score: number;
    slug: string;
    displayName: string;
    summary?: string;
    version?: string;
    updatedAt?: number;
  }>>;
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
export type SkillsUninstallRequest = Readonly<{ skillKey: string }>;
export type SkillsUninstallResult = Readonly<{ outcome: 'removed' | 'notFound' | 'rejected' | 'unknown' }>;
export type SkillsImportMarkdownRequest = Readonly<{ content: string }>;
export type SkillsImportBundleRequest = Readonly<{ skillKey: string; files: Array<Readonly<{ path: string; content: string }>> }>;
export type SkillsReadmeRequest = Readonly<{
  skillKey: string;
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
export type SkillsSearchTransportResponse = SkillsTransportResponse<SkillsSearchResult>;
export type SkillsDetailTransportResponse = SkillsTransportResponse<SkillsDetailResult>;
export type SkillsConfigMutationTransportResponse = SkillsTransportResponse<SkillsMutationResult>;
export type ClawHubSkillInstallTransportResponse = SkillsTransportResponse<SkillsMutationResult>;
export type ClawHubSkillUpdateTransportResponse = SkillsTransportResponse<SkillsMutationResult>;
export type SkillsUploadBeginTransportResponse = SkillsTransportResponse<SkillsUploadBeginResult>;
export type SkillsUploadChunkTransportResponse = SkillsTransportResponse<SkillsUploadChunkResult>;
export type SkillsUploadCommitTransportResponse = SkillsTransportResponse<SkillsUploadCommitResult>;
export type SkillsReadmeTransportResponse = SkillsTransportResponse<SkillsReadmeResult>;

export interface SkillsManagementTransport {
  readStatus(): Promise<SkillsStatusTransportResponse>;
  search(request: unknown): Promise<SkillsSearchTransportResponse>;
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
  port: number,
  fetcher: typeof fetch = fetch,
): SkillsManagementTransport {
  return {
    readStatus: () => readStatus(issuer, port, fetcher),
    search: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.search, request, 'skills:search', 'skills.search', 'skills-search', isSkillsSearchRequest, isSkillsSearchResult),
    detail: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.detail, request, 'skills:read', 'skills.detail', 'skills-detail', isSkillsDetailRequest, isSkillsDetailResult),
    mutateConfig: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.config, request, 'skills:config:write', 'skills.config.update', 'skills-config', isSkillsConfigMutationRequest, isSkillsMutationResult),
    installClawHub: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.clawHubInstall, request, 'skills:install', 'skills.install', 'skills-clawhub-install', isClawHubSkillInstallRequest, isSkillsMutationResult),
    updateClawHub: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.clawHubUpdate, request, 'skills:update', 'skills.update', 'skills-clawhub-update', isClawHubSkillUpdateRequest, isSkillsMutationResult),
    beginUpload: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.uploadBegin, request, 'skills:upload', 'skills.upload.begin', 'skills-upload-begin', isSkillsUploadBeginRequest, isSkillsUploadBeginResult),
    appendUploadChunk: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.uploadChunk, request, 'skills:upload', 'skills.upload.chunk', 'skills-upload-chunk', isSkillsUploadChunkRequest, isSkillsUploadChunkResult),
    commitUpload: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.uploadCommit, request, 'skills:upload', 'skills.upload.commit', 'skills-upload-commit', isSkillsUploadCommitRequest, isSkillsUploadCommitResult),
    uninstall: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.uninstall, request, 'skills:uninstall', 'skills.uninstall', 'skills-uninstall', isSkillsUninstallRequest, isSkillsUninstallResult),
    importMarkdown: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.importMarkdown, request, 'skills:import', 'skills.import.markdown', 'skills-import-markdown', isSkillsImportMarkdownRequest, isSkillsMutationResult),
    importBundle: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.importBundle, request, 'skills:import', 'skills.import.bundle', 'skills-import-bundle', isSkillsImportBundleRequest, isSkillsMutationResult),
    readme: (request) => post(issuer, port, fetcher, SKILLS_ENDPOINTS.readme, request, 'skills:read', 'skills.readme', 'skills-readme', isSkillsReadmeRequest, isSkillsReadmeResult),
  };
}

async function readStatus(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
): Promise<SkillsStatusTransportResponse> {
  const response = await get<NativeSkillsStatusResult>(
    issuer,
    port,
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

export function decodeSkillsStatus(value: unknown): NativeSkillsStatusResult | null {
  return isNativeSkillsStatusResult(value) ? value : null;
}

export function projectSkillsStatus(value: NativeSkillsStatusResult): SkillsStatusResult {
  return {
    skills: value.skills.map((entry) => ({
      skillKey: entry.key,
      slug: entry.key,
      name: entry.name,
      description: entry.description,
      disabled: !entry.enabled,
      selectable: entry.selectable,
      unavailableReason: entry.unavailableReason,
      installed: entry.installed,
      eligible: entry.eligible,
      blockedByAllowlist: entry.blockedByAllowlist,
      blockedByAgentFilter: entry.blockedByAgentFilter,
      missingCategories: entry.missingCategories,
      ...(entry.missingCategories.length > 0 ? { missing: projectMissing(entry.missingCategories) } : {}),
      ...(entry.bundled === undefined ? {} : { bundled: entry.bundled }),
      ...(entry.always === undefined ? {} : { always: entry.always }),
      ...(entry.emoji === undefined ? {} : { emoji: entry.emoji }),
      ...(entry.source === undefined ? {} : { source: entry.source }),
    })),
    ...(value.ready === undefined ? {} : { ready: value.ready }),
    ...(value.refreshing === undefined ? {} : { refreshing: value.refreshing }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  };
}

function projectMissing(categories: readonly string[]): SkillMissingProjection {
  const missing: Record<string, string[]> = {};
  for (const category of categories) {
    if (category === 'binaries') missing.bins = [];
    else if (category === 'anyBinaries' || category === 'anybinaries') missing.anyBins = [];
    else if (category === 'environment') missing.env = [];
    else if (category === 'configuration') missing.config = [];
    else if (category === 'operatingSystem' || category === 'operatingsystem') missing.os = [];
  }
  return missing;
}

function isNativeSkillsStatusResult(value: unknown): value is NativeSkillsStatusResult {
  return hasOnlyKeys(value, ['skills', 'ready', 'refreshing', 'updatedAt'])
    && Array.isArray(value.skills)
    && value.skills.every(isNativeSkillStatusEntry)
    && (value.ready === undefined || typeof value.ready === 'boolean')
    && (value.refreshing === undefined || typeof value.refreshing === 'boolean')
    && (value.updatedAt === undefined || value.updatedAt === null || isTimestamp(value.updatedAt));
}

function isNativeSkillStatusEntry(value: unknown): value is NativeSkillStatusEntry {
  return hasOnlyKeys(value, ['key', 'name', 'description', 'enabled', 'selectable', 'unavailableReason', 'missingCategories', 'installed', 'eligible', 'blockedByAllowlist', 'blockedByAgentFilter', 'bundled', 'always', 'emoji', 'source'])
    && hasRequiredKeys(value, ['key', 'name', 'description', 'enabled', 'selectable', 'unavailableReason', 'missingCategories', 'installed', 'eligible', 'blockedByAllowlist', 'blockedByAgentFilter'])
    && isIdentifier(value.key)
    && isText(value.name, 256)
    && isBoundedText(value.description, 8_192)
    && typeof value.enabled === 'boolean'
    && typeof value.selectable === 'boolean'
    && (value.unavailableReason === null || isText(value.unavailableReason, 256))
    && Array.isArray(value.missingCategories)
    && value.missingCategories.every(isIdentifier)
    && typeof value.installed === 'boolean'
    && typeof value.eligible === 'boolean'
    && typeof value.blockedByAllowlist === 'boolean'
    && typeof value.blockedByAgentFilter === 'boolean'
    && (value.bundled === undefined || typeof value.bundled === 'boolean')
    && (value.always === undefined || typeof value.always === 'boolean')
    && (value.emoji === undefined || isText(value.emoji, 32))
    && (value.source === undefined || isSafeSource(value.source));
}

function isSafeSource(value: unknown): value is SkillsSafeSource {
  return value === 'bundled'
    || value === 'openclaw-bundled'
    || value === 'managed'
    || value === 'openclaw-managed'
    || value === 'openclaw-workspace'
    || value === 'openclaw-extra'
    || value === 'agents-skills-personal'
    || value === 'agents-skills-project';
}

async function get<T>(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
  endpoint: SkillsEndpoint,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SkillsTransportResponse<T>> {
  return send(issuer, port, fetcher, endpoint, 'GET', undefined, scope, capability, subject, isSuccess);
}

async function post<T>(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
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
  return send(issuer, port, fetcher, endpoint, 'POST', request, scope, capability, subject, isSuccess);
}

async function send<T>(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
  endpoint: SkillsEndpoint,
  method: 'GET' | 'POST',
  request: unknown,
  scope: string,
  capability: string,
  subject: string,
  isSuccess: (value: unknown) => value is T,
): Promise<SkillsTransportResponse<T>> {
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
    if (endpoint === SKILLS_ENDPOINTS.uninstall && response.status === 404 && isSkillsUninstallNotFoundResult(body)) {
      return { status: 404, body };
    }
    if (response.status === 400 && isRejectedResult(body)) return { status: 400, body };
  } catch {
    // Public Delivery never exposes loopback errors, native errors, secrets, or paths.
  }
  return unknownResponse();
}

function rejectedResponse<T>(): SkillsTransportResponse<T> {
  return { status: 400, body: { outcome: 'rejected' } };
}

function unknownResponse<T>(): SkillsTransportResponse<T> {
  return { status: 503, body: { outcome: 'unknown' } };
}

function isSkillsSearchRequest(value: unknown): value is SkillsSearchRequest {
  return hasOnlyKeys(value, ['query', 'limit'])
    && (value.query === undefined || isText(value.query, 256))
    && (value.limit === undefined || isBoundedInteger(value.limit, 1, 100));
}

function isSkillsSearchResult(value: unknown): value is SkillsSearchResult {
  return hasExactKeys(value, ['results']) && Array.isArray(value.results) && value.results.every(isSkillsSearchResultEntry);
}

function isSkillsSearchResultEntry(value: unknown): boolean {
  return hasOnlyKeys(value, ['score', 'slug', 'displayName', 'summary', 'version', 'updatedAt'])
    && typeof value.score === 'number'
    && Number.isFinite(value.score)
    && isSlug(value.slug)
    && isText(value.displayName, 256)
    && (value.summary === undefined || isText(value.summary, 8_192))
    && (value.version === undefined || isText(value.version, 128))
    && (value.updatedAt === undefined || isTimestamp(value.updatedAt));
}

function isSkillsDetailRequest(value: unknown): value is SkillsDetailRequest {
  return hasExactKeys(value, ['slug']) && isSlug(value.slug);
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
    && isIdentifier(value.skillKey)
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
  return hasExactKeys(value, ['uploadId', 'offset', 'dataBase64'])
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
  return hasExactKeys(value, ['skillKey']) && isIdentifier(value.skillKey);
}

function isSkillsImportMarkdownRequest(value: unknown): value is SkillsImportMarkdownRequest {
  return hasExactKeys(value, ['content']) && isText(value.content, 48 * 1024);
}

function isSkillsImportBundleRequest(value: unknown): value is SkillsImportBundleRequest {
  return hasExactKeys(value, ['skillKey', 'files']) && isIdentifier(value.skillKey)
    && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 256
    && value.files.every((file) => isRecord(file) && hasExactKeys(file, ['path', 'content']) && isText(file.path, 240) && isText(file.content, 48 * 1024));
}

function isSkillsReadmeRequest(value: unknown): value is SkillsReadmeRequest {
  return hasOnlyKeys(value, ['skillKey', 'filePath', 'baseDir'])
    && hasRequiredKeys(value, ['skillKey'])
    && isReadmeSkillKey(value.skillKey)
    && (value.filePath === undefined || (isAbsolutePath(value.filePath, 4 * 1024) && isManifestPath(value.filePath)))
    && (value.baseDir === undefined || isAbsolutePath(value.baseDir, 4 * 1024));
}

function isSkillsReadmeResult(value: unknown): value is SkillsReadmeResult {
  return hasExactKeys(value, ['success', 'content', 'filePath'])
    && value.success === true
    && isBoundedText(value.content, 48 * 1024)
    && isAbsolutePath(value.filePath, 4 * 1024)
    && isManifestPath(value.filePath);
}

function isSkillsUninstallResult(value: unknown): value is SkillsUninstallResult {
  return hasExactKeys(value, ['outcome']) && (value.outcome === 'removed' || value.outcome === 'notFound' || value.outcome === 'rejected' || value.outcome === 'unknown');
}

function isSkillsUninstallNotFoundResult(value: unknown): value is Readonly<{ outcome: 'notFound' }> {
  return hasExactKeys(value, ['outcome']) && value.outcome === 'notFound';
}

function isSkillsMutationResult(value: unknown): value is SkillsMutationResult {
  return hasExactKeys(value, ['outcome'])
    && (value.outcome === 'accepted' || value.outcome === 'rejected' || value.outcome === 'unknown');
}

function isRejectedResult(value: unknown): value is SkillsTransportFailure {
  return hasExactKeys(value, ['outcome']) && value.outcome === 'rejected';
}

function isSkillsUploadBeginResult(value: unknown): value is SkillsUploadBeginResult {
  return isSkillsUploadProgressResult(value);
}

function isSkillsUploadChunkResult(value: unknown): value is SkillsUploadChunkResult {
  return isSkillsUploadProgressResult(value);
}

function isSkillsUploadProgressResult(value: unknown): boolean {
  return hasExactKeys(value, ['uploadId', 'receivedBytes', 'expiresAt'])
    && isIdentifier(value.uploadId)
    && isBoundedInteger(value.receivedBytes, 0, 100 * 1024 * 1024)
    && isTimestamp(value.expiresAt);
}

function isSkillsUploadCommitResult(value: unknown): value is SkillsUploadCommitResult {
  return hasExactKeys(value, ['uploadId', 'receivedBytes', 'sha256', 'expiresAt'])
    && isIdentifier(value.uploadId)
    && isBoundedInteger(value.receivedBytes, 0, 100 * 1024 * 1024)
    && isSha256(value.sha256)
    && isTimestamp(value.expiresAt);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isAbsolutePath(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    return false;
  }
  return /^[A-Za-z]:[\\/]|^\\\\|^\//.test(value);
}

function isManifestPath(value: string): boolean {
  return /(?:^|[\\/])SKILL\.md$/i.test(value);
}

function isReadmeSkillKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,94}[A-Za-z0-9])?$/.test(value);
}

function isSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 128;
}

function isText(value: unknown, maxLength: number): value is string {
  return isBoundedText(value, maxLength) && value.length > 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0');
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && value >= 0;
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
