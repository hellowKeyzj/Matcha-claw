export interface GatewayRpcInvoker {
  <T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}
