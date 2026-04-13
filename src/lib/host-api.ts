import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { normalizeAppError } from './error-model';
import {
  decodeHostApiProxyEnvelope,
  type HostApiProxyEnvelope,
  unwrapHostApiProxyEnvelope,
} from './host-api-transport-contract';

const HOST_API_PORT = 13210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;
const DEFAULT_HOST_GATEWAY_RPC_TIMEOUT_MS = 45000;
let cachedHostApiToken: string | null = null;

type HostApiRequestInit = RequestInit & {
  timeoutMs?: number;
};

export type HostGatewayRpcResult<TResult = unknown> = {
  success: boolean;
  result?: TResult;
  error?: string;
};

export interface GatewayClient {
  request<TResult = unknown>(
    method: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<HostGatewayRpcResult<TResult>>;
  rpc<TResult = unknown>(
    method: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<TResult>;
}

export interface OpenClawStatusPayload {
  packageExists: boolean;
  isBuilt: boolean;
  dir: string;
  version?: string;
}

export interface OpenClawCliCommandPayload {
  success: boolean;
  command?: string;
  error?: string;
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

export async function hostGatewayRequest<TResult = unknown>(
  method: string,
  payload?: unknown,
  timeoutMs?: number,
): Promise<HostGatewayRpcResult<TResult>> {
  const resolvedTimeoutMs =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HOST_GATEWAY_RPC_TIMEOUT_MS;
  return await hostApiFetch<HostGatewayRpcResult<TResult>>('/api/gateway/rpc', {
    method: 'POST',
    body: JSON.stringify({
      method,
      ...(payload !== undefined ? { params: payload } : {}),
      timeoutMs: resolvedTimeoutMs,
    }),
    timeoutMs: resolvedTimeoutMs,
  });
}

export async function hostGatewayRpc<TResult = unknown>(
  method: string,
  payload?: unknown,
  timeoutMs?: number,
): Promise<TResult> {
  const response = await hostGatewayRequest<TResult>(method, payload, timeoutMs);
  if (!response.success) {
    throw new Error(response.error || `Gateway RPC failed: ${method}`);
  }
  return response.result as TResult;
}

/**
 * @deprecated 正式业务请改用 hostGatewayRequest / hostGatewayRpc。
 * 这里只保留给旧测试和高级调试别名，避免业务层再次依赖 gatewayClient 语义。
 */
export const gatewayClient: GatewayClient = {
  request: hostGatewayRequest,
  rpc: async <TResult = unknown>(
    method: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<TResult> => await hostGatewayRpc<TResult>(method, payload, timeoutMs),
};

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

export async function hostUvInstallAll(): Promise<{ success: boolean; error?: string }> {
  return hostApiFetch('/api/toolchain/uv/install', {
    method: 'POST',
  });
}
