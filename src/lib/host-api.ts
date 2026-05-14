import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { normalizeAppError } from './error-model';
import {
  decodeHostApiProxyEnvelope,
  type HostApiProxyEnvelope,
  unwrapHostApiProxyEnvelope,
} from './host-api-transport-contract';
import type {
  SessionCatalogItem,
  SessionLoadResult,
  SessionListResult,
  SessionNewResult,
  SessionPromptResult,
  SessionWindowResult,
} from '../../runtime-host/shared/session-adapter-types';

const HOST_API_PORT = 13210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;
const SESSION_ABORT_TIMEOUT_MS = 5_000;
const SESSION_PROMPT_TIMEOUT_MS = 10_000;
const SESSION_PATCH_TIMEOUT_MS = 15_000;
let cachedHostApiToken: string | null = null;

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

export type HostSessionLoadResult = SessionLoadResult & {
  hydrationJob?: RuntimeJobSnapshot<SessionLoadResult>;
};

export type HostSessionWindowResult = SessionWindowResult & {
  hydrationJob?: RuntimeJobSnapshot<SessionWindowResult>;
};

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
  try {
    const response = await invokeIpc<unknown>('hostapi:fetch', {
      path,
      method,
      headers: headersToRecord(init?.headers),
      body: init?.body ?? null,
      timeoutMs: init?.timeoutMs,
    });
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

export async function hostUvInstallAll(): Promise<RuntimeJobSubmission> {
  return hostApiFetch('/api/toolchain/uv/install', {
    method: 'POST',
  });
}

export async function hostFileReadText(
  payload: {
    path: string;
    maxBytes?: number;
  },
): Promise<ReadTextFileResult> {
  return hostApiFetch('/api/files/read-text', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostFileReadBinary(
  payload: {
    path: string;
    maxBytes?: number;
  },
): Promise<ReadBinaryFileResult> {
  return hostApiFetch('/api/files/read-binary', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostFileStat(
  payload: {
    path: string;
  },
): Promise<FilePreviewStatResult> {
  return hostApiFetch('/api/files/stat', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostFileListDir(
  payload: {
    path: string;
    includeHidden?: boolean;
  },
  options?: {
    timeoutMs?: number;
  },
): Promise<FilePreviewListDirResult> {
  return hostApiFetch('/api/files/list-dir', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: options?.timeoutMs ?? 60000,
  });
}

export async function hostSessionList(): Promise<SessionListResult> {
  return hostApiFetch('/api/sessions/list');
}

export async function hostRuntimeJobGet<TResult = unknown>(jobId: string): Promise<RuntimeJobLookupResult<TResult>> {
  return hostApiFetch('/api/runtime-host/jobs/get', {
    method: 'POST',
    body: JSON.stringify({ jobId }),
  });
}

export async function waitForRuntimeJobResult<TResult>(
  jobId: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<TResult> {
  const timeoutMs = options.timeoutMs ?? 120000;
  const intervalMs = options.intervalMs ?? 500;
  const startedAt = Date.now();
  for (;;) {
    const response = await hostRuntimeJobGet<TResult>(jobId);
    const job = response.job;
    if (!job) {
      throw new Error(`runtime job not found: ${jobId}`);
    }
    if (job.status === 'succeeded') {
      return job.result as TResult;
    }
    if (job.status === 'failed') {
      throw new Error(job.error || `runtime job failed: ${job.type}`);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`runtime job timed out: ${job.type}`);
    }
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }
}

export async function hostSessionWindowFetch(
  payload: {
    sessionKey: string;
    mode?: 'latest' | 'older' | 'newer';
    limit?: number;
    offset?: number;
    includeCanonical?: boolean;
  },
): Promise<HostSessionWindowResult> {
  return hostApiFetch('/api/sessions/window', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionNew(
  payload: {
    sessionKey?: string;
    agentId?: string;
    canonicalPrefix?: string;
  },
): Promise<SessionNewResult> {
  return hostApiFetch('/api/session/new', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionDelete(
  payload: {
    sessionKey: string;
  },
): Promise<{ success: boolean; error?: string }> {
  return hostApiFetch('/api/sessions/delete', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionArchive(
  payload: {
    sessionKey: string;
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return hostApiFetch('/api/sessions/archive', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionUnarchive(
  payload: {
    sessionKey: string;
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return hostApiFetch('/api/sessions/unarchive', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionUpdateStatus(
  payload: {
    sessionKey: string;
    status: 'active' | 'completed' | 'archived' | 'deleted';
  },
): Promise<{ success: boolean; sessionKey?: string; status?: string; error?: string }> {
  return hostApiFetch('/api/sessions/status', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionLoad(
  payload: {
    sessionKey: string;
  },
  options?: {
    timeoutMs?: number;
  },
): Promise<HostSessionLoadResult> {
  return hostApiFetch('/api/session/load', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: options?.timeoutMs,
  });
}

export async function hostSessionSwitch(
  payload: {
    sessionKey: string;
  },
): Promise<HostSessionLoadResult> {
  return hostApiFetch('/api/session/switch', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionResume(
  payload: {
    sessionKey: string;
  },
): Promise<HostSessionLoadResult> {
  return hostApiFetch('/api/session/resume', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionState(
  payload: {
    sessionKey?: string;
  } = {},
): Promise<HostSessionLoadResult> {
  return hostApiFetch('/api/session/state', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionAbort(
  payload: {
    sessionKey: string;
    approvalIds?: string[];
  },
): Promise<SessionLoadResult & { success?: boolean }> {
  return hostApiFetch('/api/session/abort', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: SESSION_ABORT_TIMEOUT_MS,
  });
}

export async function hostSessionApprovals(): Promise<unknown> {
  return hostApiFetch('/api/session/approvals');
}

export async function hostSessionResolveApproval(
  payload: {
    id: string;
    decision: string;
  },
): Promise<unknown> {
  return hostApiFetch('/api/session/approval/resolve', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function hostSessionPatch(
  payload: {
    sessionKey: string;
    model: string;
  },
): Promise<SessionLoadResult & { success?: boolean; error?: string }> {
  return hostApiFetch('/api/session/patch', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: SESSION_PATCH_TIMEOUT_MS,
  });
}

export async function hostSessionPrompt(
  payload: {
    sessionKey: string;
    message: string;
    promptId?: string;
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
  return hostApiFetch('/api/session/prompt', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: SESSION_PROMPT_TIMEOUT_MS,
  });
}
