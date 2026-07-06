import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { normalizeAppError } from './error-model';
import {
  decodeHostApiProxyEnvelope,
  type HostApiProxyEnvelope,
  unwrapHostApiProxyEnvelope,
} from './host-api-transport-contract';
import { subscribeHostEvent } from './host-events';
import {
  buildCapabilityScopeKey,
  agentScope,
  runtimeInstanceScope,
  sessionScope,
  type CapabilityTarget,
  type RuntimeEndpointRef,
  type RuntimeScope,
  type SessionIdentity,
} from '../../runtime-host/shared/runtime-address';
import type { CapabilityDescriptor } from '../../runtime-host/shared/capability-descriptor';
import type { RuntimeAdapterInstanceSummary, RuntimeAdapterSummary, RuntimeConnectorEndpointLifecycleResult, RuntimeConnectorSummary, RuntimeEndpointSummary } from '../../runtime-host/shared/runtime-topology';
import type {
  SessionApprovalRequestItem,
  SessionCatalogItem,
  SessionLoadResult,
  SessionListResult,
  SessionNewResult,
  SessionPromptResult,
  SessionStateSnapshot,
  SessionWindowResult,
} from '../../runtime-host/shared/session-adapter-types';

const HOST_API_PORT = 13210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;
const SESSION_ABORT_TIMEOUT_MS = 5_000;
const SESSION_PROMPT_TIMEOUT_MS = 10_000;
const SESSION_PATCH_TIMEOUT_MS = 15_000;
const WORKSPACE_FILE_CAPABILITY_ID = 'workspace.file';
const RUNTIME_HOST_CAPABILITY_ID = 'runtime.host';
const SESSION_MANAGEMENT_CAPABILITY_ID = 'session.management';
const SESSION_PROMPT_CAPABILITY_ID = 'session.prompt';
const SESSION_APPROVAL_CAPABILITY_ID = 'session.approval';
const SESSION_MODEL_SELECTION_CAPABILITY_ID = 'session.modelSelection';
const RUNTIME_JOB_INITIAL_POLL_MS = 500;
const RUNTIME_JOB_MAX_POLL_MS = 5_000;
const RUNTIME_JOB_NOT_FOUND_GRACE_MS = 2_000;
const CAPABILITY_SCOPE_CACHE_TTL_MS = 5_000;
let cachedHostApiToken: string | null = null;
const capabilityScopeCache = new Map<string, { scope: RuntimeScope; expiresAt: number }>();
const capabilityScopeInflight = new Map<string, Promise<RuntimeScope>>();

type HostApiRequestInit = RequestInit & {
  timeoutMs?: number;
};

export interface RuntimeJobSnapshot<TResult = unknown> {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  maxAttempts: number;
  progress?: {
    updatedAt: number;
    percent?: number;
    message?: string;
  };
  result?: TResult;
  error?: string;
}

export interface RuntimeJobSubmission<TResult = unknown> {
  success: true;
  job: RuntimeJobSnapshot<TResult>;
}

export interface RuntimeJobLookupResult<TResult = unknown> {
  success: true;
  job: RuntimeJobSnapshot<TResult> | null;
}

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
  | string;

export interface FilePreviewDirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  hasChildren?: boolean;
}

export interface ReadTextFileResult {
  ok: boolean;
  path?: string;
  content?: string;
  mimeType?: string;
  size?: number;
  readOnly?: boolean;
  error?: FilePreviewError;
}

export interface WriteTextFileResult {
  ok: boolean;
  path?: string;
  error?: FilePreviewError;
}

export interface StagedFilePayload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
}

export interface FileThumbnailResult {
  preview: string | null;
  fileSize: number;
}

export interface WorkspaceFileContext {
  workspaceId?: string;
  sourceId?: string;
}

export interface ReadBinaryFileResult {
  ok: boolean;
  path?: string;
  data?: string;
  mimeType?: string;
  size?: number;
  readOnly?: boolean;
  error?: FilePreviewError;
}

export interface FilePreviewStatResult {
  ok: boolean;
  entry?: FilePreviewDirEntry;
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

export type OpenClawToolPermissionMode = 'default' | 'fullAccess';

export interface OpenClawToolPermissionModePayload {
  mode: OpenClawToolPermissionMode;
}

export type HostSessionCatalogItem = SessionCatalogItem;

export type HostSessionLoadResult = Partial<SessionLoadResult> & {
  hydrationJob?: RuntimeJobSnapshot<SessionLoadResult>;
};

export type HostSessionWindowResult = Partial<SessionWindowResult> & {
  hydrationJob?: RuntimeJobSnapshot<SessionWindowResult>;
};

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

async function getHostApiToken(): Promise<string> {
  if (cachedHostApiToken && cachedHostApiToken.trim()) {
    return cachedHostApiToken;
  }

  const token = await invokeIpc<unknown>('hostapi:token');
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Host API token unavailable');
  }

  cachedHostApiToken = token;
  return token;
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
      headers: headersToRecord(init?.headers),
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
      message: normalized.message,
      code: normalized.code,
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

export async function createHostEventSource(path = '/api/events'): Promise<EventSource> {
  const token = await getHostApiToken();
  const url = new URL(path, HOST_API_BASE);
  url.searchParams.set('token', token);
  return new EventSource(url.toString());
}

export function getHostApiBase(): string {
  return HOST_API_BASE;
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

export async function hostOpenClawGetToolPermissionMode(): Promise<OpenClawToolPermissionModePayload> {
  return hostApiFetch('/api/openclaw/tool-permission-mode');
}

export async function hostOpenClawSetToolPermissionMode(
  mode: OpenClawToolPermissionMode,
): Promise<OpenClawToolPermissionModePayload> {
  return hostApiFetch('/api/openclaw/tool-permission-mode', {
    method: 'PUT',
    body: JSON.stringify({ mode }),
  });
}

export async function hostUvCheck(): Promise<boolean> {
  return hostApiFetch('/api/toolchain/uv/check');
}

export async function hostUvInstallAll(endpoint: RuntimeEndpointRef): Promise<RuntimeJobSubmission> {
  return hostCapabilityExecute(buildCapabilityExecutePayload({
    id: 'platform.runtime',
    operationId: 'toolchain.installUv',
    scope: runtimeInstanceScope(endpoint),
    target: { kind: 'runtime-job' },
  }));
}

async function workspaceFileCapabilityExecute<TResult>(operationId: string, input: { sessionIdentity: SessionIdentity } & WorkspaceFileContext, options?: { timeoutMs?: number }): Promise<TResult> {
  const path = typeof (input as { path?: unknown }).path === 'string' ? (input as { path?: string }).path! : '';
  const { workspaceId: _workspaceId, sourceId: _sourceId, ...body } = input;
  const target = operationId === 'files.stagePaths' || operationId === 'files.stageBuffer'
    ? { kind: 'workspace-staging' as const, identity: input.sessionIdentity }
    : { kind: 'workspace-file' as const, path, identity: input.sessionIdentity };
  return hostCapabilityExecute<TResult>(buildCapabilityExecutePayload({
    id: WORKSPACE_FILE_CAPABILITY_ID,
    operationId,
    scope: { kind: 'workspace', endpoint: input.sessionIdentity.endpoint },
    target,
    body: body as unknown as Record<string, unknown>,
  }), options);
}

export async function hostFileReadText(
  payload: {
    path: string;
    maxBytes?: number;
    sessionIdentity: SessionIdentity;
  } & WorkspaceFileContext,
): Promise<ReadTextFileResult> {
  return await workspaceFileCapabilityExecute<ReadTextFileResult>('files.readText', payload);
}

export async function hostFileWriteText(
  payload: {
    path: string;
    content: string;
    sessionIdentity: SessionIdentity;
  } & WorkspaceFileContext,
): Promise<WriteTextFileResult> {
  return await workspaceFileCapabilityExecute<WriteTextFileResult>('files.writeText', payload);
}

export async function hostFileStagePaths(payload: { filePaths: string[]; sessionIdentity: SessionIdentity } & WorkspaceFileContext): Promise<StagedFilePayload[]> {
  return await workspaceFileCapabilityExecute<StagedFilePayload[]>('files.stagePaths', payload);
}

export async function hostFileStageBuffer(payload: {
  base64: string;
  fileName: string;
  mimeType: string;
  sessionIdentity: SessionIdentity;
} & WorkspaceFileContext): Promise<StagedFilePayload> {
  return await workspaceFileCapabilityExecute<StagedFilePayload>('files.stageBuffer', payload);
}

export async function hostFileThumbnail(payload: {
  path: string;
  mimeType: string;
  sessionIdentity: SessionIdentity;
} & WorkspaceFileContext): Promise<FileThumbnailResult> {
  return await workspaceFileCapabilityExecute<FileThumbnailResult>('files.thumbnail', payload);
}

export async function hostFileReadBinary(
  payload: {
    path: string;
    maxBytes?: number;
    sessionIdentity: SessionIdentity;
  } & WorkspaceFileContext,
): Promise<ReadBinaryFileResult> {
  return await workspaceFileCapabilityExecute<ReadBinaryFileResult>('files.readBinary', payload);
}

export async function hostFileStat(
  payload: {
    path: string;
    sessionIdentity: SessionIdentity;
  } & WorkspaceFileContext,
): Promise<FilePreviewStatResult> {
  return await workspaceFileCapabilityExecute<FilePreviewStatResult>('files.stat', payload);
}

export async function hostFileListDir(
  payload: {
    path: string;
    includeHidden?: boolean;
    sessionIdentity: SessionIdentity;
  } & WorkspaceFileContext,
  options?: {
    timeoutMs?: number;
  },
): Promise<FilePreviewListDirResult> {
  return await workspaceFileCapabilityExecute<FilePreviewListDirResult>('files.listDir', payload, {
    timeoutMs: options?.timeoutMs ?? 60000,
  });
}

function sessionCapabilityExecute<TResult>(input: {
  capabilityId: string;
  operationId: string;
  payload: Record<string, unknown>;
  scope: RuntimeScope;
  target?: CapabilityTarget | null;
}, options?: { timeoutMs?: number }): Promise<TResult> {
  return hostCapabilityExecute<TResult>(buildCapabilityExecutePayload({
    id: input.capabilityId,
    operationId: input.operationId,
    scope: input.scope,
    target: input.target,
    body: input.payload,
  }), options);
}

function sessionIdentityCapabilityExecute<TResult>(input: {
  capabilityId: string;
  operationId: string;
  payload: Record<string, unknown> & { sessionIdentity: SessionIdentity };
  target?: CapabilityTarget | null;
}, options?: { timeoutMs?: number }): Promise<TResult> {
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
): Promise<SessionListResult> {
  return sessionCapabilityExecute<SessionListResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.list',
    scope: runtimeInstanceScope(payload.endpoint),
    target: { kind: 'runtime-endpoint' },
    payload,
  });
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
  options?: {
    timeoutMs?: number;
  },
): Promise<TResult> {
  return hostApiFetch('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: options?.timeoutMs,
  });
}

function runtimeHostOperationTarget(operationId: string): CapabilityTarget {
  return operationId === 'runtimeHost.prepareGatewayLaunch'
    || operationId === 'runtimeHost.gatewayLifecycle'
    || operationId === 'runtimeHost.gatewayReady'
    || operationId === 'runtimeHost.gatewayControlUiAutoApprove'
    ? { kind: 'gateway-control' }
    : (operationId === 'runtimeHost.jobGet' ? { kind: 'runtime-job' } : { kind: 'runtime-endpoint' });
}

async function runtimeHostCapabilityExecute<TResult>(operationId: string, endpoint: RuntimeEndpointRef, input: Record<string, unknown> = {}): Promise<TResult> {
  return await hostCapabilityExecute<TResult>(buildCapabilityExecutePayload({
    id: RUNTIME_HOST_CAPABILITY_ID,
    operationId,
    scope: runtimeInstanceScope(endpoint),
    target: runtimeHostOperationTarget(operationId),
    body: input,
  }));
}

async function resolveRuntimeHostJobEndpoint(): Promise<RuntimeEndpointRef> {
  const scope = await resolveSingleCapabilityScope(RUNTIME_HOST_CAPABILITY_ID);
  if (scope.kind !== 'runtime-instance') {
    throw new Error(`runtime.host job lookup requires runtime-instance scope, got ${scope.kind}`);
  }
  return scope.endpoint;
}

export async function hostRuntimePrepareGatewayLaunch(payload: {
  gatewayToken?: string;
  proxyEnabled?: boolean;
  proxyServer?: string;
  proxyBypassRules?: string;
}, endpoint: RuntimeEndpointRef): Promise<RuntimeJobSubmission> {
  return await runtimeHostCapabilityExecute<RuntimeJobSubmission>('runtimeHost.prepareGatewayLaunch', endpoint, payload);
}

export async function hostRuntimeSyncProviderAuthBootstrap(endpoint: RuntimeEndpointRef): Promise<RuntimeJobSubmission> {
  return await runtimeHostCapabilityExecute<RuntimeJobSubmission>('runtimeHost.syncProviderAuthBootstrap', endpoint);
}

export async function hostRuntimeGatewayLifecycle(payload: Record<string, unknown>, endpoint: RuntimeEndpointRef): Promise<{ success: boolean; job?: RuntimeJobSnapshot }> {
  return await runtimeHostCapabilityExecute<{ success: boolean; job?: RuntimeJobSnapshot }>('runtimeHost.gatewayLifecycle', endpoint, payload);
}

export async function hostRuntimeGatewayReady(endpoint: RuntimeEndpointRef, input: Record<string, unknown> = {}): Promise<unknown> {
  return await runtimeHostCapabilityExecute<unknown>('runtimeHost.gatewayReady', endpoint, input);
}

export async function hostRuntimeGatewayControlUiAutoApprove(endpoint: RuntimeEndpointRef, input: Record<string, unknown> = {}): Promise<unknown> {
  return await runtimeHostCapabilityExecute<unknown>('runtimeHost.gatewayControlUiAutoApprove', endpoint, input);
}

export async function hostDiagnosticsCollect(endpoint: RuntimeEndpointRef): Promise<RuntimeJobSubmission> {
  return await runtimeHostCapabilityExecute<RuntimeJobSubmission>('diagnostics.collect', endpoint);
}

export async function hostRuntimeJobGet<TResult = unknown>(jobId: string, endpoint: RuntimeEndpointRef): Promise<RuntimeJobLookupResult<TResult>> {
  return await hostCapabilityExecute<RuntimeJobLookupResult<TResult>>(buildCapabilityExecutePayload({
    id: RUNTIME_HOST_CAPABILITY_ID,
    operationId: 'runtimeHost.jobGet',
    scope: runtimeInstanceScope(endpoint),
    target: { kind: 'runtime-job', jobId },
    body: { jobId },
  }));
}

export async function waitForRuntimeJobResult<TResult = void>(
  jobId: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    endpoint?: RuntimeEndpointRef;
  } = {},
): Promise<TResult> {
  const timeoutMs = options.timeoutMs ?? 120000;
  const intervalMs = options.intervalMs ?? RUNTIME_JOB_INITIAL_POLL_MS;

  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();
    let timeoutHandle: number | null = null;
    let pollHandle: number | null = null;
    let unsubscribe: (() => void) | null = null;
    let pollIntervalMs = intervalMs;

    const clearHandles = () => {
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (pollHandle !== null) {
        window.clearTimeout(pollHandle);
        pollHandle = null;
      }
      unsubscribe?.();
      unsubscribe = null;
    };

    const finalize = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearHandles();
      action();
    };

    const handleSnapshot = (snapshot: RuntimeJobSnapshot<TResult> | null | undefined): boolean => {
      if (!snapshot) {
        if (Date.now() - startedAt >= RUNTIME_JOB_NOT_FOUND_GRACE_MS) {
          finalize(() => reject(new Error(`runtime job not found: ${jobId}`)));
          return true;
        }
        return false;
      }
      if (snapshot.id !== jobId) {
        return false;
      }
      if (snapshot.status === 'succeeded') {
        finalize(() => resolve(snapshot.result as TResult));
        return true;
      }
      if (snapshot.status === 'failed') {
        finalize(() => reject(new Error(snapshot.error || `runtime job failed: ${snapshot.type}`)));
        return true;
      }
      return false;
    };

    const poll = () => {
      if (settled) {
        return;
      }
      void (async () => hostRuntimeJobGet<TResult>(jobId, options.endpoint ?? await resolveRuntimeHostJobEndpoint()))()
        .then((response) => {
          if (settled || handleSnapshot(response.job)) {
            return;
          }
          pollHandle = window.setTimeout(poll, pollIntervalMs);
          pollIntervalMs = Math.min(Math.max(pollIntervalMs * 2, intervalMs), RUNTIME_JOB_MAX_POLL_MS);
        })
        .catch((error) => {
          finalize(() => reject(error));
        });
    };

    unsubscribe = subscribeHostEvent<RuntimeJobSnapshot<TResult>>('runtime-job:done', (snapshot) => {
      handleSnapshot(snapshot);
    });

    timeoutHandle = window.setTimeout(() => {
      finalize(() => reject(new Error(`runtime job timed out: ${jobId}`)));
    }, timeoutMs);

    poll();
  });
}

export async function resolveHydratedSessionSnapshot(input: {
  initial: { hydrationJob?: RuntimeJobSnapshot<unknown>; snapshot?: SessionStateSnapshot };
  refetch: () => Promise<{ snapshot?: SessionStateSnapshot }>;
  timeoutMs?: number;
}): Promise<SessionStateSnapshot | null> {
  if (input.initial.snapshot) {
    return input.initial.snapshot;
  }
  const hydrationJobId = input.initial.hydrationJob?.id;
  if (!hydrationJobId) {
    return null;
  }
  const endpoint = input.initial.hydrationJob?.result && typeof input.initial.hydrationJob.result === 'object' && 'sessionIdentity' in input.initial.hydrationJob.result
    ? (input.initial.hydrationJob.result as { sessionIdentity?: SessionIdentity }).sessionIdentity?.endpoint
    : undefined;
  await waitForRuntimeJobResult(hydrationJobId, {
    timeoutMs: input.timeoutMs,
    endpoint,
  });
  const result = await input.refetch();
  return result.snapshot ?? null;
}

export async function hostSessionWindowFetch(
  payload: {
    sessionKey: string;
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
    payload,
  });
}

export async function hostSessionNew(
  payload: {
    sessionKey?: string;
    endpointSessionId?: string;
    endpoint: RuntimeEndpointRef;
    agentId: string;
  },
): Promise<SessionNewResult> {
  return sessionCapabilityExecute<SessionNewResult>({
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    operationId: 'sessions.create',
    scope: agentScope(payload.endpoint, payload.agentId),
    target: { kind: 'agent', agentId: payload.agentId },
    payload,
  });
}

export async function hostSessionDelete(
  payload: {
    sessionKey: string;
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
    sessionKey: string;
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
    sessionKey: string;
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
    sessionKey: string;
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
    sessionKey: string;
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
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    limit?: number;
  },
  options?: {
    timeoutMs?: number;
  },
): Promise<HostSessionLoadResult> {
  return sessionIdentityCapabilityExecute<HostSessionLoadResult>({
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    operationId: 'sessions.load',
    payload,
  }, options);
}

export async function hostSessionSwitch(
  payload: {
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    limit?: number;
  },
): Promise<HostSessionLoadResult> {
  return sessionIdentityCapabilityExecute<HostSessionLoadResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.switch',
    payload,
  });
}

export async function hostSessionResume(
  payload: {
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
  },
): Promise<HostSessionLoadResult> {
  return sessionIdentityCapabilityExecute<HostSessionLoadResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.resume',
    payload,
  });
}

export async function hostSessionState(
  payload: {
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
  },
): Promise<HostSessionLoadResult> {
  return sessionIdentityCapabilityExecute<HostSessionLoadResult>({
    capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
    operationId: 'sessions.state',
    payload,
  });
}

export async function hostSessionAbort(
  payload: {
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    approvalIds?: string[];
  },
): Promise<SessionLoadResult & { success?: boolean }> {
  return sessionIdentityCapabilityExecute<SessionLoadResult & { success?: boolean }>({
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    operationId: 'sessions.abort',
    payload,
  }, { timeoutMs: SESSION_ABORT_TIMEOUT_MS });
}

export async function hostSessionApprovals(
  payload: { sessionIdentity: SessionIdentity },
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
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    decision: string;
  },
): Promise<unknown> {
  return sessionIdentityCapabilityExecute<unknown>({
    capabilityId: SESSION_APPROVAL_CAPABILITY_ID,
    operationId: 'approvals.resolve',
    target: { kind: 'approval', identity: payload.sessionIdentity, approvalId: payload.id },
    payload,
  });
}

export async function hostSessionPatch(
  payload: {
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    runtimeModelRef: string;
  },
): Promise<SessionLoadResult & { success?: boolean; error?: string }> {
  return sessionIdentityCapabilityExecute<SessionLoadResult & { success?: boolean; error?: string }>({
    capabilityId: SESSION_MODEL_SELECTION_CAPABILITY_ID,
    operationId: 'sessions.patchModel',
    target: { kind: 'model-selection', identity: payload.sessionIdentity, runtimeModelRef: payload.runtimeModelRef },
    payload,
  }, { timeoutMs: SESSION_PATCH_TIMEOUT_MS });
}

export async function hostSessionPrompt(
  payload: {
    sessionKey: string;
    endpointSessionId?: string;
    sessionIdentity: SessionIdentity;
    message: string;
    idempotencyKey?: string;
    deliver?: boolean;
    media?: Array<{
      filePath: string;
      mimeType?: string;
      fileName?: string;
      fileSize?: number;
      preview?: string | null;
    }>;
  },
): Promise<SessionPromptResult> {
  return sessionIdentityCapabilityExecute<SessionPromptResult>({
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    operationId: payload.media?.length ? 'sessions.sendWithMedia' : 'sessions.prompt',
    payload,
  }, { timeoutMs: SESSION_PROMPT_TIMEOUT_MS });
}
