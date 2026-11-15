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

export type TeamRunScope = Readonly<{
  kind: 'team-run';
  endpoint: Endpoint;
  teamId: string;
  runId: string;
}>;

export type FileScope = AgentScope | TeamRunScope;
export type FileInputIdentity = Readonly<{ endpoint: Endpoint }> & (
  Readonly<{ agentId: string }> | Readonly<{ teamId: string; runId: string }>
);

export type FileTarget = Readonly<{ kind: 'workspace-file' }>;

export function isFileScope(value: unknown): value is FileScope {
  return isAgentScope(value) || (isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'teamId', 'runId'])
    && value.kind === 'team-run' && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.teamId) && value.teamId.trim().length > 0
    && isNonEmptyBoundedText(value.runId) && value.runId.trim().length > 0);
}

export function isFileInput(
  value: unknown,
  scope: FileScope,
  fields: readonly string[],
  optionalFields: readonly string[] = [],
): value is FileInputIdentity & Record<string, unknown> {
  if (!isRecord(value) || !isEndpoint(value.endpoint)) return false;
  const identityKeys = scope.kind === 'agent' ? ['endpoint', 'agentId'] : ['endpoint', 'teamId', 'runId'];
  const required = [...identityKeys, ...fields];
  if (!required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optionalFields.includes(key))) return false;
  return scope.endpoint.runtimeAdapterId === value.endpoint.runtimeAdapterId
    && scope.endpoint.runtimeInstanceId === value.endpoint.runtimeInstanceId
    && (scope.kind === 'agent' ? scope.agentId === value.agentId : scope.teamId === value.teamId && scope.runId === value.runId);
}

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
