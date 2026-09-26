import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { mapBackendErrorCode, normalizeAppError } from './error-model';
import {
  decodeHostApiProxyEnvelope,
  type HostApiProxyEnvelope,
  unwrapHostApiProxyEnvelope,
} from './host-api-transport-contract';
import {
  buildCapabilityScopeKey,
  agentScope,
  runtimeInstanceScope,
  sessionScope,
  type RuntimeEndpointRef,
  type RuntimeScope,
  type SessionIdentity,
} from '../types/desktop/runtime-address';
import type { CapabilityTarget } from '../types/desktop/capability-target';
import type { CapabilityDescriptor } from '../types/desktop/capability-descriptor';
import type { RuntimeAdapterInstanceSummary, RuntimeAdapterSummary, RuntimeConnectorEndpointLifecycleResult, RuntimeConnectorSummary, RuntimeEndpointSummary } from '../types/runtime-topology';
import {
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from './session-trace';
import {
  decodeSessionContentLoadResult,
  type SessionApprovalDecision,
  type SessionApprovalRequestItem,
  type SessionCatalogItem,
  type SessionContentLoadResult,
  type SessionListResult,
  type SessionModelState,
  type SessionView,
  type SessionWireIdentity,
} from '../types/session/snapshot';

const DEFAULT_HOST_API_PORT = 13210;
const DEFAULT_HOST_API_BASE = `http://127.0.0.1:${DEFAULT_HOST_API_PORT}`;
const SESSION_PEER_RPC_TIMEOUT_MS = 30_000;
const WORKSPACE_FILE_CAPABILITY_ID = 'workspace.file';
const SESSION_MANAGEMENT_CAPABILITY_ID = 'session.management';
const SESSION_PROMPT_CAPABILITY_ID = 'session.prompt';
const SESSION_APPROVAL_CAPABILITY_ID = 'session.approval';
const SESSION_MODEL_SELECTION_CAPABILITY_ID = 'session.modelSelection';
const OPENCLAW_BROWSER_CAPABILITY_ID = 'openclaw.browser';
const OPENCLAW_MCP_APP_CAPABILITY_ID = 'openclaw.mcpApp';
const OPENCLAW_LOCAL_ENDPOINT = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
const CAPABILITY_SCOPE_CACHE_TTL_MS = 5_000;
const capabilityScopeCache = new Map<string, { scope: RuntimeScope; expiresAt: number }>();
const capabilityScopeInflight = new Map<string, Promise<RuntimeScope>>();

type HostApiRequestInit = RequestInit & {
  timeoutMs?: number;
  traceId?: string | null;
};

type SessionCapabilityOptions = {
  timeoutMs?: number;
  traceId?: string | null;
};

const SESSION_TRACE_HEADER = 'X-MatchaClaw-Session-Trace';

export interface OpenClawStatusPayload {
  packageExists: boolean;
  isBuilt: boolean;
  dir: string;
  version?: string;
}

export type FilePreviewError =
  | 'binary'
  | 'notDirectory'
  | 'notFound'
  | 'tooLarge'
  | 'invalidPath'
  | 'outcomeUnknown'
  | 'unavailable';

export interface FilePreviewDirEntry {
  relativePath: string;
  display: string;
  isDirectory: boolean;
  size: number;
}

export interface ReadTextFileResult {
  ok: boolean;
  content?: string;
  size?: number;
  error?: FilePreviewError;
}

export interface WriteTextFileResult {
  ok: boolean;
  name?: string;
  size?: number;
  error?: FilePreviewError;
}

export interface FileThumbnailResult {
  preview: string | null;
  fileSize: number;
  error?: FilePreviewError;
}

export interface StagedFilePayload {
  stagedAttachmentId?: string;
  entryKind?: 'file' | 'directory';
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  sourcePath?: string;
}

export interface WorkspaceFileContext {
  workspaceRoot?: string;
}

export interface ReadBinaryFileResult {
  ok: boolean;
  name?: string;
  data?: string;
  size?: number;
  error?: FilePreviewError;
}

export interface FilePreviewStatResult {
  ok: boolean;
  name?: string;
  isDirectory?: boolean;
  size?: number;
  mtimeMs?: number;
  error?: FilePreviewError;
}

export interface FilePreviewListDirResult {
  ok: boolean;
  entries?: FilePreviewDirEntry[];
  error?: FilePreviewError;
}

export interface OpenClawCliCommandPayload {
  success: boolean;
  command?: string;
  error?: string;
}

export type SessionPermissionMode = 'read-only' | 'guarded' | 'workspace' | 'full';
export type SessionPermissionSelection = SessionPermissionMode | null;

export type HostSessionPermissionResult = Readonly<{
  supported: boolean;
  mode: SessionPermissionSelection;
  defaultMode?: SessionPermissionMode;
  pending: boolean;
  canSelectFull: boolean;
  options: readonly SessionPermissionMode[];
  reason?: string;
}>;

export type HostSessionPermissionSetResult = HostSessionPermissionResult & Readonly<{
  changed?: boolean;
}>;

export type HostSessionCatalogItem = SessionCatalogItem;

export type HostSessionLoadResult = SessionView;

export type HostSessionWindowResult = SessionView;

export type HostSessionContentLoadResult = SessionContentLoadResult;

export type HostSessionAbortResult = Readonly<{ outcome?: string; projection?: unknown }>;

export type HostSessionPromptResult = Readonly<{
  success?: boolean;
  outcome?: 'queued' | 'succeeded' | 'target_rejected' | 'unavailable' | 'unknown';
  routeKey?: string;
  runId?: string;
  status?: 'started' | 'in_flight' | 'ok';
  projection?: unknown;
  snapshot?: unknown;
  error?: string;
}>;

function capabilityScopeCacheKey(capabilityId: string, scope?: RuntimeScope): string {
  return scope ? `${capabilityId}:${buildCapabilityScopeKey(scope)}` : capabilityId;
}

function describeCapabilityScope(scope: RuntimeScope): string {
  return buildCapabilityScopeKey(scope);
}

function resolveCapabilityScopeFromList(
  capabilityId: string,
  capabilities: readonly CapabilityDescriptor[],
  sourceScope?: RuntimeScope,
): RuntimeScope {
  const available = capabilities.filter((capability) => capability.id === capabilityId && capability.availability === 'available');
  const matched = sourceScope
    ? available.find((capability) => buildCapabilityScopeKey(capability.scope) === buildCapabilityScopeKey(sourceScope))
    : null;
  const scope = matched?.scope ?? (available.length === 1 ? available[0]!.scope : null);
  if (!scope) {
    const scopeHint = sourceScope ? ` for source scope ${describeCapabilityScope(sourceScope)}` : '';
    const availableHint = available.length > 0
      ? `; available scopes: ${available.map((capability) => describeCapabilityScope(capability.scope)).join(', ')}`
      : '; available scopes: none';
    throw new Error(`Expected exactly one RuntimeScope for capability: ${capabilityId}${scopeHint}, got ${available.length}${availableHint}`);
  }
  return scope;
}

async function resolveCapabilityScope(capabilityId: string, sourceScope?: RuntimeScope): Promise<RuntimeScope> {
  const cacheKey = capabilityScopeCacheKey(capabilityId, sourceScope);
  const now = Date.now();
  const cached = capabilityScopeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.scope;
  }
  const inflight = capabilityScopeInflight.get(cacheKey);
  if (inflight) {
    return await inflight;
  }
  const task = (async () => {
    const { capabilities } = await hostCapabilitiesList();
    const scope = resolveCapabilityScopeFromList(capabilityId, capabilities, sourceScope);
    capabilityScopeCache.set(cacheKey, {
      scope,
      expiresAt: Date.now() + CAPABILITY_SCOPE_CACHE_TTL_MS,
    });
    return scope;
  })();
  capabilityScopeInflight.set(cacheKey, task);
  try {
    return await task;
  } catch (error) {
    capabilityScopeCache.delete(cacheKey);
    throw error;
  } finally {
    if (capabilityScopeInflight.get(cacheKey) === task) {
      capabilityScopeInflight.delete(cacheKey);
    }
  }
}

export async function resolveSingleCapabilityScope(capabilityId: string, sourceScope?: RuntimeScope): Promise<RuntimeScope> {
  return resolveCapabilityScope(capabilityId, sourceScope);
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function withSessionTraceHeader(headers: HeadersInit | undefined, traceId: string | null | undefined): Record<string, string> {
  const record = headersToRecord(headers);
  if (traceId) {
    record[SESSION_TRACE_HEADER] = traceId;
  }
  return record;
}

function parseUnifiedProxyResponse<T>(
  envelope: HostApiProxyEnvelope,
  path: string,
  method: string,
  startedAt: number,
): T {
  const status = envelope.ok ? envelope.data.status : 502;
  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'ipc-proxy',
    durationMs: Date.now() - startedAt,
    status,
  });
  return unwrapHostApiProxyEnvelope<T>(envelope, { method, path }).data;
}

export async function hostApiFetch<T>(path: string, init?: HostApiRequestInit): Promise<T> {
  const startedAt = Date.now();
  const method = init?.method || 'GET';
  const signal = init?.signal ?? null;
  if (signal?.aborted) {
    throw normalizeAppError(new DOMException('Aborted', 'AbortError'), {
      source: 'ipc-proxy',
      path,
      method,
    });
  }
  const requestId = crypto.randomUUID();
  let abortListener: (() => void) | null = null;
  if (signal) {
    abortListener = () => {
      // 通过独立 IPC 通道告诉 main 取消正在进行的 upstream fetch；这里不 await，
      // 上层 Promise.race 由 signal.addEventListener('abort') 立即 reject 主流程。
      void invokeIpc<unknown>('hostapi:abort', { requestId }).catch(() => undefined);
    };
    signal.addEventListener('abort', abortListener, { once: true });
  }
  try {
    const responsePromise = invokeIpc<unknown>('hostapi:fetch', {
      requestId,
      path,
      method,
      headers: withSessionTraceHeader(init?.headers, init?.traceId),
      body: init?.body ?? null,
      timeoutMs: init?.timeoutMs,
    });
    const response = signal
      ? await Promise.race<unknown>([
        responsePromise,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      ])
      : await responsePromise;
    const envelope = decodeHostApiProxyEnvelope(response);
    return parseUnifiedProxyResponse<T>(envelope, path, method, startedAt);
  } catch (error) {
    const normalized = normalizeAppError(error, { source: 'ipc-proxy', path, method });
    trackUiEvent('hostapi.fetch_error', {
      path,
      method,
      source: 'ipc-proxy',
      durationMs: Date.now() - startedAt,
      message: path.startsWith('/api/channels/') ? 'Channel request failed' : normalized.message,
      code: path.startsWith('/api/channels/') ? mapBackendErrorCode(normalized.code) : normalized.code,
    });
    throw normalized;
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

export type HostApiResponseDecoder<T> = (payload: unknown) => T;

export async function hostApiFetchDecoded<T>(
  path: string,
  decode: HostApiResponseDecoder<T>,
  init?: HostApiRequestInit,
): Promise<T> {
  const payload = await hostApiFetch<unknown>(path, init);
  return decode(payload);
}

export function getHostApiBase(): string {
  return DEFAULT_HOST_API_BASE;
}

export async function resolveHostApiBase(): Promise<string> {
  try {
    const baseUrl = await invokeIpc<unknown>('hostapi:base-url');
    return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : DEFAULT_HOST_API_BASE;
  } catch {
    return DEFAULT_HOST_API_BASE;
  }
}

export async function hostOpenClawGetStatus(): Promise<OpenClawStatusPayload> {
  return hostApiFetch('/api/openclaw/status');
}

export async function hostOpenClawIsReady(): Promise<boolean> {
  return hostApiFetch('/api/openclaw/ready');
}

export async function hostOpenClawGetDir(): Promise<string> {
  return hostApiFetch('/api/openclaw/dir');
}

export async function hostOpenClawGetConfigDir(): Promise<string> {
  return hostApiFetch('/api/openclaw/config-dir');
}

export async function hostOpenClawGetSubagentTemplateCatalog<T = unknown>(): Promise<T> {
  return hostApiFetch('/api/openclaw/subagent-templates');
}

export async function hostOpenClawGetSubagentTemplate<T = unknown>(templateId: string): Promise<T> {
  return hostApiFetch(`/api/openclaw/subagent-templates/${encodeURIComponent(templateId)}`);
}

export async function hostOpenClawGetWorkspaceDir(): Promise<string> {
  return hostApiFetch('/api/openclaw/workspace-dir');
}

export async function hostOpenClawGetTaskWorkspaceDirs(): Promise<string[]> {
  return hostApiFetch('/api/openclaw/task-workspace-dirs');
}

export async function hostOpenClawGetSkillsDir(): Promise<string> {
  return hostApiFetch('/api/openclaw/skills-dir');
}

export async function hostOpenClawGetCliCommand(): Promise<OpenClawCliCommandPayload> {
  return hostApiFetch('/api/openclaw/cli-command');
}

export async function hostUvCheck(): Promise<boolean> {
  const result = await hostApiFetch<{ installed: boolean }>('/api/toolchain/uv/check');
  return result.installed;
}

export async function hostToolchainPrepare(): Promise<void> {
  await hostApiFetch('/api/toolchain/uv/prepare', {
    method: 'POST',
    timeoutMs: 120000,
  });
}

export type HostWikiRequest = Record<string, unknown>;

export type HostWikiImportSourceReceipt = Readonly<{
  sourceRelativePath: string;
  pageRelativePath: string;
  revision: unknown;
}>;

export type HostWikiGeneratedPageInput = Readonly<{
  path: string;
  content: string;
}>;

export type HostWikiReviewOption = Readonly<{
  label: string;
  action: string;
}>;

export type HostWikiReviewItem = Readonly<{
  id: string;
  type: string;
  title: string;
  description: string;
  sourcePath?: string;
  affectedPages?: readonly string[];
  searchQueries?: readonly string[];
  options: readonly HostWikiReviewOption[];
  resolved: boolean;
  resolvedAction?: string;
  createdAt: number;
}>;

export type HostWikiSourceWatchConfig = Readonly<{
  enabled: boolean;
  autoIngest: boolean;
  outputLanguage: string;
  generationModelRef?: string | null;
  captionModelRef?: string | null;
  captionEnabled: boolean;
  captionConcurrency: number;
  mineruEnabled: boolean;
  mineruBackend: string;
  mineruTokenConfigured: boolean;
  mineruModelVersion: string;
  mineruLocalEndpoint: string;
  mineruLocalTokenConfigured: boolean;
  mineruLocalBackend: string;
  mineruLocalEffort: string;
  mineruLocalParseMethod: string;
  mineruLocalLanguage: string;
  mineruLocalFormulaEnabled: boolean;
  mineruLocalTableEnabled: boolean;
  mineruLocalImageAnalysis: boolean;
  mineruLocalServerUrl: string;
}>;

export type HostWikiSourceWatchConfigUpdate = Readonly<{
  projectId?: string;
  enabled?: boolean;
  autoIngest?: boolean;
  outputLanguage?: string;
  generationModelRef?: string | null;
  captionModelRef?: string | null;
  captionEnabled?: boolean;
  captionConcurrency?: number;
  mineruEnabled?: boolean;
  mineruBackend?: string;
  mineruToken?: string;
  mineruModelVersion?: string;
  mineruLocalEndpoint?: string;
  mineruLocalToken?: string;
  mineruLocalBackend?: string;
  mineruLocalEffort?: string;
  mineruLocalParseMethod?: string;
  mineruLocalLanguage?: string;
  mineruLocalFormulaEnabled?: boolean;
  mineruLocalTableEnabled?: boolean;
  mineruLocalImageAnalysis?: boolean;
  mineruLocalServerUrl?: string;
}>;

export async function hostWikiStatus(): Promise<unknown> {
  return hostApiFetch('/api/wiki/status');
}

export async function hostWikiProjects(): Promise<unknown> {
  return hostApiFetch('/api/wiki/projects');
}

export async function hostWikiProjectTemplates(): Promise<unknown> {
  return hostApiFetch('/api/wiki/project-templates');
}

export async function hostWikiCreateProject(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/project/create', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiOpenProject(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/project/open', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiCurrentProject(): Promise<unknown> {
  return hostApiFetch('/api/wiki/project/current');
}

export async function hostWikiFiles(payload: { projectId?: string; directory?: string } = {}): Promise<unknown> {
  const query = new URLSearchParams();
  if (payload.projectId) query.set('projectId', payload.projectId);
  if (payload.directory) query.set('directory', payload.directory);
  const queryText = query.toString();
  return hostApiFetch(`/api/wiki/files${queryText ? `?${queryText}` : ''}`);
}

export async function hostWikiReadFile(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/read-file', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiReadBinaryFile(payload: HostWikiRequest): Promise<ReadBinaryFileResult> {
  try {
    const value = await hostApiFetch<unknown>('/api/wiki/read-binary-file', { method: 'POST', body: JSON.stringify(payload) });
    return isWorkspaceBinaryResponse(value)
      ? { ok: true, name: value.name, data: value.data, size: value.size }
      : { ok: false, error: 'unavailable' };
  } catch (error) {
    return { ok: false, error: wikiFileFailure(error instanceof Error ? error.message : error) };
  }
}

export async function hostWikiReadSourcePreview(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/read-source-preview', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiWriteFile(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/write-file', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiSearch(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/search', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiGraph(payload: { projectId?: string } = {}): Promise<unknown> {
  const query = new URLSearchParams();
  if (payload.projectId) query.set('projectId', payload.projectId);
  const queryText = query.toString();
  return hostApiFetch(`/api/wiki/graph${queryText ? `?${queryText}` : ''}`);
}

export async function hostWikiSourceWatchConfig(payload: { projectId?: string } = {}): Promise<{ projectId: string; config: HostWikiSourceWatchConfig }> {
  const query = new URLSearchParams();
  if (payload.projectId) query.set('projectId', payload.projectId);
  const queryText = query.toString();
  return hostApiFetch(`/api/wiki/source-watch-config${queryText ? `?${queryText}` : ''}`);
}

export async function hostWikiUpdateSourceWatchConfig(payload: HostWikiSourceWatchConfigUpdate): Promise<{ projectId: string; config: HostWikiSourceWatchConfig }> {
  return hostApiFetch('/api/wiki/source-watch-config', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiRescanSources(payload: HostWikiRequest = {}): Promise<unknown> {
  return hostApiFetch('/api/wiki/rescan-sources', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiImportSource(payload: { projectId?: string; sourcePath: string }): Promise<HostWikiImportSourceReceipt> {
  return hostApiFetch('/api/wiki/import-source', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiImportFolder(payload: { projectId?: string; folderPath: string }): Promise<unknown> {
  return hostApiFetch('/api/wiki/import-folder', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiRefreshSources(payload: { projectId?: string } = {}): Promise<unknown> {
  return hostApiFetch('/api/wiki/refresh-sources', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiApplyGeneratedPages(payload: { projectId?: string; sourcePath: string; files: HostWikiGeneratedPageInput[] }): Promise<unknown> {
  return hostApiFetch('/api/wiki/apply-generated-pages', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiDeleteSource(payload: { projectId?: string; sourcePath: string; fileAlreadyDeleted?: boolean }): Promise<unknown> {
  return hostApiFetch('/api/wiki/delete-source', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiReviews(payload: { projectId?: string } = {}): Promise<unknown> {
  const query = new URLSearchParams();
  if (payload.projectId) query.set('projectId', payload.projectId);
  const queryText = query.toString();
  return hostApiFetch(`/api/wiki/reviews${queryText ? `?${queryText}` : ''}`);
}

export async function hostWikiResolveReview(payload: { projectId?: string; id: string; action: string }): Promise<unknown> {
  return hostApiFetch('/api/wiki/review/resolve', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiDismissReview(payload: { projectId?: string; id: string }): Promise<unknown> {
  return hostApiFetch('/api/wiki/review/dismiss', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiClearResolvedReviews(payload: { projectId?: string } = {}): Promise<unknown> {
  return hostApiFetch('/api/wiki/reviews/clear-resolved', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiSourceFiles(payload: { projectId?: string } = {}): Promise<unknown> {
  const query = new URLSearchParams();
  if (payload.projectId) query.set('projectId', payload.projectId);
  const queryText = query.toString();
  return hostApiFetch(`/api/wiki/source-files${queryText ? `?${queryText}` : ''}`);
}

export async function hostWikiSourceTasks(payload: { projectId?: string } = {}): Promise<unknown> {
  return hostApiFetch('/api/wiki/source-tasks', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiCancelSourceTask(payload: { projectId?: string; sourcePath: string }): Promise<unknown> {
  return hostApiFetch('/api/wiki/source-task/cancel', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiEmbedPage(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/embed-page', { method: 'POST', body: JSON.stringify(payload) });
}

export async function hostWikiRetrieveContext(payload: HostWikiRequest): Promise<unknown> {
  return hostApiFetch('/api/wiki/retrieve-context', { method: 'POST', body: JSON.stringify(payload) });
}

type WorkspaceFileRequest = {
  endpoint: RuntimeEndpointRef;
  sessionKey: string;
  relativePath: string;
};

function workspaceFileInput(
  payload: WorkspaceFileRequest & { maxBytes?: number; content?: string; includeHidden?: boolean },
  includeHiddenDefault: boolean,
): Record<string, unknown> {
  return {
    endpoint: payload.endpoint,
    sessionKey: payload.sessionKey,
    relativePath: payload.relativePath,
    ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes }),
    ...(payload.content === undefined ? {} : { content: payload.content }),
    ...(includeHiddenDefault ? { includeHidden: payload.includeHidden ?? false } : {}),
  };
}

function workspaceFileScope(payload: WorkspaceFileRequest): RuntimeScope {
  return {
    kind: 'session',
    endpoint: payload.endpoint,
    sessionKey: payload.sessionKey,
  } as unknown as RuntimeScope;
}

function workspaceFilePayload(
  operationId: string,
  payload: WorkspaceFileRequest & { maxBytes?: number; content?: string; includeHidden?: boolean },
) {
  return buildCapabilityExecutePayload({
    id: WORKSPACE_FILE_CAPABILITY_ID,
    operationId,
    scope: workspaceFileScope(payload),
    target: { kind: 'workspace-file' },
    body: workspaceFileInput(payload, operationId === 'files.listDir'),
  });
}

function wikiFileFailure(error: unknown): FilePreviewError {
  const message = typeof error === 'string' ? error : '';
  if (message.includes('outside project') || message.includes('Invalid wiki path')) return 'invalidPath';
  if (message.includes('not found') || message.includes('is a directory')) return 'notFound';
  if (message.includes('exceeds the limit')) return 'tooLarge';
  return 'unavailable';
}

function workspaceFailure(error: unknown): FilePreviewError {
  if (typeof error !== 'string') {
    return 'unavailable';
  }
  switch (error) {
    case 'Workspace text path is invalid':
    case 'Workspace binary path is invalid':
    case 'Workspace directory path is invalid':
    case 'Workspace write path is invalid':
    case 'Workspace media path is invalid':
    case 'Workspace media reference is invalid':
      return 'invalidPath';
    case 'Workspace text target is not a file':
    case 'Workspace binary target is not a file':
    case 'Workspace write target is not a file':
    case 'Workspace media target is not a file':
      return 'notFound';
    case 'Workspace directory target is not a directory':
      return 'notDirectory';
    case 'Workspace text target exceeds the limit':
    case 'Workspace binary target exceeds the limit':
    case 'Workspace write content exceeds the limit':
    case 'Workspace media target exceeds the limit':
      return 'tooLarge';
    case 'Workspace write outcome is unknown':
      return 'outcomeUnknown';
    case 'Workspace media is unavailable':
      return 'unavailable';
    case 'Workspace text target is binary':
      return 'binary';
    default:
      return 'unavailable';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function isCanonicalPreview(value: string): boolean {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  return match !== null && isCanonicalBase64(match[1]);
}

function isWorkspaceFileResponse(value: unknown): value is { name: string; content: string; size: number } {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'content', 'size'])
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.content === 'string'
    && isSafeNonNegativeInteger(value.size);
}

function isWorkspaceBinaryResponse(value: unknown): value is { name: string; data: string; size: number } {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'data', 'size'])
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.data === 'string'
    && isSafeNonNegativeInteger(value.size);
}

function isWorkspaceStatResponse(value: unknown): value is { name: string; isDirectory: boolean; size: number; mtimeMs: number } {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'isDirectory', 'size', 'mtimeMs'])
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.isDirectory === 'boolean'
    && isSafeNonNegativeInteger(value.size)
    && isSafeNonNegativeInteger(value.mtimeMs);
}

function isWorkspaceDirectoryEntry(value: unknown): value is FilePreviewDirEntry {
  return isRecord(value)
    && hasExactKeys(value, ['relativePath', 'display', 'isDirectory', 'size'])
    && typeof value.relativePath === 'string'
    && value.relativePath.length > 0
    && typeof value.display === 'string'
    && value.display.length > 0
    && typeof value.isDirectory === 'boolean'
    && isSafeNonNegativeInteger(value.size);
}

function isWorkspaceDirectoryResponse(value: unknown): value is { entries: FilePreviewDirEntry[] } {
  return isRecord(value)
    && hasExactKeys(value, ['entries'])
    && Array.isArray(value.entries)
    && value.entries.every(isWorkspaceDirectoryEntry);
}

function isWorkspaceWriteResponse(value: unknown): value is { name: string; size: number } {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'size'])
    && typeof value.name === 'string'
    && value.name.length > 0
    && isSafeNonNegativeInteger(value.size);
}

async function workspaceFileFetch<TResult>(
  path: string,
  operationId: string,
  payload: WorkspaceFileRequest & { maxBytes?: number; content?: string; includeHidden?: boolean },
  decode: (value: unknown) => TResult | null,
  options?: { timeoutMs?: number },
): Promise<TResult | FilePreviewError> {
  try {
    const result = decode(await hostApiFetch<unknown>(path, {
      method: 'POST',
      body: JSON.stringify(workspaceFilePayload(operationId, payload)),
      timeoutMs: options?.timeoutMs,
    }));
    return result ?? 'unavailable';
  } catch (error) {
    return workspaceFailure(error instanceof Error ? error.message : error);
  }
}

export async function hostFileReadText(
  payload: WorkspaceFileRequest & { maxBytes?: number } & WorkspaceFileContext,
): Promise<ReadTextFileResult> {
  const result = await workspaceFileFetch('/api/files/read-text', 'files.readText', payload, (value) => (
    isWorkspaceFileResponse(value) ? { ok: true, content: value.content, size: value.size } : null
  ));
  return typeof result === 'string' ? { ok: false, error: result } : result;
}

export async function hostFileWriteText(
  payload: WorkspaceFileRequest & { content: string } & WorkspaceFileContext,
): Promise<WriteTextFileResult> {
  const result = await workspaceFileFetch('/api/files/write-text', 'files.writeText', payload, (value) => (
    isWorkspaceWriteResponse(value) ? { ok: true, name: value.name, size: value.size } : null
  ));
  return typeof result === 'string' ? { ok: false, error: result } : result;
}

function workspaceMediaScope(identity: SessionIdentity): RuntimeScope {
  return {
    kind: 'session',
    endpoint: identity.endpoint,
    sessionKey: identity.sessionKey,
  } as unknown as RuntimeScope;
}

function workspaceMediaPayload(
  operationId: string,
  identity: SessionIdentity,
  input: Record<string, unknown>,
) {
  return buildCapabilityExecutePayload({
    id: 'workspace.media',
    operationId,
    scope: workspaceMediaScope(identity),
    target: { kind: 'workspace-media' },
    body: {
      endpoint: identity.endpoint,
      sessionKey: identity.sessionKey,
      ...input,
    },
  });
}

function stagedFilePayload(value: unknown): StagedFilePayload {
  if (!isWorkspaceMediaAttachment(value)) {
    throw new Error('Workspace attachment staging failed');
  }
  return value;
}

export async function hostFileStagePaths(
  payload: { filePaths: string[]; sessionIdentity: SessionIdentity } & WorkspaceFileContext,
): Promise<StagedFilePayload[]> {
  const result = await invokeIpc<unknown>('dialog:stageDroppedAttachments', payload.filePaths);
  if (!isRecord(result) || !hasExactKeys(result, ['attachments']) || !Array.isArray(result.attachments)) {
    throw new Error('Workspace attachment staging failed');
  }
  return result.attachments.map(stagedFilePayload);
}

export async function hostFileStageBuffer(payload: {
  base64: string;
  fileName: string;
  mimeType: string;
  sessionIdentity: SessionIdentity;
} & WorkspaceFileContext): Promise<StagedFilePayload> {
  const result = await invokeIpc<unknown>('dialog:stageRendererBufferAttachment', {
    base64: payload.base64,
    fileName: payload.fileName,
    mimeType: payload.mimeType,
  });
  return stagedFilePayload(result);
}

export async function hostFileThumbnail(payload: ({
  path: string;
  mimeType: string;
  sessionIdentity: SessionIdentity;
} | {
  gatewayUrl: string;
  mimeType: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
}) & WorkspaceFileContext): Promise<FileThumbnailResult> {
  if ('gatewayUrl' in payload) {
    return hostWorkspaceMediaThumbnail({
      gatewayUrl: payload.gatewayUrl,
      mimeType: payload.mimeType,
      agentId: payload.agentId,
      sessionIdentity: payload.sessionIdentity,
    });
  }

  const relativePath = resolveWorkspaceRelativePath(payload.path, payload.workspaceRoot);
  if (!relativePath) return { preview: null, fileSize: 0, error: 'invalidPath' };
  return hostWorkspaceMediaThumbnail({
    relativePath,
    mimeType: payload.mimeType,
    sessionIdentity: payload.sessionIdentity,
  });
}

export async function hostFileThumbnails(payload: {
  paths: Array<{ filePath?: string; gatewayUrl?: string; mimeType?: string }>;
  sessionIdentity: SessionIdentity;
} & WorkspaceFileContext): Promise<Record<string, FileThumbnailResult>> {
  const result: Record<string, FileThumbnailResult> = {};
  const validPaths: Array<{
    key: string;
    input: Record<string, string>;
    resultKey: string;
  }> = [];

  for (const entry of payload.paths) {
    const resultKey = entry.gatewayUrl ?? entry.filePath ?? '';
    if (!resultKey) continue;
    result[resultKey] = { preview: null, fileSize: 0 };
    const mimeType = entry.mimeType || 'application/octet-stream';

    if (entry.gatewayUrl !== undefined) {
      if (isWorkspaceGatewayUrl(entry.gatewayUrl) && isIdentifier(payload.sessionIdentity.agentId)) {
        validPaths.push({
          key: entry.gatewayUrl,
          input: {
            key: entry.gatewayUrl,
            gatewayUrl: entry.gatewayUrl,
            mimeType,
            agentId: payload.sessionIdentity.agentId,
          },
          resultKey,
        });
      }
      continue;
    }

    if (!entry.filePath) continue;
    const relativePath = resolveWorkspaceRelativePath(entry.filePath, payload.workspaceRoot);
    if (relativePath) {
      validPaths.push({
        key: entry.filePath,
        input: { key: entry.filePath, relativePath, mimeType },
        resultKey,
      });
    }
  }

  if (validPaths.length === 0) return result;
  try {
    const thumbnails = await hostCapabilityExecute<unknown>(workspaceMediaPayload(
      'media.thumbnails',
      payload.sessionIdentity,
      { paths: validPaths.map(({ input }) => input) },
    ));
    if (!isRecord(thumbnails)) return result;
    for (const entry of validPaths) {
      const thumbnail = thumbnails[entry.key];
      if (isMediaThumbnailResult(thumbnail)) result[entry.resultKey] = thumbnail;
    }
  } catch {
    // Batch thumbnail failures are soft failures per legacy contract.
  }
  return result;
}

type WorkspaceMediaThumbnailPayload = {
  relativePath: string;
  mimeType: string;
  sessionIdentity: SessionIdentity;
} | {
  gatewayUrl: string;
  mimeType: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
};

export async function hostWorkspaceMediaThumbnail(
  payload: WorkspaceMediaThumbnailPayload,
): Promise<FileThumbnailResult> {
  if ('relativePath' in payload && !isSafeWorkspaceRelativePath(payload.relativePath)) {
    return { preview: null, fileSize: 0, error: 'invalidPath' };
  }
  if ('gatewayUrl' in payload && (!isWorkspaceGatewayUrl(payload.gatewayUrl) || !isIdentifier(payload.agentId))) {
    return { preview: null, fileSize: 0, error: 'invalidPath' };
  }

  try {
    const input = 'relativePath' in payload
      ? { relativePath: payload.relativePath, mimeType: payload.mimeType }
      : {
        gatewayUrl: payload.gatewayUrl,
        mimeType: payload.mimeType,
        agentId: payload.agentId,
      };
    const thumbnail = await hostCapabilityExecute<unknown>(workspaceMediaPayload(
      'media.thumbnail',
      payload.sessionIdentity,
      input,
    ));
    return isMediaThumbnailResult(thumbnail)
      ? thumbnail
      : { preview: null, fileSize: 0, error: 'unavailable' };
  } catch (error) {
    return {
      preview: null,
      fileSize: 0,
      error: workspaceFailure(error instanceof Error ? error.message : error),
    };
  }
}

function isWorkspaceMediaAttachment(value: unknown): value is StagedFilePayload {
  return isRecord(value)
    && hasAllowedKeys(value, ['fileName', 'mimeType', 'fileSize', 'preview'], ['stagedAttachmentId', 'entryKind', 'sourcePath'])
    && (value.stagedAttachmentId === undefined || (typeof value.stagedAttachmentId === 'string' && value.stagedAttachmentId.length > 0))
    && (value.entryKind === undefined || value.entryKind === 'file' || value.entryKind === 'directory')
    && (value.entryKind !== 'directory' || (value.mimeType === 'application/x-directory' && value.fileSize === 0 && value.preview === null))
    && (value.entryKind === 'directory' || typeof value.stagedAttachmentId === 'string')
    && typeof value.fileName === 'string'
    && value.fileName.length > 0
    && typeof value.mimeType === 'string'
    && value.mimeType.length > 0
    && isSafeNonNegativeInteger(value.fileSize)
    && (value.preview === null || typeof value.preview === 'string')
    && (value.sourcePath === undefined || (typeof value.sourcePath === 'string' && value.sourcePath.trim().length > 0));
}

function isMediaThumbnailResult(value: unknown): value is FileThumbnailResult {
  return isRecord(value)
    && hasExactKeys(value, ['preview', 'fileSize'])
    && (value.preview === null || (typeof value.preview === 'string' && isCanonicalPreview(value.preview)))
    && isSafeNonNegativeInteger(value.fileSize);
}

function resolveWorkspaceRelativePath(value: string, workspaceRoot?: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (isSafeWorkspaceRelativePath(normalized)) return normalized;
  if (!workspaceRoot) return null;
  const root = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/$/, '');
  const comparableRoot = /^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root;
  const comparableValue = /^[A-Za-z]:\//.test(root) ? normalized.toLowerCase() : normalized;
  const prefix = root === '/' || root.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  if (!comparableValue.startsWith(prefix)) return null;
  const relativePath = normalized.slice(root.length + (root.endsWith('/') ? 0 : 1));
  return isSafeWorkspaceRelativePath(relativePath) ? relativePath : null;
}

function isSafeWorkspaceRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 4096
    && !value.includes('\0')
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes(':')
    && value.split(/[\\/]/).every((component) => component !== '' && component !== '.' && component !== '..');
}

function isWorkspaceGatewayUrl(value: string): boolean {
  return value.length > 0
    && value.length <= 4096
    && !hasControlCharacter(value)
    && /^(?:\/?api\/chat\/media\/outgoing\/[^/\s]+\/[^/\s]+\/[^\s]*|https?:\/\/[^/\s]+\/api\/chat\/media\/outgoing\/[^/\s]+\/[^/\s]+\/[^\s]*)$/.test(value);
}

function isIdentifier(value: string): boolean {
  return value.length > 0
    && value.length <= 4096
    && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export async function hostFileReadBinary(
  payload: WorkspaceFileRequest & { maxBytes?: number } & WorkspaceFileContext,
): Promise<ReadBinaryFileResult> {
  const result = await workspaceFileFetch('/api/files/binary', 'files.readBinary', payload, (value) => (
    isWorkspaceBinaryResponse(value) ? { ok: true, name: value.name, data: value.data, size: value.size } : null
  ));
  return typeof result === 'string' ? { ok: false, error: result } : result;
}

export async function hostFileStat(
  payload: WorkspaceFileRequest & WorkspaceFileContext,
): Promise<FilePreviewStatResult> {
  const result = await workspaceFileFetch('/api/files/binary', 'files.stat', payload, (value) => (
    isWorkspaceStatResponse(value)
      ? { ok: true, name: value.name, isDirectory: value.isDirectory, size: value.size, mtimeMs: value.mtimeMs }
      : null
  ));
  return typeof result === 'string' ? { ok: false, error: result } : result;
}

export async function hostFileListDir(
  payload: WorkspaceFileRequest & WorkspaceFileContext & { includeHidden?: boolean },
  options?: { timeoutMs?: number },
): Promise<FilePreviewListDirResult> {
  const result = await workspaceFileFetch('/api/files/list-dir', 'files.listDir', payload, (value) => (
    isWorkspaceDirectoryResponse(value) ? { ok: true, entries: value.entries } : null
  ), { timeoutMs: options?.timeoutMs ?? 60000 });
  return typeof result === 'string' ? { ok: false, error: result } : result;
}

function sessionCapabilityExecute<TResult>(input: {
  capabilityId: string;
  operationId: string;
  payload: Record<string, unknown>;
  scope: RuntimeScope;
  target?: CapabilityTarget | null;
}, options?: SessionCapabilityOptions): Promise<TResult> {
  return hostCapabilityExecute<TResult>(buildCapabilityExecutePayload({
    id: input.capabilityId,
    operationId: input.operationId,
    scope: input.scope,
    target: input.target,
    body: input.payload,
  }), { ...options, timeoutMs: options?.timeoutMs ?? SESSION_PEER_RPC_TIMEOUT_MS });
}

function sessionIdentityCapabilityExecute<TResult>(input: {
  capabilityId: string;
  operationId: string;
  payload: Record<string, unknown> & { sessionIdentity: SessionIdentity };
  target?: CapabilityTarget | null;
}, options?: SessionCapabilityOptions): Promise<TResult> {
  const identity = input.payload.sessionIdentity;
  return sessionCapabilityExecute<TResult>({
    capabilityId: input.capabilityId,
    operationId: input.operationId,
    scope: sessionScope(identity),
    target: input.target ?? { kind: 'session', identity },
    payload: input.payload,
  }, options);
}

export async function hostSessionList(
  payload: { endpoint: RuntimeEndpointRef },
  options?: { timeoutMs?: number },
): Promise<SessionListResult> {
  return sessionCapabilityExecute<SessionListResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.list',
    scope: runtimeInstanceScope(payload.endpoint),
    target: { kind: 'runtime-endpoint' },
    payload,
  }, options);
}

export async function hostCapabilitiesList(): Promise<{ capabilities: CapabilityDescriptor[] }> {
  return hostApiFetch('/api/capabilities/list');
}

export async function hostRuntimeAdaptersList(): Promise<{ adapters: RuntimeAdapterSummary[] }> {
  return hostApiFetch('/api/runtime-adapters/list');
}

export async function hostRuntimeAdapterInstancesList(): Promise<{ instances: RuntimeAdapterInstanceSummary[] }> {
  return hostApiFetch('/api/runtime-adapters/instances/list');
}

export async function hostRuntimeConnectorsList(): Promise<{ connectors: RuntimeConnectorSummary[] }> {
  return hostApiFetch('/api/runtime-connectors/list');
}

export async function hostRuntimeEndpointsList(): Promise<{ endpoints: RuntimeEndpointSummary[] }> {
  return hostApiFetch('/api/runtime-endpoints/list');
}

export async function hostRuntimeConnectorConnect(payload: {
  protocolId: string;
  connectorId: string;
  endpointId: string;
}): Promise<RuntimeConnectorEndpointLifecycleResult> {
  return hostApiFetch('/api/runtime-connectors/connect', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostRuntimeConnectorDisconnect(payload: {
  protocolId: string;
  connectorId: string;
  endpointId: string;
}): Promise<RuntimeConnectorEndpointLifecycleResult> {
  return hostApiFetch('/api/runtime-connectors/disconnect', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostCapabilityDescribe(payload: {
  id: string;
  scope: RuntimeScope;
}): Promise<{ capability: CapabilityDescriptor }> {
  return hostApiFetch('/api/capabilities/describe', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function buildCapabilityExecutePayload(input: {
  id: string;
  operationId: string;
  scope: RuntimeScope;
  target?: CapabilityTarget | null;
  body?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    operationId: input.operationId,
    scope: input.scope,
    target: input.target ?? null,
    input: input.body ?? {},
  };
}

async function hostCapabilityExecute<TResult = unknown>(
  payload: {
    id: string;
    operationId: string;
    scope: RuntimeScope;
    target?: CapabilityTarget | null;
    input?: unknown;
  },
  options?: SessionCapabilityOptions,
): Promise<TResult> {
  return hostApiFetch('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: options?.timeoutMs,
    traceId: options?.traceId,
  });
}

export async function hostOpenClawBrowserRequest<TResult = unknown>(
  input: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    timeoutMs?: number;
    target?: 'host' | 'node';
    node?: string;
  },
  options?: SessionCapabilityOptions,
): Promise<TResult> {
  return hostCapabilityExecute<TResult>({
    id: OPENCLAW_BROWSER_CAPABILITY_ID,
    operationId: 'browser.request',
    scope: runtimeInstanceScope(OPENCLAW_LOCAL_ENDPOINT),
    target: null,
    input,
  }, options);
}

export async function hostOpenClawMcpAppRequest<TResult = unknown>(
  input: { operationId: `mcp.app.${string}`; sessionKey: string; viewId: string; standalone?: boolean },
  options?: SessionCapabilityOptions,
): Promise<TResult> {
  const { operationId, ...requestInput } = input;
  return hostCapabilityExecute<TResult>({
    id: OPENCLAW_MCP_APP_CAPABILITY_ID,
    operationId,
    scope: runtimeInstanceScope(OPENCLAW_LOCAL_ENDPOINT),
    target: null,
    input: requestInput,
  }, options);
}

function bindSessionIdentityInput<T extends { sessionIdentity: SessionIdentity }>(
  payload: T,
): T & { sessionKey: string } {
  return {
    ...payload,
    sessionKey: payload.sessionIdentity.sessionKey,
  };
}

function sessionWireIdentityScope(identity: SessionWireIdentity): RuntimeScope {
  return { kind: 'session', identity } as unknown as RuntimeScope;
}

function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return value === 'read-only' || value === 'guarded' || value === 'workspace' || value === 'full';
}

function isSessionPermissionSelection(value: unknown): value is SessionPermissionSelection {
  return value === null || isSessionPermissionMode(value);
}

function decodeHostSessionPermissionResult(
  value: unknown,
  optionalKeys: readonly string[] = [],
): HostSessionPermissionResult {
  if (!isRecord(value)
    || !hasAllowedKeys(value, ['supported', 'mode', 'pending', 'canSelectFull', 'options'], ['defaultMode', 'reason', ...optionalKeys])
    || typeof value.supported !== 'boolean'
    || !isSessionPermissionSelection(value.mode)
    || typeof value.pending !== 'boolean'
    || typeof value.canSelectFull !== 'boolean'
    || !Array.isArray(value.options)
    || !value.options.every(isSessionPermissionMode)
    || (value.reason !== undefined && typeof value.reason !== 'string')) {
    throw new Error('Invalid session permission result');
  }
  if (!value.supported) {
    if (value.mode !== null || value.pending || value.canSelectFull || value.options.length !== 0) {
      throw new Error('Invalid session permission result');
    }
    return {
      supported: false,
      mode: null,
      pending: false,
      canSelectFull: false,
      options: [],
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
  }
  if (value.defaultMode !== undefined && !isSessionPermissionMode(value.defaultMode)) {
    throw new Error('Invalid session permission result');
  }
  return {
    supported: true,
    mode: value.mode,
    ...(value.defaultMode === undefined ? {} : { defaultMode: value.defaultMode }),
    pending: value.pending,
    canSelectFull: value.canSelectFull,
    options: value.options,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function decodeHostSessionPermissionSetResult(value: unknown): HostSessionPermissionSetResult {
  const result = decodeHostSessionPermissionResult(value, ['changed']);
  if (isRecord(value) && Object.hasOwn(value, 'changed') && typeof value.changed !== 'boolean') {
    throw new Error('Invalid session permission result');
  }
  return {
    ...result,
    ...(isRecord(value) && typeof value.changed === 'boolean' ? { changed: value.changed } : {}),
  };
}

export async function hostSessionWindowFetch(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    mode?: 'latest' | 'older' | 'newer';
    limit?: number;
    offset?: number;
    includeCanonical?: boolean;
  },
): Promise<HostSessionWindowResult> {
  return sessionIdentityCapabilityExecute<HostSessionWindowResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.window',
    payload: bindSessionIdentityInput(payload),
  });
}

export async function hostSessionPermissionGet(
  payload: { identity: SessionWireIdentity },
  options?: SessionCapabilityOptions,
): Promise<HostSessionPermissionResult> {
  const result = await sessionCapabilityExecute<unknown>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.permission.get',
    scope: sessionWireIdentityScope(payload.identity),
    target: { kind: 'session', identity: payload.identity },
    payload: {
      sessionKey: payload.identity.sessionKey,
      sessionIdentity: payload.identity,
    },
  }, options);
  return decodeHostSessionPermissionResult(result);
}

export async function hostSessionPermissionSet(
  payload: { identity: SessionWireIdentity; selection: SessionPermissionSelection },
  options?: SessionCapabilityOptions,
): Promise<HostSessionPermissionSetResult> {
  const result = await sessionCapabilityExecute<unknown>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.permission.set',
    scope: sessionWireIdentityScope(payload.identity),
    target: { kind: 'session', identity: payload.identity },
    payload: {
      sessionKey: payload.identity.sessionKey,
      sessionIdentity: payload.identity,
      permissionMode: payload.selection,
    },
  }, options);
  return decodeHostSessionPermissionSetResult(result);
}

export async function hostSessionContentLoad(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    contentRef: string;
    offset: number;
    limit?: number;
  },
  options?: SessionCapabilityOptions,
): Promise<HostSessionContentLoadResult> {
  const result = await sessionIdentityCapabilityExecute<unknown>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.content.load',
    payload: bindSessionIdentityInput(payload),
  }, options);
  return decodeSessionContentLoadResult(result);
}

export async function hostSessionNew(
  payload: {
    endpointSessionId?: string;
    endpoint: RuntimeEndpointRef;
    agentId: string;
  },
  options?: Pick<SessionCapabilityOptions, 'traceId'>,
): Promise<SessionView | { outcome: 'target_rejected' | 'unknown' }> {
  return sessionCapabilityExecute<SessionView | { outcome: 'target_rejected' | 'unknown' }>({
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    operationId: 'sessions.create',
    scope: agentScope(payload.endpoint, payload.agentId),
    target: { kind: 'agent', agentId: payload.agentId },
    payload,
  }, { traceId: options?.traceId });
}

export async function hostSessionDelete(
  payload: {
    sessionIdentity: SessionIdentity;
  },
): Promise<{ success: boolean; error?: string }> {
  return sessionIdentityCapabilityExecute<{ success: boolean; error?: string }>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.delete',
    payload,
  });
}

export async function hostSessionRename(
  payload: {
    sessionIdentity: SessionIdentity;
    label: string;
  },
): Promise<{ success: boolean; sessionKey?: string; label?: string; error?: string }> {
  return sessionIdentityCapabilityExecute<{ success: boolean; sessionKey?: string; label?: string; error?: string }>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.rename',
    payload,
  });
}

export async function hostSessionArchive(
  payload: {
    sessionIdentity: SessionIdentity;
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return sessionIdentityCapabilityExecute<{ success: boolean; sessionKey?: string; status?: string; error?: string }>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.archive',
    payload,
  });
}

export async function hostSessionUnarchive(
  payload: {
    sessionIdentity: SessionIdentity;
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return sessionIdentityCapabilityExecute<{ success: boolean; sessionKey?: string; status?: string; error?: string }>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.unarchive',
    payload,
  });
}

export async function hostSessionUpdateStatus(
  payload: {
    sessionIdentity: SessionIdentity;
    status: 'active' | 'completed' | 'archived' | 'deleted';
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return sessionIdentityCapabilityExecute<{ success: boolean; sessionKey?: string; status?: string; error?: string }>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.updateStatus',
    payload,
  });
}

export async function hostSessionLoad(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    limit?: number;
  },
  options?: SessionCapabilityOptions,
): Promise<HostSessionLoadResult> {
  const input = bindSessionIdentityInput(payload);
  logSessionTrace('history.host-api.request', options?.traceId, {
    sessionKey: summarizeIdentifier(input.sessionKey),
    endpointSessionId: summarizeIdentifier(input.endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(input.sessionIdentity),
    limit: input.limit ?? null,
    timeoutMs: options?.timeoutMs ?? SESSION_PEER_RPC_TIMEOUT_MS,
  });
  try {
    const result = await sessionIdentityCapabilityExecute<HostSessionLoadResult>({
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.load',
      payload: input,
    }, options);
    logSessionTrace('history.host-api.response', options?.traceId, {
      rawType: result && typeof result === 'object' ? 'object' : typeof result,
    });
    return result;
  } catch (error) {
    logSessionTrace('history.host-api.error', options?.traceId, summarizeError(error));
    throw error;
  }
}

export async function hostSessionSwitch(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    limit?: number;
  },
): Promise<HostSessionLoadResult> {
  return sessionIdentityCapabilityExecute<HostSessionLoadResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.switch',
    payload: bindSessionIdentityInput(payload),
  });
}

export async function hostSessionResume(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
  },
): Promise<HostSessionLoadResult> {
  return sessionIdentityCapabilityExecute<HostSessionLoadResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.resume',
    payload: bindSessionIdentityInput(payload),
  });
}

export async function hostSessionState(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
  },
): Promise<HostSessionLoadResult> {
  return sessionIdentityCapabilityExecute<HostSessionLoadResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.state',
    payload: bindSessionIdentityInput(payload),
  });
}

export async function hostSessionAbort(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    runId?: string;
    approvalIds?: string[];
  },
): Promise<HostSessionAbortResult> {
  return sessionIdentityCapabilityExecute<HostSessionAbortResult>({
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    operationId: 'sessions.abort',
    payload: bindSessionIdentityInput(payload),
  }, { timeoutMs: SESSION_PEER_RPC_TIMEOUT_MS });
}

export async function hostSessionApprovals(
  payload: { sessionIdentity: SessionIdentity; endpointSessionId: string },
): Promise<{ approvals: SessionApprovalRequestItem[] }> {
  return sessionIdentityCapabilityExecute<{ approvals: SessionApprovalRequestItem[] }>({
    capabilityId: SESSION_APPROVAL_CAPABILITY_ID,
    operationId: 'approvals.list',
    payload,
  });
}

export async function hostSessionResolveApproval(
  payload: {
    id: string;
    endpointSessionId: string;
    sessionIdentity: SessionIdentity;
    decision: SessionApprovalDecision;
    request?: Record<string, unknown>;
  },
): Promise<unknown> {
  return sessionIdentityCapabilityExecute<unknown>({
    capabilityId: SESSION_APPROVAL_CAPABILITY_ID,
    operationId: 'approvals.resolve',
    target: { kind: 'approval', identity: payload.sessionIdentity, approvalId: payload.id },
    payload: bindSessionIdentityInput(payload),
  });
}

export type HostSessionModelSelectionResult =
  | Readonly<{ outcome: 'succeeded'; modelState: SessionModelState }>
  | Readonly<{ outcome: 'target_rejected' | 'outcome_unknown' }>;

export async function hostSessionPatch(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    modelSelectionId: string;
  },
  options?: Pick<SessionCapabilityOptions, 'traceId'>,
): Promise<HostSessionModelSelectionResult> {
  const input = bindSessionIdentityInput(payload);
  logSessionTrace('model-selection.host-api.request', options?.traceId, {
    endpointSessionId: summarizeIdentifier(input.endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(input.sessionIdentity),
    sessionKey: summarizeIdentifier(input.sessionKey),
    modelSelectionId: summarizeIdentifier(input.modelSelectionId),
  });
  try {
    const result = await sessionIdentityCapabilityExecute<HostSessionModelSelectionResult>({
      capabilityId: SESSION_MODEL_SELECTION_CAPABILITY_ID,
      operationId: 'sessions.patchModel',
      target: { kind: 'model-selection', identity: payload.sessionIdentity, modelSelectionId: payload.modelSelectionId },
      payload: input,
    }, { timeoutMs: SESSION_PEER_RPC_TIMEOUT_MS, traceId: options?.traceId });
    logSessionTrace('model-selection.host-api.response', options?.traceId, { outcome: result.outcome });
    return result;
  } catch (error) {
    logSessionTrace('model-selection.host-api.error', options?.traceId, summarizeError(error));
    throw error;
  }
}

export async function hostSessionPrompt(
  payload: {
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    message: string;
    idempotencyKey?: string;
    deliver?: boolean;
    attachments?: Array<{
      stagedAttachmentId: string;
      fileName: string;
      mimeType: string;
      fileSize: number;
    }>;
  },
  options?: Pick<SessionCapabilityOptions, 'traceId'>,
): Promise<HostSessionPromptResult> {
  return sessionIdentityCapabilityExecute<HostSessionPromptResult>({
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    operationId: payload.attachments?.length ? 'sessions.sendWithMedia' : 'sessions.prompt',
    payload: bindSessionIdentityInput(payload),
  }, { timeoutMs: SESSION_PEER_RPC_TIMEOUT_MS, traceId: options?.traceId });
}
