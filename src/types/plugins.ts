import { validateRuntimeScope, type AgentScope, type RuntimeInstanceScope } from './desktop/runtime-address';

export type PluginScope = RuntimeInstanceScope | AgentScope;
export type PluginRuntimeId = 'openclaw' | 'matcha-agent';
export type OpenClawPlugin = Readonly<{
  runtime: 'openclaw';
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw';
  enabled: boolean;
  installed: boolean;
  updateAvailable: boolean;
  companionSkillReady: boolean;
  description?: string;
  companionSkillSlugs?: string[];
}>;
export type MatchaPlugin = Readonly<{
  runtime: 'matcha-agent';
  id: string;
  version: string;
  scope: 'user' | 'project' | 'local' | 'managed' | 'session';
  enabled: boolean;
  errorCount: number;
}>;
export type PluginCatalogItem = OpenClawPlugin | MatchaPlugin;
export type PluginCatalog = Readonly<{
  success: true;
  execution: Readonly<{ enabledPluginIds: string[] }>;
  plugins: readonly OpenClawPlugin[];
}> | Readonly<{
  success: true;
  agentId: string;
  sessionState: 'not_observed';
  plugins: readonly MatchaPlugin[];
}>;

type Lifecycle = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
export type PluginRuntime = Readonly<{
  success: true;
  state: Readonly<{ lifecycle: Lifecycle; runtimeLifecycle: Lifecycle; activePluginCount: number; enabledPluginIds: string[] }>;
  health: Readonly<{ ok: boolean; lifecycle: Lifecycle; activePluginCount: number; degradedPlugins: string[]; error?: string }>;
  execution: Readonly<{ enabledPluginIds: string[] }>;
}>;
export type PluginConfigurationInput = Readonly<{ runtime: PluginRuntimeId; scope?: PluginScope; pluginId: string; enabled: boolean }>;
export type PluginOperation = 'install' | 'update' | 'uninstall';
export type PluginOperationInput = Readonly<{ runtime: PluginRuntimeId; scope?: PluginScope; pluginId: string; operation: PluginOperation }>;
export type PluginMutationReceipt = Readonly<{ callId: string; accepted: true }>;

export function isPluginScope(value: unknown): value is PluginScope {
  if (validateRuntimeScope(value) !== null) return false;
  const scope = value as PluginScope;
  return (scope.kind === 'runtime-instance' || scope.kind === 'agent')
    && scope.endpoint.kind === 'native-runtime' && scope.endpoint.runtimeInstanceId === 'local'
    && (scope.kind === 'runtime-instance' ? scope.endpoint.runtimeAdapterId === 'openclaw' : scope.endpoint.runtimeAdapterId === 'matcha-agent');
}

export function pluginRuntime(scope?: PluginScope): PluginRuntimeId {
  if (scope !== undefined && !isPluginScope(scope)) throw new Error('Invalid plugin scope');
  return scope?.kind === 'agent' ? 'matcha-agent' : 'openclaw';
}

export function isPluginCatalog(value: unknown, scope?: PluginScope): value is PluginCatalog {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.plugins)) return false;
  if (scope?.kind === 'agent') {
    return exact(value, ['success', 'agentId', 'sessionState', 'plugins'])
      && value.agentId === scope.agentId && value.sessionState === 'not_observed'
      && value.plugins.every(isMatchaPlugin);
  }
  return exact(value, ['success', 'execution', 'plugins']) && isExecution(value.execution) && value.plugins.every(isOpenClawPlugin);
}

function isOpenClawPlugin(value: unknown): value is OpenClawPlugin {
  return isRecord(value)
    && keys(value, ['runtime', 'id', 'name', 'version', 'kind', 'platform', 'enabled', 'installed', 'updateAvailable', 'companionSkillReady'], ['description', 'companionSkillSlugs'])
    && value.runtime === 'openclaw' && value.platform === 'openclaw' && identity(value.id)
    && text(value.name) && text(value.version) && (value.kind === 'builtin' || value.kind === 'third-party')
    && typeof value.enabled === 'boolean' && typeof value.installed === 'boolean'
    && typeof value.updateAvailable === 'boolean' && typeof value.companionSkillReady === 'boolean'
    && (value.description === undefined || typeof value.description === 'string')
    && (value.companionSkillSlugs === undefined || (Array.isArray(value.companionSkillSlugs) && value.companionSkillSlugs.every(identity)));
}

function isMatchaPlugin(value: unknown): value is MatchaPlugin {
  return isRecord(value) && exact(value, ['runtime', 'id', 'version', 'scope', 'enabled', 'errorCount'])
    && value.runtime === 'matcha-agent' && typeof value.id === 'string' && value.id.trim().length > 0
    && typeof value.version === 'string' && ['user', 'project', 'local', 'managed', 'session'].includes(value.scope as string)
    && typeof value.enabled === 'boolean' && count(value.errorCount);
}

export function isPluginRuntime(value: unknown): value is PluginRuntime {
  if (!isRecord(value) || !exact(value, ['success', 'state', 'health', 'execution']) || value.success !== true) return false;
  const { state, health } = value;
  return isRecord(state) && exact(state, ['lifecycle', 'runtimeLifecycle', 'activePluginCount', 'enabledPluginIds'])
    && lifecycle(state.lifecycle) && lifecycle(state.runtimeLifecycle) && count(state.activePluginCount)
    && Array.isArray(state.enabledPluginIds) && state.enabledPluginIds.every(identity)
    && isRecord(health) && keys(health, ['ok', 'lifecycle', 'activePluginCount', 'degradedPlugins'], ['error'])
    && typeof health.ok === 'boolean' && lifecycle(health.lifecycle) && count(health.activePluginCount)
    && Array.isArray(health.degradedPlugins) && health.degradedPlugins.every(identity)
    && (health.error === undefined || typeof health.error === 'string') && isExecution(value.execution);
}

function binding(value: Record<string, unknown>): boolean {
  return value.scope === undefined ? !Object.hasOwn(value, 'scope') && value.runtime === 'openclaw'
    : isPluginScope(value.scope) && value.runtime === pluginRuntime(value.scope);
}

export function isPluginConfigurationInput(value: unknown): value is PluginConfigurationInput {
  return isRecord(value) && keys(value, ['runtime', 'pluginId', 'enabled'], ['scope'])
    && binding(value) && identity(value.pluginId) && typeof value.enabled === 'boolean';
}

export function isPluginOperationInput(value: unknown): value is PluginOperationInput {
  return isRecord(value) && keys(value, ['runtime', 'pluginId', 'operation'], ['scope'])
    && binding(value) && identity(value.pluginId) && ['install', 'update', 'uninstall'].includes(value.operation as string);
}

export function isPluginMutationReceipt(value: unknown): value is PluginMutationReceipt {
  return isRecord(value) && exact(value, ['callId', 'accepted'])
    && typeof value.callId === 'string' && /^[a-f0-9]{32}$/.test(value.callId) && value.accepted === true;
}

function isExecution(value: unknown): boolean {
  return isRecord(value) && exact(value, ['enabledPluginIds']) && Array.isArray(value.enabledPluginIds) && value.enabledPluginIds.every(identity);
}
function lifecycle(value: unknown): boolean { return ['starting', 'running', 'restarting', 'stopping', 'stopped', 'error'].includes(value as string); }
function count(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function text(value: unknown): boolean { return typeof value === 'string' && value.trim().length > 0; }
function identity(value: unknown): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\0]/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, required: readonly string[]): boolean { return keys(value, required, []); }
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
