import { fetchLatestAssistantText } from '@/lib/openclaw/session-runtime';

interface RpcResult<T> {
  success: boolean;
  result?: T;
  error?: string;
}

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const response = await window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs) as RpcResult<T>;
  if (!response.success) {
    throw new Error(response.error || `RPC failed: ${method}`);
  }
  return response.result as T;
}

export async function fetchLatestAgentOutput(sessionKey: string): Promise<string> {
  return fetchLatestAssistantText(rpc, {
    sessionKey,
    limit: 20,
  });
}
