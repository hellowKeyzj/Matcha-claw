export type GatewayOperation = 'browser.request' | 'mcp.app.request' | 'question.resolve';

export interface GatewayCallDetail {
  runtime: 'openclaw';
  operation: GatewayOperation;
}

declare module '../call-log' {
  interface CallDetailByModule {
    'openclaw-gateway': GatewayCallDetail;
  }
}

export function decodeGatewayCallDetail(value: unknown): GatewayCallDetail | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const detail = value as Record<string, unknown>;
  if (Object.keys(detail).length !== 2 || detail.runtime !== 'openclaw'
    || (detail.operation !== 'browser.request' && detail.operation !== 'mcp.app.request'
      && detail.operation !== 'question.resolve')) return undefined;
  return { runtime: detail.runtime, operation: detail.operation };
}
