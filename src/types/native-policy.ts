import { runtimeEndpointsEqual, sessionIdentitiesEqual, validateRuntimeScope, validateSessionIdentity, type AgentScope, type SessionIdentity } from './desktop/runtime-address';

export const NATIVE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const;
export type NativePermissionMode = typeof NATIVE_PERMISSION_MODES[number];
export interface NativePermissions {
  allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: NativePermissionMode;
  disableBypassPermissionsMode?: 'disable'; additionalDirectories?: string[];
}
export const NATIVE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged'] as const;
export type NativeHookEvent = typeof NATIVE_HOOK_EVENTS[number];
type HookCommon = { if?: string; timeout?: number; statusMessage?: string; once?: boolean };
export type NativeHook = HookCommon & (
  | { type: 'command'; command: string; shell?: 'bash' | 'powershell'; async?: boolean; asyncRewake?: boolean }
  | { type: 'prompt' | 'agent'; prompt: string; model?: string }
  | { type: 'http'; url: string; headers?: Record<string, string>; allowedEnvVars?: string[] }
);
export type NativeHooks = Partial<Record<NativeHookEvent, { matcher?: string; hooks: NativeHook[] }[]>>;
export type NativeHookCounts = Partial<Record<NativeHookEvent, { matcherCount: number; hookCount: number }>>;
export type NativePlatform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown';
export interface NativeSandboxNetwork {
  allowedDomains?: string[]; allowManagedDomainsOnly?: boolean; allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean; allowLocalBinding?: boolean; httpProxyPort?: number; socksProxyPort?: number;
}
export interface NativeSandboxFilesystem {
  allowWrite?: string[]; denyWrite?: string[]; denyRead?: string[]; allowRead?: string[]; allowManagedReadPathsOnly?: boolean;
}
interface SandboxSettings {
  enabled?: boolean; failIfUnavailable?: boolean; autoAllowBashIfSandboxed?: boolean; allowUnsandboxedCommands?: boolean;
  enabledPlatforms?: NativePlatform[]; network?: NativeSandboxNetwork; filesystem?: NativeSandboxFilesystem;
  ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean; enableWeakerNetworkIsolation?: boolean; excludedCommands?: string[];
}
export interface NativeSandbox extends SandboxSettings { ripgrepConfigured: boolean }
export interface NativeSandboxPatch extends SandboxSettings { ripgrep?: { command: string; args?: string[] } }
export type NativePolicyOperation = 'nativePermissions.get' | 'nativePermissions.set' | 'nativeHooks.get' | 'nativeHooks.set' | 'nativeSandbox.status' | 'nativeSandbox.set' | 'nativePolicy.result';
type PolicySubject = { sessionIdentity?: SessionIdentity };
type PolicyEnvelope = { id: 'security.nativePolicy'; scope: AgentScope; target: { kind: 'native-policy' } };
export type NativePolicyRequest = PolicyEnvelope & (
  | { operationId: 'nativePermissions.get' | 'nativeHooks.get' | 'nativeSandbox.status'; input: PolicySubject }
  | { operationId: 'nativePermissions.set'; input: PolicySubject & { permissions: NativePermissions } }
  | { operationId: 'nativeHooks.set'; input: PolicySubject & { hooks: NativeHooks } }
  | { operationId: 'nativeSandbox.set'; input: PolicySubject & { sandbox: NativeSandboxPatch } }
  | { operationId: 'nativePolicy.result'; input: PolicySubject & { callId: string } }
);
export type NativePolicyStep = 'apply_flag_settings' | 'set_permission_mode';
export interface NativePolicyMutation {
  agentId: string; persisted: boolean; projection: 'nextLaunchFlagSettings';
  live: { status: 'notRequested' | 'notRunning' | 'restartRequired' | 'acknowledged'; sessionId: string | null; instanceId: string | null; steps: NativePolicyStep[] };
  restartRequired: boolean; restartFields: string[]; otherSessions: 'notApplied';
}
export interface NativePolicyFailure {
  outcome: 'unsupported' | 'rejected' | 'unavailable' | 'unknown'; code: number | null; kind: string;
  persisted: boolean | null; projection: 'nextLaunchFlagSettings' | null; acknowledgedSteps: NativePolicyStep[];
  restartRequired: boolean | null; restartFields: string[]; otherSessions: 'notApplied' | null;
}
export interface NativePolicySnapshot<T> {
  agentId: string; configured: T; configuredSource: 'serverAgentSettings'; projection: 'nextLaunchFlagSettings';
  authority: 'nativePermissionPipeline' | 'nativeHookPipeline' | 'nativeSandbox';
  native: { status: 'observedSettings'; sessionIdentity: SessionIdentity; instanceId: string; effective: T;
    sources: { source: 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'; settings: T }[] } | null;
  nativeObservation: 'notRequested' | 'notRunning' | 'observed';
  platform: { name: NativePlatform; support: 'unsupportedWindows' | 'unsupportedWsl1' | 'nativeDependencyCheckRequired' | 'unsupportedPlatform'; nativeDependencies: 'notProbedByServer' } | null;
  isolation: 'notObserved' | null;
}
export type NativePolicyResult =
  | { outcome: 'available'; snapshot: NativePolicySnapshot<NativePermissions | NativeHookCounts | NativeSandbox> }
  | { outcome: 'confirmed'; receipt: NativePolicyMutation }
  | NativePolicyFailure;

type Validator = (value: unknown) => boolean;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const string: Validator = (value) => typeof value === 'string';
const identifier: Validator = (value) => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const boolean: Validator = (value) => typeof value === 'boolean';
const integer: Validator = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const number: Validator = (value) => typeof value === 'number' && Number.isFinite(value);
const member = (values: readonly string[]): Validator => (value) => typeof value === 'string' && values.includes(value);
const array = (validate: Validator): Validator => (value) => Array.isArray(value) && value.every(validate);
const nullable = (validate: Validator): Validator => (value) => value === null || validate(value);
const strings = array(string);
function shape(value: unknown, required: Record<string, Validator>, optional: Record<string, Validator> = {}): value is Record<string, unknown> {
  return record(value) && Object.entries(required).every(([key, validate]) => Object.hasOwn(value, key) && validate(value[key]))
    && Object.entries(value).every(([key, item]) => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](item)));
}
const map = (validate: Validator, key: Validator = string): Validator => (value) => record(value) && Object.entries(value).every(([name, item]) => key(name) && validate(item));
const permissionFields = { allow: strings, deny: strings, ask: strings, defaultMode: member(NATIVE_PERMISSION_MODES), disableBypassPermissionsMode: member(['disable']), additionalDirectories: strings };
const permissions: Validator = (value) => shape(value, {}, permissionFields);
const hookEvent = member(NATIVE_HOOK_EVENTS);
const hookCommon = { if: string, timeout: number, statusMessage: string, once: boolean };
const hook: Validator = (value) => {
  if (!record(value)) return false;
  if (value.type === 'command') return shape(value, { type: member(['command']), command: string }, { ...hookCommon, shell: member(['bash', 'powershell']), async: boolean, asyncRewake: boolean });
  if (value.type === 'prompt' || value.type === 'agent') return shape(value, { type: member(['prompt', 'agent']), prompt: string }, { ...hookCommon, model: string });
  return shape(value, { type: member(['http']), url: string }, { ...hookCommon, headers: map(string), allowedEnvVars: strings });
};
const hooks: Validator = map(array((value) => shape(value, { hooks: array(hook) }, { matcher: string })), hookEvent);
const hookCounts: Validator = map((value) => shape(value, { matcherCount: integer, hookCount: integer }), hookEvent);
const platformName = member(['macos', 'windows', 'wsl', 'linux', 'unknown']);
const port: Validator = (value) => integer(value) && (value as number) <= 65535;
const sandboxFields = {
  enabled: boolean, failIfUnavailable: boolean, autoAllowBashIfSandboxed: boolean, allowUnsandboxedCommands: boolean,
  enabledPlatforms: array(platformName),
  network: (value: unknown) => shape(value, {}, { allowedDomains: strings, allowManagedDomainsOnly: boolean, allowUnixSockets: strings, allowAllUnixSockets: boolean, allowLocalBinding: boolean, httpProxyPort: port, socksProxyPort: port }),
  filesystem: (value: unknown) => shape(value, {}, { allowWrite: strings, denyWrite: strings, denyRead: strings, allowRead: strings, allowManagedReadPathsOnly: boolean }),
  ignoreViolations: map(strings), enableWeakerNestedSandbox: boolean, enableWeakerNetworkIsolation: boolean, excludedCommands: strings,
};
const sandbox: Validator = (value) => shape(value, { ripgrepConfigured: boolean }, sandboxFields);
const sandboxPatch: Validator = (value) => shape(value, {}, { ...sandboxFields, ripgrep: (item) => shape(item, { command: string }, { args: strings }) });
const policyStep = member(['apply_flag_settings', 'set_permission_mode']);
const projection = member(['nextLaunchFlagSettings']);
const otherSessions = member(['notApplied']);
const restartField: Validator = (value) => typeof value === 'string' && (['sandbox', 'permissions.allow', 'permissions.deny', 'permissions.ask', 'permissions.defaultMode', 'permissions.disableBypassPermissionsMode', 'permissions.additionalDirectories'].includes(value)
  || value.startsWith('hooks.') && hookEvent(value.slice(6)));
const failureKind = member(['native_policy_unavailable', 'native_policy_unknown', 'native_policy_target_rejected', 'native_policy_unsupported', 'native_policy_failed', 'policy_response_invalid', 'policy_session_agent_mismatch', 'policy_settings_shape', 'policy_native_settings_schema', 'permissions_rule_invalid', 'permissions_directory_invalid', 'hooks_event_unknown', 'hooks_event_type_unsupported', 'hooks_timeout_invalid', 'hooks_url_invalid', 'hooks_schema_invalid', 'sandbox_windows_unsupported', 'sandbox_wsl1_unsupported', 'sandbox_platform_unsupported', 'sandbox_platform_excluded', 'sandbox_silent_fallback_forbidden', 'sandbox_unsandboxed_exclusions', 'sandbox_settings_invalid', 'sandbox_platform_probe']);

export function isNativePolicyRequest(value: unknown): value is NativePolicyRequest {
  if (!shape(value, { id: member(['security.nativePolicy']), operationId: string, scope: (scope) => validateRuntimeScope(scope) === null && record(scope) && scope.kind === 'agent', target: (target) => shape(target, { kind: member(['native-policy']) }), input: record })) return false;
  const scope = value.scope as AgentScope;
  if (scope.endpoint.kind !== 'native-runtime' || !['openclaw', 'matcha-agent'].includes(scope.endpoint.runtimeAdapterId) || scope.endpoint.runtimeInstanceId !== 'local') return false;
  const subject = { sessionIdentity: (identity: unknown) => validateSessionIdentity(identity) === null && (identity as SessionIdentity).agentId === scope.agentId && runtimeEndpointsEqual((identity as SessionIdentity).endpoint, scope.endpoint) };
  const input = value.input as Record<string, unknown>;
  switch (value.operationId) {
    case 'nativePermissions.get': case 'nativeHooks.get': case 'nativeSandbox.status': return shape(input, {}, subject);
    case 'nativePolicy.result': return shape(input, { callId: (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) }, subject);
    case 'nativePermissions.set': return shape(input, { permissions }, subject) && Object.keys(input.permissions as object).length > 0;
    case 'nativeHooks.set': return shape(input, { hooks }, subject) && Object.keys(input.hooks as object).length > 0;
    case 'nativeSandbox.set': return shape(input, { sandbox: sandboxPatch }, subject) && Object.keys(input.sandbox as object).length > 0;
    default: return false;
  }
}
export function decodeNativePolicyResult(value: unknown, request: NativePolicyRequest): NativePolicyResult | null {
  if (!isNativePolicyRequest(request) || !record(value)) return null;
  const failure: Validator = (item) => shape(item, { outcome: member(['unsupported', 'rejected', 'unavailable', 'unknown']), code: nullable((code) => typeof code === 'number' && Number.isSafeInteger(code)), kind: failureKind,
    persisted: nullable(boolean), projection: nullable(projection), acknowledgedSteps: array(policyStep), restartRequired: nullable(boolean), restartFields: array(restartField), otherSessions: nullable(otherSessions) });
  if (failure(value)) return value as unknown as NativePolicyFailure;
  if (value.outcome === 'confirmed') {
    const live: Validator = (item) => {
      if (!shape(item, { status: member(['notRequested', 'notRunning', 'restartRequired', 'acknowledged']), sessionId: nullable(identifier), instanceId: nullable(identifier), steps: array(policyStep) })) return false;
      const steps = item.steps as NativePolicyStep[];
      if (!request.input.sessionIdentity) return item.status === 'notRequested' && item.sessionId === null && item.instanceId === null && steps.length === 0;
      if (item.sessionId === null || item.status === 'notRequested') return false;
      if (item.status === 'notRunning') return item.instanceId === null && steps.length === 0;
      if (item.status === 'restartRequired') return record(value.receipt) && value.receipt.restartRequired === true && steps.length === 0;
      return item.instanceId !== null && steps.length > 0;
    };
    return (request.operationId.endsWith('.set') || request.operationId === 'nativePolicy.result')
      && shape(value, { outcome: member(['confirmed']), receipt: (item) => shape(item, { agentId: (id) => id === request.scope.agentId, persisted: (persisted) => persisted === true, projection, live, restartRequired: boolean, restartFields: array(restartField), otherSessions }) })
      ? value as unknown as NativePolicyResult : null;
  }
  const section = request.operationId === 'nativePermissions.get' ? permissions : request.operationId === 'nativeHooks.get' ? hookCounts : request.operationId === 'nativeSandbox.status' ? sandbox : null;
  if (!section) return null;
  const authority = request.operationId === 'nativePermissions.get' ? 'nativePermissionPipeline' : request.operationId === 'nativeHooks.get' ? 'nativeHookPipeline' : 'nativeSandbox';
  const native: Validator = (item) => shape(item, { status: member(['observedSettings']), sessionIdentity: (identity) => validateSessionIdentity(identity) === null && !!request.input.sessionIdentity && sessionIdentitiesEqual(identity as SessionIdentity, request.input.sessionIdentity), instanceId: identifier, effective: section,
    sources: array((source) => shape(source, { source: member(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']), settings: section })) });
  const platform: Validator = (item) => shape(item, { name: platformName, support: member(['unsupportedWindows', 'unsupportedWsl1', 'nativeDependencyCheckRequired', 'unsupportedPlatform']), nativeDependencies: member(['notProbedByServer']) });
  if (!shape(value, { outcome: member(['available']), snapshot: (item) => shape(item, { agentId: (id) => id === request.scope.agentId, configured: section, configuredSource: member(['serverAgentSettings']), projection, authority: member([authority]), native: nullable(native), nativeObservation: member(['notRequested', 'notRunning', 'observed']), platform: nullable(platform), isolation: nullable(member(['notObserved'])) }) })) return null;
  const snapshot = value.snapshot as Record<string, unknown>;
  if ((snapshot.nativeObservation === 'observed') !== (snapshot.native !== null)
    || (request.input.sessionIdentity === undefined ? snapshot.nativeObservation !== 'notRequested' : snapshot.nativeObservation === 'notRequested')) return null;
  return value as unknown as NativePolicyResult;
}
