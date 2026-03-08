import type { ConfigGetResult } from '@/types/subagent';

interface RpcSuccess<T> {
  success: true;
  result: T;
}

interface RpcFailure {
  success: false;
  error?: string;
}

type RpcResult<T> = RpcSuccess<T> | RpcFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeConfigGetResult(raw: unknown): ConfigGetResult | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (!isRecord(raw.config)) {
    return undefined;
  }
  return {
    config: raw.config as ConfigGetResult['config'],
    hash: getOptionalString(raw.hash),
    baseHash: getOptionalString(raw.baseHash),
    path: getOptionalString(raw.path),
  };
}

function normalizeLocalConfigSnapshot(raw: unknown): ConfigGetResult | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  // Preferred local snapshot payload:
  // { config: {...}, path?: string }
  if (isRecord(raw.config)) {
    return {
      config: raw.config as ConfigGetResult['config'],
      path: getOptionalString(raw.path),
    };
  }

  // Backward-compatible wrapper shape used in tests:
  // { success: true, result: { config: {...}, ... } }
  if (isRecord(raw.result)) {
    return normalizeConfigGetResult(raw.result);
  }

  return undefined;
}

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const response = await (timeoutMs == null
    ? window.electron.ipcRenderer.invoke('gateway:rpc', method, params)
    : window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs)
  ) as RpcResult<T>;
  if (!response.success) {
    throw new Error(response.error || `RPC call failed: ${method}`);
  }
  return response.result;
}

/**
 * 读优化路径：优先主进程本地快照（不触发 gateway config.get）。
 * 兜底才走 gateway config.get。
 */
export async function readConfigForDisplay(): Promise<ConfigGetResult | undefined> {
  try {
    const localResult = await window.electron.ipcRenderer.invoke('openclaw:getConfigJson');
    const normalized = normalizeLocalConfigSnapshot(localResult);
    if (normalized) {
      return normalized;
    }
  } catch {
    // fallback below
  }

  try {
    return await rpc<ConfigGetResult>('config.get', {});
  } catch {
    return undefined;
  }
}
