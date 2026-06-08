export type RuntimeEndpointRef = NativeRuntimeEndpointRef | ConnectorRuntimeEndpointRef;

export interface NativeRuntimeEndpointRef {
  kind: 'native-runtime';
  runtimeAdapterId: string;
  runtimeInstanceId: string;
}

export interface ConnectorRuntimeEndpointRef {
  kind: 'protocol-connector';
  protocolId: string;
  connectorId: string;
  endpointId: string;
}

export type RuntimeEndpointKind = RuntimeEndpointRef['kind'];

export type RuntimeScope =
  | AppScope
  | BootstrapScope
  | RuntimeInstanceScope
  | AgentScope
  | SessionScope
  | WorkspaceScope
  | TeamRunScope;

export interface AppScope {
  kind: 'app';
}

export interface BootstrapScope {
  kind: 'bootstrap';
}

export interface RuntimeInstanceScope {
  kind: 'runtime-instance';
  endpoint: RuntimeEndpointRef;
}

export interface AgentScope {
  kind: 'agent';
  endpoint: RuntimeEndpointRef;
  agentId: string;
}

export interface SessionScope {
  kind: 'session';
  identity: SessionIdentity;
}

export interface WorkspaceScope {
  kind: 'workspace';
  endpoint: RuntimeEndpointRef;
  workspaceId?: string;
  sourceId?: string;
}

export interface TeamRunScope {
  kind: 'team-run';
  endpoint: RuntimeEndpointRef;
  teamId?: string;
  runId: string;
}

export type RuntimeScopeKind = RuntimeScope['kind'];

export interface SessionIdentity {
  endpoint: RuntimeEndpointRef;
  agentId: string;
  sessionKey: string;
}

export type CapabilityTargetKind =
  | 'none'
  | 'setting'
  | 'license'
  | 'runtime-endpoint'
  | 'runtime-job'
  | 'gateway-control'
  | 'provider-account'
  | 'provider-credential'
  | 'provider-oauth'
  | 'capability-route'
  | 'security-policy'
  | 'security-remediation'
  | 'channel'
  | 'channel-pairing'
  | 'skill'
  | 'skill-bundle'
  | 'plugin'
  | 'cron-job'
  | 'task'
  | 'agent'
  | 'subagent'
  | 'session'
  | 'approval'
  | 'model-selection'
  | 'tool'
  | 'workspace-file'
  | 'workspace-staging'
  | 'team'
  | 'team-run'
  | 'team-stage'
  | 'team-dispatch'
  | 'team-approval';

export type CapabilityTarget =
  | NoCapabilityTarget
  | SettingTarget
  | LicenseTarget
  | RuntimeEndpointTarget
  | RuntimeJobTarget
  | GatewayControlTarget
  | ProviderAccountTarget
  | ProviderCredentialTarget
  | ProviderOAuthTarget
  | CapabilityRouteTarget
  | SecurityPolicyTarget
  | SecurityRemediationTarget
  | ChannelTarget
  | ChannelPairingTarget
  | SkillTarget
  | SkillBundleTarget
  | PluginTarget
  | CronJobTarget
  | TaskTarget
  | AgentTarget
  | SubagentTarget
  | SessionTarget
  | ApprovalTarget
  | ModelSelectionTarget
  | ToolTarget
  | WorkspaceFileTarget
  | WorkspaceStagingTarget
  | TeamTarget
  | TeamRunTarget
  | TeamStageTarget
  | TeamDispatchTarget
  | TeamApprovalTarget;

export interface NoCapabilityTarget {
  kind: 'none';
}

export interface SettingTarget {
  kind: 'setting';
  key?: string;
}

export interface LicenseTarget {
  kind: 'license';
  subject?: 'installation' | 'key' | 'gate';
}

export interface RuntimeEndpointTarget {
  kind: 'runtime-endpoint';
}

export interface RuntimeJobTarget {
  kind: 'runtime-job';
  jobId?: string;
}

export interface GatewayControlTarget {
  kind: 'gateway-control';
  requestId?: string;
}

export interface ProviderAccountTarget {
  kind: 'provider-account';
  accountId?: string;
  vendorId?: string;
}

export interface ProviderCredentialTarget {
  kind: 'provider-credential';
  accountId: string;
  vendorId?: string;
}

export interface ProviderOAuthTarget {
  kind: 'provider-oauth';
  flowId?: string;
  accountId?: string;
  vendorId?: string;
}

export interface CapabilityRouteTarget {
  kind: 'capability-route';
  capabilityId: string;
}

export interface SecurityPolicyTarget {
  kind: 'security-policy';
  policyId?: string;
}

export interface SecurityRemediationTarget {
  kind: 'security-remediation';
  remediationId?: string;
  snapshotId?: string;
}

export interface ChannelTarget {
  kind: 'channel';
  channelType: string;
  accountId?: string;
}

export interface ChannelPairingTarget {
  kind: 'channel-pairing';
  channelType: string;
  accountId?: string;
  pairingId?: string;
}

export interface SkillTarget {
  kind: 'skill';
  skillId?: string;
  slug?: string;
}

export interface SkillBundleTarget {
  kind: 'skill-bundle';
  bundleId?: string;
  agentId?: string;
}

export interface PluginTarget {
  kind: 'plugin';
  pluginId?: string;
}

export interface CronJobTarget {
  kind: 'cron-job';
  jobId?: string;
  executionTarget?: AgentTarget | SessionTarget;
}

export interface TaskTarget {
  kind: 'task';
  taskId: string;
  owner?: SessionTarget | TeamRunTarget;
}

export interface AgentTarget {
  kind: 'agent';
  agentId: string;
}

export interface SubagentTarget {
  kind: 'subagent';
  agentId: string;
  subagentId?: string;
}

export interface SessionTarget {
  kind: 'session';
  identity: SessionIdentity;
}

export interface ApprovalTarget {
  kind: 'approval';
  identity: SessionIdentity;
  approvalId: string;
}

export interface ModelSelectionTarget {
  kind: 'model-selection';
  identity: SessionIdentity;
  runtimeModelRef?: string;
}

export interface ToolTarget {
  kind: 'tool';
  toolName: string;
  identity?: SessionIdentity;
  agentId?: string;
}

export interface WorkspaceFileTarget {
  kind: 'workspace-file';
  path: string;
  workspaceId?: string;
  sourceId?: string;
  identity: SessionIdentity;
}

export interface WorkspaceStagingTarget {
  kind: 'workspace-staging';
  identity: SessionIdentity;
  stagingId?: string;
}

export interface TeamTarget {
  kind: 'team';
  teamId?: string;
  packagePath?: string;
}

export interface TeamRunTarget {
  kind: 'team-run';
  teamId?: string;
  runId: string;
}

export interface TeamStageTarget {
  kind: 'team-stage';
  runId: string;
  stageId: string;
}

export interface TeamDispatchTarget {
  kind: 'team-dispatch';
  runId: string;
  dispatchId: string;
}

export interface TeamApprovalTarget {
  kind: 'team-approval';
  runId: string;
  approvalId: string;
}

export function nativeRuntimeEndpoint(input: Omit<NativeRuntimeEndpointRef, 'kind'>): NativeRuntimeEndpointRef {
  return { kind: 'native-runtime', ...input };
}

export function connectorRuntimeEndpoint(input: Omit<ConnectorRuntimeEndpointRef, 'kind'>): ConnectorRuntimeEndpointRef {
  return { kind: 'protocol-connector', ...input };
}

export function appScope(): AppScope {
  return { kind: 'app' };
}

export function bootstrapScope(): BootstrapScope {
  return { kind: 'bootstrap' };
}

export function runtimeInstanceScope(endpoint: RuntimeEndpointRef): RuntimeInstanceScope {
  return { kind: 'runtime-instance', endpoint };
}

export function agentScope(endpoint: RuntimeEndpointRef, agentId: string): AgentScope {
  return { kind: 'agent', endpoint, agentId };
}

export function sessionScope(identity: SessionIdentity): SessionScope {
  return { kind: 'session', identity };
}

export function buildRuntimeEndpointKey(endpoint: RuntimeEndpointRef): string {
  assertRuntimeEndpointRef(endpoint);
  return encodeStructuredKey(runtimeEndpointKeyPayload(endpoint));
}

export function buildCapabilityScopeKey(scope: RuntimeScope): string {
  assertRuntimeScope(scope);
  return encodeStructuredKey(runtimeScopeKeyPayload(scope));
}

export function buildSessionIdentityKey(identity: SessionIdentity): string {
  assertSessionIdentity(identity);
  return encodeStructuredKey(sessionIdentityKeyPayload(identity));
}

export function buildCapabilityTargetKey(target: CapabilityTarget | null | undefined): string {
  if (!target) {
    return encodeStructuredKey({ type: 'capability-target', kind: 'none' });
  }
  assertCapabilityTarget(target);
  return encodeStructuredKey(capabilityTargetKeyPayload(target));
}

function encodeStructuredKey(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function runtimeEndpointKeyPayload(endpoint: RuntimeEndpointRef): Record<string, unknown> {
  if (endpoint.kind === 'native-runtime') {
    return {
      type: 'runtime-endpoint',
      kind: 'native-runtime',
      runtimeAdapterId: endpoint.runtimeAdapterId,
      runtimeInstanceId: endpoint.runtimeInstanceId,
    };
  }
  return {
    type: 'runtime-endpoint',
    kind: 'protocol-connector',
    protocolId: endpoint.protocolId,
    connectorId: endpoint.connectorId,
    endpointId: endpoint.endpointId,
  };
}

function runtimeScopeKeyPayload(scope: RuntimeScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'app':
      return { type: 'runtime-scope', kind: 'app' };
    case 'bootstrap':
      return { type: 'runtime-scope', kind: 'bootstrap' };
    case 'runtime-instance':
      return { type: 'runtime-scope', kind: 'runtime-instance', endpoint: runtimeEndpointKeyPayload(scope.endpoint) };
    case 'agent':
      return { type: 'runtime-scope', kind: 'agent', endpoint: runtimeEndpointKeyPayload(scope.endpoint), agentId: scope.agentId };
    case 'session':
      return { type: 'runtime-scope', kind: 'session', identity: sessionIdentityKeyPayload(scope.identity) };
    case 'workspace':
      return withOptionalKeyFields(
        { type: 'runtime-scope', kind: 'workspace', endpoint: runtimeEndpointKeyPayload(scope.endpoint) },
        [['workspaceId', scope.workspaceId], ['sourceId', scope.sourceId]],
      );
    case 'team-run':
      return withOptionalKeyFields(
        { type: 'runtime-scope', kind: 'team-run', endpoint: runtimeEndpointKeyPayload(scope.endpoint), runId: scope.runId },
        [['teamId', scope.teamId]],
      );
  }
}

function sessionIdentityKeyPayload(identity: SessionIdentity): Record<string, unknown> {
  return {
    type: 'session-identity',
    endpoint: runtimeEndpointKeyPayload(identity.endpoint),
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
  };
}

function capabilityTargetKeyPayload(target: CapabilityTarget): Record<string, unknown> {
  switch (target.kind) {
    case 'none':
      return { type: 'capability-target', kind: 'none' };
    case 'setting':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'setting' }, [['key', target.key]]);
    case 'license':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'license' }, [['subject', target.subject]]);
    case 'runtime-endpoint':
      return { type: 'capability-target', kind: 'runtime-endpoint' };
    case 'runtime-job':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'runtime-job' }, [['jobId', target.jobId]]);
    case 'gateway-control':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'gateway-control' }, [['requestId', target.requestId]]);
    case 'provider-account':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'provider-account' }, [['accountId', target.accountId], ['vendorId', target.vendorId]]);
    case 'provider-credential':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'provider-credential', accountId: target.accountId }, [['vendorId', target.vendorId]]);
    case 'provider-oauth':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'provider-oauth' }, [['flowId', target.flowId], ['accountId', target.accountId], ['vendorId', target.vendorId]]);
    case 'capability-route':
      return { type: 'capability-target', kind: 'capability-route', capabilityId: target.capabilityId };
    case 'security-policy':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'security-policy' }, [['policyId', target.policyId]]);
    case 'security-remediation':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'security-remediation' }, [['remediationId', target.remediationId], ['snapshotId', target.snapshotId]]);
    case 'channel':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'channel', channelType: target.channelType }, [['accountId', target.accountId]]);
    case 'channel-pairing':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'channel-pairing', channelType: target.channelType }, [['accountId', target.accountId], ['pairingId', target.pairingId]]);
    case 'skill':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'skill' }, [['skillId', target.skillId], ['slug', target.slug]]);
    case 'skill-bundle':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'skill-bundle' }, [['bundleId', target.bundleId], ['agentId', target.agentId]]);
    case 'plugin':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'plugin' }, [['pluginId', target.pluginId]]);
    case 'cron-job':
      return withOptionalKeyFields(
        { type: 'capability-target', kind: 'cron-job' },
        [['jobId', target.jobId], ['executionTarget', target.executionTarget ? capabilityTargetKeyPayload(target.executionTarget) : undefined]],
      );
    case 'task':
      return withOptionalKeyFields(
        { type: 'capability-target', kind: 'task', taskId: target.taskId },
        [['owner', target.owner ? capabilityTargetKeyPayload(target.owner) : undefined]],
      );
    case 'agent':
      return { type: 'capability-target', kind: 'agent', agentId: target.agentId };
    case 'subagent':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'subagent', agentId: target.agentId }, [['subagentId', target.subagentId]]);
    case 'session':
      return { type: 'capability-target', kind: 'session', identity: sessionIdentityKeyPayload(target.identity) };
    case 'approval':
      return { type: 'capability-target', kind: 'approval', identity: sessionIdentityKeyPayload(target.identity), approvalId: target.approvalId };
    case 'model-selection':
      return withOptionalKeyFields(
        { type: 'capability-target', kind: 'model-selection', identity: sessionIdentityKeyPayload(target.identity) },
        [['runtimeModelRef', target.runtimeModelRef]],
      );
    case 'tool':
      return withOptionalKeyFields(
        { type: 'capability-target', kind: 'tool', toolName: target.toolName },
        [['identity', target.identity ? sessionIdentityKeyPayload(target.identity) : undefined], ['agentId', target.agentId]],
      );
    case 'workspace-file':
      return withOptionalKeyFields(
        { type: 'capability-target', kind: 'workspace-file', path: target.path },
        [['workspaceId', target.workspaceId], ['sourceId', target.sourceId], ['identity', target.identity ? sessionIdentityKeyPayload(target.identity) : undefined]],
      );
    case 'workspace-staging':
      return withOptionalKeyFields(
        { type: 'capability-target', kind: 'workspace-staging', identity: sessionIdentityKeyPayload(target.identity) },
        [['stagingId', target.stagingId]],
      );
    case 'team':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'team' }, [['teamId', target.teamId], ['packagePath', target.packagePath]]);
    case 'team-run':
      return withOptionalKeyFields({ type: 'capability-target', kind: 'team-run', runId: target.runId }, [['teamId', target.teamId]]);
    case 'team-stage':
      return { type: 'capability-target', kind: 'team-stage', runId: target.runId, stageId: target.stageId };
    case 'team-dispatch':
      return { type: 'capability-target', kind: 'team-dispatch', runId: target.runId, dispatchId: target.dispatchId };
    case 'team-approval':
      return { type: 'capability-target', kind: 'team-approval', runId: target.runId, approvalId: target.approvalId };
  }
}

function withOptionalKeyFields(payload: Record<string, unknown>, fields: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  for (const [key, value] of fields) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  return payload;
}

export function runtimeEndpointsEqual(left: RuntimeEndpointRef, right: RuntimeEndpointRef): boolean {
  return buildRuntimeEndpointKey(left) === buildRuntimeEndpointKey(right);
}

export function capabilityScopesEqual(left: RuntimeScope, right: RuntimeScope): boolean {
  return buildCapabilityScopeKey(left) === buildCapabilityScopeKey(right);
}

export function sessionIdentitiesEqual(left: SessionIdentity, right: SessionIdentity): boolean {
  return buildSessionIdentityKey(left) === buildSessionIdentityKey(right);
}

export function assertRuntimeEndpointRef(input: unknown): asserts input is RuntimeEndpointRef {
  const error = validateRuntimeEndpointRef(input);
  if (error) {
    throw new Error(error);
  }
}

export function assertRuntimeScope(input: unknown): asserts input is RuntimeScope {
  const error = validateRuntimeScope(input);
  if (error) {
    throw new Error(error);
  }
}

export function assertSessionIdentity(input: unknown): asserts input is SessionIdentity {
  const error = validateSessionIdentity(input);
  if (error) {
    throw new Error(error);
  }
}

export function assertCapabilityTarget(input: unknown): asserts input is CapabilityTarget {
  const error = validateCapabilityTarget(input);
  if (error) {
    throw new Error(error);
  }
}

export function validateRuntimeEndpointRef(input: unknown): string | null {
  if (!isRecord(input)) {
    return 'RuntimeEndpointRef must be an object';
  }
  if (input.kind === 'native-runtime') {
    return validateRequiredStrings(input, ['runtimeAdapterId', 'runtimeInstanceId'])
      ?? validateForbiddenKeys(input, ['capabilityId', 'agentId', 'sessionKey', 'modelProviderId', 'protocolId', 'connectorId', 'endpointId']);
  }
  if (input.kind === 'protocol-connector') {
    return validateRequiredStrings(input, ['protocolId', 'connectorId', 'endpointId'])
      ?? validateForbiddenKeys(input, ['capabilityId', 'agentId', 'sessionKey', 'modelProviderId', 'runtimeAdapterId', 'runtimeInstanceId']);
  }
  return 'RuntimeEndpointRef kind must be native-runtime or protocol-connector';
}

export function validateRuntimeScope(input: unknown): string | null {
  if (!isRecord(input)) {
    return 'RuntimeScope must be an object';
  }
  switch (input.kind) {
    case 'app':
      return validateAllowedKeys(input, ['kind']);
    case 'bootstrap':
      return validateAllowedKeys(input, ['kind']);
    case 'runtime-instance':
      return validateAllowedKeys(input, ['kind', 'endpoint'])
        ?? validateRuntimeEndpointRef(input.endpoint);
    case 'agent':
      return validateAllowedKeys(input, ['kind', 'endpoint', 'agentId'])
        ?? validateRuntimeEndpointRef(input.endpoint)
        ?? validateRequiredStrings(input, ['agentId']);
    case 'session':
      return validateAllowedKeys(input, ['kind', 'identity'])
        ?? validateSessionIdentity(input.identity);
    case 'workspace':
      return validateAllowedKeys(input, ['kind', 'endpoint', 'workspaceId', 'sourceId'])
        ?? validateRuntimeEndpointRef(input.endpoint)
        ?? validateOptionalStrings(input, ['workspaceId', 'sourceId']);
    case 'team-run':
      return validateAllowedKeys(input, ['kind', 'endpoint', 'teamId', 'runId'])
        ?? validateRuntimeEndpointRef(input.endpoint)
        ?? validateRequiredStrings(input, ['runId'])
        ?? validateOptionalStrings(input, ['teamId']);
    default:
      return 'RuntimeScope kind is invalid';
  }
}

export function validateSessionIdentity(input: unknown): string | null {
  if (!isRecord(input)) {
    return 'SessionIdentity must be an object';
  }
  return validateRuntimeEndpointRef(input.endpoint) ?? validateRequiredStrings(input, ['agentId', 'sessionKey']);
}

export function validateCapabilityTarget(input: unknown): string | null {
  if (!isRecord(input)) {
    return 'CapabilityTarget must be an object';
  }
  if (typeof input.kind !== 'string' || !input.kind.trim()) {
    return 'CapabilityTarget kind is required';
  }
  switch (input.kind) {
    case 'none':
      return validateAllowedKeys(input, ['kind']);
    case 'setting':
      return validateAllowedKeys(input, ['kind', 'key']) ?? validateOptionalStrings(input, ['key']);
    case 'license':
      return validateAllowedKeys(input, ['kind', 'subject']) ?? validateOptionalStrings(input, ['subject']);
    case 'runtime-endpoint':
      return validateAllowedKeys(input, ['kind']);
    case 'runtime-job':
      return validateAllowedKeys(input, ['kind', 'jobId']) ?? validateOptionalStrings(input, ['jobId']);
    case 'gateway-control':
      return validateAllowedKeys(input, ['kind', 'requestId']) ?? validateOptionalStrings(input, ['requestId']);
    case 'provider-account':
      return validateAllowedKeys(input, ['kind', 'accountId', 'vendorId']) ?? validateOptionalStrings(input, ['accountId', 'vendorId']);
    case 'provider-credential':
      return validateAllowedKeys(input, ['kind', 'accountId', 'vendorId']) ?? validateRequiredStrings(input, ['accountId']) ?? validateOptionalStrings(input, ['vendorId']);
    case 'provider-oauth':
      return validateAllowedKeys(input, ['kind', 'flowId', 'accountId', 'vendorId']) ?? validateOptionalStrings(input, ['flowId', 'accountId', 'vendorId']);
    case 'capability-route':
      return validateAllowedKeys(input, ['kind', 'capabilityId']) ?? validateRequiredStrings(input, ['capabilityId']);
    case 'security-policy':
      return validateAllowedKeys(input, ['kind', 'policyId']) ?? validateOptionalStrings(input, ['policyId']);
    case 'security-remediation':
      return validateAllowedKeys(input, ['kind', 'remediationId', 'snapshotId']) ?? validateOptionalStrings(input, ['remediationId', 'snapshotId']);
    case 'channel':
      return validateAllowedKeys(input, ['kind', 'channelType', 'accountId'])
        ?? validateRequiredStrings(input, ['channelType'])
        ?? validateOptionalStrings(input, ['accountId']);
    case 'channel-pairing':
      return validateAllowedKeys(input, ['kind', 'channelType', 'accountId', 'pairingId'])
        ?? validateRequiredStrings(input, ['channelType'])
        ?? validateOptionalStrings(input, ['accountId', 'pairingId']);
    case 'skill':
      return validateAllowedKeys(input, ['kind', 'skillId', 'slug']) ?? validateOptionalStrings(input, ['skillId', 'slug']);
    case 'skill-bundle':
      return validateAllowedKeys(input, ['kind', 'bundleId', 'agentId']) ?? validateOptionalStrings(input, ['bundleId', 'agentId']);
    case 'plugin':
      return validateAllowedKeys(input, ['kind', 'pluginId']) ?? validateOptionalStrings(input, ['pluginId']);
    case 'cron-job':
      return validateAllowedKeys(input, ['kind', 'jobId', 'executionTarget'])
        ?? validateOptionalStrings(input, ['jobId'])
        ?? validateNestedTarget(input.executionTarget, ['agent', 'session'], 'executionTarget');
    case 'task':
      return validateAllowedKeys(input, ['kind', 'taskId', 'owner'])
        ?? validateRequiredStrings(input, ['taskId'])
        ?? validateNestedTarget(input.owner, ['session', 'team-run'], 'owner');
    case 'agent':
      return validateAllowedKeys(input, ['kind', 'agentId']) ?? validateRequiredStrings(input, ['agentId']);
    case 'subagent':
      return validateAllowedKeys(input, ['kind', 'agentId', 'subagentId'])
        ?? validateRequiredStrings(input, ['agentId'])
        ?? validateOptionalStrings(input, ['subagentId']);
    case 'session':
      return validateAllowedKeys(input, ['kind', 'identity']) ?? validateSessionIdentity(input.identity);
    case 'approval':
      return validateAllowedKeys(input, ['kind', 'identity', 'approvalId'])
        ?? validateSessionIdentity(input.identity)
        ?? validateRequiredStrings(input, ['approvalId']);
    case 'model-selection':
      return validateAllowedKeys(input, ['kind', 'identity', 'runtimeModelRef'])
        ?? validateSessionIdentity(input.identity)
        ?? validateOptionalStrings(input, ['runtimeModelRef']);
    case 'tool':
      return validateAllowedKeys(input, ['kind', 'toolName', 'identity', 'agentId'])
        ?? validateRequiredStrings(input, ['toolName'])
        ?? (input.identity !== undefined ? validateSessionIdentity(input.identity) : null)
        ?? validateOptionalStrings(input, ['agentId']);
    case 'workspace-file':
      return validateAllowedKeys(input, ['kind', 'path', 'workspaceId', 'sourceId', 'identity'])
        ?? validateRequiredStrings(input, ['path'])
        ?? validateOptionalStrings(input, ['workspaceId', 'sourceId'])
        ?? validateSessionIdentity(input.identity);
    case 'workspace-staging':
      return validateAllowedKeys(input, ['kind', 'identity', 'stagingId'])
        ?? validateSessionIdentity(input.identity)
        ?? validateOptionalStrings(input, ['stagingId']);
    case 'team':
      return validateAllowedKeys(input, ['kind', 'teamId', 'packagePath']) ?? validateOptionalStrings(input, ['teamId', 'packagePath']);
    case 'team-run':
      return validateAllowedKeys(input, ['kind', 'teamId', 'runId'])
        ?? validateRequiredStrings(input, ['runId'])
        ?? validateOptionalStrings(input, ['teamId']);
    case 'team-stage':
      return validateAllowedKeys(input, ['kind', 'runId', 'stageId']) ?? validateRequiredStrings(input, ['runId', 'stageId']);
    case 'team-dispatch':
      return validateAllowedKeys(input, ['kind', 'runId', 'dispatchId']) ?? validateRequiredStrings(input, ['runId', 'dispatchId']);
    case 'team-approval':
      return validateAllowedKeys(input, ['kind', 'runId', 'approvalId']) ?? validateRequiredStrings(input, ['runId', 'approvalId']);
    default:
      return 'CapabilityTarget kind is invalid';
  }
}

export function targetBelongsToScope(target: CapabilityTarget | null | undefined, scope: RuntimeScope): boolean {
  if (!target || target.kind === 'none') {
    return true;
  }
  switch (target.kind) {
    case 'setting':
    case 'license':
      return scope.kind === 'app';
    case 'runtime-endpoint':
    case 'runtime-job':
    case 'gateway-control':
    case 'provider-account':
    case 'provider-credential':
    case 'provider-oauth':
    case 'capability-route':
    case 'security-policy':
    case 'security-remediation':
    case 'channel':
    case 'channel-pairing':
    case 'skill':
    case 'plugin':
      return scope.kind === 'runtime-instance';
    case 'team':
      return scope.kind === 'runtime-instance';
    case 'skill-bundle':
      return target.agentId ? targetBelongsToScope({ kind: 'agent', agentId: target.agentId }, scope) : scope.kind === 'runtime-instance';
    case 'cron-job':
      return target.executionTarget ? targetBelongsToScope(target.executionTarget, scope) : scope.kind === 'runtime-instance';
    case 'task':
      return target.owner ? targetBelongsToScope(target.owner, scope) : false;
    case 'agent':
      return scope.kind === 'agent' && scope.agentId === target.agentId;
    case 'subagent':
      return scope.kind === 'agent' && scope.agentId === target.agentId;
    case 'session':
      return scopeContainsSessionIdentity(scope, target.identity);
    case 'approval':
    case 'model-selection':
      return scopeContainsSessionIdentity(scope, target.identity);
    case 'tool':
      return target.identity
        ? scopeContainsSessionIdentity(scope, target.identity)
        : target.agentId
          ? targetBelongsToScope({ kind: 'agent', agentId: target.agentId }, scope)
          : scope.kind === 'runtime-instance' || scope.kind === 'agent' || scope.kind === 'session';
    case 'workspace-file':
      return workspaceFileTargetBelongsToScope(target, scope);
    case 'workspace-staging':
      return scopeContainsSessionIdentity(scope, target.identity);
    case 'team-run':
      return scope.kind === 'team-run' ? scope.runId === target.runId : scope.kind === 'runtime-instance';
    case 'team-stage':
    case 'team-dispatch':
    case 'team-approval':
      return scope.kind === 'team-run' ? scope.runId === target.runId : scope.kind === 'runtime-instance';
  }
}

function scopeContainsSessionIdentity(scope: RuntimeScope, identity: SessionIdentity): boolean {
  if (scope.kind === 'session') {
    return sessionIdentitiesEqual(scope.identity, identity);
  }
  if (scope.kind === 'agent') {
    return scope.agentId === identity.agentId && runtimeEndpointsEqual(scope.endpoint, identity.endpoint);
  }
  if (scope.kind === 'runtime-instance' || scope.kind === 'workspace') {
    return runtimeEndpointsEqual(scope.endpoint, identity.endpoint);
  }
  return false;
}

function workspaceFileTargetBelongsToScope(target: WorkspaceFileTarget, scope: RuntimeScope): boolean {
  if (!target.identity || !scopeContainsSessionIdentity(scope, target.identity)) {
    return false;
  }
  if (scope.kind === 'workspace') {
    if (target.workspaceId !== scope.workspaceId) {
      return false;
    }
    if (target.sourceId !== scope.sourceId) {
      return false;
    }
    return runtimeEndpointsEqual(scope.endpoint, target.identity.endpoint);
  }
  return scopeContainsSessionIdentity(scope, target.identity);
}

function validateNestedTarget(input: unknown, allowedKinds: readonly CapabilityTargetKind[], key: string): string | null {
  if (input === undefined) {
    return null;
  }
  const targetError = validateCapabilityTarget(input);
  if (targetError) {
    return `${key}.${targetError}`;
  }
  const target = input as CapabilityTarget;
  return allowedKinds.includes(target.kind) ? null : `${key} target kind is invalid`;
}

function validateAllowedKeys(input: Record<string, unknown>, allowedKeys: readonly string[]): string | null {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      return `${key} is not allowed for ${input.kind}`;
    }
  }
  return null;
}

function validateOptionalStrings(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      return `${key} must be a string`;
    }
  }
  return null;
}

function validateRequiredStrings(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim()) {
      return `${key} is required`;
    }
  }
  return null;
}

function validateForbiddenKeys(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (input[key] !== undefined) {
      return `${key} is not allowed for ${input.kind}`;
    }
  }
  return null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
