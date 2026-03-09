import { create } from 'zustand';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import { buildLineDiff } from '@/lib/line-diff';
import {
  waitAgentRunWithProgress,
} from '@/lib/openclaw/agent-runtime';
import {
  deleteSession,
  fetchLatestAssistantText,
  sendChatMessage,
} from '@/lib/openclaw/session-runtime';
import {
  buildSubagentWorkspacePath,
  hasSubagentNameConflict,
  normalizeSubagentNameToSlug,
} from '@/lib/subagent/workspace';
import {
  buildSubagentPromptPayload,
  extractChatSendOutput,
  parseDraftPayload,
} from '@/lib/subagent/prompt';
import { collectConfiguredModelIdsFromConfig } from '@/lib/openclaw/model-catalog';
import {
  readConfigForDisplay,
} from '@/lib/openclaw/config-repository';
import {
  mergeRolesFromAgents,
  readRolesMetadata,
  resolveRolesMetadataRoot,
  writeRolesMetadata,
} from '@/lib/team/roles-metadata';
import type {
  AgentConfigEntry,
  AgentsListResult,
  ConfigGetResult,
  DraftByFile,
  SubagentDraftRoleMetadata,
  ModelCatalogEntry,
  PreviewDiffByFile,
  SubagentSummary,
  SubagentTargetFile,
} from '@/types/subagent';

interface RpcSuccess<T> {
  success: true;
  result: T;
}

interface RpcFailure {
  success: false;
  error?: string;
}

type RpcResult<T> = RpcSuccess<T> | RpcFailure;
const MAIN_AGENT_ID = 'main';
const DRAFT_HISTORY_POLL_INTERVAL_MS = 500;
const DRAFT_HISTORY_READ_TIMEOUT_MS = 180000;
const DRAFT_CHAT_SEND_RPC_TIMEOUT_MS = 30000;
const DRAFT_AGENT_NO_PROGRESS_TIMEOUT_MS = 180000;
const DRAFT_HISTORY_AFTER_WAIT_TIMEOUT_MS = 15000;
const DRAFT_RPC_TIMEOUT_BUFFER_MS = 10000;
const IDENTITY_EMOJI_CACHE_TTL_MS = 5 * 60 * 1000;
const CREATE_AGENT_RUNTIME_BARRIER_TIMEOUT_MS = 3000;
const CREATE_AGENT_RUNTIME_BARRIER_POLL_INTERVAL_MS = 120;

function buildDraftSessionKey(agentId: string): string {
  return `agent:${agentId}:subagent-draft`;
}

interface AgentFileGetResult {
  file?: {
    content?: unknown;
  };
  content?: unknown;
}

interface AgentIdentityGetResult {
  agentId?: unknown;
  name?: unknown;
  avatar?: unknown;
  emoji?: unknown;
}

interface AgentsCreateResult {
  agentId?: unknown;
  name?: unknown;
  workspace?: unknown;
}

interface ConfigChangedPayload {
  revision?: unknown;
}

interface SubagentsState {
  agents: SubagentSummary[];
  availableModels: ModelCatalogEntry[];
  modelsLoading: boolean;
  loading: boolean;
  error: string | null;
  managedAgentId: string | null;
  draftPromptByAgent: Record<string, string>;
  draftGeneratingByAgent: Record<string, boolean>;
  draftApplyingByAgent: Record<string, boolean>;
  draftApplySuccessByAgent: Record<string, boolean>;
  draftSessionKeyByAgent: Record<string, string>;
  draftRawOutputByAgent: Record<string, string>;
  draftRoleMetadataByAgent: Record<string, SubagentDraftRoleMetadata | undefined>;
  persistedFilesByAgent: Record<string, Partial<Record<SubagentTargetFile, string>>>;
  draftByFile: DraftByFile;
  draftError: string | null;
  previewDiffByFile: PreviewDiffByFile;
  selectedAgentId: string | null;
  bindConfigChangedListener: () => void;
  loadAgents: () => Promise<void>;
  loadAvailableModels: (cfg?: ConfigGetResult) => Promise<void>;
  selectAgent: (agentId: string | null) => void;
  setManagedAgentId: (agentId: string | null) => void;
  loadPersistedFilesForAgent: (agentId: string) => Promise<Partial<Record<SubagentTargetFile, string>>>;
  setDraftPromptForAgent: (agentId: string, prompt: string) => void;
  cancelDraft: (agentId: string) => Promise<void>;
  createAgent: (input: {
    name: string;
    workspace: string;
    model?: string;
    emoji?: string;
  }) => Promise<string>;
  updateAgent: (input: {
    agentId: string;
    name: string;
    workspace: string;
    model?: string;
  }) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  generateDraftFromPrompt: (agentId: string, prompt: string) => Promise<void>;
  generatePreviewDiffByFile: (originalByFile: Partial<Record<SubagentTargetFile, string>>) => void;
  applyDraft: (agentId: string) => Promise<void>;
}

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const response = await (timeoutMs == null
    ? window.electron.ipcRenderer.invoke(
      'gateway:rpc',
      method,
      params
    )
    : window.electron.ipcRenderer.invoke(
      'gateway:rpc',
      method,
      params,
      timeoutMs
    )) as RpcResult<T>;

  if (!response.success) {
    throw new Error(response.error || `RPC call failed: ${method}`);
  }

  return response.result;
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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

function parseProviderFromModelId(modelId: string): string | undefined {
  const idx = modelId.indexOf('/');
  if (idx <= 0) {
    return undefined;
  }
  return modelId.slice(0, idx);
}

function normalizeConfiguredModelsFromConfig(cfg: ConfigGetResult): ModelCatalogEntry[] {
  const modelIds = collectConfiguredModelIdsFromConfig(cfg);
  return modelIds.map((modelId) => ({
    id: modelId,
    provider: parseProviderFromModelId(modelId),
  }));
}

function resolveDefaultAgentId(
  result: AgentsListResult,
  cfg?: ConfigGetResult,
): string {
  const fromResult = getOptionalString(result.defaultId);
  if (fromResult) {
    return fromResult;
  }

  const configList = cfg?.config?.agents?.list ?? [];
  const explicitDefault = configList.find((agent) => agent?.default === true);
  const explicitDefaultId = getOptionalString(explicitDefault?.id);
  if (explicitDefaultId) {
    return explicitDefaultId;
  }

  const firstConfigId = getOptionalString(configList[0]?.id);
  if (firstConfigId) {
    return firstConfigId;
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
  cfg?: ConfigGetResult,
): SubagentSummary[] {
  const defaultId = resolveDefaultAgentId(result, cfg);
  const configList = cfg?.config?.agents?.list ?? [];
  const configById = new Map<string, AgentConfigEntry>();
  for (const entry of configList) {
    const id = getOptionalString(entry?.id);
    if (!id) {
      continue;
    }
    configById.set(id, entry);
  }
  const runtimeById = new Map<string, SubagentSummary>();
  const runtimeOrderedIds: string[] = [];
  for (const agent of result.agents) {
    const id = getOptionalString(agent?.id);
    if (!id) {
      continue;
    }
    runtimeById.set(id, agent);
    runtimeOrderedIds.push(id);
  }
  const displayIds: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined) => {
    const normalizedId = getOptionalString(id);
    if (!normalizedId || seen.has(normalizedId)) {
      return;
    }
    seen.add(normalizedId);
    displayIds.push(normalizedId);
  };
  for (const runtimeId of runtimeOrderedIds) {
    push(runtimeId);
  }
  push(defaultId);
  const defaultsWorkspace = getOptionalString(cfg?.config?.agents?.defaults?.workspace);
  const defaultsModel = extractModelId(cfg?.config?.agents?.defaults?.model);

  return displayIds.map((agentId) => {
    const runtimeAgent = runtimeById.get(agentId);
    const configEntry = configById.get(agentId);
    const workspace = getOptionalString(runtimeAgent?.workspace)
      ?? getOptionalString(configEntry?.workspace)
      ?? (agentId === defaultId ? defaultsWorkspace : undefined);
    const model = getOptionalString(runtimeAgent?.model)
      ?? extractModelId(configEntry?.model)
      ?? (agentId === defaultId ? defaultsModel : undefined);
    const runtimeName = getOptionalString(runtimeAgent?.name);
    const configName = getOptionalString(configEntry?.name);
    const fallbackName = agentId;
    return {
      ...(runtimeAgent ?? { id: agentId }),
      id: agentId,
      name: runtimeName ?? configName ?? fallbackName,
      workspace,
      model,
      isDefault: runtimeAgent?.isDefault ?? (agentId === defaultId),
    };
  });
}

function resolveDefaultAgentFromState(agents: SubagentSummary[]): SubagentSummary | undefined {
  return agents.find((agent) => agent.isDefault);
}

function assertMutableAgent(agentId: string, agents: SubagentSummary[]): void {
  const defaultAgent = resolveDefaultAgentFromState(agents);
  if (defaultAgent && defaultAgent.id === agentId) {
    throw new Error('Default agent is read-only');
  }
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

function isLikelyEmojiToken(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 16) {
    return false;
  }
  let hasNonAscii = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return false;
  }
  if (text.includes('://') || text.includes('/') || text.includes('.')) {
    return false;
  }
  return true;
}

function resolveIdentityEmojiFromAgentMeta(agent: SubagentSummary): string | undefined {
  const directEmoji = getOptionalString((agent as { emoji?: unknown }).emoji);
  if (directEmoji && isLikelyEmojiToken(directEmoji)) {
    return directEmoji;
  }
  const nestedEmoji = getOptionalString((agent as { identity?: { emoji?: unknown } }).identity?.emoji);
  if (nestedEmoji && isLikelyEmojiToken(nestedEmoji)) {
    return nestedEmoji;
  }
  const directAvatar = getOptionalString((agent as { avatar?: unknown }).avatar);
  if (directAvatar && isLikelyEmojiToken(directAvatar)) {
    return directAvatar;
  }
  const nestedAvatar = getOptionalString((agent as { identity?: { avatar?: unknown } }).identity?.avatar);
  if (nestedAvatar && isLikelyEmojiToken(nestedAvatar)) {
    return nestedAvatar;
  }
  return undefined;
}

async function fetchIdentityEmojiFromAgentIdentity(agentId: string): Promise<string | undefined> {
  try {
    const result = await rpc<AgentIdentityGetResult>('agent.identity.get', {
      agentId,
    });
    const emoji = getOptionalString(result?.emoji);
    if (emoji && isLikelyEmojiToken(emoji)) {
      return emoji;
    }
    const avatar = getOptionalString(result?.avatar);
    if (avatar && isLikelyEmojiToken(avatar)) {
      return avatar;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface IdentityEmojiCacheEntry {
  checkedAt: number;
  emoji?: string;
}

const identityEmojiCache = new Map<string, IdentityEmojiCacheEntry>();
const identityEmojiLoadTasks = new Map<string, Promise<string | undefined>>();

function readIdentityEmojiFromCache(agentId: string): string | undefined | null {
  const entry = identityEmojiCache.get(agentId);
  if (!entry) {
    return null;
  }
  if ((Date.now() - entry.checkedAt) > IDENTITY_EMOJI_CACHE_TTL_MS) {
    identityEmojiCache.delete(agentId);
    return null;
  }
  return entry.emoji;
}

async function resolveIdentityEmojiWithCache(agentId: string): Promise<string | undefined> {
  const cached = readIdentityEmojiFromCache(agentId);
  if (cached !== null) {
    return cached;
  }
  const existingTask = identityEmojiLoadTasks.get(agentId);
  if (existingTask) {
    return existingTask;
  }
  const task = fetchIdentityEmojiFromAgentIdentity(agentId)
    .then((emoji) => {
      identityEmojiCache.set(agentId, {
        checkedAt: Date.now(),
        emoji,
      });
      return emoji;
    })
    .finally(() => {
      identityEmojiLoadTasks.delete(agentId);
    });
  identityEmojiLoadTasks.set(agentId, task);
  return task;
}

async function hydrateAgentIdentityEmoji(agents: SubagentSummary[]): Promise<SubagentSummary[]> {
  const hydrated = await Promise.all(agents.map(async (agent) => {
    const fromMeta = resolveIdentityEmojiFromAgentMeta(agent);
    if (fromMeta) {
      identityEmojiCache.set(agent.id, {
        checkedAt: Date.now(),
        emoji: fromMeta,
      });
      return {
        ...agent,
        identityEmoji: fromMeta,
      };
    }
    const fromIdentity = await resolveIdentityEmojiWithCache(agent.id);
    if (!fromIdentity) {
      return agent;
    }
    return {
      ...agent,
      identityEmoji: fromIdentity,
    };
  }));
  return hydrated;
}

async function removeRoleMetadataForAgent(agentId: string, agents: SubagentSummary[]): Promise<void> {
  if (agents.length === 0) {
    return;
  }
  try {
    const root = resolveRolesMetadataRoot(agents);
    const current = await readRolesMetadata(root).catch(() => []);
    if (!current.some((entry) => entry.agentId === agentId)) {
      return;
    }
    const next = current.filter((entry) => entry.agentId !== agentId);
    await writeRolesMetadata(root, next);
  } catch {
    // ROLES_METADATA is auxiliary; avoid blocking core agent flows.
  }
}

async function syncRoleMetadataFromAgents(agents: SubagentSummary[]): Promise<void> {
  if (agents.length === 0) {
    return;
  }
  try {
    const root = resolveRolesMetadataRoot(agents);
    const current = await readRolesMetadata(root).catch(() => []);
    const next = mergeRolesFromAgents(current, agents);
    await writeRolesMetadata(root, next);
  } catch {
    // ROLES_METADATA is auxiliary; avoid blocking core agent flows.
  }
}

async function upsertRoleMetadataFromDraft(
  agentId: string,
  roleMetadata: SubagentDraftRoleMetadata,
  agents: SubagentSummary[],
): Promise<void> {
  if (agents.length === 0) {
    return;
  }
  try {
    const root = resolveRolesMetadataRoot(agents);
    const current = await readRolesMetadata(root).catch(() => []);
    const merged = mergeRolesFromAgents(current, agents);
    const nowIso = new Date().toISOString();
    const next = merged.map((entry) => {
      if (entry.agentId !== agentId) {
        return entry;
      }
      return {
        ...entry,
        summary: roleMetadata.summary,
        tags: roleMetadata.tags,
        updatedAt: nowIso,
      };
    });
    await writeRolesMetadata(root, next);
  } catch {
    // ROLES_METADATA is auxiliary; avoid blocking core agent flows.
  }
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
let agentsStateMutationVersion = 0;
let agentMutationChain: Promise<void> = Promise.resolve();
const CONFIG_CHANGED_REFRESH_DEBOUNCE_MS = 180;
let subagentsConfigChangedListenerBound = false;
let subagentsConfigChangedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let subagentsConfigChangedRefreshTask: Promise<void> | null = null;
let latestHandledConfigRevision = 0;
const pendingDeletedAgentIds = new Set<string>();

function bumpAgentsStateMutationVersion(): number {
  agentsStateMutationVersion += 1;
  return agentsStateMutationVersion;
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

function parseConfigChangedRevision(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const revision = (payload as ConfigChangedPayload).revision;
  if (typeof revision !== 'number' || !Number.isFinite(revision) || revision <= 0) {
    return null;
  }
  return revision;
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

function scheduleConfigChangedDrivenRefresh(getState: () => SubagentsState): void {
  if (subagentsConfigChangedRefreshTimer) {
    clearTimeout(subagentsConfigChangedRefreshTimer);
  }
  subagentsConfigChangedRefreshTimer = setTimeout(() => {
    subagentsConfigChangedRefreshTimer = null;
    if (subagentsConfigChangedRefreshTask) {
      return;
    }
    subagentsConfigChangedRefreshTask = (async () => {
      const state = getState();
      await state.loadAgents();
      await getState().loadAvailableModels();
    })().finally(() => {
      subagentsConfigChangedRefreshTask = null;
    });
  }, CONFIG_CHANGED_REFRESH_DEBOUNCE_MS);
}

function bindSubagentsConfigChangedListener(getState: () => SubagentsState): void {
  if (subagentsConfigChangedListenerBound) {
    return;
  }
  if (typeof window === 'undefined' || !window.electron?.ipcRenderer?.on) {
    return;
  }
  window.electron.ipcRenderer.on('config:changed', (payload: unknown) => {
    const revision = parseConfigChangedRevision(payload);
    if (revision != null) {
      if (revision <= latestHandledConfigRevision) {
        return;
      }
      latestHandledConfigRevision = revision;
    }
    scheduleConfigChangedDrivenRefresh(getState);
  });
  subagentsConfigChangedListenerBound = true;
}

export const useSubagentsStore = create<SubagentsState>((set, get) => ({
  agents: [],
  availableModels: [],
  modelsLoading: false,
  loading: false,
  error: null,
  managedAgentId: null,
  draftPromptByAgent: {},
  draftGeneratingByAgent: {},
  draftApplyingByAgent: {},
  draftApplySuccessByAgent: {},
  draftSessionKeyByAgent: {},
  draftRawOutputByAgent: {},
  draftRoleMetadataByAgent: {},
  persistedFilesByAgent: {},
  draftByFile: {},
  draftError: null,
  previewDiffByFile: {},
  selectedAgentId: null,

  bindConfigChangedListener: () => {
    bindSubagentsConfigChangedListener(get);
  },

  loadAgents: async () => {
    bindSubagentsConfigChangedListener(get);
    const requestId = ++latestLoadAgentsRequestId;
    set({ loading: true, error: null });
    try {
      const result = await rpc<AgentsListResult>('agents.list', {});
      settlePendingDeletedAgentIds(collectRuntimeAgentIdSet(result));
      let cfg: ConfigGetResult | undefined;
      try {
        cfg = await readConfigForDisplay();
      } catch {
        cfg = undefined;
      }
      const normalizedAgents = filterOutPendingDeletedAgents(normalizeAgents(result, cfg));
      if (requestId !== latestLoadAgentsRequestId) {
        return;
      }
      const selectedAgentId = get().selectedAgentId;
      const hasSelected = selectedAgentId && normalizedAgents.some((agent) => agent.id === selectedAgentId);
      const managedAgentId = get().managedAgentId;
      const hasManaged = managedAgentId && normalizedAgents.some((agent) => agent.id === managedAgentId);
      const hydrationSourceVersion = bumpAgentsStateMutationVersion();

      set({
        agents: normalizedAgents,
        selectedAgentId: hasSelected ? selectedAgentId : (normalizedAgents[0]?.id ?? null),
        managedAgentId: hasManaged ? managedAgentId : null,
        error: null,
        loading: false,
      });

      void hydrateAgentIdentityEmoji(normalizedAgents)
        .then((hydratedAgents) => {
          if (requestId !== latestLoadAgentsRequestId) {
            return;
          }
          const emojiByAgentId = new Map<string, string>();
          for (const agent of hydratedAgents) {
            const emoji = getOptionalString(agent.identityEmoji);
            if (!emoji) {
              continue;
            }
            emojiByAgentId.set(agent.id, emoji);
          }
          set((state) => {
            if (requestId !== latestLoadAgentsRequestId) {
              return {};
            }
            if (agentsStateMutationVersion !== hydrationSourceVersion) {
              return {};
            }
            let changed = false;
            const nextAgents = state.agents.map((agent) => {
              const nextEmoji = emojiByAgentId.get(agent.id);
              if (!nextEmoji || nextEmoji === agent.identityEmoji || isAgentPendingDeletion(agent.id)) {
                return agent;
              }
              changed = true;
              return {
                ...agent,
                identityEmoji: nextEmoji,
              };
            });
            if (!changed) {
              return {};
            }
            bumpAgentsStateMutationVersion();
            return {
              agents: nextAgents,
            };
          });
        })
        .catch(() => {
          // identity hydration is best-effort; keep core list path deterministic.
        });
    } catch (error) {
      if (requestId !== latestLoadAgentsRequestId) {
        return;
      }
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load subagents',
      });
    }
  },

  loadAvailableModels: async (cfg) => {
    set({ modelsLoading: true });
    try {
      const result = cfg ?? await readConfigForDisplay();
      if (!result) {
        throw new Error('Failed to load config snapshot');
      }
      set({
        availableModels: normalizeConfiguredModelsFromConfig(result),
        modelsLoading: false,
        error: null,
      });
    } catch (error) {
      set({
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
    assertMutableAgent(agentId, get().agents);
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
        const nextRoleMetadataByAgent = { ...state.draftRoleMetadataByAgent };
        delete nextRoleMetadataByAgent[agentId];
        return {
          draftByFile: {},
          previewDiffByFile: {},
          draftError: null,
          draftPromptByAgent: nextPromptByAgent,
          draftRawOutputByAgent: nextRawOutputByAgent,
          draftRoleMetadataByAgent: nextRoleMetadataByAgent,
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

  createAgent: async ({ name, workspace, model, emoji }) => runSerializedAgentMutation(async () => {
    set({ loading: true, error: null });
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
      const predictedAgentId = normalizeAgentIdForComparison(trimmedName);
      if (predictedAgentId) {
        pendingDeletedAgentIds.delete(predictedAgentId);
      }
      const emojiValue = getOptionalString(emoji);
      if (hasSubagentNameConflict(trimmedName, get().agents)) {
        throw new Error('Invalid subagent name: duplicate');
      }
      const resolvedWorkspace = buildSubagentWorkspacePath({
        name: trimmedName,
        agents: get().agents,
      });
      const createResult = await rpc<AgentsCreateResult>('agents.create', {
        name: trimmedName,
        workspace: resolvedWorkspace,
        ...(emojiValue ? { emoji: emojiValue } : {}),
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
      } catch {
        partialFailureMessage = `智能体 "${createdAgentId}" 已创建，但模型配置写入失败，请在编辑中重新选择模型`;
      }
      await get().loadAgents();
      await syncRoleMetadataFromAgents(get().agents);
      if (partialFailureMessage) {
        set({ error: partialFailureMessage });
      }
      return createdAgentId;
    } catch (error) {
      const message = getErrorMessage(error) || 'Failed to create subagent';
      set({
        loading: false,
        error: message,
      });
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(message, { cause: error });
    }
  }),

  updateAgent: async ({ agentId, name, workspace, model }) => runSerializedAgentMutation(async () => {
    const current = get().agents.find((agent) => agent.id === agentId);
    if (
      current
      && equalOptionalTrimmedString(current.name, name)
      && equalOptionalTrimmedString(current.workspace, workspace)
      && equalOptionalTrimmedString(current.model, model)
    ) {
      return;
    }

    const nextName = name.trim();
    const nextWorkspace = workspace.trim();
    const nextModel = getOptionalString(model);

    set({ loading: true, error: null });
    try {
      assertMutableAgent(agentId, get().agents);
      await rpc('agents.update', {
        agentId,
        name: nextName,
        workspace: nextWorkspace,
        model: nextModel,
      });
      await get().loadAgents();
      await syncRoleMetadataFromAgents(get().agents);
    } catch (error) {
      set({
        loading: false,
        error: getErrorMessage(error) || 'Failed to update subagent',
      });
    }
  }),

  deleteAgent: async (agentId) => runSerializedAgentMutation(async () => {
    try {
      assertMutableAgent(agentId, get().agents);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete subagent',
      });
      return;
    }

    set({ loading: true, error: null });
    const agentsSnapshot = get().agents;
    const selectedAgentIdSnapshot = get().selectedAgentId;
    const managedAgentIdSnapshot = get().managedAgentId;
    try {
      const normalizedAgentId = normalizeAgentIdForComparison(agentId);
      if (normalizedAgentId) {
        pendingDeletedAgentIds.add(normalizedAgentId);
      }
      bumpAgentsStateMutationVersion();
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
      await removeRoleMetadataForAgent(agentId, agentsSnapshot);
      set({ loading: false, error: null });
    } catch (error) {
      const normalizedAgentId = normalizeAgentIdForComparison(agentId);
      if (normalizedAgentId) {
        pendingDeletedAgentIds.delete(normalizedAgentId);
      }
      bumpAgentsStateMutationVersion();
      set({
        agents: agentsSnapshot,
        selectedAgentId: selectedAgentIdSnapshot,
        managedAgentId: managedAgentIdSnapshot,
        loading: false,
        error: getErrorMessage(error) || 'Failed to delete subagent',
      });
    }
  }),

  generateDraftFromPrompt: async (agentId, prompt) => {
    assertMutableAgent(agentId, get().agents);
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
    set((state) => ({
      loading: true,
      error: null,
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
      let roleMetadata: SubagentDraftRoleMetadata;
      try {
        const parsedDraft = parseDraftPayload(outputText);
        draftByFile = parsedDraft.draftByFile;
        roleMetadata = parsedDraft.roleMetadata;
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
          '严格使用结构：{"files":[{"name","content","reason","confidence"}],"roleMetadata":{"summary","tags"}}。',
          'roleMetadata.summary 必填。',
          'roleMetadata.tags 必填，至少 3 个短标签。',
          'content 内不要使用 ``` 代码块；若有双引号必须转义为 \\\\"。',
          '请精简内容，确保 5 个文件都完整闭合后再输出。',
        ].join('\n');
        outputText = await sendDraftMessage(retryMessage);
        lastModelOutput = outputText;
        const parsedDraft = parseDraftPayload(outputText);
        draftByFile = parsedDraft.draftByFile;
        roleMetadata = parsedDraft.roleMetadata;
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
        draftRoleMetadataByAgent: {
          ...state.draftRoleMetadataByAgent,
          [agentId]: roleMetadata,
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
          loading: false,
          draftGeneratingByAgent: nextDraftGeneratingByAgent,
        };
      });
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
    assertMutableAgent(agentId, get().agents);
    const draftEntries = Object.entries(get().draftByFile)
      .filter(([, draft]) => draft && !draft.needsReview) as [SubagentTargetFile, NonNullable<DraftByFile[SubagentTargetFile]>][];

    if (draftEntries.length === 0) {
      throw new Error('No approved draft content to apply');
    }

    const roleMetadata = get().draftRoleMetadataByAgent[agentId];
    if (!roleMetadata) {
      throw new Error('Missing role metadata in draft; please regenerate draft');
    }

    set((state) => ({
      loading: true,
      error: null,
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
      await get().loadAgents();
      await upsertRoleMetadataFromDraft(agentId, roleMetadata, get().agents);
      set((state) => ({
        loading: false,
        draftByFile: {},
        previewDiffByFile: {},
        draftError: null,
        draftApplyingByAgent: {
          ...state.draftApplyingByAgent,
          [agentId]: false,
        },
        draftRoleMetadataByAgent: {
          ...state.draftRoleMetadataByAgent,
          [agentId]: undefined,
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
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to apply draft',
        draftApplyingByAgent: {
          ...state.draftApplyingByAgent,
          [agentId]: false,
        },
      }));
      throw error;
    }
  },
}));
