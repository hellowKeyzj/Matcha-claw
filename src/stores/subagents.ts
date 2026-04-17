import { create } from 'zustand';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import { buildLineDiff } from '@/lib/line-diff';
import {
  buildTemplateAvatarSeed,
  DEFAULT_AGENT_AVATAR_STYLE,
  resolveAgentAvatarStyle,
  type AgentAvatarStyle,
} from '@/lib/agent-avatar';
import { hostGatewayRpc, hostOpenClawGetConfigDir } from '@/lib/host-api';
import { fetchProviderSnapshot } from '@/lib/provider-accounts';
import { buildSelectableProviderModels } from '@/lib/provider-models';
import {
  waitAgentRunWithProgress,
} from '@/services/openclaw/agent-runtime';
import {
  deleteSession,
  fetchLatestAssistantText,
  sendChatMessage,
} from '@/services/openclaw/session-runtime';
import {
  buildSubagentWorkspacePath,
  buildWorkspaceSubagentsRootFromConfigDir,
  hasSubagentNameConflict,
  normalizeSubagentNameToSlug,
} from '@/features/subagents/domain/workspace';
import {
  buildSubagentPromptPayload,
  extractChatSendOutput,
  parseDraftPayload,
} from '@/features/subagents/domain/prompt';
import { useProviderStore } from '@/stores/providers';
import type {
  AgentsListResult,
  ConfigGetResult,
  DraftByFile,
  ModelCatalogEntry,
  PreviewDiffByFile,
  SubagentSummary,
  SubagentTemplateDetail,
  SubagentTargetFile,
} from '@/types/subagent';

const MAIN_AGENT_ID = 'main';
const DRAFT_HISTORY_POLL_INTERVAL_MS = 500;
const DRAFT_HISTORY_READ_TIMEOUT_MS = 180000;
const DRAFT_CHAT_SEND_RPC_TIMEOUT_MS = 30000;
const DRAFT_AGENT_NO_PROGRESS_TIMEOUT_MS = 180000;
const DRAFT_HISTORY_AFTER_WAIT_TIMEOUT_MS = 15000;
const DRAFT_RPC_TIMEOUT_BUFFER_MS = 10000;
const CREATE_AGENT_RUNTIME_BARRIER_TIMEOUT_MS = 3000;
const CREATE_AGENT_RUNTIME_BARRIER_POLL_INTERVAL_MS = 120;
const CONFIG_DISPLAY_CACHE_TTL_MS = 1000;
let workspaceFallbackRootCache: string | undefined;
let workspaceFallbackRootTask: Promise<string | undefined> | null = null;
let configDisplayCache:
  | { snapshot: ConfigDisplaySnapshot; cachedAt: number; requestSeq: number }
  | null = null;
let configDisplayReadTask: Promise<ConfigDisplaySnapshot> | null = null;
let configDisplayReadTaskSeq = 0;
let configDisplayReadSeq = 0;
let queuedLoadAgentsTask: Promise<void> | null = null;

function buildDraftSessionKey(agentId: string): string {
  return `agent:${agentId}:subagent-draft`;
}

interface AgentFileGetResult {
  file?: {
    content?: unknown;
  };
  content?: unknown;
}

interface AgentsCreateResult {
  agentId?: unknown;
  name?: unknown;
  workspace?: unknown;
}

interface ConfigAgentDisplaySnapshot {
  workspace?: string;
  model?: string;
  skills?: string[];
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface ConfigDisplaySnapshot {
  byAgentId: Map<string, ConfigAgentDisplaySnapshot>;
  defaultWorkspace?: string;
  defaultModel?: string;
}

interface ReadConfigForDisplayOptions {
  forceRefresh?: boolean;
}

interface LoadAgentsOptions {
  silent?: boolean;
}

interface SubagentsState {
  agents: SubagentSummary[];
  lastLoadedAt: number | null;
  availableModels: ModelCatalogEntry[];
  modelsLoading: boolean;
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  error: string | null;
  managedAgentId: string | null;
  draftPromptByAgent: Record<string, string>;
  draftGeneratingByAgent: Record<string, boolean>;
  draftApplyingByAgent: Record<string, boolean>;
  draftApplySuccessByAgent: Record<string, boolean>;
  draftSessionKeyByAgent: Record<string, string>;
  draftRawOutputByAgent: Record<string, string>;
  persistedFilesByAgent: Record<string, Partial<Record<SubagentTargetFile, string>>>;
  draftByFile: DraftByFile;
  draftError: string | null;
  previewDiffByFile: PreviewDiffByFile;
  selectedAgentId: string | null;
  loadAgents: (options?: LoadAgentsOptions) => Promise<void>;
  loadAvailableModels: () => Promise<void>;
  selectAgent: (agentId: string | null) => void;
  setManagedAgentId: (agentId: string | null) => void;
  loadPersistedFilesForAgent: (agentId: string) => Promise<Partial<Record<SubagentTargetFile, string>>>;
  setDraftPromptForAgent: (agentId: string, prompt: string) => void;
  cancelDraft: (agentId: string) => Promise<void>;
  createAgent: (input: {
    name: string;
    workspace: string;
    model?: string;
    avatarSeed?: string;
    avatarStyle?: AgentAvatarStyle;
  }) => Promise<string>;
  createAgentFromTemplate: (input: {
    template: SubagentTemplateDetail;
    model: string;
    localizedName?: string;
  }) => Promise<string>;
  updateAgent: (input: {
    agentId: string;
    name: string;
    workspace: string;
    model?: string;
    skills?: string[] | null;
    avatarSeed?: string | null;
    avatarStyle?: AgentAvatarStyle | null;
  }) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  generateDraftFromPrompt: (agentId: string, prompt: string) => Promise<void>;
  generatePreviewDiffByFile: (originalByFile: Partial<Record<SubagentTargetFile, string>>) => void;
  applyDraft: (agentId: string) => Promise<void>;
}

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  return await hostGatewayRpc<T>(method, params, timeoutMs);
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getOptionalAgentAvatarStyle(value: unknown): AgentAvatarStyle | undefined {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return resolveAgentAvatarStyle(normalized);
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

function equalSkillAllowlist(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
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

function buildConfigDisplaySnapshot(configGetResult: ConfigGetResult | undefined): ConfigDisplaySnapshot {
  const byAgentId = new Map<string, ConfigAgentDisplaySnapshot>();
  const config = configGetResult?.config;
  const agents = (config && typeof config === 'object')
    ? (config as { agents?: unknown }).agents
    : undefined;
  const defaults = (agents && typeof agents === 'object')
    ? (agents as { defaults?: unknown }).defaults
    : undefined;
  const defaultWorkspace = defaults && typeof defaults === 'object'
    ? getOptionalString((defaults as { workspace?: unknown }).workspace)
    : undefined;

  let defaultModel: string | undefined;
  if (defaults && typeof defaults === 'object') {
    for (const modelId of collectModelIdsFromAgentModelValue((defaults as { model?: unknown }).model)) {
      if (!defaultModel) {
        defaultModel = modelId;
      }
    }
  }

  const agentsList = (agents && typeof agents === 'object')
    ? (agents as { list?: unknown }).list
    : undefined;
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
      const workspace = getOptionalString((item as { workspace?: unknown }).workspace);
      const skills = normalizeSkillAllowlist((item as { skills?: unknown }).skills);
      const avatarSeed = getOptionalString((item as { avatarSeed?: unknown }).avatarSeed);
      const avatarStyle = getOptionalAgentAvatarStyle((item as { avatarStyle?: unknown }).avatarStyle);
      let model: string | undefined;
      for (const modelId of collectModelIdsFromAgentModelValue((item as { model?: unknown }).model)) {
        if (!model) {
          model = modelId;
        }
      }
      byAgentId.set(normalizedAgentId, {
        workspace,
        model,
        skills,
        avatarSeed,
        avatarStyle,
      });
    }
  }

  return {
    byAgentId,
    defaultWorkspace,
    defaultModel,
  };
}

function createEmptyConfigDisplaySnapshot(): ConfigDisplaySnapshot {
  return {
    byAgentId: new Map(),
  };
}

function isConfigDisplayCacheFresh(nowMs: number): boolean {
  if (!configDisplayCache) {
    return false;
  }
  return (nowMs - configDisplayCache.cachedAt) <= CONFIG_DISPLAY_CACHE_TTL_MS;
}

function invalidateConfigDisplayCache(): void {
  configDisplayCache = null;
}

async function readConfigForDisplay(options?: ReadConfigForDisplayOptions): Promise<ConfigDisplaySnapshot> {
  const forceRefresh = options?.forceRefresh === true;
  const nowMs = Date.now();

  if (!forceRefresh && isConfigDisplayCacheFresh(nowMs) && configDisplayCache) {
    return configDisplayCache.snapshot;
  }
  if (!forceRefresh && configDisplayReadTask) {
    return configDisplayReadTask;
  }

  const requestSeq = ++configDisplayReadSeq;
  const task = (async () => {
    try {
      const configGetResult = await rpc<ConfigGetResult>('config.get', {});
      const snapshot = buildConfigDisplaySnapshot(configGetResult);
      if (!configDisplayCache || requestSeq >= configDisplayCache.requestSeq) {
        configDisplayCache = {
          snapshot,
          cachedAt: Date.now(),
          requestSeq,
        };
      }
      return snapshot;
    } catch {
      if (configDisplayCache) {
        return configDisplayCache.snapshot;
      }
      return createEmptyConfigDisplaySnapshot();
    } finally {
      if (configDisplayReadTaskSeq === requestSeq) {
        configDisplayReadTask = null;
      }
    }
  })();

  configDisplayReadTask = task;
  configDisplayReadTaskSeq = requestSeq;
  return task;
}

async function resolveWorkspaceFallbackRoot(): Promise<string | undefined> {
  if (workspaceFallbackRootCache) {
    return workspaceFallbackRootCache;
  }
  if (workspaceFallbackRootTask) {
    return workspaceFallbackRootTask;
  }
  workspaceFallbackRootTask = (async () => {
    try {
      const configDir = getOptionalString(await hostOpenClawGetConfigDir());
      if (!configDir) {
        return undefined;
      }
      const fallbackRoot = buildWorkspaceSubagentsRootFromConfigDir(configDir);
      workspaceFallbackRootCache = fallbackRoot;
      return fallbackRoot;
    } catch {
      return undefined;
    } finally {
      workspaceFallbackRootTask = null;
    }
  })();
  return workspaceFallbackRootTask;
}

function resolveDefaultAgentId(result: AgentsListResult): string {
  const fromResult = getOptionalString(result.defaultId);
  if (fromResult) {
    return fromResult;
  }

  for (const agent of result.agents) {
    const id = getOptionalString(agent?.id);
    if (id) {
      return id;
    }
  }

  return MAIN_AGENT_ID;
}

function normalizeAgents(
  result: AgentsListResult,
  configSnapshot?: ConfigDisplaySnapshot,
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
    const workspace = configAgent?.workspace
      ?? getOptionalString(runtimeAgent?.workspace)
      ?? (agentId === defaultId ? configSnapshot?.defaultWorkspace : undefined);
    const model = configAgent?.model
      ?? extractModelId(runtimeAgent?.model)
      ?? configSnapshot?.defaultModel;
    const skills = configAgent?.skills
      ?? normalizeSkillAllowlist(runtimeAgent?.skills);
    const avatarSeed = configAgent?.avatarSeed;
    const avatarStyle = configAgent?.avatarStyle;
    return {
      ...(runtimeAgent ?? { id: agentId }),
      id: agentId,
      name: runtimeName ?? fallbackName,
      workspace,
      model,
      skills,
      avatarSeed,
      avatarStyle,
      isDefault: agentId === defaultId,
    };
  });
}

function resolveDefaultAgentFromState(agents: SubagentSummary[]): SubagentSummary | undefined {
  return agents.find((agent) => agent.isDefault);
}

function assertDeletableAgent(agentId: string, agents: SubagentSummary[]): void {
  const defaultAgent = resolveDefaultAgentFromState(agents);
  if (defaultAgent && defaultAgent.id === agentId) {
    throw new Error('Default agent cannot be deleted');
  }
}

function cloneConfigForWrite(config: ConfigGetResult['config'] | undefined): ConfigGetResult['config'] {
  if (!config || typeof config !== 'object') {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(config)) as ConfigGetResult['config'];
  } catch {
    return {};
  }
}

function upsertAgentSkillsInConfig(params: {
  config: ConfigGetResult['config'];
  agentId: string;
  skills: string[] | undefined;
}): ConfigGetResult['config'] {
  const nextConfig = cloneConfigForWrite(params.config);
  const nextAgents = (nextConfig.agents && typeof nextConfig.agents === 'object')
    ? { ...nextConfig.agents }
    : {};
  const list = Array.isArray(nextAgents.list) ? [...nextAgents.list] : [];
  const normalizedTargetId = normalizeAgentIdForComparison(params.agentId);
  if (!normalizedTargetId) {
    return nextConfig;
  }

  const targetIndex = list.findIndex((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const id = getOptionalString((entry as { id?: unknown }).id);
    if (!id) {
      return false;
    }
    return normalizeAgentIdForComparison(id) === normalizedTargetId;
  });

  const current = targetIndex >= 0
    ? list[targetIndex]
    : { id: normalizedTargetId };
  const nextEntry = (current && typeof current === 'object')
    ? { ...current } as Record<string, unknown>
    : ({ id: normalizedTargetId } as Record<string, unknown>);

  if (params.skills === undefined) {
    delete nextEntry.skills;
  } else {
    nextEntry.skills = params.skills;
  }

  if (targetIndex >= 0) {
    list[targetIndex] = nextEntry as typeof list[number];
  } else {
    list.push(nextEntry as typeof list[number]);
  }

  nextAgents.list = list;
  nextConfig.agents = nextAgents;
  return nextConfig;
}

function upsertAgentModelInConfig(params: {
  config: ConfigGetResult['config'];
  agentId: string;
  model: string | undefined;
}): ConfigGetResult['config'] {
  const nextConfig = cloneConfigForWrite(params.config);
  const nextAgents = (nextConfig.agents && typeof nextConfig.agents === 'object')
    ? { ...nextConfig.agents }
    : {};
  const list = Array.isArray(nextAgents.list) ? [...nextAgents.list] : [];
  const normalizedTargetId = normalizeAgentIdForComparison(params.agentId);
  if (!normalizedTargetId) {
    return nextConfig;
  }

  const targetIndex = list.findIndex((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const id = getOptionalString((entry as { id?: unknown }).id);
    if (!id) {
      return false;
    }
    return normalizeAgentIdForComparison(id) === normalizedTargetId;
  });

  const current = targetIndex >= 0
    ? list[targetIndex]
    : { id: normalizedTargetId };
  const nextEntry = (current && typeof current === 'object')
    ? { ...current } as Record<string, unknown>
    : ({ id: normalizedTargetId } as Record<string, unknown>);

  if (params.model === undefined) {
    delete nextEntry.model;
  } else {
    nextEntry.model = params.model;
  }

  if (targetIndex >= 0) {
    list[targetIndex] = nextEntry as typeof list[number];
  } else {
    list.push(nextEntry as typeof list[number]);
  }

  nextAgents.list = list;
  nextConfig.agents = nextAgents;
  return nextConfig;
}

function upsertAgentAvatarConfigInConfig(params: {
  config: ConfigGetResult['config'];
  agentId: string;
  avatarSeed: string | undefined;
  avatarStyle: AgentAvatarStyle | undefined;
}): ConfigGetResult['config'] {
  const nextConfig = cloneConfigForWrite(params.config);
  const nextAgents = (nextConfig.agents && typeof nextConfig.agents === 'object')
    ? { ...nextConfig.agents }
    : {};
  const list = Array.isArray(nextAgents.list) ? [...nextAgents.list] : [];
  const normalizedTargetId = normalizeAgentIdForComparison(params.agentId);
  if (!normalizedTargetId) {
    return nextConfig;
  }

  const targetIndex = list.findIndex((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const id = getOptionalString((entry as { id?: unknown }).id);
    if (!id) {
      return false;
    }
    return normalizeAgentIdForComparison(id) === normalizedTargetId;
  });

  const current = targetIndex >= 0
    ? list[targetIndex]
    : { id: normalizedTargetId };
  const nextEntry = (current && typeof current === 'object')
    ? { ...current } as Record<string, unknown>
    : ({ id: normalizedTargetId } as Record<string, unknown>);

  if (params.avatarSeed === undefined) {
    delete nextEntry.avatarSeed;
  } else {
    nextEntry.avatarSeed = params.avatarSeed;
  }
  if (params.avatarStyle === undefined) {
    delete nextEntry.avatarStyle;
  } else {
    nextEntry.avatarStyle = params.avatarStyle;
  }

  if (targetIndex >= 0) {
    list[targetIndex] = nextEntry as typeof list[number];
  } else {
    list.push(nextEntry as typeof list[number]);
  }

  nextAgents.list = list;
  nextConfig.agents = nextAgents;
  return nextConfig;
}

async function updateAgentSkillsConfig(agentId: string, skills: string[] | undefined): Promise<void> {
  const configGetResult = await rpc<ConfigGetResult>('config.get', {});
  const hash = getOptionalString(configGetResult.hash) ?? getOptionalString(configGetResult.baseHash);
  if (!hash) {
    throw new Error('Missing config hash for skills update');
  }
  const nextConfig = upsertAgentSkillsInConfig({
    config: configGetResult.config,
    agentId,
    skills,
  });
  await rpc('config.set', {
    raw: JSON.stringify(nextConfig),
    baseHash: hash,
  });
}

async function updateAgentModelConfig(agentId: string, model: string | undefined): Promise<void> {
  const configGetResult = await rpc<ConfigGetResult>('config.get', {});
  const hash = getOptionalString(configGetResult.hash) ?? getOptionalString(configGetResult.baseHash);
  if (!hash) {
    throw new Error('Missing config hash for model update');
  }
  const nextConfig = upsertAgentModelInConfig({
    config: configGetResult.config,
    agentId,
    model,
  });
  await rpc('config.set', {
    raw: JSON.stringify(nextConfig),
    baseHash: hash,
  });
}

async function updateAgentAvatarConfig(
  agentId: string,
  input: { avatarSeed: string | undefined; avatarStyle: AgentAvatarStyle | undefined },
): Promise<void> {
  const configGetResult = await rpc<ConfigGetResult>('config.get', {});
  const hash = getOptionalString(configGetResult.hash) ?? getOptionalString(configGetResult.baseHash);
  if (!hash) {
    throw new Error('Missing config hash for avatar seed update');
  }
  const nextConfig = upsertAgentAvatarConfigInConfig({
    config: configGetResult.config,
    agentId,
    avatarSeed: input.avatarSeed,
    avatarStyle: input.avatarStyle,
  });
  await rpc('config.set', {
    raw: JSON.stringify(nextConfig),
    baseHash: hash,
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAgentNotFoundErrorForId(error: unknown, agentId: string): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const normalizedId = normalizeSubagentNameToSlug(agentId).toLowerCase();
  if (!normalizedId) {
    return false;
  }
  const quotedPattern = new RegExp(`agent\\s+["']${normalizedId}["']\\s+not\\s+found`);
  const plainPattern = new RegExp(`agent\\s+${normalizedId}\\s+not\\s+found`);
  if (quotedPattern.test(message) || plainPattern.test(message)) {
    return true;
  }
  return message.includes('not found') && message.includes(normalizedId);
}

function runtimeListContainsAgent(result: AgentsListResult, agentId: string): boolean {
  const normalizedAgentId = normalizeSubagentNameToSlug(agentId);
  if (!normalizedAgentId) {
    return false;
  }
  return result.agents.some((agent) => {
    const runtimeId = getOptionalString(agent?.id);
    return runtimeId != null && normalizeSubagentNameToSlug(runtimeId) === normalizedAgentId;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilAgentVisibleInRuntimeList(
  agentId: string,
  timeoutMs: number = CREATE_AGENT_RUNTIME_BARRIER_TIMEOUT_MS,
): Promise<void> {
  const normalizedAgentId = normalizeSubagentNameToSlug(agentId);
  if (!normalizedAgentId) {
    throw new Error('Invalid agentId');
  }
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const result = await rpc<AgentsListResult>('agents.list', {});
    if (runtimeListContainsAgent(result, normalizedAgentId)) {
      return;
    }
    await sleep(CREATE_AGENT_RUNTIME_BARRIER_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for agent "${normalizedAgentId}" to appear in agents.list`);
}

async function updateAgentWithCreateBarrier(params: {
  agentId: string;
  model?: string;
}): Promise<void> {
  await waitUntilAgentVisibleInRuntimeList(params.agentId);
  try {
    await rpc('agents.update', params);
    return;
  } catch (error) {
    if (!isAgentNotFoundErrorForId(error, params.agentId)) {
      throw error;
    }
  }
  await waitUntilAgentVisibleInRuntimeList(params.agentId);
  await rpc('agents.update', params);
}

async function waitForDraftOutputFromHistory(sessionKey: string): Promise<string> {
  return waitForDraftOutputFromHistoryWithTimeout(sessionKey, DRAFT_HISTORY_READ_TIMEOUT_MS);
}

async function waitForDraftOutputFromHistoryWithTimeout(
  sessionKey: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = await fetchLatestAssistantText(rpc, {
      sessionKey,
      limit: 20,
    });
    if (output) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, DRAFT_HISTORY_POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for draft output');
}

async function waitForRunCompletion(runId: string, sessionKey: string): Promise<void> {
  await waitAgentRunWithProgress(rpc, {
    runId,
    sessionKey,
    waitSliceMs: 30000,
    idleTimeoutMs: DRAFT_AGENT_NO_PROGRESS_TIMEOUT_MS,
    rpcTimeoutBufferMs: DRAFT_RPC_TIMEOUT_BUFFER_MS,
    logPrefix: 'subagents.draft',
  });
}

async function cleanupSession(sessionKey: string): Promise<void> {
  await deleteSession(rpc, { key: sessionKey, deleteTranscript: true });
}

async function cleanupDraftSessionForAgent(agentId: string, getState: () => SubagentsState): Promise<void> {
  const sessionKey = getState().draftSessionKeyByAgent[agentId];
  if (!sessionKey) {
    return;
  }
  await cleanupSession(sessionKey);
}

function normalizeAgentFileContent(result: AgentFileGetResult): string {
  const fileContent = getOptionalString(result?.file?.content);
  if (fileContent != null) {
    return fileContent;
  }
  return getOptionalString(result?.content) ?? '';
}

async function fetchPersistedFilesForAgent(agentId: string): Promise<Partial<Record<SubagentTargetFile, string>>> {
  const fileByName: Partial<Record<SubagentTargetFile, string>> = {};
  await Promise.all(SUBAGENT_TARGET_FILES.map(async (name) => {
    try {
      const result = await rpc<AgentFileGetResult>('agents.files.get', { agentId, name });
      fileByName[name] = normalizeAgentFileContent(result);
    } catch {
      fileByName[name] = '';
    }
  }));
  return fileByName;
}

const persistedFilesLoadTasks = new Map<string, Promise<Partial<Record<SubagentTargetFile, string>>>>();
let latestLoadAgentsRequestId = 0;
let agentMutationChain: Promise<void> = Promise.resolve();
let activeMutatingOperationCount = 0;
const pendingDeletedAgentIds = new Set<string>();
let inflightLoadAgentsTask: Promise<void> | null = null;

export function __resetSubagentsStoreInternalCachesForTest(): void {
  workspaceFallbackRootCache = undefined;
  workspaceFallbackRootTask = null;
  configDisplayCache = null;
  configDisplayReadTask = null;
  configDisplayReadTaskSeq = 0;
  configDisplayReadSeq = 0;
  persistedFilesLoadTasks.clear();
  pendingDeletedAgentIds.clear();
  latestLoadAgentsRequestId = 0;
  agentMutationChain = Promise.resolve();
  activeMutatingOperationCount = 0;
  inflightLoadAgentsTask = null;
}

function normalizeAgentIdForComparison(agentId: string): string {
  return normalizeSubagentNameToSlug(agentId).trim().toLowerCase();
}

function isAgentPendingDeletion(agentId: string): boolean {
  const normalized = normalizeAgentIdForComparison(agentId);
  return normalized !== '' && pendingDeletedAgentIds.has(normalized);
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

function settlePendingDeletedAgentIds(runtimeAgentIds: Set<string>): void {
  for (const pendingId of [...pendingDeletedAgentIds]) {
    if (!runtimeAgentIds.has(pendingId)) {
      pendingDeletedAgentIds.delete(pendingId);
    }
  }
}

function filterOutPendingDeletedAgents(agents: SubagentSummary[]): SubagentSummary[] {
  return agents.filter((agent) => !isAgentPendingDeletion(agent.id));
}

function runSerializedAgentMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = agentMutationChain.then(task, task);
  agentMutationChain = run.then(() => undefined, () => undefined);
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

async function resolvePersistedFilesForAgent(agentId: string): Promise<Partial<Record<SubagentTargetFile, string>>> {
  const activeTask = persistedFilesLoadTasks.get(agentId);
  if (activeTask) {
    return activeTask;
  }
  const task = fetchPersistedFilesForAgent(agentId)
    .finally(() => {
      persistedFilesLoadTasks.delete(agentId);
    });
  persistedFilesLoadTasks.set(agentId, task);
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
    && (left.workspace ?? '') === (right.workspace ?? '')
    && (left.model ?? '') === (right.model ?? '')
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
  agents: [],
  lastLoadedAt: null,
  availableModels: [],
  modelsLoading: false,
  snapshotReady: false,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  error: null,
  managedAgentId: null,
  draftPromptByAgent: {},
  draftGeneratingByAgent: {},
  draftApplyingByAgent: {},
  draftApplySuccessByAgent: {},
  draftSessionKeyByAgent: {},
  draftRawOutputByAgent: {},
  persistedFilesByAgent: {},
  draftByFile: {},
  draftError: null,
  previewDiffByFile: {},
  selectedAgentId: null,

  loadAgents: async (options) => {
    const silent = options?.silent === true;
    if (inflightLoadAgentsTask) {
      if (!queuedLoadAgentsTask) {
        queuedLoadAgentsTask = inflightLoadAgentsTask.finally(async () => {
          queuedLoadAgentsTask = null;
          await get().loadAgents(options);
        });
      }
      await queuedLoadAgentsTask;
      return;
    }

    const requestId = ++latestLoadAgentsRequestId;
    const stateBeforeLoad = get();
    const hasSnapshot = stateBeforeLoad.snapshotReady || stateBeforeLoad.agents.length > 0;
    set({
      initialLoading: !hasSnapshot,
      refreshing: hasSnapshot && !silent,
      error: null,
    });

    const task = (async () => {
      try {
        const [result, configSnapshot] = await Promise.all([
          rpc<AgentsListResult>('agents.list', {}),
          readConfigForDisplay(),
        ]);
        settlePendingDeletedAgentIds(collectRuntimeAgentIdSet(result));
        const normalizedAgents = filterOutPendingDeletedAgents(normalizeAgents(result, configSnapshot));
        if (requestId !== latestLoadAgentsRequestId) {
          return;
        }
        const stateSnapshot = get();
        const selectedAgentId = stateSnapshot.selectedAgentId;
        const hasSelected = selectedAgentId && normalizedAgents.some((agent) => agent.id === selectedAgentId);
        const managedAgentId = stateSnapshot.managedAgentId;
        const hasManaged = managedAgentId && normalizedAgents.some((agent) => agent.id === managedAgentId);
        const nextSelectedAgentId = hasSelected ? selectedAgentId : (normalizedAgents[0]?.id ?? null);
        const nextManagedAgentId = hasManaged ? managedAgentId : null;
        const shouldPatchAgents = (
          !areAgentListsEquivalent(stateSnapshot.agents, normalizedAgents)
          || stateSnapshot.selectedAgentId !== nextSelectedAgentId
          || stateSnapshot.managedAgentId !== nextManagedAgentId
          || stateSnapshot.error !== null
          || stateSnapshot.initialLoading
          || stateSnapshot.refreshing
          || !stateSnapshot.snapshotReady
        );

        if (shouldPatchAgents) {
          set({
            agents: normalizedAgents,
            lastLoadedAt: Date.now(),
            selectedAgentId: nextSelectedAgentId,
            managedAgentId: nextManagedAgentId,
            snapshotReady: true,
            initialLoading: false,
            refreshing: false,
            error: null,
          });
        } else {
          set({
            lastLoadedAt: Date.now(),
            initialLoading: false,
            refreshing: false,
            error: null,
          });
        }
      } catch (error) {
        if (requestId !== latestLoadAgentsRequestId) {
          return;
        }
        set({
          initialLoading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : 'Failed to load subagents',
        });
      } finally {
        inflightLoadAgentsTask = null;
      }
    })();

    inflightLoadAgentsTask = task;
    await task;
  },

  loadAvailableModels: async () => {
    set({ modelsLoading: true });
    try {
      const providerState = useProviderStore.getState();
      const snapshot = providerState.snapshotReady
        ? providerState.providerSnapshot
        : await fetchProviderSnapshot();
      const normalizedModels = buildSelectableProviderModels(snapshot);
      set({
        availableModels: normalizedModels,
        modelsLoading: false,
        error: null,
      });
    } catch (error) {
      set({
        availableModels: [],
        modelsLoading: false,
        error: getErrorMessage(error) || 'Failed to load models',
      });
    }
  },

  selectAgent: (agentId) => set({ selectedAgentId: agentId }),
  setManagedAgentId: (agentId) => set({ managedAgentId: agentId }),
  loadPersistedFilesForAgent: async (agentId) => {
    if (!agentId) {
      return {};
    }
    try {
      const files = await resolvePersistedFilesForAgent(agentId);
      set((state) => ({
        persistedFilesByAgent: {
          ...state.persistedFilesByAgent,
          [agentId]: files,
        },
      }));
      return files;
    } catch (error) {
      set({
        error: getErrorMessage(error) || 'Failed to load agent files',
      });
      return {};
    }
  },
  setDraftPromptForAgent: (agentId, prompt) => set((state) => ({
    draftPromptByAgent: {
      ...state.draftPromptByAgent,
      [agentId]: prompt,
    },
    draftApplySuccessByAgent: {
      ...state.draftApplySuccessByAgent,
      [agentId]: false,
    },
  })),
  cancelDraft: async (agentId) => {
    try {
      await cleanupDraftSessionForAgent(agentId, get);
    } catch (error) {
      set({ error: getErrorMessage(error) || 'Failed to cleanup draft session' });
    } finally {
      set((state) => {
        const nextSessionMap = { ...state.draftSessionKeyByAgent };
        delete nextSessionMap[agentId];
        const nextApplyingByAgent = { ...state.draftApplyingByAgent };
        delete nextApplyingByAgent[agentId];
        const nextPromptByAgent = { ...state.draftPromptByAgent };
        delete nextPromptByAgent[agentId];
        const nextRawOutputByAgent = { ...state.draftRawOutputByAgent };
        delete nextRawOutputByAgent[agentId];
        return {
          draftByFile: {},
          previewDiffByFile: {},
          draftError: null,
          draftPromptByAgent: nextPromptByAgent,
          draftRawOutputByAgent: nextRawOutputByAgent,
          draftApplyingByAgent: nextApplyingByAgent,
          draftApplySuccessByAgent: {
            ...state.draftApplySuccessByAgent,
            [agentId]: false,
          },
          draftSessionKeyByAgent: nextSessionMap,
        };
      });
    }
  },

  createAgent: async ({ name, workspace, model, avatarSeed, avatarStyle }) => runSerializedAgentMutation(async () => {
    beginGlobalMutating(set);
    try {
      void workspace;
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Subagent name is required');
      }
      const modelId = (model ?? '').trim();
      if (!modelId) {
        throw new Error('Model is required');
      }
      const avatarSeedValue = getOptionalString(avatarSeed);
      const avatarStyleValue = resolveAgentAvatarStyle(avatarStyle);
      const predictedAgentId = normalizeAgentIdForComparison(trimmedName);
      if (predictedAgentId) {
        pendingDeletedAgentIds.delete(predictedAgentId);
      }
      if (hasSubagentNameConflict(trimmedName, get().agents)) {
        throw new Error('Invalid subagent name: duplicate');
      }
      const fallbackRoot = await resolveWorkspaceFallbackRoot();
      const resolvedWorkspace = buildSubagentWorkspacePath({
        name: trimmedName,
        agents: get().agents,
        fallbackRoot,
      });
      const createResult = await rpc<AgentsCreateResult>('agents.create', {
        name: trimmedName,
        workspace: resolvedWorkspace,
      });
      const createdAgentId = getOptionalString(createResult?.agentId);
      if (!createdAgentId) {
        throw new Error('agents.create returned missing agentId');
      }
      const normalizedCreatedAgentId = normalizeAgentIdForComparison(createdAgentId);
      if (normalizedCreatedAgentId) {
        pendingDeletedAgentIds.delete(normalizedCreatedAgentId);
      }
      let partialFailureMessage: string | null = null;
      try {
        await updateAgentWithCreateBarrier({
          agentId: createdAgentId,
          model: modelId,
        });
        await updateAgentAvatarConfig(createdAgentId, {
          avatarSeed: avatarSeedValue ?? `agent:${normalizeAgentIdForComparison(createdAgentId) || createdAgentId}`,
          avatarStyle: avatarStyleValue,
        });
      } catch {
        partialFailureMessage = `智能体 "${createdAgentId}" 已创建，但模型或头像配置写入失败，请在编辑中重新确认`;
      }
      invalidateConfigDisplayCache();
      await get().loadAgents({ silent: true });
      if (partialFailureMessage) {
        set({ error: partialFailureMessage });
      }
      return createdAgentId;
    } catch (error) {
      const message = getErrorMessage(error) || 'Failed to create subagent';
      set({
        error: message,
      });
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(message, { cause: error });
    } finally {
      finishGlobalMutating(set);
    }
  }),

  createAgentFromTemplate: async ({ template, model, localizedName }) => {
    const modelId = getOptionalString(model);
    if (!modelId) {
      throw new Error('Model is required');
    }
    const templateName = getOptionalString(template.name);
    if (!templateName) {
      throw new Error('Template name is required');
    }
    const localizedTemplateName = getOptionalString(localizedName);
    const createdAgentId = await get().createAgent({
      name: templateName,
      workspace: '',
      model: modelId,
      avatarSeed: buildTemplateAvatarSeed(template.id),
      avatarStyle: DEFAULT_AGENT_AVATAR_STYLE,
    });
    if (localizedTemplateName && localizedTemplateName !== templateName) {
      const createdAgent = get().agents.find((agent) => agent.id === createdAgentId);
      const workspace = getOptionalString(createdAgent?.workspace);
      if (workspace) {
        await get().updateAgent({
          agentId: createdAgentId,
          name: localizedTemplateName,
          workspace,
          model: modelId,
        });
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

    if (fileEntries.length === 0) {
      return createdAgentId;
    }

    beginGlobalMutating(set);
    try {
      for (const [name, content] of fileEntries) {
        await rpc('agents.files.set', {
          agentId: createdAgentId,
          name,
          content,
        });
      }
      await rpc('agents.files.list', { agentId: createdAgentId });
      await get().loadAgents({ silent: true });
      set((state) => ({
        persistedFilesByAgent: {
          ...state.persistedFilesByAgent,
          [createdAgentId]: {
            ...(state.persistedFilesByAgent[createdAgentId] ?? {}),
            ...Object.fromEntries(fileEntries) as Partial<Record<SubagentTargetFile, string>>,
          },
        },
      }));
      return createdAgentId;
    } catch (error) {
      const message = getErrorMessage(error) || `Agent "${createdAgentId}" created, but template file copy failed`;
      set({
        error: message,
      });
      throw error instanceof Error ? error : new Error(message, { cause: error });
    } finally {
      finishGlobalMutating(set);
    }
  },

  updateAgent: async ({ agentId, name, workspace, model, skills, avatarSeed, avatarStyle }) => runSerializedAgentMutation(async () => {
    const current = get().agents.find((agent) => agent.id === agentId);
    const skillChangeRequested = skills !== undefined;
    const nextSkills = skills === null
      ? undefined
      : normalizeSkillAllowlist(skills);
    const currentSkills = normalizeSkillAllowlist(current?.skills);
    const skillsChanged = skillChangeRequested && !equalSkillAllowlist(currentSkills, nextSkills);
    const avatarSeedChangeRequested = avatarSeed !== undefined;
    const nextAvatarSeed = avatarSeed == null ? undefined : getOptionalString(avatarSeed);
    const avatarSeedChanged = avatarSeedChangeRequested && !equalOptionalTrimmedString(current?.avatarSeed, nextAvatarSeed);
    const avatarStyleChangeRequested = avatarStyle !== undefined;
    const nextAvatarStyle = avatarStyle == null ? undefined : resolveAgentAvatarStyle(avatarStyle);
    const avatarStyleChanged = avatarStyleChangeRequested && (current?.avatarStyle ?? '') !== (nextAvatarStyle ?? '');
    const identityChanged = !(
      current
      && equalOptionalTrimmedString(current.name, name)
      && equalOptionalTrimmedString(current.workspace, workspace)
    );
    const modelChanged = !(
      current
      && equalOptionalTrimmedString(current.model, model)
    );

    if (
      !identityChanged
      && !modelChanged
      && !skillsChanged
      && !avatarSeedChanged
      && !avatarStyleChanged
    ) {
      return;
    }

    const nextName = name.trim();
    const nextWorkspace = workspace.trim();
    const nextModel = getOptionalString(model);

    beginGlobalMutating(set);
    try {
      if (identityChanged || (modelChanged && nextModel !== undefined)) {
        const updatePayload: Record<string, unknown> = {
          agentId,
        };
        if (identityChanged) {
          updatePayload.name = nextName;
          updatePayload.workspace = nextWorkspace;
        }
        if (modelChanged && nextModel !== undefined) {
          updatePayload.model = nextModel;
        }
        await rpc('agents.update', updatePayload);
      }
      if (modelChanged && nextModel === undefined) {
        await updateAgentModelConfig(agentId, undefined);
      }
      if (skillsChanged) {
        await updateAgentSkillsConfig(agentId, nextSkills);
      }
      if (avatarSeedChanged || avatarStyleChanged) {
        await updateAgentAvatarConfig(agentId, {
          avatarSeed: avatarSeedChanged ? nextAvatarSeed : (current?.avatarSeed ?? undefined),
          avatarStyle: avatarStyleChanged ? nextAvatarStyle : current?.avatarStyle,
        });
      }
      invalidateConfigDisplayCache();
      await get().loadAgents({ silent: true });
    } catch (error) {
      set({
        error: getErrorMessage(error) || 'Failed to update subagent',
      });
    } finally {
      finishGlobalMutating(set);
    }
  }),

  deleteAgent: async (agentId) => runSerializedAgentMutation(async () => {
    try {
      assertDeletableAgent(agentId, get().agents);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete subagent',
      });
      return;
    }

    beginGlobalMutating(set);
    const agentsSnapshot = get().agents;
    const selectedAgentIdSnapshot = get().selectedAgentId;
    const managedAgentIdSnapshot = get().managedAgentId;
    try {
      const normalizedAgentId = normalizeAgentIdForComparison(agentId);
      if (normalizedAgentId) {
        pendingDeletedAgentIds.add(normalizedAgentId);
      }
      set((state) => {
        const nextAgents = state.agents.filter((entry) => entry.id !== agentId);
        const selectedAgentId = state.selectedAgentId === agentId
          ? (nextAgents[0]?.id ?? null)
          : state.selectedAgentId;
        const managedAgentId = state.managedAgentId === agentId
          ? null
          : state.managedAgentId;
        return {
          agents: nextAgents,
          selectedAgentId,
          managedAgentId,
        };
      });
      await rpc('agents.delete', { agentId, deleteFiles: true });
    } catch (error) {
      const normalizedAgentId = normalizeAgentIdForComparison(agentId);
      if (normalizedAgentId) {
        pendingDeletedAgentIds.delete(normalizedAgentId);
      }
      set({
        agents: agentsSnapshot,
        selectedAgentId: selectedAgentIdSnapshot,
        managedAgentId: managedAgentIdSnapshot,
        error: getErrorMessage(error) || 'Failed to delete subagent',
      });
    } finally {
      finishGlobalMutating(set);
    }
  }),

  generateDraftFromPrompt: async (agentId, prompt) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      throw new Error('Prompt cannot be empty');
    }
    if (get().draftGeneratingByAgent[agentId]) {
      const message = 'Draft generation already in progress for this agent';
      set({ error: message, draftError: message });
      throw new Error(message);
    }
    const existingSessionKey = get().draftSessionKeyByAgent[agentId];
    const sessionKey = existingSessionKey || buildDraftSessionKey(agentId);
    let persistedFiles = existingSessionKey
      ? {}
      : get().persistedFilesByAgent[agentId];
    if (!existingSessionKey && !persistedFiles) {
      persistedFiles = await get().loadPersistedFilesForAgent(agentId);
    }
    beginGlobalMutating(set);
    set((state) => ({
      draftError: null,
      draftRawOutputByAgent: {
        ...state.draftRawOutputByAgent,
        [agentId]: '',
      },
      draftApplySuccessByAgent: {
        ...state.draftApplySuccessByAgent,
        [agentId]: false,
      },
      draftSessionKeyByAgent: {
        ...state.draftSessionKeyByAgent,
        [agentId]: sessionKey,
      },
      draftGeneratingByAgent: {
        ...state.draftGeneratingByAgent,
        [agentId]: true,
      },
    }));
    let lastModelOutput = '';
    try {
      const payload = buildSubagentPromptPayload(trimmedPrompt, persistedFiles ?? {});
      const baseMessage = `${payload.systemPrompt}\n\n${payload.userPrompt}`;
      const sendDraftMessage = async (message: string): Promise<string> => {
        const result = await sendChatMessage<Record<string, unknown>>(rpc, {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: crypto.randomUUID(),
        }, DRAFT_CHAT_SEND_RPC_TIMEOUT_MS + DRAFT_RPC_TIMEOUT_BUFFER_MS);
        try {
          return extractChatSendOutput(result);
        } catch {
          const runId = typeof result.runId === 'string' ? result.runId.trim() : '';
          if (runId) {
            await waitForRunCompletion(runId, sessionKey);
            return waitForDraftOutputFromHistoryWithTimeout(
              sessionKey,
              DRAFT_HISTORY_AFTER_WAIT_TIMEOUT_MS,
            );
          }
          return waitForDraftOutputFromHistory(sessionKey);
        }
      };

      let outputText = await sendDraftMessage(baseMessage);
      lastModelOutput = outputText;

      let draftByFile: DraftByFile;
      try {
        const parsedDraft = parseDraftPayload(outputText);
        draftByFile = parsedDraft.draftByFile;
      } catch (firstParseError) {
        const parseMessage = firstParseError instanceof Error ? firstParseError.message : '';
        const shouldRetry = parseMessage.includes('Invalid JSON output from model')
          || parseMessage.includes('Invalid output schema');
        if (!shouldRetry) {
          throw firstParseError;
        }

        const retryMessage = [
          '上一条输出无法解析为有效 JSON。',
          '请只返回一个 JSON 对象，不要 Markdown 代码块，不要任何额外解释。',
          '严格使用结构：{"files":[{"name","content","reason","confidence"}]}。',
          'content 内不要使用 ``` 代码块；若有双引号必须转义为 \\\\"。',
          '请精简内容，确保 5 个文件都完整闭合后再输出。',
        ].join('\n');
        outputText = await sendDraftMessage(retryMessage);
        lastModelOutput = outputText;
        const parsedDraft = parseDraftPayload(outputText);
        draftByFile = parsedDraft.draftByFile;
      }

      set((state) => ({
        draftByFile,
        draftError: null,
        draftRawOutputByAgent: {
          ...state.draftRawOutputByAgent,
          [agentId]: '',
        },
        draftPromptByAgent: {
          ...state.draftPromptByAgent,
          [agentId]: trimmedPrompt,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate draft';
      set((state) => ({
        error: message,
        draftError: message,
        draftRawOutputByAgent: {
          ...state.draftRawOutputByAgent,
          [agentId]: lastModelOutput,
        },
      }));
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(message, { cause: error });
    } finally {
      set((state) => {
        const nextDraftGeneratingByAgent = { ...state.draftGeneratingByAgent };
        delete nextDraftGeneratingByAgent[agentId];
        return {
          draftGeneratingByAgent: nextDraftGeneratingByAgent,
        };
      });
      finishGlobalMutating(set);
    }
  },

  generatePreviewDiffByFile: (originalByFile) => {
    const draftByFile = get().draftByFile;
    const previewDiffByFile: PreviewDiffByFile = {};

    for (const [name, draft] of Object.entries(draftByFile) as [SubagentTargetFile, DraftByFile[SubagentTargetFile]][]) {
      if (!draft) {
        continue;
      }
      const original = originalByFile[name] ?? '';
      previewDiffByFile[name] = buildLineDiff(original, draft.content);
    }

    set({ previewDiffByFile });
  },

  applyDraft: async (agentId) => {
    const draftEntries = Object.entries(get().draftByFile)
      .filter(([, draft]) => draft && !draft.needsReview) as [SubagentTargetFile, NonNullable<DraftByFile[SubagentTargetFile]>][];

    if (draftEntries.length === 0) {
      throw new Error('No approved draft content to apply');
    }

    beginGlobalMutating(set);
    set((state) => ({
      draftApplyingByAgent: {
        ...state.draftApplyingByAgent,
        [agentId]: true,
      },
    }));
    try {
      for (const [name, draft] of draftEntries) {
        await rpc('agents.files.set', {
          agentId,
          name,
          content: draft.content,
        });
      }
      await rpc('agents.files.list', { agentId });
      await get().loadAgents({ silent: true });
      set((state) => ({
        draftByFile: {},
        previewDiffByFile: {},
        draftError: null,
        draftApplyingByAgent: {
          ...state.draftApplyingByAgent,
          [agentId]: false,
        },
        persistedFilesByAgent: {
          ...state.persistedFilesByAgent,
          [agentId]: {
            ...(state.persistedFilesByAgent[agentId] ?? {}),
            ...Object.fromEntries(draftEntries.map(([name, draft]) => [name, draft.content])) as Partial<Record<SubagentTargetFile, string>>,
          },
        },
        draftApplySuccessByAgent: {
          ...state.draftApplySuccessByAgent,
          [agentId]: true,
        },
      }));
    } catch (error) {
      set((state) => ({
        error: error instanceof Error ? error.message : 'Failed to apply draft',
        draftApplyingByAgent: {
          ...state.draftApplyingByAgent,
          [agentId]: false,
        },
      }));
      throw error;
    } finally {
      finishGlobalMutating(set);
    }
  },
}));
