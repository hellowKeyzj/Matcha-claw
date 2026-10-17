import { hasExactKeys, isRecord } from './client';

export type ProductRuntimeEndpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

export type ProductRuntimeScope = Readonly<{
  kind: 'runtime-instance';
  endpoint: ProductRuntimeEndpoint;
}>;

export function isProductRuntimeEndpoint(value: unknown): value is ProductRuntimeEndpoint {
  return isRecord(value) && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

export function isProductRuntimeScope(value: unknown): value is ProductRuntimeScope {
  return isRecord(value) && hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'runtime-instance' && isProductRuntimeEndpoint(value.endpoint);
}

export function readRuntimeScopeQuery(query: URLSearchParams): unknown {
  const values = query.getAll('scope');
  if (values.length === 0) return undefined;
  if (values.length !== 1) return null;
  try { return JSON.parse(values[0]); } catch { return null; }
}
