import { hasExactKeys, isNonEmptyBoundedText, isRecord } from '../client';

export type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw';
  runtimeInstanceId: 'local';
}>;

export type SessionScope = Readonly<{
  kind: 'session';
  endpoint: Endpoint;
  sessionKey: string;
}>;

export type FileTarget = Readonly<{ kind: 'workspace-file' }>;

export function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
}

export function isSessionScope(value: unknown): value is SessionScope {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.sessionKey);
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
