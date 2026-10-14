import { hasExactKeys, isRecord } from '../client';
import { isEndpoint } from './session-contract';

export type OpenClawSessionIdentity = Readonly<{
  endpoint: Readonly<{
    kind: 'native-runtime';
    runtimeAdapterId: 'openclaw';
    runtimeInstanceId: 'local';
  }>;
  agentId: string;
  sessionKey: string;
}>;

export function isOpenClawSessionIdentity(value: unknown): value is OpenClawSessionIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && value.endpoint.runtimeAdapterId === 'openclaw'
    && typeof value.agentId === 'string'
    && value.agentId.length > 0
    && typeof value.sessionKey === 'string'
    && value.sessionKey.length > 0;
}

export function isOpenClawSessionScope(value: unknown): value is Readonly<{ kind: 'session'; identity: OpenClawSessionIdentity }> {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isOpenClawSessionIdentity(value.identity);
}
