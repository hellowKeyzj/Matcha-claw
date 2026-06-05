import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { normalizeAppError } from './error-model';
import {
  decodeHostApiProxyEnvelope,
  type HostApiProxyEnvelope,
  unwrapHostApiProxyEnvelope,
} from './host-api-transport-contract';
import { subscribeHostEvent } from './host-events';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';
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
const RUNTIME_JOB_INITIAL_POLL_MS = 500;
const RUNTIME_JOB_MAX_POLL_MS = 5_000;
const RUNTIME_JOB_NOT_FOUND_GRACE_MS = 2_000;
const CAPABILITY_ADDRESS_CACHE_TTL_MS = 5_000;
let cachedHostApiToken: string | null = null;
const capabilityAddressCache = new Map<string, { address: RuntimeAddress; expiresAt: number }>();

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

export type HostSessionCatalogItem = SessionCatalogItem;

export type HostSessionLoadResult = Partial<SessionLoadResult> & {
  hydrationJob?: RuntimeJobSnapshot<SessionLoadResult>;
};

export type HostSessionWindowResult = Partial<SessionWindowResult> & {
  hydrationJob?: RuntimeJobSnapshot<SessionWindowResult>;
};

function runtimeAddressForCapability(address: RuntimeAddress, capabilityId: string): RuntimeAddress {
  return {
    ...address,
    capabilityId,
  };
}

export async function resolveSingleCapabilityRuntimeAddress(capabilityId: string): Promise<RuntimeAddress> {
  const now = Date.now();
  const cached = capabilityAddressCache.get(capabilityId);
  if (cached && cached.expiresAt > now) {
    return cached.address;
  }
  const { capabilities } = await hostCapabilitiesList();
  const available = capabilities.filter((capability) => capability.id === capabilityId && capability.availability === 'available');
  if (available.length !== 1) {
    capabilityAddressCache.delete(capabilityId);
    throw new Error(`Expected exactly one RuntimeAddress for capability: ${capabilityId}`);
  }
  const address = available[0].address;
  capabilityAddressCache.set(capabilityId, {
    address,
    expiresAt: now + CAPABILITY_ADDRESS_CACHE_TTL_MS,
  });
  return address;
}

export function runtimeAddressForAgentCapability(input: {
  runtimeAddress: RuntimeAddress;
  capabilityId: string;
  agentId: string;
  sessionKey?: string;
}): RuntimeAddress {
  return {
    ...input.runtimeAddress,
    capabilityId: input.capabilityId,
    agentId: input.agentId,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  };
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

export async function hostUvCheck(): Promise<boolean> {
  return hostApiFetch('/api/toolchain/uv/check');
}

export async function hostUvInstallAll(runtimeAddress: RuntimeAddress): Promise<RuntimeJobSubmission> {
  return hostCapabilityExecute(buildCapabilityExecutePayload({
    id: 'platform.runtime',
    operationId: 'toolchain.installUv',
    runtimeAddress,
  }));
}

async function workspaceFileCapabilityExecute<TResult>(operationId: string, input: Record<string, unknown> & { runtimeAddress: RuntimeAddress }, options?: { timeoutMs?: number }): Promise<TResult> {
  const runtimeAddress = runtimeAddressForCapability(input.runtimeAddress, WORKSPACE_FILE_CAPABILITY_ID);
  return hostCapabilityExecute<TResult>(buildCapabilityExecutePayload({
    id: WORKSPACE_FILE_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    body: input,
  }), options);
}

export async function hostFileReadText(
  payload: {
    path: string;
    maxBytes?: number;
    runtimeAddress: RuntimeAddress;
  },
): Promise<ReadTextFileResult> {
  return await workspaceFileCapabilityExecute<ReadTextFileResult>('files.readText', payload);
}

export async function hostFileWriteText(
  payload: {
    path: string;
    content: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<WriteTextFileResult> {
  return await workspaceFileCapabilityExecute<WriteTextFileResult>('files.writeText', payload);
}

export async function hostFileStagePaths(payload: { filePaths: string[]; runtimeAddress: RuntimeAddress }): Promise<StagedFilePayload[]> {
  return await workspaceFileCapabilityExecute<StagedFilePayload[]>('files.stagePaths', payload);
}

export async function hostFileStageBuffer(payload: {
  base64: string;
  fileName: string;
  mimeType: string;
  runtimeAddress: RuntimeAddress;
}): Promise<StagedFilePayload> {
  return await workspaceFileCapabilityExecute<StagedFilePayload>('files.stageBuffer', payload);
}

export async function hostFileReadBinary(
  payload: {
    path: string;
    maxBytes?: number;
    runtimeAddress: RuntimeAddress;
  },
): Promise<ReadBinaryFileResult> {
  return await workspaceFileCapabilityExecute<ReadBinaryFileResult>('files.readBinary', payload);
}

export async function hostFileStat(
  payload: {
    path: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<FilePreviewStatResult> {
  return await workspaceFileCapabilityExecute<FilePreviewStatResult>('files.stat', payload);
}

export async function hostFileListDir(
  payload: {
    path: string;
    includeHidden?: boolean;
    runtimeAddress: RuntimeAddress;
  },
  options?: {
    timeoutMs?: number;
  },
): Promise<FilePreviewListDirResult> {
  return await workspaceFileCapabilityExecute<FilePreviewListDirResult>('files.listDir', payload, {
    timeoutMs: options?.timeoutMs ?? 60000,
  });
}

function hostSessionPost<TResult>(path: string, payload: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<TResult> {
  return hostApiFetch<TResult>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: options?.timeoutMs,
  });
}

export async function hostSessionList(
  payload: { runtimeAddress: RuntimeAddress },
): Promise<SessionListResult> {
  return hostSessionPost<SessionListResult>('/api/sessions/list', payload);
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
  runtimeAddress: RuntimeAddress;
}): Promise<{ capability: CapabilityDescriptor }> {
  return hostApiFetch('/api/capabilities/describe', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function buildCapabilityExecutePayload(input: {
  id: string;
  operationId: string;
  runtimeAddress: RuntimeAddress;
  body?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    operationId: input.operationId,
    runtimeAddress: input.runtimeAddress,
    input: {
      ...(input.body ?? {}),
      runtimeAddress: input.runtimeAddress,
    },
  };
}

export async function hostCapabilityExecute<TResult = unknown>(
  payload: {
    id: string;
    operationId: string;
    runtimeAddress: RuntimeAddress;
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

async function runtimeHostCapabilityExecute<TResult>(operationId: string, runtimeAddress: RuntimeAddress, input: Record<string, unknown> = {}): Promise<TResult> {
  return await hostCapabilityExecute<TResult>(buildCapabilityExecutePayload({
    id: RUNTIME_HOST_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    body: input,
  }));
}

export async function hostRuntimePrepareGatewayLaunch(payload: {
  gatewayToken?: string;
  proxyEnabled?: boolean;
  proxyServer?: string;
  proxyBypassRules?: string;
}, runtimeAddress: RuntimeAddress): Promise<RuntimeJobSubmission> {
  return await runtimeHostCapabilityExecute<RuntimeJobSubmission>('runtimeHost.prepareGatewayLaunch', runtimeAddress, payload);
}

export async function hostRuntimeSyncProviderAuthBootstrap(runtimeAddress: RuntimeAddress): Promise<RuntimeJobSubmission> {
  return await runtimeHostCapabilityExecute<RuntimeJobSubmission>('runtimeHost.syncProviderAuthBootstrap', runtimeAddress);
}

export async function hostRuntimeGatewayLifecycle(payload: Record<string, unknown>, runtimeAddress: RuntimeAddress): Promise<{ success: boolean; job?: RuntimeJobSnapshot }> {
  return await runtimeHostCapabilityExecute<{ success: boolean; job?: RuntimeJobSnapshot }>('runtimeHost.gatewayLifecycle', runtimeAddress, payload);
}

export async function hostDiagnosticsCollect(runtimeAddress: RuntimeAddress): Promise<RuntimeJobSubmission> {
  return await runtimeHostCapabilityExecute<RuntimeJobSubmission>('diagnostics.collect', runtimeAddress);
}

export async function hostRuntimeJobGet<TResult = unknown>(jobId: string): Promise<RuntimeJobLookupResult<TResult>> {
  return hostApiFetch('/api/runtime-host/jobs/get', {
    method: 'POST',
    body: JSON.stringify({ jobId }),
  });
}

export async function waitForRuntimeJobResult<TResult = void>(
  jobId: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
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
      void hostRuntimeJobGet<TResult>(jobId)
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
  await waitForRuntimeJobResult(hydrationJobId, {
    timeoutMs: input.timeoutMs,
  });
  const result = await input.refetch();
  return result.snapshot ?? null;
}

export async function hostSessionWindowFetch(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    mode?: 'latest' | 'older' | 'newer';
    limit?: number;
    offset?: number;
    includeCanonical?: boolean;
  },
): Promise<HostSessionWindowResult> {
  return hostSessionPost<HostSessionWindowResult>('/api/sessions/window', payload);
}

export async function hostSessionNew(
  payload: {
    sessionKey?: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<SessionNewResult> {
  return hostSessionPost<SessionNewResult>('/api/sessions/create', payload);
}

export async function hostSessionDelete(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<{ success: boolean; error?: string }> {
  return hostSessionPost<{ success: boolean; error?: string }>('/api/sessions/delete', payload);
}

export async function hostSessionRename(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    label: string;
  },
): Promise<{ success: boolean; sessionKey?: string; label?: string; error?: string }> {
  return hostSessionPost<{ success: boolean; sessionKey?: string; label?: string; error?: string }>('/api/sessions/rename', payload);
}

export async function hostSessionArchive(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return hostSessionPost<{ success: boolean; sessionKey?: string; status?: string; error?: string }>('/api/sessions/archive', payload);
}

export async function hostSessionUnarchive(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return hostSessionPost<{ success: boolean; sessionKey?: string; status?: string; error?: string }>('/api/sessions/unarchive', payload);
}

export async function hostSessionUpdateStatus(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    status: 'active' | 'completed' | 'archived' | 'deleted';
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return hostSessionPost<{ success: boolean; sessionKey?: string; status?: string; error?: string }>('/api/sessions/status', payload);
}

export async function hostSessionLoad(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    limit?: number;
  },
  options?: {
    timeoutMs?: number;
  },
): Promise<HostSessionLoadResult> {
  return hostSessionPost<HostSessionLoadResult>('/api/sessions/load', payload, options);
}

export async function hostSessionSwitch(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    limit?: number;
  },
): Promise<HostSessionLoadResult> {
  return hostSessionPost<HostSessionLoadResult>('/api/sessions/switch', payload);
}

export async function hostSessionResume(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<HostSessionLoadResult> {
  return hostSessionPost<HostSessionLoadResult>('/api/sessions/resume', payload);
}

export async function hostSessionState(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  },
): Promise<HostSessionLoadResult> {
  return hostSessionPost<HostSessionLoadResult>('/api/sessions/state', payload);
}

export async function hostSessionAbort(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    approvalIds?: string[];
  },
): Promise<SessionLoadResult & { success?: boolean }> {
  return hostSessionPost<SessionLoadResult & { success?: boolean }>('/api/sessions/abort', payload, { timeoutMs: SESSION_ABORT_TIMEOUT_MS });
}

export async function hostSessionApprovals(
  payload: { runtimeAddress: RuntimeAddress },
): Promise<{ approvals: SessionApprovalRequestItem[] }> {
  return hostSessionPost<{ approvals: SessionApprovalRequestItem[] }>('/api/sessions/approvals', payload);
}

export async function hostSessionResolveApproval(
  payload: {
    id: string;
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    decision: string;
  },
): Promise<unknown> {
  return hostSessionPost<unknown>('/api/sessions/approval/resolve', payload);
}

export async function hostSessionPatch(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    runtimeModelRef: string;
  },
): Promise<SessionLoadResult & { success?: boolean; error?: string }> {
  return hostSessionPost<SessionLoadResult & { success?: boolean; error?: string }>('/api/sessions/patch', payload, { timeoutMs: SESSION_PATCH_TIMEOUT_MS });
}

export async function hostSessionPrompt(
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
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
  return hostSessionPost<SessionPromptResult>('/api/sessions/prompt', payload, { timeoutMs: SESSION_PROMPT_TIMEOUT_MS });
}
