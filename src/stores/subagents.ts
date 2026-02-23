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
  loadAgents: () => Promise<void>;
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
    emoji?: string;
  }) => Promise<void>;
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

function resolveDefaultAgentId(
  result: AgentsListResult,
  cfg?: ConfigGetResult,
): string {
  if (result.agents.some((agent) => agent.id === MAIN_AGENT_ID)) {
    return MAIN_AGENT_ID;
  }

  const configList = cfg?.config?.agents?.list ?? [];
  if (configList.some((agent) => getOptionalString(agent?.id) === MAIN_AGENT_ID)) {
    return MAIN_AGENT_ID;
  }

  const fromResult = getOptionalString(result.defaultId);
  if (fromResult) {
    return fromResult;
  }
  const explicitDefault = configList.find((agent) => agent?.default === true);
  const explicitDefaultId = getOptionalString(explicitDefault?.id);
  if (explicitDefaultId) {
    return explicitDefaultId;
  }
  const firstConfigId = getOptionalString(configList[0]?.id);
  return firstConfigId || MAIN_AGENT_ID;
}

function normalizeAgents(result: AgentsListResult, cfg?: ConfigGetResult): SubagentSummary[] {
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
  const defaultsWorkspace = getOptionalString(cfg?.config?.agents?.defaults?.workspace);
  const defaultsModel = extractModelId(cfg?.config?.agents?.defaults?.model);

  return result.agents.map((agent) => {
    const configEntry = configById.get(agent.id);
    const workspace = getOptionalString(agent.workspace)
      ?? getOptionalString(configEntry?.workspace)
      ?? (agent.id === MAIN_AGENT_ID ? defaultsWorkspace : undefined);
    const model = getOptionalString(agent.model)
      ?? extractModelId(configEntry?.model)
      ?? (agent.id === MAIN_AGENT_ID ? defaultsModel : undefined);
    return {
      ...agent,
      workspace,
      model,
      isDefault: agent.isDefault ?? (agent.id === defaultId),
    };
  });
}

function assertMutableAgent(agentId: string): void {
  if (agentId === MAIN_AGENT_ID) {
    throw new Error('Main agent is read-only');
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseProviderFromModelId(modelId: string): string | undefined {
  const idx = modelId.indexOf('/');
  if (idx <= 0) {
    return undefined;
  }
  return modelId.slice(0, idx);
}

function collectConfiguredModel(
  modelsById: Map<string, ModelCatalogEntry>,
  rawModelId: unknown,
  providerHint?: string,
): void {
  if (typeof rawModelId !== 'string') {
    return;
  }
  const trimmed = rawModelId.trim();
  if (!trimmed) {
    return;
  }
  const modelId = providerHint
    ? (trimmed.startsWith(`${providerHint}/`) ? trimmed : `${providerHint}/${trimmed}`)
    : trimmed;
  if (modelsById.has(modelId)) {
    return;
  }
  modelsById.set(modelId, {
    id: modelId,
    provider: providerHint ?? parseProviderFromModelId(modelId),
  });
}

function collectConfiguredModelValue(
  modelsById: Map<string, ModelCatalogEntry>,
  value: unknown,
  providerHint?: string,
): void {
  if (typeof value === 'string') {
    collectConfiguredModel(modelsById, value, providerHint);
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const model = value as { primary?: unknown; fallbacks?: unknown };
  collectConfiguredModel(modelsById, model.primary, providerHint);
  if (!Array.isArray(model.fallbacks)) {
    return;
  }
  for (const fallback of model.fallbacks) {
    collectConfiguredModel(modelsById, fallback, providerHint);
  }
}

function normalizeConfiguredModelsFromConfig(result: ConfigGetResult): ModelCatalogEntry[] {
  const modelsById = new Map<string, ModelCatalogEntry>();

  collectConfiguredModelValue(modelsById, result.config?.agents?.defaults?.model);

  const agentList = result.config?.agents?.list ?? [];
  for (const agent of agentList) {
    collectConfiguredModelValue(modelsById, agent?.model);
  }

  const providers = result.config?.models?.providers;
  if (providers && typeof providers === 'object') {
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      if (!providerConfig || typeof providerConfig !== 'object') {
        continue;
      }
      const modelList = (providerConfig as { models?: unknown }).models;
      if (!Array.isArray(modelList)) {
        continue;
      }
      for (const entry of modelList) {
        if (typeof entry === 'string') {
          collectConfiguredModel(modelsById, entry, providerId);
          continue;
        }
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        collectConfiguredModel(modelsById, (entry as { id?: unknown }).id, providerId);
      }
    }
  }

  return Array.from(modelsById.values())
    .sort((a, b) => a.id.localeCompare(b.id));
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

async function hydrateAgentIdentityEmoji(agents: SubagentSummary[]): Promise<SubagentSummary[]> {
  const hydrated = await Promise.all(agents.map(async (agent) => {
    const fromMeta = resolveIdentityEmojiFromAgentMeta(agent);
    if (fromMeta) {
      return {
        ...agent,
        identityEmoji: fromMeta,
      };
    }
    const fromIdentity = await fetchIdentityEmojiFromAgentIdentity(agent.id);
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

  loadAgents: async () => {
    set({ loading: true, error: null });
    try {
      const result = await rpc<AgentsListResult>('agents.list');
      let cfg: ConfigGetResult | undefined;
      try {
        cfg = await rpc<ConfigGetResult>('config.get', {});
      } catch {
        cfg = undefined;
      }
      const normalizedAgents = normalizeAgents(result, cfg);
      const agents = await hydrateAgentIdentityEmoji(normalizedAgents);
      const selectedAgentId = get().selectedAgentId;
      const hasSelected = selectedAgentId && agents.some((agent) => agent.id === selectedAgentId);
      const managedAgentId = get().managedAgentId;
      const hasManaged = managedAgentId && agents.some((agent) => agent.id === managedAgentId);

      set({
        agents,
        selectedAgentId: hasSelected ? selectedAgentId : (agents[0]?.id ?? null),
        managedAgentId: hasManaged ? managedAgentId : null,
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load subagents',
      });
    }
  },

  loadAvailableModels: async () => {
    set({ modelsLoading: true });
    try {
      const result = await rpc<ConfigGetResult>('config.get', {});
      set({
        availableModels: normalizeConfiguredModelsFromConfig(result),
        modelsLoading: false,
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
    assertMutableAgent(agentId);
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

  createAgent: async ({ name, workspace, model, emoji }) => {
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
      const emojiValue = getOptionalString(emoji);
      if (hasSubagentNameConflict(trimmedName, get().agents)) {
        throw new Error('Invalid subagent name: duplicate');
      }
      const agentId = normalizeSubagentNameToSlug(trimmedName);
      const resolvedWorkspace = buildSubagentWorkspacePath({
        name: trimmedName,
        agents: get().agents,
      });
      await rpc('agents.create', {
        name: trimmedName,
        workspace: resolvedWorkspace,
        ...(emojiValue ? { emoji: emojiValue } : {}),
      });
      await rpc('agents.update', {
        agentId,
        model: modelId,
      });
      await get().loadAgents();
      await syncRoleMetadataFromAgents(get().agents);
    } catch (error) {
      set({
        loading: false,
        error: getErrorMessage(error) || 'Failed to create subagent',
      });
    }
  },

  updateAgent: async ({ agentId, name, workspace, model }) => {
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
      assertMutableAgent(agentId);
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
  },

  deleteAgent: async (agentId) => {
    try {
      assertMutableAgent(agentId);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete subagent',
      });
      return;
    }

    set({ loading: true, error: null });
    try {
      const agentsSnapshot = get().agents;
      await rpc('agents.delete', { agentId, deleteFiles: true });
      await removeRoleMetadataForAgent(agentId, agentsSnapshot);
      await get().loadAgents();
    } catch (error) {
      set({
        loading: false,
        error: getErrorMessage(error) || 'Failed to delete subagent',
      });
    }
  },

  generateDraftFromPrompt: async (agentId, prompt) => {
    assertMutableAgent(agentId);
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
      throw new Error(message);
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
    assertMutableAgent(agentId);
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


