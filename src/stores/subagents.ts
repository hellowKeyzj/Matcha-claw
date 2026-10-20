import { create } from 'zustand';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import type {
  AgentScope, RuntimeEndpointRef, RuntimeInstanceScope,
} from '../types/desktop/runtime-address';
import type { CapabilityTarget } from '../types/desktop/capability-target';
import {
  createErrorResourceState,
  createIdleResourceState,
  createLoadingResourceState,
  createReadyResourceState,
  type ResourceStateMeta,
} from '@/lib/resource-state';
import {
  buildTemplateAvatarSeed,
  DEFAULT_AGENT_AVATAR_STYLE,
  resolveAgentAvatarStyle,
  type AgentAvatarStyle,
} from '@/lib/agent-avatar';
import { hostApiFetch } from '@/lib/host-api';
import { agentScope, buildCapabilityScopeKey, runtimeEndpointsEqual, runtimeInstanceScope } from '@/types/desktop/runtime-address';
import { selectManagementEndpoint, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { hostExportSkillBundles, hostSkillsMutation } from '@/lib/skills';
import { isSubagentMutation, subagentMutationError, waitForSubagentMutation, waitForSubagentResult } from '@/lib/subagent-call';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import { runCloudPackageOperation } from '@/lib/cloud-package-call';
import i18n from '@/i18n';
import { fetchSelectableProviderModels } from '@/lib/provider-models';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier } from '@/lib/session-trace';
import { useChatStore } from '@/stores/chat';
import {
  buildSubagentWorkspacePath,
  hasSubagentNameConflict,
  normalizeSubagentNameToSlug,
} from '@/features/subagents/domain/workspace';
import type {
  AgentsListResult,
  ModelCatalogEntry,
  SubagentCloudPackage,
  SubagentCloudPackageInstallResult,
  SubagentCloudPackageUploadResult,
  SubagentConfigPackage,
  SubagentImportResult,
  SubagentPackageExportResult,
  SubagentSummary,
  SubagentTemplateDetail,
  SubagentTargetFile,
} from '@/types/subagent';

import type { CloudPackageListPage, CloudPackageVersion, InstalledCloudPackage, InstalledCloudPackageList } from '@/types/cloud-package';

const CONFIG_DISPLAY_CACHE_TTL_MS = 1000;
const SUBAGENT_SNAPSHOT_NOT_READY_RETRY_MS = 1200;
const SUBAGENT_AVATAR_STORAGE_KEY = 'matchaclaw-subagent-avatar-presentations';
const SUBAGENT_MANAGEMENT_CAPABILITY_ID = 'subagent.management';
const SUBAGENT_CONFIG_PACKAGE_SCHEMA = 'matchaclaw.agent-config' as const;
const SUBAGENT_CONFIG_PACKAGE_VERSION = 1 as const;
type SubagentWorkspaceInitialization = 'mainAgentTemplate' | 'emptyWorkspace';
interface RuntimeAgentReads {
  generation: number;
  loadTask: Promise<void> | null;
  configCache: { snapshot: ConfigDisplaySnapshot; cachedAt: number } | null;
  configTask: Promise<ConfigDisplaySnapshot> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pendingDeletedAgentIds: Set<string>;
  unconfirmedDeletedAgentIds: Set<string>;
}
const agentReadsByRuntime = new Map<string, RuntimeAgentReads>();
const EMPTY_AGENTS_RESOURCE = createIdleResourceState<SubagentSummary[]>([]);

function agentRuntimeKey(endpoint: RuntimeEndpointRef): string {
  return buildCapabilityScopeKey(runtimeInstanceScope(endpoint));
}

export function selectAgentsResource(
  state: Pick<SubagentsState, 'agentsByRuntime'>,
  endpoint: RuntimeEndpointRef | null,
): ResourceStateMeta<SubagentSummary[]> {
  return endpoint ? state.agentsByRuntime[agentRuntimeKey(endpoint)] ?? EMPTY_AGENTS_RESOURCE : EMPTY_AGENTS_RESOURCE;
}

function runtimeAgentReads(endpoint: RuntimeEndpointRef): RuntimeAgentReads {
  const key = agentRuntimeKey(endpoint);
  let reads = agentReadsByRuntime.get(key);
  if (!reads) {
    reads = { generation: 0, loadTask: null, configCache: null, configTask: null, retryTimer: null, pendingDeletedAgentIds: new Set(), unconfirmedDeletedAgentIds: new Set() };
    agentReadsByRuntime.set(key, reads);
  }
  return reads;
}

function publishAgentsResource(
  endpoint: RuntimeEndpointRef,
  resource: ResourceStateMeta<SubagentSummary[]>,
  managementPatch: Partial<SubagentsState> = {},
): void {
  useSubagentsStore.setState((state) => ({
    agentsByRuntime: { ...state.agentsByRuntime, [agentRuntimeKey(endpoint)]: resource },
    ...(state.managementScope && runtimeEndpointsEqual(state.managementScope.endpoint, endpoint)
      ? { ...managementPatch, agentsResource: resource }
      : {}),
  }));
}
let availableModelsLoaded = false;
let inflightAvailableModelsTask: Promise<void> | null = null;
let latestAvailableModelsRequestId = 0;

async function subagentManagementCapabilityExecute<TResult>(
  operationId: string,
  scope: SubagentManagementScope,
  input: Record<string, unknown>,
  target: CapabilityTarget,
  timeoutMs?: number,
): Promise<TResult> {
  const result = await hostApiFetch<unknown>('/api/subagents/agents', {
    method: 'POST',
    body: JSON.stringify({
      id: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId,
      scope,
      target,
      input,
    }),
    timeoutMs,
  });
  return isSubagentMutation(operationId)
    ? await waitForSubagentMutation<TResult>(result, operationId, scope.endpoint, typeof input.agentId === 'string' ? input.agentId : undefined)
    : result as TResult;
}

interface AgentFileGetResult {
  file?: {
    content?: unknown;
  };
}

interface AgentsCreateResult {
  success: boolean;
  agent: { id: string };
  error?: string;
}

interface CreateAgentOptions {
  scope?: SubagentManagementScope;
  workspaceInitialization?: SubagentWorkspaceInitialization;
}

interface SubagentCreateResult {
  agentId: string;
  warning?: string;
}

interface ConfigAgentDisplaySnapshot {
  description?: string;
  workspace?: string;
  model?: string;
  skills?: string[];
}

interface SubagentAvatarPresentation {
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface SkillBundleImportResult {
  ok?: boolean;
  installed?: string[];
  error?: string;
}

interface ConfigDisplaySnapshot {
  byAgentId: Map<string, ConfigAgentDisplaySnapshot>;
  defaultWorkspace?: string;
  defaultModel?: string;
  defaultSkills?: string[];
}

interface SubagentDisplayConfigResult {
  agents?: unknown;
  defaults?: unknown;
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}

interface LoadAgentsOptions {
  silent?: boolean;
  scope?: SubagentManagementScope;
}

export type SubagentManagementScope = AgentScope | RuntimeInstanceScope;
let activeManagementKey: string | null = null;
let activeManagementScope: SubagentManagementScope | null = null;

function scopeKey(scope: SubagentManagementScope): string { return buildCapabilityScopeKey(scope); }
function isCurrentScope(scope: SubagentManagementScope): boolean {
  const selected = selectedManagementScope();
  return activeManagementScope === scope && selected !== null && scopeKey(selected) === scopeKey(scope);
}
function requireAgentScope(scope: SubagentManagementScope): AgentScope {
  if (scope.kind !== 'agent') throw new Error('Select a real management Agent before this operation.');
  return scope;
}
function activateManagementScope(scope: SubagentManagementScope | null): void {
  const key = scope ? scopeKey(scope) : null;
  if (activeManagementKey === key) return;
  activeManagementKey = key;
  activeManagementScope = scope ? { ...scope } : null;
  resetManagementCaches();
  const resource = selectAgentsResource(useSubagentsStore.getState(), scope?.endpoint ?? null);
  useSubagentsStore.setState({ managementScope: activeManagementScope, agentsResource: resource, managedAgentId: null, selectedAgentId: null, persistedFilesByAgent: {}, mutating: false, error: resource.error });
}

interface SubagentRpcOptions {
  scope?: SubagentManagementScope;
  target?: CapabilityTarget;
  timeoutMs?: number;
}

export function getSubagentManagementScope(endpoint: RuntimeEndpointRef | null): SubagentManagementScope | null {
  if (!endpoint) return null;
  if (endpoint.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'matcha-agent') return runtimeInstanceScope(endpoint);
  const runtime = useRuntimeEndpointsStore.getState().endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint));
  return runtime?.defaultAgentId ? agentScope(endpoint, runtime.defaultAgentId) : null;
}

function selectedManagementScope(): SubagentManagementScope | null {
  return getSubagentManagementScope(selectManagementEndpoint(useRuntimeEndpointsStore.getState()));
}

async function resolveSubagentManagementScope(capturedScope?: SubagentManagementScope): Promise<SubagentManagementScope> {
  if (capturedScope) {
    if (!isCurrentScope(capturedScope)) throw new Error('Management scope changed before Agent operation.');
    return capturedScope;
  }
  activateManagementScope(selectedManagementScope());
  if (!activeManagementScope) throw new Error('Select a runtime first.');
  return activeManagementScope;
}

function buildSubagentTarget(_scope: SubagentManagementScope, subagentId: string): CapabilityTarget {
  return {
    kind: 'subagent',
    subagentId,
  };
}

interface SubagentsState {
  agents: SubagentSummary[];
  agentsResource: ResourceStateMeta<SubagentSummary[]>;
  agentsByRuntime: Record<string, ResourceStateMeta<SubagentSummary[]>>;
  managementScope: SubagentManagementScope | null;
  cloudPackages: SubagentCloudPackage[];
  installedCloudPackages: InstalledCloudPackage[];
  cloudLoading: boolean;
  cloudError: string | null;
  myCloudPackages: CloudPackageVersion[];
  myCloudLoading: boolean;
  myCloudError: string | null;
  cloudPublishingByVersionId: Record<string, boolean>;
  cloudInstallingByVersionId: Record<string, boolean>;
  loadMyCloudPackages: () => Promise<void>;
  publishCloudAgentPackage: (packageVersionId: string) => Promise<void>;
  availableModels: ModelCatalogEntry[];
  modelsLoading: boolean;
  mutating: boolean;
  error: string | null;
  managedAgentId: string | null;
  persistedFilesByAgent: Record<string, Partial<Record<SubagentTargetFile, string>>>;
  selectedAgentId: string | null;
  loadAgents: (options?: LoadAgentsOptions) => Promise<void>;
  loadCloudPackages: () => Promise<void>;
  loadAvailableModels: (options?: { force?: boolean }) => Promise<void>;
  selectAgent: (agentId: string | null) => void;
  setManagedAgentId: (agentId: string | null) => void;
  setManagementScope: (scope: SubagentManagementScope | null) => void;
  loadPersistedFilesForAgent: (agentId: string, scope?: SubagentManagementScope) => Promise<Partial<Record<SubagentTargetFile, string>>>;
  createAgent: (input: {
    name: string;
    description?: string | null;
    workspace?: string;
    model?: string;
    avatarSeed?: string;
    avatarStyle?: AgentAvatarStyle;
  }, options?: CreateAgentOptions) => Promise<SubagentCreateResult>;
  createAgentFromTemplate: (input: {
    template: SubagentTemplateDetail;
    model: string;
    localizedName?: string;
  }, scope?: SubagentManagementScope) => Promise<SubagentCreateResult>;
  exportAgentConfig: (agentId: string) => Promise<SubagentConfigPackage>;
  exportAgentPackage: (agentId: string) => Promise<SubagentPackageExportResult>;
  uploadAgentPackageToCloud: (agentId: string) => Promise<SubagentCloudPackageUploadResult>;
  installAgentPackageFromCloud: (packageVersionId: string) => Promise<SubagentCloudPackageInstallResult>;
  importAgentConfig: (input: unknown, scope?: SubagentManagementScope) => Promise<SubagentImportResult>;
  updateAgent: (input: {
    agentId: string;
    name: string;
    description?: string | null;
    workspace?: string;
    model?: string;
    skills?: string[] | null;
    avatarSeed?: string | null;
    avatarStyle?: AgentAvatarStyle | null;
  }, scope?: SubagentManagementScope) => Promise<void>;
  deleteAgent: (agentId: string, deleteFiles?: boolean, scope?: SubagentManagementScope) => Promise<void>;
}

async function rpc<T>(method: string, params?: unknown, options?: SubagentRpcOptions): Promise<T> {
  const capabilityOperationId = resolveSubagentCapabilityOperation(method);
  if (capabilityOperationId) {
    const managementScope = options?.scope ?? await resolveSubagentManagementScope();
    if (!isCurrentScope(managementScope)) throw new Error('Management scope changed before Agent operation.');
    const rpcParams = readRpcParams(params);
    const scope = typeof rpcParams.agentId === 'string'
      ? agentScope(managementScope.endpoint, rpcParams.agentId)
      : managementScope;
    const input = buildSubagentCapabilityInput(capabilityOperationId, scope, rpcParams);
    try {
      return await subagentManagementCapabilityExecute<T>(
        capabilityOperationId,
        scope,
        input,
        options?.target ?? buildSubagentCapabilityTarget(capabilityOperationId, scope, input),
        options?.timeoutMs,
      );
    } finally {
      if (isSubagentMutation(capabilityOperationId) && capabilityOperationId !== 'subagents.package.export') {
        invalidateAgentsSnapshot(managementScope.endpoint);
      }
      if (capabilityOperationId === 'subagents.files.set') {
        persistedFilesLoadTasks.delete(JSON.stringify([scopeKey(managementScope), rpcParams.agentId]));
      }
    }
  }
  throw new Error(`Unsupported subagent runtime method: ${method}`);
}

function buildSubagentCapabilityInput(
  operationId: string,
  scope: SubagentManagementScope,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const endpoint = scope.endpoint;
  if (operationId === 'subagents.list') return { kind: 'list', endpoint };
  if (operationId === 'subagents.displayConfig.get') return { kind: 'displayConfiguration', endpoint };
  if (scope.kind !== 'agent' && !['subagents.list', 'subagents.displayConfig.get', 'subagents.create'].includes(operationId)) requireAgentScope(scope);
  if (operationId === 'subagents.create') {
    const workspaceInitialization = readWorkspaceInitialization(params.workspaceInitialization);
    return {
      kind: 'create',
      endpoint,
      name: getRequiredString(params.name, 'Subagent name is required'),
      ...(endpoint.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'matcha-agent'
        ? { workspaceMode: 'managed' }
        : { workspace: getRequiredString(params.workspace, 'Subagent workspace is required') }),
      model: getOptionalString(params.model) ?? null,
      ...(workspaceInitialization ? { workspaceInitialization } : {}),
    };
  }

  const agentId = getRequiredString(params.agentId, 'Subagent id is required');
  if (operationId === 'subagents.description.set') {
    return { kind: 'setDescription', endpoint, agentId, description: getOptionalString(params.description) ?? null };
  }
  if (operationId === 'subagents.model.set') {
    const model = getOptionalString(params.model);
    return { kind: 'setConfigurationModel', endpoint, agentId, model: model ? { primary: model, fallbacks: [] } : null };
  }
  if (operationId === 'subagents.skills.set') {
    return { kind: 'setSkills', endpoint, agentId, skills: getOptionalStringArray(params.skills) };
  }
  if (operationId === 'subagents.update') {
    return {
      kind: 'update',
      endpoint,
      agentId,
      ...(Object.hasOwn(params, 'name') ? { name: getRequiredString(params.name, 'Subagent name is required') } : {}),
      ...(Object.hasOwn(params, 'workspace') ? { workspace: getRequiredString(params.workspace, 'Subagent workspace is required') } : {}),
      ...(Object.hasOwn(params, 'model') ? { model: getOptionalString(params.model) ?? null } : {}),
    };
  }
  if (operationId === 'subagents.delete') {
    return { kind: 'delete', endpoint, agentId, deleteFiles: params.deleteFiles === true };
  }
  if (operationId === 'subagents.files.get') {
    return { kind: 'filesGet', endpoint, agentId, name: getRequiredString(params.name, 'Subagent file name is required') };
  }
  if (operationId === 'subagents.files.set') {
    return {
      kind: 'filesSet',
      endpoint,
      agentId,
      name: getRequiredString(params.name, 'Subagent file name is required'),
      content: typeof params.content === 'string' ? params.content : '',
    };
  }
  if (operationId === 'subagents.files.list') return { kind: 'filesList', endpoint, agentId };
  if (operationId === 'subagents.package.export') return { kind: 'packageExport', endpoint, agentId };
  return params;
}

function buildSubagentCapabilityTarget(operationId: string, scope: SubagentManagementScope, input: Record<string, unknown>): CapabilityTarget {
  if (operationId === 'subagents.list' || operationId === 'subagents.displayConfig.get') {
    return scope.kind === 'agent' ? { kind: 'agent', agentId: scope.agentId } : { kind: 'runtime-instance' };
  }
  const agentId = getOptionalString(input.agentId);
  return agentId ? { kind: 'subagent', subagentId: agentId } : { kind: 'subagent' };
}

function queryAgents<TResult>(operationId: 'subagents.list' | 'subagents.displayConfig.get', scope: SubagentManagementScope): Promise<TResult> {
  const input = buildSubagentCapabilityInput(operationId, scope, {});
  return subagentManagementCapabilityExecute<TResult>(
    operationId, scope, input, buildSubagentCapabilityTarget(operationId, scope, input),
  );
}

function resolveSubagentCapabilityOperation(method: string): string | null {
  switch (method) {
    case 'agents.list':
      return 'subagents.list';
    case 'displayConfig.get':
      return 'subagents.displayConfig.get';
    case 'description.set':
      return 'subagents.description.set';
    case 'model.set':
      return 'subagents.model.set';
    case 'skills.set':
      return 'subagents.skills.set';
    case 'agents.create':
      return 'subagents.create';
    case 'agents.update':
      return 'subagents.update';
    case 'agents.delete':
      return 'subagents.delete';
    case 'agents.files.get':
      return 'subagents.files.get';
    case 'agents.files.set':
      return 'subagents.files.set';
    case 'agents.files.list':
      return 'subagents.files.list';
    case 'agents.package.export':
      return 'subagents.package.export';
    default:
      return null;
  }
}

function readRpcParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

function readWorkspaceInitialization(value: unknown): SubagentWorkspaceInitialization | undefined {
  return value === 'mainAgentTemplate' || value === 'emptyWorkspace' ? value : undefined;
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getRequiredString(value: unknown, message: string): string {
  const normalized = getOptionalString(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function getOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    const normalized = getOptionalString(item);
    if (!normalized) {
      continue;
    }
    result.push(normalized);
  }
  return result;
}

function normalizeSkillAllowlist(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deduped = Array.from(new Set(getOptionalStringArray(value)));
  return deduped;
}

function normalizeImportedFiles(value: unknown): Partial<Record<SubagentTargetFile, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const files: Partial<Record<SubagentTargetFile, string>> = {};
  for (const fileName of SUBAGENT_TARGET_FILES) {
    const content = (value as Record<string, unknown>)[fileName];
    if (typeof content === 'string') {
      files[fileName] = content;
    }
  }
  return files;
}

function normalizeImportedSkillBundles(value: unknown): SubagentConfigPackage['agent']['skillBundles'] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const bundles: NonNullable<SubagentConfigPackage['agent']['skillBundles']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const skillKey = getOptionalString(record.skillKey);
    if (!skillKey || !Array.isArray(record.files)) {
      continue;
    }
    const files = record.files.flatMap((file): Array<{ path: string; content: string }> => {
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        return [];
      }
      const fileRecord = file as Record<string, unknown>;
      const filePath = getOptionalString(fileRecord.path);
      return filePath && typeof fileRecord.content === 'string'
        ? [{ path: filePath, content: fileRecord.content }]
        : [];
    });
    if (files.length > 0) {
      bundles.push({ skillKey, files });
    }
  }
  return bundles.length > 0 ? bundles : undefined;
}

function normalizeSubagentConfigPackage(input: unknown): SubagentConfigPackage {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid agent config file');
  }
  const record = input as Record<string, unknown>;
  if (record.schema !== SUBAGENT_CONFIG_PACKAGE_SCHEMA) {
    throw new Error('Unsupported agent config schema');
  }
  if (record.version !== SUBAGENT_CONFIG_PACKAGE_VERSION) {
    throw new Error('Unsupported agent config version');
  }
  const agentRecord = record.agent && typeof record.agent === 'object' && !Array.isArray(record.agent)
    ? record.agent as Record<string, unknown>
    : {};
  return {
    schema: SUBAGENT_CONFIG_PACKAGE_SCHEMA,
    version: SUBAGENT_CONFIG_PACKAGE_VERSION,
    agent: {
      name: getRequiredString(agentRecord.name, 'Agent name is required'),
      ...(getOptionalString(agentRecord.description) ? { description: getOptionalString(agentRecord.description) } : {}),
      ...(normalizeSkillAllowlist(agentRecord.skills) ? { skills: normalizeSkillAllowlist(agentRecord.skills) } : {}),
      ...(normalizeImportedSkillBundles(agentRecord.skillBundles) ? { skillBundles: normalizeImportedSkillBundles(agentRecord.skillBundles) } : {}),
      files: normalizeImportedFiles(agentRecord.files),
    },
  };
}

function equalOptionalTrimmedString(a: unknown, b: unknown): boolean {
  return (getOptionalString(a) ?? '') === (getOptionalString(b) ?? '');
}

function extractModelId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return getOptionalString(value);
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return getOptionalString((value as { primary?: unknown }).primary);
}

function collectModelIdsFromAgentModelValue(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: unknown) => {
    const normalized = getOptionalString(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ids.push(normalized);
  };
  if (typeof value === 'string') {
    push(value);
    return ids;
  }
  if (!value || typeof value !== 'object') {
    return ids;
  }
  const modelObject = value as { primary?: unknown; fallbacks?: unknown };
  push(modelObject.primary);
  for (const fallback of getOptionalStringArray(modelObject.fallbacks)) {
    push(fallback);
  }
  return ids;
}

function buildConfigDisplaySnapshot(displayConfig: SubagentDisplayConfigResult | undefined): ConfigDisplaySnapshot {
  const byAgentId = new Map<string, ConfigAgentDisplaySnapshot>();
  const defaults = (displayConfig?.defaults && typeof displayConfig.defaults === 'object')
    ? displayConfig.defaults
    : undefined;
  const defaultWorkspace = defaults && typeof defaults === 'object'
    ? getOptionalString((defaults as { workspace?: unknown }).workspace)
    : undefined;
  const defaultSkills = defaults && typeof defaults === 'object'
    ? normalizeSkillAllowlist((defaults as { skills?: unknown }).skills)
    : undefined;

  let defaultModel: string | undefined;
  if (defaults && typeof defaults === 'object') {
    for (const modelId of collectModelIdsFromAgentModelValue((defaults as { model?: unknown }).model)) {
      if (!defaultModel) {
        defaultModel = modelId;
      }
    }
  }

  const agentsList = displayConfig?.agents;
  if (Array.isArray(agentsList)) {
    for (const item of agentsList) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const id = getOptionalString((item as { id?: unknown }).id);
      if (!id) {
        continue;
      }
      const normalizedAgentId = normalizeAgentIdForComparison(id);
      if (!normalizedAgentId) {
        continue;
      }
      const description = getOptionalString((item as { description?: unknown }).description);
      const workspace = getOptionalString((item as { workspace?: unknown }).workspace);
      const skills = normalizeSkillAllowlist((item as { skills?: unknown }).skills);
      let model: string | undefined;
      for (const modelId of collectModelIdsFromAgentModelValue((item as { model?: unknown }).model)) {
        if (!model) {
          model = modelId;
        }
      }
      byAgentId.set(normalizedAgentId, {
        description,
        workspace,
        model,
        skills,
      });
    }
  }

  return {
    byAgentId,
    defaultWorkspace,
    defaultModel,
    defaultSkills,
  };
}

function isSnapshotReady(result: { ready?: boolean } | undefined): boolean {
  return result?.ready !== false;
}

function scheduleAgentsSnapshotRetry(scope: SubagentManagementScope, reads: RuntimeAgentReads): void {
  if (reads.retryTimer) return;
  reads.retryTimer = setTimeout(() => {
    reads.retryTimer = null;
    void useSubagentsStore.getState().loadAgents({ silent: true, scope });
  }, SUBAGENT_SNAPSHOT_NOT_READY_RETRY_MS);
}

function createEmptyConfigDisplaySnapshot(): ConfigDisplaySnapshot {
  return { byAgentId: new Map() };
}

function invalidateAgentsSnapshot(endpoint: RuntimeEndpointRef): void {
  const reads = runtimeAgentReads(endpoint);
  reads.generation += 1;
  reads.configCache = null;
  reads.configTask = null;
  reads.loadTask = null;
  if (reads.retryTimer) clearTimeout(reads.retryTimer);
  reads.retryTimer = null;
  const current = selectAgentsResource(useSubagentsStore.getState(), endpoint);
  publishAgentsResource(endpoint, {
    ...current,
    status: current.status === 'loading' ? (current.hasLoadedOnce ? 'ready' : 'idle') : current.status,
    lastLoadedAt: null,
  });
}

async function readConfigForDisplay(scope: SubagentManagementScope, reads: RuntimeAgentReads): Promise<ConfigDisplaySnapshot> {
  if (reads.configCache && Date.now() - reads.configCache.cachedAt <= CONFIG_DISPLAY_CACHE_TTL_MS) {
    return reads.configCache.snapshot;
  }
  if (reads.configTask) return reads.configTask;

  const generation = reads.generation;
  const task = (async () => {
    try {
      const result = await queryAgents<SubagentDisplayConfigResult>('subagents.displayConfig.get', scope);
      if (generation !== reads.generation) return createEmptyConfigDisplaySnapshot();
      if (!isSnapshotReady(result)) {
        scheduleAgentsSnapshotRetry(scope, reads);
        return reads.configCache?.snapshot ?? createEmptyConfigDisplaySnapshot();
      }
      const snapshot = buildConfigDisplaySnapshot(result);
      reads.configCache = { snapshot, cachedAt: Date.now() };
      return snapshot;
    } catch {
      return generation === reads.generation && reads.configCache
        ? reads.configCache.snapshot
        : createEmptyConfigDisplaySnapshot();
    } finally {
      if (generation === reads.generation) reads.configTask = null;
    }
  })();
  reads.configTask = task;
  return task;
}

function resolveDefaultAgentId(result: AgentsListResult): string {
  const defaultId = getRequiredString(result.defaultId, 'Default Agent is missing from the runtime roster.');
  if (!result.agents.some((agent) => agent.id === defaultId)) throw new Error('Default Agent is missing from the runtime roster.');
  return defaultId;
}

function normalizeAvatarPresentation(
  value: { avatarSeed?: unknown; avatarStyle?: unknown } | undefined,
): SubagentAvatarPresentation | undefined {
  const avatarSeed = getOptionalString(value?.avatarSeed);
  const avatarStyle = typeof value?.avatarStyle === 'string' ? resolveAgentAvatarStyle(value.avatarStyle) : undefined;
  if (avatarSeed === undefined && avatarStyle === undefined) {
    return undefined;
  }
  return {
    ...(avatarSeed === undefined ? {} : { avatarSeed }),
    ...(avatarStyle === undefined ? {} : { avatarStyle }),
  };
}

function avatarStorageKey(scope: SubagentManagementScope | null = activeManagementScope): string { return `${SUBAGENT_AVATAR_STORAGE_KEY}:${scope ? scopeKey(scope) : 'unselected'}`; }

function readStoredAvatarPresentations(scope: SubagentManagementScope | null = activeManagementScope): Record<string, SubagentAvatarPresentation> {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(avatarStorageKey(scope));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const result: Record<string, SubagentAvatarPresentation> = {};
    for (const [agentId, value] of Object.entries(parsed)) {
      const normalizedAgentId = normalizeAgentIdForComparison(agentId);
      if (!normalizedAgentId || !value || typeof value !== 'object') {
        continue;
      }
      const presentation = normalizeAvatarPresentation(value as {
        avatarSeed?: unknown;
        avatarStyle?: unknown;
      });
      if (!presentation) {
        continue;
      }
      result[normalizedAgentId] = presentation;
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredAvatarPresentations(
  presentations: Record<string, SubagentAvatarPresentation>,
): void {
  if (typeof window === 'undefined') {
    return;
  }
  const entries = Object.entries(presentations);
  if (entries.length === 0) {
    window.localStorage.removeItem(avatarStorageKey());
    return;
  }
  window.localStorage.setItem(avatarStorageKey(), JSON.stringify(Object.fromEntries(entries)));
}

function persistAvatarPresentation(
  agentId: string,
  presentation: SubagentAvatarPresentation | undefined,
): void {
  const normalizedAgentId = normalizeAgentIdForComparison(agentId);
  if (!normalizedAgentId) {
    return;
  }
  const nextPresentations = readStoredAvatarPresentations();
  if (!presentation) {
    delete nextPresentations[normalizedAgentId];
  } else {
    nextPresentations[normalizedAgentId] = presentation;
  }
  try {
    writeStoredAvatarPresentations(nextPresentations);
  } finally {
    if (activeManagementScope) invalidateAgentsSnapshot(activeManagementScope.endpoint);
  }
}

function pruneStoredAvatarPresentations(validAgentIds: Iterable<string>): void {
  const presentations = readStoredAvatarPresentations();
  const validIds = new Set<string>();
  for (const agentId of validAgentIds) {
    const normalizedAgentId = normalizeAgentIdForComparison(agentId);
    if (normalizedAgentId) {
      validIds.add(normalizedAgentId);
    }
  }
  let changed = false;
  for (const agentId of Object.keys(presentations)) {
    if (validIds.has(agentId)) {
      continue;
    }
    delete presentations[agentId];
    changed = true;
  }
  if (changed) {
    writeStoredAvatarPresentations(presentations);
  }
}

function normalizeAgents(
  result: AgentsListResult,
  configSnapshot?: ConfigDisplaySnapshot,
  avatarPresentations?: Record<string, SubagentAvatarPresentation>,
): SubagentSummary[] {
  const defaultId = resolveDefaultAgentId(result);
  const runtimeById = new Map<string, SubagentSummary>();
  const displayIds: string[] = [];
  const seen = new Set<string>();
  for (const agent of result.agents) {
    const id = getOptionalString(agent?.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    runtimeById.set(id, agent);
    displayIds.push(id);
  }

  return displayIds.map((agentId) => {
    const runtimeAgent = runtimeById.get(agentId);
    const runtimeName = getOptionalString(runtimeAgent?.name);
    const fallbackName = agentId;
    const configAgent = configSnapshot?.byAgentId.get(normalizeAgentIdForComparison(agentId));
    const description = configAgent?.description
      ?? getOptionalString(runtimeAgent?.description);
    const workspace = configAgent?.workspace
      ?? getOptionalString(runtimeAgent?.workspace)
      ?? (agentId === defaultId ? configSnapshot?.defaultWorkspace : undefined);
    const model = configAgent?.model
      ?? extractModelId(runtimeAgent?.model)
      ?? configSnapshot?.defaultModel;
    const skills = configAgent?.skills
      ?? configSnapshot?.defaultSkills
      ?? normalizeSkillAllowlist(runtimeAgent?.skills);
    const avatarPresentation = avatarPresentations?.[normalizeAgentIdForComparison(agentId) ?? ''];
    return {
      ...(runtimeAgent ?? { id: agentId }),
      id: agentId,
      name: runtimeName ?? fallbackName,
      description,
      workspace,
      model,
      skills,
      avatarSeed: avatarPresentation?.avatarSeed,
      avatarStyle: avatarPresentation?.avatarStyle,
      isDefault: agentId === defaultId,
    };
  });
}

function resolveDefaultAgentFromState(agents: SubagentSummary[]): SubagentSummary | undefined {
  return agents.find((agent) => agent.isDefault);
}

function readAgentsFromState(
  state: Pick<SubagentsState, 'agentsResource'> & { agents?: SubagentSummary[] },
): SubagentSummary[] {
  if (Array.isArray(state.agentsResource.data)) {
    return state.agentsResource.data;
  }
  return Array.isArray(state.agents) ? state.agents : [];
}

function assertDeletableAgent(agentId: string, agents: SubagentSummary[]): void {
  const agent = agents.find((entry) => entry.id === agentId);
  if (agent?.kind === 'system') {
    throw new Error('System agent cannot be deleted');
  }
  const defaultAgent = resolveDefaultAgentFromState(agents);
  if (defaultAgent && defaultAgent.id === agentId) {
    throw new Error('Default agent cannot be deleted');
  }
}

async function updateAgentSkillsConfig(scope: SubagentManagementScope, agentId: string, skills: string[] | undefined): Promise<void> {
  if (scope.endpoint.kind !== 'native-runtime' || scope.endpoint.runtimeAdapterId !== 'openclaw') throw new Error('Native Agent skill selection is unsupported.');
  await rpc('skills.set', { agentId, skills }, {
    scope,
    target: buildSubagentTarget(scope, agentId),
  });
}

async function exportSkillBundles(
  skillKeys: string[],
): Promise<NonNullable<SubagentConfigPackage['agent']['skillBundles']>> {
  return hostExportSkillBundles(skillKeys);
}

async function importSkillBundles(
  skillBundles: NonNullable<SubagentConfigPackage['agent']['skillBundles']>,
): Promise<SkillBundleImportResult> {
  const result = await hostSkillsMutation('/api/subagents/skill-bundles/import',
    { skillBundles }, 'skills.bundles.import');
  return { ok: result.outcome === 'accepted' };
}

async function updateAgentDescriptionConfig(scope: SubagentManagementScope, agentId: string, description: string | undefined): Promise<void> {
  await rpc('description.set', { agentId, description }, {
    scope,
    target: buildSubagentTarget(scope, agentId),
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentPackageInstallErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (message === 'Subagent mutation outcome is unknown') {
    return i18n.t('subagents:transfer.installPackageUnknownOutcome');
  }
  if (message === 'Subagent request was rejected') {
    return i18n.t('subagents:transfer.installPackageRejected');
  }
  return message;
}

function buildCreateWarning(agentId: string, message: string): string {
  return `智能体 "${agentId}" 已创建，但${message}。请在编辑中重新确认`;
}

function buildCreateAvatarWarning(agentId: string, error: unknown): string {
  return buildCreateWarning(agentId, `头像展示配置写入失败：${getErrorMessage(error)}`);
}

function buildCreateDescriptionWarning(agentId: string, error: unknown): string {
  return buildCreateWarning(agentId, `简介配置写入失败：${getErrorMessage(error)}`);
}

function buildCreateRefreshWarning(agentId: string, error: unknown): string {
  return buildCreateWarning(agentId, `列表刷新失败：${getErrorMessage(error)}`);
}

function buildTemplateRenameWarning(agentId: string, error: unknown): string {
  return buildCreateWarning(agentId, `模板名称写入失败：${getErrorMessage(error)}`);
}

function buildTemplateFilesWarning(agentId: string, error: unknown): string {
  return buildCreateWarning(agentId, `模板文件写入失败：${getErrorMessage(error)}`);
}

function toSubagentCreateResult(agentId: string, warnings: string[]): SubagentCreateResult {
  if (warnings.length === 0) {
    return { agentId };
  }
  return {
    agentId,
    warning: warnings.join('；'),
  };
}

function normalizeAgentFileContent(result: AgentFileGetResult): string {
  return getOptionalString(result?.file?.content) ?? '';
}

async function fetchPersistedFilesForAgent(agentId: string, sourceScope?: SubagentManagementScope): Promise<Partial<Record<SubagentTargetFile, string>>> {
  const fileByName: Partial<Record<SubagentTargetFile, string>> = {};
  const managementScope = sourceScope ?? await resolveSubagentManagementScope();
  const target = buildSubagentTarget(managementScope, agentId);
  await Promise.all(SUBAGENT_TARGET_FILES.map(async (name) => {
    const result = await rpc<AgentFileGetResult>('agents.files.get', { agentId, name }, {
      scope: managementScope,
      target,
    });
    fileByName[name] = normalizeAgentFileContent(result);
  }));
  return fileByName;
}

const persistedFilesLoadTasks = new Map<string, Promise<Partial<Record<SubagentTargetFile, string>>>>();
let agentMutationChain: Promise<void> = Promise.resolve();
const agentMutationTails = new Map<string, Promise<void>>();
let activeMutatingOperationCount = 0;

function resetManagementCaches(): void {
  persistedFilesLoadTasks.clear();
  activeMutatingOperationCount = 0;
}

export function __resetSubagentsStoreInternalCachesForTest(): void {
  resetManagementCaches();
  for (const reads of agentReadsByRuntime.values()) {
    reads.generation += 1;
    if (reads.retryTimer) clearTimeout(reads.retryTimer);
  }
  agentReadsByRuntime.clear();
  agentMutationChain = Promise.resolve();
  agentMutationTails.clear();
  activeManagementScope = null;
  activeManagementKey = null;
  availableModelsLoaded = false;
  inflightAvailableModelsTask = null;
  latestAvailableModelsRequestId += 1;
}

function normalizeAgentIdForComparison(agentId: string): string {
  return normalizeSubagentNameToSlug(agentId).trim().toLowerCase();
}

function isAgentPendingDeletion(agentId: string, reads: RuntimeAgentReads): boolean {
  const normalized = normalizeAgentIdForComparison(agentId);
  return normalized !== '' && reads.pendingDeletedAgentIds.has(normalized);
}

function collectRuntimeAgentIdSet(result: AgentsListResult): Set<string> {
  const runtimeAgentIds = new Set<string>();
  for (const agent of result.agents) {
    const runtimeId = getOptionalString(agent?.id);
    if (!runtimeId) {
      continue;
    }
    const normalized = normalizeAgentIdForComparison(runtimeId);
    if (normalized) {
      runtimeAgentIds.add(normalized);
    }
  }
  return runtimeAgentIds;
}

function settlePendingDeletedAgentIds(runtimeAgentIds: Set<string>, reads: RuntimeAgentReads): void {
  for (const pendingId of [...reads.pendingDeletedAgentIds]) {
    if (!runtimeAgentIds.has(pendingId)) {
      reads.pendingDeletedAgentIds.delete(pendingId);
    }
  }
}

function filterOutPendingDeletedAgents(agents: SubagentSummary[], reads: RuntimeAgentReads): SubagentSummary[] {
  return agents.filter((agent) => !isAgentPendingDeletion(agent.id, reads));
}

function trackAgentMutation(agentId: string, task: Promise<unknown>): void {
  const key = normalizeAgentIdForComparison(agentId);
  const previous = agentMutationTails.get(key) ?? Promise.resolve();
  const tail = Promise.all([previous, task.then(() => undefined, () => undefined)]).then(() => {
    if (agentMutationTails.get(key) === tail) {
      agentMutationTails.delete(key);
    }
  });
  agentMutationTails.set(key, tail);
}

function runSerializedAgentMutation<T>(
  task: () => Promise<T>,
  agentId?: string,
  canRunLocally?: () => boolean,
): Promise<T> {
  const previousGlobal = agentMutationChain;
  const previousAgent = agentId === undefined
    ? undefined
    : agentMutationTails.get(normalizeAgentIdForComparison(agentId));
  const run = (previousAgent ?? Promise.resolve()).then(async () => {
    if (!canRunLocally?.()) {
      await previousGlobal;
    }
    return task();
  });
  const settled = run.then(() => undefined, () => undefined);
  agentMutationChain = Promise.all([previousGlobal, settled]).then(() => undefined);
  if (agentId !== undefined) {
    trackAgentMutation(agentId, settled);
  }
  return run;
}

function beginGlobalMutating(setState: (partial: Partial<SubagentsState>) => void): void {
  activeMutatingOperationCount += 1;
  setState({
    mutating: true,
    error: null,
  });
}

function finishGlobalMutating(setState: (partial: Partial<SubagentsState>) => void): void {
  activeMutatingOperationCount = Math.max(0, activeMutatingOperationCount - 1);
  if (activeMutatingOperationCount !== 0) {
    return;
  }
  setState({ mutating: false });
}

async function resolvePersistedFilesForAgent(agentId: string, scope: SubagentManagementScope): Promise<Partial<Record<SubagentTargetFile, string>>> {
  const key = JSON.stringify([scopeKey(scope), agentId]);
  const activeTask = persistedFilesLoadTasks.get(key);
  if (activeTask) {
    return activeTask;
  }
  const task = fetchPersistedFilesForAgent(agentId, scope)
    .then((files) => {
      if (persistedFilesLoadTasks.get(key) === task && isCurrentScope(scope)) {
        useSubagentsStore.setState((state) => ({
          persistedFilesByAgent: { ...state.persistedFilesByAgent, [agentId]: files },
        }));
      }
      return files;
    }, (error) => {
      if (persistedFilesLoadTasks.get(key) === task && isCurrentScope(scope)) {
        useSubagentsStore.setState({ error: getErrorMessage(error) || 'Failed to load agent files' });
      }
      throw error;
    })
    .finally(() => {
      if (persistedFilesLoadTasks.get(key) === task) persistedFilesLoadTasks.delete(key);
    });
  persistedFilesLoadTasks.set(key, task);
  return task;
}

function areStringArraysEqual(left?: string[], right?: string[]): boolean {
  const normalizedLeft = Array.isArray(left) ? [...left].sort() : [];
  const normalizedRight = Array.isArray(right) ? [...right].sort() : [];
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    if (normalizedLeft[index] !== normalizedRight[index]) {
      return false;
    }
  }
  return true;
}

function areSubagentSummariesEqual(left: SubagentSummary, right: SubagentSummary): boolean {
  return (
    left.id === right.id
    && (left.name ?? '') === (right.name ?? '')
    && (left.description ?? '') === (right.description ?? '')
    && (left.workspace ?? '') === (right.workspace ?? '')
    && (left.model ?? '') === (right.model ?? '')
    && (left.kind ?? 'agent') === (right.kind ?? 'agent')
    && Boolean(left.sealed) === Boolean(right.sealed)
    && (left.avatarSeed ?? '') === (right.avatarSeed ?? '')
    && (left.avatarStyle ?? '') === (right.avatarStyle ?? '')
    && areStringArraysEqual(left.skills, right.skills)
    && (left.identity?.name ?? '') === (right.identity?.name ?? '')
    && (left.identity?.theme ?? '') === (right.identity?.theme ?? '')
    && Boolean(left.isDefault) === Boolean(right.isDefault)
  );
}

function areAgentListsEquivalent(left: SubagentSummary[], right: SubagentSummary[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (!areSubagentSummariesEqual(left[index], right[index])) {
      return false;
    }
  }
  return true;
}

export const useSubagentsStore = create<SubagentsState>((set, get) => ({
  get agents(): SubagentSummary[] {
    return readAgentsFromState(this);
  },
  agentsResource: EMPTY_AGENTS_RESOURCE,
  agentsByRuntime: {},
  managementScope: null,
  cloudPackages: [],
  installedCloudPackages: [],
  cloudLoading: false,
  cloudError: null,
  myCloudPackages: [],
  myCloudLoading: false,
  myCloudError: null,
  cloudPublishingByVersionId: {},
  cloudInstallingByVersionId: {},
  availableModels: [],
  modelsLoading: false,
  mutating: false,
  error: null,
  managedAgentId: null,
  persistedFilesByAgent: {},
  selectedAgentId: null,

  loadCloudPackages: async () => {
    set({ cloudLoading: true, cloudError: null });
    try {
      const [result, installed] = await Promise.all([
        hostApiFetch<CloudPackageListPage>('/api/packages/market?packageType=agent'),
        hostApiFetch<InstalledCloudPackageList>('/api/packages/installed'),
      ]);
      set({ cloudPackages: result.items, installedCloudPackages: installed.packages });
    } catch {
      set({ cloudPackages: [], installedCloudPackages: [], cloudError: 'cloudUnavailable' });
    } finally {
      set({ cloudLoading: false });
    }
  },

  loadMyCloudPackages: async () => {
    set({ myCloudLoading: true, myCloudError: null });
    try {
      const result = await hostApiFetch<CloudPackageListPage>('/api/packages/mine?packageType=agent');
      set({ myCloudPackages: result.items });
    } catch {
      set({ myCloudError: 'cloudUnavailable' });
    } finally {
      set({ myCloudLoading: false });
    }
  },

  publishCloudAgentPackage: async (packageVersionId) => {
    if (get().cloudPublishingByVersionId[packageVersionId]) return;
    set((state) => ({ cloudPublishingByVersionId: { ...state.cloudPublishingByVersionId, [packageVersionId]: true } }));
    try {
      const published = await hostApiFetch<CloudPackageVersion>(`/api/packages/${encodeURIComponent(packageVersionId)}/publish`, { method: 'POST' });
      set((state) => ({ myCloudPackages: state.myCloudPackages.map((item) => item.packageVersionId === packageVersionId ? published : item) }));
      await get().loadCloudPackages();
    } finally {
      set((state) => {
        const next = { ...state.cloudPublishingByVersionId };
        delete next[packageVersionId];
        return { cloudPublishingByVersionId: next };
      });
    }
  },

  loadAgents: async (options) => {
    const scope = options?.scope ?? await resolveSubagentManagementScope();
    const reads = runtimeAgentReads(scope.endpoint);
    if (reads.loadTask) return reads.loadTask;
    const generation = reads.generation;
    const task = Promise.resolve().then(async () => {
      try {
        const [result, configSnapshot] = await Promise.all([
          queryAgents<AgentsListResult>('subagents.list', scope),
          readConfigForDisplay(scope, reads),
        ]);
        if (generation !== reads.generation) return;
        const current = selectAgentsResource(get(), scope.endpoint);
        if (!isSnapshotReady(result)) {
          const hasUsableSnapshot = current.hasLoadedOnce || current.data.length > 0;
          const message = getOptionalString(result.error);
          if (hasUsableSnapshot) {
            publishAgentsResource(scope.endpoint, {
              ...current, status: 'ready', error: null, hasLoadedOnce: true,
            }, { error: message ?? null });
            scheduleAgentsSnapshotRetry(scope, reads);
          } else if (message) {
            publishAgentsResource(scope.endpoint, createErrorResourceState({
              ...current, hasLoadedOnce: false,
            }, message), { error: message });
          } else {
            publishAgentsResource(scope.endpoint, createLoadingResourceState({
              ...current, hasLoadedOnce: false,
            }), { error: null });
            scheduleAgentsSnapshotRetry(scope, reads);
          }
          return;
        }
        settlePendingDeletedAgentIds(collectRuntimeAgentIdSet(result), reads);
        const retainedAgentIds = [...result.agents.map((agent) => agent.id), ...reads.unconfirmedDeletedAgentIds];
        useChatStore.getState().reconcileAgentSessionTombstones(
          retainedAgentIds.filter((agentId) => !isAgentPendingDeletion(agentId, reads)),
          scope.endpoint,
        );
        const stateSnapshot = get();
        const managementScope = stateSnapshot.managementScope;
        if (managementScope && runtimeEndpointsEqual(managementScope.endpoint, scope.endpoint)) {
          try {
            pruneStoredAvatarPresentations(retainedAgentIds);
          } catch {
            // Ignore local presentation cleanup failures during refresh.
          }
        }
        const normalizedAgents = filterOutPendingDeletedAgents(normalizeAgents(
          result,
          configSnapshot,
          readStoredAvatarPresentations(getSubagentManagementScope(scope.endpoint) ?? scope),
        ), reads);
        const selectedAgentId = stateSnapshot.selectedAgentId;
        const hasSelected = selectedAgentId && normalizedAgents.some((agent) => agent.id === selectedAgentId);
        const managedAgentId = stateSnapshot.managedAgentId;
        const hasManaged = managedAgentId && normalizedAgents.some((agent) => agent.id === managedAgentId);
        const defaultAgentId = normalizedAgents.find((agent) => agent.isDefault)?.id ?? null;
        publishAgentsResource(scope.endpoint, createReadyResourceState(
          areAgentListsEquivalent(current.data, normalizedAgents) ? current.data : normalizedAgents,
        ), {
          selectedAgentId: hasSelected ? selectedAgentId : result.selectionRequired === true ? null : defaultAgentId,
          managedAgentId: hasManaged ? managedAgentId : null,
          error: null,
        });
      } catch (error) {
        if (generation !== reads.generation) return;
        const current = selectAgentsResource(get(), scope.endpoint);
        const message = error instanceof Error ? error.message : 'Failed to load subagents';
        publishAgentsResource(scope.endpoint, createErrorResourceState({
          ...current,
          hasLoadedOnce: current.hasLoadedOnce || current.data.length > 0,
        }, message), { error: message });
      } finally {
        if (reads.loadTask === task) reads.loadTask = null;
      }
    });

    reads.loadTask = task;
    const previousResource = selectAgentsResource(get(), scope.endpoint);
    publishAgentsResource(scope.endpoint, options?.silent && previousResource.hasLoadedOnce
      ? previousResource
      : createLoadingResourceState({
        ...previousResource,
        hasLoadedOnce: previousResource.hasLoadedOnce || previousResource.data.length > 0,
      }), { error: null });
    await task;
  },

  loadAvailableModels: async (options) => {
    const sourceScope = activeManagementScope;
    const force = options?.force === true;
    const traceId = createSessionTraceId('available-models');
    const startedAt = traceId ? performance.now() : 0;
    if (!force && availableModelsLoaded) {
      logSessionTrace('models.available.cache-hit', traceId, () => ({
        requestId: latestAvailableModelsRequestId, force, outcome: 'cached',
        count: get().availableModels.length, loading: get().modelsLoading,
        elapsedMs: Math.round(performance.now() - startedAt),
      }));
      return;
    }
    if (!force && inflightAvailableModelsTask) {
      logSessionTrace('models.available.inflight-join', traceId, () => ({
        requestId: latestAvailableModelsRequestId, force, outcome: 'joined',
        count: get().availableModels.length, loading: get().modelsLoading,
        elapsedMs: Math.round(performance.now() - startedAt),
      }));
      await inflightAvailableModelsTask;
      return;
    }

    if (force) {
      availableModelsLoaded = false;
    }
    const requestId = ++latestAvailableModelsRequestId;
    const previousCount = traceId ? get().availableModels.length : 0;
    set({
      ...(force ? { availableModels: [] } : {}),
      modelsLoading: true,
    });
    logSessionTrace('models.available.start', traceId, () => ({
      requestId, force, outcome: 'loading', cleared: force, previousCount,
      count: get().availableModels.length, loading: get().modelsLoading,
      elapsedMs: Math.round(performance.now() - startedAt),
    }));
    let currentTask: Promise<void> | null = null;
    const task = (async () => {
      try {
        const normalizedModels = await fetchSelectableProviderModels();
        if (requestId !== latestAvailableModelsRequestId) {
          logSessionTrace('models.available.result', traceId, () => ({
            requestId, latestRequestId: latestAvailableModelsRequestId, force, outcome: 'stale-discarded', response: 'success',
            resultCount: normalizedModels.length, count: get().availableModels.length, loading: get().modelsLoading,
            elapsedMs: Math.round(performance.now() - startedAt),
          }));
          return;
        }
        availableModelsLoaded = true;
        set({
          availableModels: normalizedModels,
          modelsLoading: false,
          ...(sourceScope && isCurrentScope(sourceScope) ? { error: null } : {}),
        });
        logSessionTrace('models.available.result', traceId, () => ({
          requestId, force, outcome: 'success', count: get().availableModels.length, loading: get().modelsLoading,
          models: normalizedModels.slice(0, 32).map((model) => ({
            idHash: summarizeIdentifier(model.id).hash,
            referenceHashes: (model.modelReferences ?? []).slice(0, 4).map((reference) => summarizeIdentifier(reference).hash),
            referenceCount: model.modelReferences?.length ?? 0, truncated: (model.modelReferences?.length ?? 0) > 4,
          })),
          truncated: normalizedModels.length > 32,
          elapsedMs: Math.round(performance.now() - startedAt),
        }));
      } catch (error) {
        if (requestId !== latestAvailableModelsRequestId) {
          logSessionTrace('models.available.result', traceId, () => ({
            requestId, latestRequestId: latestAvailableModelsRequestId, force, outcome: 'stale-discarded', response: 'error',
            count: get().availableModels.length, loading: get().modelsLoading, error: summarizeError(error),
            elapsedMs: Math.round(performance.now() - startedAt),
          }));
          return;
        }
        set({
          modelsLoading: false,
          ...(sourceScope && isCurrentScope(sourceScope) ? { error: getErrorMessage(error) || 'Failed to load models' } : {}),
        });
        logSessionTrace('models.available.result', traceId, () => ({
          requestId, force, outcome: 'error', count: get().availableModels.length, loading: get().modelsLoading,
          error: summarizeError(error), elapsedMs: Math.round(performance.now() - startedAt),
        }));
      } finally {
        if (inflightAvailableModelsTask === currentTask) {
          inflightAvailableModelsTask = null;
        }
      }
    })();

    currentTask = task;
    inflightAvailableModelsTask = task;
    await task;
  },

  selectAgent: (agentId) => set({ selectedAgentId: agentId }),
  setManagedAgentId: (agentId) => set({ managedAgentId: agentId }),
  setManagementScope: activateManagementScope,
  loadPersistedFilesForAgent: async (agentId, capturedScope) => {
    const scope = await resolveSubagentManagementScope(capturedScope);
    return agentId ? resolvePersistedFilesForAgent(agentId, scope) : {};
  },
  createAgent: async ({
    name,
    description,
    workspace,
    model,
    avatarSeed,
    avatarStyle,
  }, options) => {
    const managementScope = await resolveSubagentManagementScope(options?.scope);
    const creation: Promise<SubagentCreateResult> = runSerializedAgentMutation(async () => {
      if (!isCurrentScope(managementScope)) throw new Error('Management scope changed before Agent creation.');
      beginGlobalMutating(set);
      try {
        const trimmedName = name.trim();
        if (!trimmedName) {
          throw new Error('Subagent name is required');
        }
        const modelId = (model ?? '').trim();
        const avatarPresentation = normalizeAvatarPresentation({
          avatarSeed,
          avatarStyle: avatarStyle === undefined ? undefined : resolveAgentAvatarStyle(avatarStyle),
        });
        const predictedAgentId = normalizeAgentIdForComparison(trimmedName);
        if (predictedAgentId) {
          runtimeAgentReads(managementScope.endpoint).pendingDeletedAgentIds.delete(predictedAgentId);
        }
        const agents = readAgentsFromState(get());
        if (hasSubagentNameConflict(trimmedName, agents)) {
          throw new Error('Invalid subagent name: duplicate');
        }
        const managedWorkspace = managementScope.endpoint.kind === 'native-runtime' && managementScope.endpoint.runtimeAdapterId === 'matcha-agent';
        if (managedWorkspace && workspace?.trim()) throw new Error('This runtime requires a Server-managed workspace.');
        const resolvedWorkspace = managedWorkspace ? undefined : workspace?.trim() || buildSubagentWorkspacePath({
          name: trimmedName,
          agents,
        });
        if (!managedWorkspace && !resolvedWorkspace) {
          throw new Error('Subagent workspace is required');
        }
        const createResult = await rpc<AgentsCreateResult>('agents.create', {
          name: trimmedName,
          workspace: resolvedWorkspace,
          model: modelId || null,
          ...(options?.workspaceInitialization ? { workspaceInitialization: options.workspaceInitialization } : {}),
        }, {
          scope: managementScope,
          target: { kind: 'subagent' },
        });
        const createdAgentId = getOptionalString(createResult.agent?.id);
        if (!createdAgentId) {
          throw new Error('Subagent creation returned an invalid receipt');
        }
        if (!isCurrentScope(managementScope)) return { agentId: createdAgentId };
        trackAgentMutation(createdAgentId, creation);
        const reads = runtimeAgentReads(managementScope.endpoint);
        reads.unconfirmedDeletedAgentIds.delete(createdAgentId);
        const normalizedCreatedAgentId = normalizeAgentIdForComparison(createdAgentId);
        if (normalizedCreatedAgentId) {
          reads.pendingDeletedAgentIds.delete(normalizedCreatedAgentId);
        }
        const warnings: string[] = createResult.success ? [] : [buildCreateWarning(createdAgentId, createResult.error || 'Subagent workspace initialization failed')];
        const nextDescription = getOptionalString(description);
        if (nextDescription !== undefined) {
          try {
            await updateAgentDescriptionConfig(managementScope, createdAgentId, nextDescription);
          } catch (error) {
            warnings.push(buildCreateDescriptionWarning(createdAgentId, error));
          }
        }
        if (!isCurrentScope(managementScope)) return toSubagentCreateResult(createdAgentId, warnings);
        try {
          persistAvatarPresentation(createdAgentId, avatarPresentation);
        } catch (error) {
          warnings.push(buildCreateAvatarWarning(createdAgentId, error));
        }
        try {
          if (isCurrentScope(managementScope)) await get().loadAgents({ silent: true, scope: managementScope });
        } catch (error) {
          warnings.push(buildCreateRefreshWarning(createdAgentId, error));
        }
        return toSubagentCreateResult(createdAgentId, warnings);
      } catch (error) {
        const message = getErrorMessage(error) || 'Failed to create subagent';
        if (isCurrentScope(managementScope)) set({ error: message });
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(message, { cause: error });
      } finally {
        if (isCurrentScope(managementScope)) finishGlobalMutating(set);
      }
    });
    return creation;
  },

  createAgentFromTemplate: async ({ template, model, localizedName }, capturedScope) => {
    const managementScope = await resolveSubagentManagementScope(capturedScope);
    const modelId = getOptionalString(model);
    if (!modelId && (managementScope.endpoint.kind !== 'native-runtime' || managementScope.endpoint.runtimeAdapterId !== 'matcha-agent')) {
      throw new Error('Model is required');
    }
    const templateName = getOptionalString(template.name);
    if (!templateName) {
      throw new Error('Template name is required');
    }
    const localizedTemplateName = getOptionalString(localizedName);
    const createResult = await get().createAgent({
      name: templateName,
      model: modelId,
      avatarSeed: buildTemplateAvatarSeed(template.id),
      avatarStyle: DEFAULT_AGENT_AVATAR_STYLE,
    }, { scope: managementScope, workspaceInitialization: 'emptyWorkspace' });
    const createdAgentId = createResult.agentId;
    return runSerializedAgentMutation(async () => {
    const warnings = createResult.warning ? [createResult.warning] : [];
    if (!isCurrentScope(managementScope)) return toSubagentCreateResult(createdAgentId, warnings);
    if (localizedTemplateName && localizedTemplateName !== templateName) {
      const createdAgent = readAgentsFromState(get()).find((agent) => agent.id === createdAgentId);
      const workspace = getOptionalString(createdAgent?.workspace);
      if (workspace || (managementScope.endpoint.kind === 'native-runtime' && managementScope.endpoint.runtimeAdapterId === 'matcha-agent')) {
        try {
          await rpc('agents.update', {
            agentId: createdAgentId,
            name: localizedTemplateName,
            ...(managementScope.endpoint.kind === 'native-runtime' && managementScope.endpoint.runtimeAdapterId === 'matcha-agent' ? {} : { workspace }),
            model: modelId,
          }, {
            scope: managementScope,
            target: buildSubagentTarget(managementScope, createdAgentId),
          });
          if (isCurrentScope(managementScope)) await get().loadAgents({ silent: true, scope: managementScope });
        } catch (error) {
          warnings.push(buildTemplateRenameWarning(createdAgentId, error));
        }
      }
    }
    const fileEntries = SUBAGENT_TARGET_FILES
      .map((fileName) => {
        const content = template.fileContents[fileName];
        if (typeof content !== 'string') {
          return undefined;
        }
        return [fileName, content] as const;
      })
      .filter((entry): entry is readonly [SubagentTargetFile, string] => Boolean(entry));

    if (isCurrentScope(managementScope)) beginGlobalMutating(set);
    try {
      try {
        for (const [name, content] of fileEntries) {
          await rpc('agents.files.set', {
            agentId: createdAgentId,
            name,
            content,
          }, {
            scope: managementScope,
            target: buildSubagentTarget(managementScope, createdAgentId),
          });
        }
      } catch (error) {
        warnings.push(buildTemplateFilesWarning(createdAgentId, error));
      }
      try {
        await get().loadPersistedFilesForAgent(createdAgentId, managementScope);
      } catch (error) {
        warnings.push(buildTemplateFilesWarning(createdAgentId, error));
      }
    } finally {
      if (isCurrentScope(managementScope)) finishGlobalMutating(set);
    }
    return toSubagentCreateResult(createdAgentId, warnings);
    }, createdAgentId);
  },

  exportAgentConfig: async (agentId) => {
    const managementScope = await resolveSubagentManagementScope();
    const agent = readAgentsFromState(get()).find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }
    if (agent.kind === 'system') {
      throw new Error('System agent cannot be exported');
    }
    if (agent.sealed) {
      throw new Error('Sealed agent config cannot be exported');
    }
    const files = await fetchPersistedFilesForAgent(agentId, managementScope);
    const skills = normalizeSkillAllowlist(agent.skills);
    const skillBundles = skills ? await exportSkillBundles(skills) : undefined;
    return {
      schema: SUBAGENT_CONFIG_PACKAGE_SCHEMA,
      version: SUBAGENT_CONFIG_PACKAGE_VERSION,
      agent: {
        name: getOptionalString(agent.name) ?? agent.id,
        ...(getOptionalString(agent.description) ? { description: getOptionalString(agent.description) } : {}),
        ...(skills ? { skills } : {}),
        ...(skillBundles && skillBundles.length > 0 ? { skillBundles } : {}),
        files,
      },
    };
  },

  exportAgentPackage: async (agentId) => {
    const agent = readAgentsFromState(get()).find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }
    if (agent.kind === 'system') {
      throw new Error('System agent package cannot be exported');
    }
    const managementScope = await resolveSubagentManagementScope();
    const result = await rpc<{ success?: boolean; package?: SubagentPackageExportResult; error?: string }>('agents.package.export', { agentId }, {
      scope: managementScope,
      target: buildSubagentTarget(managementScope, agentId),
    });
    if (!result.success || !result.package) {
      throw new Error(result.error || 'Failed to export agent package');
    }
    return {
      agentId: result.package.agentId,
      fileName: result.package.fileName,
      size: result.package.size,
      exportedAtMs: result.package.exportedAtMs,
    };
  },

  uploadAgentPackageToCloud: async (agentId) => {
    const scope = await resolveSubagentManagementScope();
    if (scope.endpoint.kind !== 'native-runtime' || scope.endpoint.runtimeAdapterId !== 'openclaw') throw new Error('This runtime does not support sealed Agent packages.');
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) {
      throw new Error('Agent id is required');
    }
    const uploaded = await runCloudPackageOperation('uploadSealedAgent', { agentId: normalizedAgentId });
    await get().loadMyCloudPackages();
    return {
      agentId: normalizedAgentId,
      packageId: uploaded.packageId,
      packageVersionId: uploaded.packageVersionId,
      fileName: uploaded.name,
      uploadedAtMs: Date.now(),
    };
  },

  installAgentPackageFromCloud: async (packageVersionId) => {
    const managementScope = await resolveSubagentManagementScope();
    if (managementScope.endpoint.kind !== 'native-runtime' || managementScope.endpoint.runtimeAdapterId !== 'openclaw') throw new Error('This runtime does not support sealed Agent packages.');
    set((state) => ({ cloudInstallingByVersionId: { ...state.cloudInstallingByVersionId, [packageVersionId]: true } }));
    try {
      let result: { packageId?: string; packageVersionId?: string; install?: { outcome?: string; agentId?: string } };
      try {
        const admitted = await runCloudPackageOperation('install', { packageVersionId, packageType: 'agent', source: 'subagents' });
        if (admitted.packageVersionId !== packageVersionId) throw new Error('Invalid cloud package installation identity');
        const receipt = decodeCallReceipt(admitted.install);
        const terminal = await waitForSubagentResult(receipt, 'subagents.package.install', {
          kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local',
        }).finally(() => invalidateAgentsSnapshot(managementScope.endpoint));
        const confirmed = await hostApiFetch<typeof result>('/api/packages/install/confirm', {
          method: 'POST', body: JSON.stringify({ callId: receipt.callId }),
        });
        result = { ...admitted, ...confirmed, install: confirmed.install };
        if (terminal.body.success !== true) throw new Error(subagentMutationError(terminal.body));
        const installed = terminal.body.package as { agentId: string };
        if (result.install?.agentId !== installed.agentId) throw new Error('Invalid Subagent package confirmation');
      } catch (error) {
        throw new Error(agentPackageInstallErrorMessage(error), { cause: error });
      }
      if (result.install?.outcome !== 'accepted' || !result.install.agentId) {
        throw new Error(i18n.t('subagents:transfer.installPackageUnexpectedResult'));
      }
      if (isCurrentScope(managementScope)) await get().loadAgents({ silent: true, scope: managementScope });
      await get().loadCloudPackages();
      return {
        agentId: result.install.agentId,
        packageId: result.packageId,
        packageVersionId: result.packageVersionId ?? packageVersionId,
      };
    } finally {
      set((state) => {
        const next = { ...state.cloudInstallingByVersionId };
        delete next[packageVersionId];
        return { cloudInstallingByVersionId: next };
      });
    }
  },

  importAgentConfig: async (input, capturedScope) => {
    const managementScope = await resolveSubagentManagementScope(capturedScope);
    const packageData = normalizeSubagentConfigPackage(input);
    if (managementScope.endpoint.kind === 'native-runtime' && managementScope.endpoint.runtimeAdapterId === 'matcha-agent' && (packageData.agent.skills !== undefined || packageData.agent.skillBundles?.length)) throw new Error('Native Agent skill selection/import is unsupported.');
    const createResult = await get().createAgent({
      name: packageData.agent.name,
      description: packageData.agent.description,
    }, { scope: managementScope, workspaceInitialization: 'emptyWorkspace' });
    const createdAgentId = createResult.agentId;
    return runSerializedAgentMutation(async () => {
    const warnings = createResult.warning ? [createResult.warning] : [];
    if (!isCurrentScope(managementScope)) return toSubagentCreateResult(createdAgentId, warnings);
    const fileEntries = Object.entries(packageData.agent.files)
      .filter((entry): entry is [SubagentTargetFile, string] => {
        const [fileName, content] = entry;
        return SUBAGENT_TARGET_FILES.includes(fileName as SubagentTargetFile)
          && typeof content === 'string';
      });

    if (packageData.agent.skillBundles && packageData.agent.skillBundles.length > 0) {
      try {
        const result = await importSkillBundles(packageData.agent.skillBundles);
        if (!result.ok) {
          warnings.push(buildCreateWarning(createdAgentId, `技能导入失败：${result.error || 'unknown error'}`));
        }
      } catch (error) {
        warnings.push(buildCreateWarning(createdAgentId, `技能导入失败：${getErrorMessage(error)}`));
      }
    }

    if (packageData.agent.skills !== undefined) {
      try {
        await updateAgentSkillsConfig(managementScope, createdAgentId, packageData.agent.skills);
      } catch (error) {
        warnings.push(buildCreateWarning(createdAgentId, `技能配置写入失败：${getErrorMessage(error)}`));
      }
    }

    if (isCurrentScope(managementScope)) beginGlobalMutating(set);
    try {
      try {
        for (const [name, content] of fileEntries) {
          await rpc('agents.files.set', {
            agentId: createdAgentId,
            name,
            content,
          }, {
            scope: managementScope,
            target: buildSubagentTarget(managementScope, createdAgentId),
          });
        }
      } catch (error) {
        warnings.push(buildCreateWarning(createdAgentId, `人设文件写入失败：${getErrorMessage(error)}`));
      }
      try {
        await get().loadPersistedFilesForAgent(createdAgentId, managementScope);
      } catch (error) {
        warnings.push(buildCreateWarning(createdAgentId, `人设文件写入失败：${getErrorMessage(error)}`));
      }
    } finally {
      if (isCurrentScope(managementScope)) finishGlobalMutating(set);
    }

    try {
      if (isCurrentScope(managementScope)) await get().loadAgents({ silent: true, scope: managementScope });
    } catch (error) {
      warnings.push(buildCreateRefreshWarning(createdAgentId, error));
    }
    return toSubagentCreateResult(createdAgentId, warnings);
    }, createdAgentId);
  },

  updateAgent: async ({ agentId, name, description, workspace, model, skills, avatarSeed, avatarStyle }, capturedScope) => {
    const managementScope = await resolveSubagentManagementScope(capturedScope);
    return runSerializedAgentMutation(async () => {
    if (!isCurrentScope(managementScope)) throw new Error('Management scope changed before Agent update.');
    const current = readAgentsFromState(get()).find((agent) => agent.id === agentId);
    const explicitSkillAllowlistRequested = skills !== undefined;
    const nextExplicitSkillAllowlist = skills === null
      ? undefined
      : normalizeSkillAllowlist(skills);
    const avatarSeedChangeRequested = avatarSeed !== undefined;
    const nextAvatarSeed = avatarSeed == null ? undefined : getOptionalString(avatarSeed);
    const avatarSeedChanged = avatarSeedChangeRequested && !equalOptionalTrimmedString(current?.avatarSeed, nextAvatarSeed);
    const avatarStyleChangeRequested = avatarStyle !== undefined;
    const nextAvatarStyle = avatarStyle == null ? undefined : resolveAgentAvatarStyle(avatarStyle);
    const avatarStyleChanged = avatarStyleChangeRequested && (current?.avatarStyle ?? '') !== (nextAvatarStyle ?? '');
    const identityChanged = !(
      current
      && equalOptionalTrimmedString(current.name, name)
      && (workspace === undefined || equalOptionalTrimmedString(current.workspace, workspace))
    );
    const modelChanged = !(
      current
      && equalOptionalTrimmedString(current.model, model)
    );
    const descriptionChangeRequested = description !== undefined;
    const nextDescription = description == null ? undefined : getOptionalString(description);
    const descriptionChanged = descriptionChangeRequested && !equalOptionalTrimmedString(current?.description, nextDescription);

    if (
      !identityChanged
      && !modelChanged
      && !descriptionChanged
      && !explicitSkillAllowlistRequested
      && !avatarSeedChanged
      && !avatarStyleChanged
    ) {
      return;
    }

    const nextName = name.trim();
    const nextWorkspace = workspace?.trim();
    const nextModel = getOptionalString(model);
    if (managementScope.endpoint.kind === 'native-runtime' && managementScope.endpoint.runtimeAdapterId === 'matcha-agent'
      && workspace !== undefined && !equalOptionalTrimmedString(current?.workspace, workspace)) {
      throw new Error('This runtime requires a Server-managed workspace.');
    }

    beginGlobalMutating(set);
    try {
      if (identityChanged || modelChanged || descriptionChanged || explicitSkillAllowlistRequested) {
        if (identityChanged || modelChanged) {
          const updatePayload: Record<string, unknown> = {
            agentId,
          };
          if (identityChanged) {
            updatePayload.name = nextName;
            if (workspace !== undefined) updatePayload.workspace = nextWorkspace;
          }
          if (modelChanged) {
            updatePayload.model = nextModel ?? null;
          }
          await rpc('agents.update', updatePayload, {
            scope: managementScope,
            target: buildSubagentTarget(managementScope, agentId),
          });
        }
        if (descriptionChanged) {
          await updateAgentDescriptionConfig(managementScope, agentId, nextDescription);
        }
        if (explicitSkillAllowlistRequested) {
          await updateAgentSkillsConfig(managementScope, agentId, nextExplicitSkillAllowlist);
        }
      }
      if (!isCurrentScope(managementScope)) return;
      if (avatarSeedChanged || avatarStyleChanged) {
        persistAvatarPresentation(agentId, normalizeAvatarPresentation({
          avatarSeed: avatarSeedChanged ? nextAvatarSeed : current?.avatarSeed,
          avatarStyle: avatarStyleChanged ? nextAvatarStyle : current?.avatarStyle,
        }));
      }
      if (isCurrentScope(managementScope)) await get().loadAgents({ silent: true, scope: managementScope });
    } catch (error) {
      const message = getErrorMessage(error) || 'Failed to update subagent';
      if (isCurrentScope(managementScope)) set({ error: message });
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(message, { cause: error });
    } finally {
      if (isCurrentScope(managementScope)) finishGlobalMutating(set);
    }
  }, agentId, () => {
    const current = readAgentsFromState(get()).find((agent) => agent.id === agentId);
    // Native updates share one configuration document; local presentation does not.
    return Boolean(current
      && equalOptionalTrimmedString(current.name, name)
      && (workspace === undefined || equalOptionalTrimmedString(current.workspace, workspace))
      && equalOptionalTrimmedString(current.model, model)
      && (description === undefined || equalOptionalTrimmedString(current.description, description))
      && skills === undefined);
  });
  },

  deleteAgent: async (agentId, deleteFiles = false, capturedScope) => {
    const managementScope = await resolveSubagentManagementScope(capturedScope);
    return runSerializedAgentMutation(async () => {
    if (!isCurrentScope(managementScope)) throw new Error('Management scope changed before Agent deletion.');
    try {
      assertDeletableAgent(agentId, readAgentsFromState(get()));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete subagent',
      });
      throw error;
    }

    beginGlobalMutating(set);
    const agentsSnapshot = readAgentsFromState(get());
    const reads = runtimeAgentReads(managementScope.endpoint);
    reads.unconfirmedDeletedAgentIds.add(agentId);
    try {
      await rpc('agents.delete', { agentId, deleteFiles }, {
        scope: managementScope,
        target: buildSubagentTarget(managementScope, agentId),
      });
      reads.unconfirmedDeletedAgentIds.delete(agentId);
      const normalizedAgentId = normalizeAgentIdForComparison(agentId);
      if (normalizedAgentId) reads.pendingDeletedAgentIds.add(normalizedAgentId);
      const state = get();
      const resource = selectAgentsResource(state, managementScope.endpoint);
      const nextAgents = resource.data.filter((entry) => entry.id !== agentId);
      publishAgentsResource(managementScope.endpoint, { ...resource, data: nextAgents }, isCurrentScope(managementScope) ? {
        selectedAgentId: state.selectedAgentId === agentId
          ? (managementScope.endpoint.kind === 'native-runtime' && managementScope.endpoint.runtimeAdapterId === 'matcha-agent' ? null : (nextAgents[0]?.id ?? null))
          : state.selectedAgentId,
        managedAgentId: state.managedAgentId === agentId ? null : state.managedAgentId,
      } : {});
      useChatStore.getState().forgetAgentSessions(agentId, managementScope.endpoint);
      if (!isCurrentScope(managementScope)) return;
      if (agentsSnapshot.find((agent) => agent.id === agentId)?.sealed) await get().loadCloudPackages();
      if (!isCurrentScope(managementScope)) return;
      try {
        persistAvatarPresentation(agentId, undefined);
      } catch {
        // Ignore local presentation cleanup failures during delete.
      }
    } catch (error) {
      const message = getErrorMessage(error) || 'Failed to delete subagent';
      if (isCurrentScope(managementScope)) set({ error: message });
      throw error instanceof Error ? error : new Error(message, { cause: error });
    } finally {
      if (isCurrentScope(managementScope)) finishGlobalMutating(set);
    }
  }, agentId);
  },
}));

function normalizeSubagentsStatePatch<T extends Partial<SubagentsState> | SubagentsState>(patch: T): T {
  if (!patch || typeof patch !== 'object' || !('agents' in patch)) {
    return patch;
  }
  const next = { ...patch } as Partial<SubagentsState> & { agents?: SubagentSummary[] };
  const nextAgents = Array.isArray(next.agents) ? next.agents : [];
  delete next.agents;
  next.agentsResource = {
    ...(next.agentsResource ?? useSubagentsStore.getState().agentsResource),
    data: nextAgents,
  };
  return next as T;
}

const rawSubagentsSetState = useSubagentsStore.setState;
useSubagentsStore.setState = ((partial, replace) => {
  if (typeof partial === 'function') {
    if (replace === true) {
      return rawSubagentsSetState(
        (state) => normalizeSubagentsStatePatch(partial(state)) as SubagentsState,
        true,
      );
    }
    return rawSubagentsSetState(
      (state) => normalizeSubagentsStatePatch(partial(state)) as Partial<SubagentsState>,
      false,
    );
  }
  if (replace === true) {
    return rawSubagentsSetState(normalizeSubagentsStatePatch(partial) as SubagentsState, true);
  }
  return rawSubagentsSetState(normalizeSubagentsStatePatch(partial) as Partial<SubagentsState>, false);
}) as typeof useSubagentsStore.setState;

const rawSubagentsGetState = useSubagentsStore.getState;
useSubagentsStore.getState = (() => {
  const state = rawSubagentsGetState();
  return {
    ...state,
    agents: readAgentsFromState(state),
  };
}) as typeof useSubagentsStore.getState;

useRuntimeEndpointsStore.subscribe(() => {
  activateManagementScope(selectedManagementScope());
});
