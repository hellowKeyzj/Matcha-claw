import { hasExactKeys, isNonEmptyBoundedText, isRecord } from '../client';

export type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

export type SessionScope = Readonly<{
  kind: 'session';
  endpoint: Endpoint;
  sessionKey: string;
}>;

export type AgentScope = Readonly<{
  kind: 'agent';
  endpoint: Endpoint;
  agentId: string;
}>;

export type FileTarget = Readonly<{ kind: 'workspace-file' }>;

export function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

export function isSessionScope(value: unknown): value is SessionScope {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.sessionKey);
}

export function isAgentScope(value: unknown): value is AgentScope {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'agentId'])
    && value.kind === 'agent'
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.agentId)
    && value.agentId.trim().length > 0;
}

export function isFileTarget(value: unknown): value is FileTarget {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'workspace-file';
}

export function isFileRelativePath(value: unknown): value is string {
  return isNonEmptyBoundedText(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes(':')
    && value.split(/[\\/]/).every((component) => component !== '' && component !== '.' && component !== '..');
}
