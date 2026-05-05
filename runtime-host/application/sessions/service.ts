import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  SessionAssistantTurnItem,
  SessionCatalogItem,
  SessionCatalogKind,
  SessionExecutionGraphItem,
  SessionLoadResult,
  SessionListResult,
  SessionNewResult,
  SessionPromptResult,
  SessionRenderItem,
  SessionRenderTaskCompletionItem,
  SessionRenderUserMessageItem,
  SessionRuntimeStateSnapshot,
  SessionStateSnapshot,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
  SessionUpdateEvent,
  SessionWindowStateSnapshot,
  SessionWindowResult,
} from '../../shared/session-adapter-types';
import {
  buildTimelineEntriesFromTranscriptMessage,
  materializeTranscriptTimelineEntries,
  materializeTranscriptToolResultPatchEntries,
  parseTranscriptMessages,
  resolveSessionLabelDetailsFromTimelineEntries,
  type SessionTranscriptMessage,
} from './transcript-utils';
import {
  assembleAuthoritativeAssistantTurns,
  resolveAssistantTurnItemKeyFromTimelineEntry,
} from './assistant-turn-assembler';
import {
  attachExecutionGraphReply,
  createExecutionGraphItem,
  deriveExecutionGraphSteps,
  isTaskCompletionEntry,
  updateExecutionGraphChildSteps,
  updateExecutionGraphMainSteps,
} from './execution-graphs';
import { buildSessionUpdateEventsFromGatewayConversationEvent } from './gateway-ingress';
import {
  findTimelineEntryIndex,
  mergeTimelineEntries,
  resolveTimelineLastActivityAt,
  upsertTimelineEntry,
} from './timeline-state';
import {
  normalizeSendWithMediaInput,
  sendWithMediaViaOpenClawBridge,
} from '../chat/send-media';

interface SessionRuntimeServiceDeps {
  getOpenClawConfigDir: () => string;
  resolveDeletedPath?: (path: string) => string;
  openclawBridge: {
    chatSend: (params: Record<string, unknown>) => Promise<unknown>;
  };
}

interface SessionNewPayload {
  sessionKey?: unknown;
  agentId?: unknown;
  canonicalPrefix?: unknown;
}

interface SessionLoadPayload {
  sessionKey?: unknown;
}

interface SessionDeletePayload {
  sessionKey?: unknown;
}

type SessionWindowMode = 'latest' | 'older' | 'newer';

interface SessionWindowPayload {
  sessionKey?: unknown;
  mode?: unknown;
  limit?: unknown;
  offset?: unknown;
  includeCanonical?: unknown;
}

interface SessionPromptPayload {
  sessionKey?: unknown;
  message?: unknown;
  deliver?: unknown;
  runId?: unknown;
  promptId?: unknown;
  idempotencyKey?: unknown;
  media?: unknown;
}

interface SessionAbortRuntimePayload {
  sessionKey?: unknown;
}

interface SessionPromptMediaPayload {
  filePath: string;
  mimeType: string;
  fileName: string;
  fileSize?: number;
  preview?: string | null;
}

interface SessionRuntimeTimelineState {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionExecutionGraphItem[];
  renderItems: SessionRenderItem[];
  hydrated: boolean;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
}

interface SessionStorageDescriptor {
  sessionKey: string;
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string | null;
  sessionsJson: Record<string, unknown> | null;
  transcriptPath: string | null;
}

interface PersistedSessionRuntimeStoreFile {
  version: 3;
  activeSessionKey: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeWindowMode(value: unknown): SessionWindowMode {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'older' || normalized === 'newer') {
    return normalized;
  }
  return 'latest';
}

function normalizeWindowLimit(value: unknown): number {
  const parsed = normalizeFiniteNumber(value);
  if (parsed == null) {
    return 80;
  }
  return Math.min(Math.max(Math.floor(parsed), 0), 200);
}

function normalizeWindowOffset(value: unknown): number | null {
  const parsed = normalizeFiniteNumber(value);
  if (parsed == null) {
    return null;
  }
  return Math.max(Math.floor(parsed), 0);
}

function normalizeIncludeCanonical(value: unknown): boolean {
  return value === true;
}

function createEmptySessionRuntimeState(): SessionRuntimeStateSnapshot {
  return {
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    pendingFinal: false,
    lastUserMessageAt: null,
    updatedAt: null,
  };
}

function createWindowStateSnapshot(input: {
  totalItemCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}): SessionWindowStateSnapshot {
  return {
    totalItemCount: input.totalItemCount,
    windowStartOffset: input.windowStartOffset,
    windowEndOffset: input.windowEndOffset,
    hasMore: input.hasMore,
    hasNewer: input.hasNewer,
    isAtLatest: input.isAtLatest,
  };
}

function createLatestWindowState(totalItemCount: number): SessionWindowStateSnapshot {
  return createWindowStateSnapshot({
    totalItemCount,
    windowStartOffset: 0,
    windowEndOffset: totalItemCount,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  });
}

function createEmptyTimelineState(
  patch: Partial<SessionRuntimeTimelineState> = {},
): SessionRuntimeTimelineState {
  return {
    sessionKey: '',
    timelineEntries: [],
    executionGraphItems: [],
    renderItems: [],
    hydrated: false,
    runtime: createEmptySessionRuntimeState(),
    window: createLatestWindowState(0),
    ...patch,
  };
}

function cloneSessionRuntimeState(runtime: SessionRuntimeStateSnapshot): SessionRuntimeStateSnapshot {
  return { ...runtime };
}

function cloneSessionWindowState(window: SessionWindowStateSnapshot): SessionWindowStateSnapshot {
  return { ...window };
}

function cloneRenderItems(items: SessionRenderItem[]): SessionRenderItem[] {
  return structuredClone(items);
}

function isAssistantTimelineEntry(
  entry: SessionTimelineEntry,
): entry is SessionTimelineMessageEntry | SessionTimelineToolActivityEntry {
  return entry.role === 'assistant' && (entry.kind === 'message' || entry.kind === 'tool-activity');
}

function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function parseSessionKeyAgent(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) {
    return null;
  }
  const parts = sessionKey.split(':');
  const agentId = parts[1]?.trim();
  return agentId || null;
}

function readSessionKeySuffix(sessionKey: string): string {
  const parts = sessionKey.split(':');
  return parts.length >= 3 ? parts.slice(2).join(':') : sessionKey;
}

function resolveSessionCatalogKind(sessionKey: string): SessionCatalogKind {
  const suffix = readSessionKeySuffix(sessionKey).trim().toLowerCase();
  if (suffix === 'main') {
    return 'main';
  }
  if (suffix.startsWith('subagent:')) {
    return 'subsession';
  }
  if (/^session-\d{8,16}$/i.test(suffix)) {
    return 'session';
  }
  return 'named';
}

function buildSessionCatalogItem(input: {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
}): SessionCatalogItem {
  const agentId = parseSessionKeyAgent(input.sessionKey) ?? 'main';
  const label = resolveSessionLabelDetailsFromTimelineEntries(input.timelineEntries);
  const updatedAt = resolveTimelineLastActivityAt(input.timelineEntries, input.runtime);
  const kind = resolveSessionCatalogKind(input.sessionKey);
  return {
    key: input.sessionKey,
    agentId,
    kind,
    preferred: kind === 'main',
    ...(label.label ? { label: label.label } : {}),
    ...(label.titleSource !== 'none' ? { titleSource: label.titleSource } : {}),
    displayName: input.sessionKey,
    ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
  };
}

function resolveIndexedTranscriptPath(
  entry: Record<string, unknown>,
  sessionsDir: string,
): string | null {
  const indexedPath = entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path;
  if (typeof indexedPath === 'string' && indexedPath.trim()) {
    const normalizedPath = indexedPath.trim();
    if (isAbsolutePath(normalizedPath)) {
      return normalizedPath;
    }
    const normalizedFileName = normalizedPath.endsWith('.jsonl') ? normalizedPath : `${normalizedPath}.jsonl`;
    return join(sessionsDir, normalizedFileName);
  }

  const sessionId = entry.id ?? entry.sessionId;
  if (typeof sessionId === 'string' && sessionId.trim()) {
    const normalizedFileName = sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`;
    return join(sessionsDir, normalizedFileName);
  }

  return null;
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listAgentStorageDescriptors(input: {
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string;
  sessionsJson: Record<string, unknown>;
}): SessionStorageDescriptor[] {
  const descriptors: SessionStorageDescriptor[] = [];

  if (Array.isArray(input.sessionsJson.sessions)) {
    for (const candidate of input.sessionsJson.sessions) {
      if (!isRecord(candidate)) {
        continue;
      }
      const sessionKey = normalizeString(candidate.key ?? candidate.sessionKey);
      if (!sessionKey) {
        continue;
      }
      descriptors.push({
        sessionKey,
        agentId: input.agentId,
        sessionsDir: input.sessionsDir,
        sessionsJsonPath: input.sessionsJsonPath,
        sessionsJson: input.sessionsJson,
        transcriptPath: resolveIndexedTranscriptPath(candidate, input.sessionsDir),
      });
    }
    return descriptors;
  }

  for (const [sessionKey, value] of Object.entries(input.sessionsJson)) {
    if (!sessionKey.startsWith('agent:')) {
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      const normalizedFileName = value.endsWith('.jsonl') ? value : `${value}.jsonl`;
      descriptors.push({
        sessionKey,
        agentId: input.agentId,
        sessionsDir: input.sessionsDir,
        sessionsJsonPath: input.sessionsJsonPath,
        sessionsJson: input.sessionsJson,
        transcriptPath: join(input.sessionsDir, normalizedFileName),
      });
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    descriptors.push({
      sessionKey,
      agentId: input.agentId,
      sessionsDir: input.sessionsDir,
      sessionsJsonPath: input.sessionsJsonPath,
      sessionsJson: input.sessionsJson,
      transcriptPath: resolveIndexedTranscriptPath(value, input.sessionsDir),
    });
  }

  return descriptors;
}

function normalizeTranscriptFileName(fileName: string): string | null {
  const normalized = normalizeString(fileName);
  if (!normalized.endsWith('.jsonl') || normalized.endsWith('.deleted.jsonl')) {
    return null;
  }
  return normalized;
}

function buildFallbackSessionKey(agentId: string, transcriptFileName: string): string {
  const suffix = transcriptFileName.slice(0, -'.jsonl'.length);
  return `agent:${agentId}:${suffix}`;
}

function listTranscriptStorageDescriptors(input: {
  agentId: string;
  sessionsDir: string;
  sessionsJsonPath: string | null;
  sessionsJson: Record<string, unknown> | null;
  indexedDescriptors?: readonly SessionStorageDescriptor[];
}): SessionStorageDescriptor[] {
  if (!existsSync(input.sessionsDir)) {
    return [];
  }

  const indexedTranscriptPaths = new Set(
    (input.indexedDescriptors ?? [])
      .map((descriptor) => normalizeString(descriptor.transcriptPath))
      .filter((path): path is string => path.length > 0),
  );
  const descriptors: SessionStorageDescriptor[] = [];

  for (const entry of readdirSync(input.sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const transcriptFileName = normalizeTranscriptFileName(entry.name);
    if (!transcriptFileName) {
      continue;
    }
    const transcriptPath = join(input.sessionsDir, transcriptFileName);
    if (indexedTranscriptPaths.has(transcriptPath)) {
      continue;
    }
    descriptors.push({
      sessionKey: buildFallbackSessionKey(input.agentId, transcriptFileName),
      agentId: input.agentId,
      sessionsDir: input.sessionsDir,
      sessionsJsonPath: input.sessionsJsonPath,
      sessionsJson: input.sessionsJson,
      transcriptPath,
    });
  }

  return descriptors;
}

function pruneStorageIndex(
  sessionsJson: Record<string, unknown>,
  sessionKey: string,
): Record<string, unknown> {
  if (Array.isArray(sessionsJson.sessions)) {
    return {
      ...sessionsJson,
      sessions: sessionsJson.sessions.filter((candidate) => {
        if (!isRecord(candidate)) {
          return true;
        }
        const candidateKey = normalizeString(candidate.key ?? candidate.sessionKey);
        return candidateKey !== sessionKey;
      }),
    };
  }

  return Object.fromEntries(
    Object.entries(sessionsJson).filter(([candidateKey]) => candidateKey !== sessionKey),
  );
}

function clampWindowState(
  window: SessionWindowStateSnapshot,
  totalItemCount: number,
): SessionWindowStateSnapshot {
  const start = Math.max(0, Math.min(window.windowStartOffset, totalItemCount));
  const end = Math.max(start, Math.min(window.windowEndOffset, totalItemCount));
  return createWindowStateSnapshot({
    totalItemCount,
    windowStartOffset: start,
    windowEndOffset: end,
    hasMore: start > 0,
    hasNewer: end < totalItemCount,
    isAtLatest: end >= totalItemCount,
  });
}

function shouldExposeRuntimeOnlySession(runtime: SessionRuntimeStateSnapshot): boolean {
  return typeof runtime.updatedAt === 'number';
}

function buildWindowRange(input: {
  totalItemCount: number;
  mode: SessionWindowMode;
  limit: number;
  offset: number | null;
}): { start: number; end: number } {
  const { totalItemCount, mode, limit, offset } = input;
  if (mode === 'older') {
    const anchor = Math.min(Math.max(offset ?? totalItemCount, 0), totalItemCount);
    return {
      start: Math.max(0, anchor - limit),
      end: Math.min(totalItemCount, anchor + limit),
    };
  }
  if (mode === 'newer') {
    const start = Math.min(Math.max(offset ?? totalItemCount, 0), totalItemCount);
    return {
      start,
      end: Math.min(totalItemCount, start + limit),
    };
  }
  return {
    start: Math.max(0, totalItemCount - limit),
    end: totalItemCount,
  };
}

function sortExecutionGraphItems(graphs: SessionExecutionGraphItem[]): SessionExecutionGraphItem[] {
  return [...graphs].sort((left, right) => {
    const leftCreatedAt = typeof left.createdAt === 'number' ? left.createdAt : 0;
    const rightCreatedAt = typeof right.createdAt === 'number' ? right.createdAt : 0;
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.key.localeCompare(right.key);
  });
}

function buildRenderItemsFromTimeline(input: {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionExecutionGraphItem[];
  runtime: SessionRuntimeStateSnapshot;
}): SessionRenderItem[] {
  const assembledTurns = assembleAuthoritativeAssistantTurns({
    sessionKey: input.sessionKey,
    timelineEntries: input.timelineEntries,
    runtime: input.runtime,
  });
  const graphByAnchorKey = new Map<string, SessionExecutionGraphItem[]>();
  const tailGraphs: SessionExecutionGraphItem[] = [];
  for (const graph of sortExecutionGraphItems(input.executionGraphItems)) {
    const anchorKey = normalizeString(graph.anchorItemKey);
    if (!anchorKey) {
      tailGraphs.push(structuredClone(graph));
      continue;
    }
    const current = graphByAnchorKey.get(anchorKey);
    if (current) {
      current.push(structuredClone(graph));
    } else {
      graphByAnchorKey.set(anchorKey, [structuredClone(graph)]);
    }
  }
  const renderItems: SessionRenderItem[] = [];
  const emittedAssistantTurnKeys = new Set<string>();

  const flushAnchoredGraphs = (anchorKey: string) => {
    const anchored = graphByAnchorKey.get(anchorKey);
    if (!anchored?.length) {
      return;
    }
    renderItems.push(...anchored.map((graph) => structuredClone(graph)));
    graphByAnchorKey.delete(anchorKey);
  };

  for (const entry of input.timelineEntries) {
    if (isAssistantTimelineEntry(entry)) {
      const item = assembledTurns.turnsByLatestTimelineKey.get(entry.key);
      if (!item) {
        continue;
      }
      if (emittedAssistantTurnKeys.has(item.key)) {
        continue;
      }
      emittedAssistantTurnKeys.add(item.key);
      renderItems.push(structuredClone(item));
      flushAnchoredGraphs(item.key);
      continue;
    }

    if (entry.kind === 'message' && entry.role === 'user') {
      const item: SessionRenderUserMessageItem = {
        key: entry.key,
        kind: 'user-message',
        sessionKey: entry.sessionKey,
        role: 'user',
        text: entry.text,
        images: structuredClone(entry.images),
        attachedFiles: structuredClone(entry.attachedFiles),
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.messageId ? { messageId: entry.messageId } : {}),
      };
      renderItems.push(item);
      flushAnchoredGraphs(item.key);
      continue;
    }

    if (entry.kind === 'task-completion') {
      const item: SessionRenderTaskCompletionItem = {
        key: entry.key,
        kind: 'task-completion',
        sessionKey: entry.sessionKey,
        role: 'system',
        text: entry.text,
        childSessionKey: entry.childSessionKey,
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.childSessionId ? { childSessionId: entry.childSessionId } : {}),
        ...(entry.childAgentId ? { childAgentId: entry.childAgentId } : {}),
        ...(entry.taskLabel ? { taskLabel: entry.taskLabel } : {}),
        ...(entry.statusLabel ? { statusLabel: entry.statusLabel } : {}),
        ...(entry.result ? { result: entry.result } : {}),
        ...(entry.statsLine ? { statsLine: entry.statsLine } : {}),
        ...(entry.replyInstruction ? { replyInstruction: entry.replyInstruction } : {}),
        ...(entry.anchorItemKey ? { anchorItemKey: entry.anchorItemKey } : {}),
        ...(entry.triggerItemKey ? { triggerItemKey: entry.triggerItemKey } : {}),
        ...(entry.replyItemKey ? { replyItemKey: entry.replyItemKey } : {}),
      };
      renderItems.push(item);
      flushAnchoredGraphs(item.key);
      continue;
    }

    if (entry.kind === 'system') {
      renderItems.push(structuredClone(entry));
      flushAnchoredGraphs(entry.key);
    }
  }

  const pendingAssistantTurn = assembledTurns.pendingTurn;
  if (
    pendingAssistantTurn
    && !renderItems.some((item) => item.kind === 'assistant-turn' && item.turnKey === pendingAssistantTurn.turnKey && item.laneKey === pendingAssistantTurn.laneKey)
  ) {
    renderItems.push(pendingAssistantTurn);
    flushAnchoredGraphs(pendingAssistantTurn.key);
  }

  renderItems.push(...tailGraphs);
  return renderItems;
}

export class SessionRuntimeService {
  private readonly sessionStates = new Map<string, SessionRuntimeTimelineState>();
  private readonly parentSessionsByChildSessionKey = new Map<string, Set<string>>();
  private activeSessionKey: string | null = null;
  private readonly storeFilePath: string;

  constructor(private readonly deps: SessionRuntimeServiceDeps) {
    this.storeFilePath = join(this.deps.getOpenClawConfigDir(), 'matchaclaw-session-runtime-store.json');
    this.loadPersistedStore();
  }

  private loadPersistedStore(): void {
    if (!existsSync(this.storeFilePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.storeFilePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedSessionRuntimeStoreFile;
      if (!parsed || typeof parsed !== 'object') {
        return;
      }
      this.activeSessionKey = typeof parsed.activeSessionKey === 'string' && parsed.activeSessionKey.trim()
        ? parsed.activeSessionKey.trim()
        : null;
    } catch {
      // ignore invalid persisted store
    }
  }

  private persistStore(): void {
    const payload: PersistedSessionRuntimeStoreFile = {
      version: 3,
      activeSessionKey: this.activeSessionKey,
    };
    mkdirSync(dirname(this.storeFilePath), { recursive: true });
    writeFileSync(this.storeFilePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private getSessionState(sessionKey: string): SessionRuntimeTimelineState {
    const existing = this.sessionStates.get(sessionKey);
    if (existing) {
      return existing;
    }
    const created = createEmptyTimelineState();
    created.sessionKey = sessionKey;
    this.sessionStates.set(sessionKey, created);
    return created;
  }

  private listStorageDescriptors(): SessionStorageDescriptor[] {
    const agentsDir = join(this.deps.getOpenClawConfigDir(), 'agents');
    if (!existsSync(agentsDir)) {
      return [];
    }

    const descriptors: SessionStorageDescriptor[] = [];
    for (const agentDirEntry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentDirEntry.isDirectory()) {
        continue;
      }
      const agentId = agentDirEntry.name;
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');
      const sessionsJson = readJsonRecord(sessionsJsonPath);
      const indexedDescriptors = sessionsJson ? listAgentStorageDescriptors({
        agentId,
        sessionsDir,
        sessionsJsonPath,
        sessionsJson,
      }) : [];
      descriptors.push(...indexedDescriptors);
      descriptors.push(...listTranscriptStorageDescriptors({
        agentId,
        sessionsDir,
        sessionsJsonPath: sessionsJson ? sessionsJsonPath : null,
        sessionsJson,
        indexedDescriptors,
      }));
    }
    return descriptors;
  }

  private findStorageDescriptor(sessionKey: string): SessionStorageDescriptor | null {
    if (!sessionKey.startsWith('agent:')) {
      return null;
    }
    for (const descriptor of this.listStorageDescriptors()) {
      if (descriptor.sessionKey === sessionKey) {
        return descriptor;
      }
    }
    return null;
  }

  private readTranscriptTimelineEntries(sessionKey: string): SessionTimelineEntry[] {
    const descriptor = this.findStorageDescriptor(sessionKey);
    if (!descriptor?.transcriptPath || !existsSync(descriptor.transcriptPath)) {
      return [];
    }

    let content: string;
    try {
      content = readFileSync(descriptor.transcriptPath, 'utf8');
    } catch {
      return [];
    }

    return materializeTranscriptTimelineEntries(sessionKey, parseTranscriptMessages(content));
  }

  private reconcileTranscriptTimelineEntries(input: {
    sessionKey: string;
    existingEntries: SessionTimelineEntry[];
    runId?: string | null;
  }): SessionTimelineEntry[] {
    const descriptor = this.findStorageDescriptor(input.sessionKey);
    if (!descriptor?.transcriptPath || !existsSync(descriptor.transcriptPath)) {
      return input.existingEntries;
    }

    let content: string;
    try {
      content = readFileSync(descriptor.transcriptPath, 'utf8');
    } catch {
      return input.existingEntries;
    }

    const transcriptMessages = parseTranscriptMessages(content);
    const toolPatchEntries = materializeTranscriptToolResultPatchEntries(
      input.sessionKey,
      transcriptMessages,
      input.existingEntries,
    );
    if (toolPatchEntries.length === 0) {
      return input.existingEntries;
    }
    let nextEntries = input.existingEntries;
    for (const entry of toolPatchEntries) {
      nextEntries = upsertTimelineEntry(nextEntries, entry);
    }
    return nextEntries;
  }

  private resolveChildTimelineEntriesForExecutionGraph(childSessionKey: string): SessionTimelineEntry[] {
    const childState = this.getSessionState(childSessionKey);
    if (!childState.hydrated) {
      this.ensureSessionHydrated(childSessionKey, childState);
    }
    return childState.timelineEntries;
  }

  private updateExecutionGraphDependencyIndex(
    sessionKey: string,
    graphs: SessionExecutionGraphItem[],
  ): void {
    for (const parents of this.parentSessionsByChildSessionKey.values()) {
      parents.delete(sessionKey);
    }
    for (const graph of graphs) {
      const childSessionKey = normalizeString(graph.childSessionKey);
      if (!childSessionKey) {
        continue;
      }
      let parents = this.parentSessionsByChildSessionKey.get(childSessionKey);
      if (!parents) {
        parents = new Set<string>();
        this.parentSessionsByChildSessionKey.set(childSessionKey, parents);
      }
      parents.add(sessionKey);
    }
  }

  private findExecutionGraphItemIndex(
    state: SessionRuntimeTimelineState,
    completionItemKey: string,
  ): number {
    return state.executionGraphItems.findIndex((graph) => graph.completionItemKey === completionItemKey);
  }

  private findExecutionGraphReplyItem(
    renderItems: SessionRenderItem[],
    completionItemKey: string,
  ): SessionAssistantTurnItem | null {
    const completionIndex = renderItems.findIndex((item) => item.key === completionItemKey);
    if (completionIndex < 0) {
      return null;
    }
    for (let index = completionIndex + 1; index < renderItems.length; index += 1) {
      const item = renderItems[index];
      if (item?.kind === 'assistant-turn') {
        return item;
      }
    }
    return null;
  }

  private buildExecutionGraphMainTimelineEntries(
    state: SessionRuntimeTimelineState,
    graph: SessionExecutionGraphItem,
  ): SessionTimelineEntry[] {
    const triggerIndex = state.timelineEntries.findIndex((entry) => entry.key === graph.triggerItemKey);
    if (triggerIndex < 0) {
      return [];
    }
    const replyItemIndex = graph.replyItemKey
      ? state.renderItems.findIndex((item) => item.key === graph.replyItemKey)
      : -1;
    let replyTimelineIndex = -1;
    if (replyItemIndex >= 0) {
      const replyItem = state.renderItems[replyItemIndex];
      if (replyItem?.kind === 'assistant-turn') {
        replyTimelineIndex = state.timelineEntries.findIndex((entry) => (
          entry.turnKey === replyItem.turnKey
          && entry.laneKey === replyItem.laneKey
        ));
      }
    }
    const endExclusive = replyTimelineIndex >= 0 ? replyTimelineIndex + 1 : state.timelineEntries.length;
    return state.timelineEntries.slice(triggerIndex, Math.max(triggerIndex, endExclusive));
  }

  private refreshExecutionGraphItem(
    state: SessionRuntimeTimelineState,
    graphIndex: number,
    options: {
      refreshChildSteps?: boolean;
    } = {},
  ): void {
    const current = state.executionGraphItems[graphIndex];
    if (!current) {
      return;
    }
    const next = attachExecutionGraphReply(
      current,
      this.findExecutionGraphReplyItem(state.renderItems, current.completionItemKey),
    );
    const withMainSteps = updateExecutionGraphMainSteps(
      next,
      deriveExecutionGraphSteps(this.buildExecutionGraphMainTimelineEntries(state, next)),
    );
    state.executionGraphItems[graphIndex] = options.refreshChildSteps
      ? updateExecutionGraphChildSteps(
          withMainSteps,
          deriveExecutionGraphSteps(this.resolveChildTimelineEntriesForExecutionGraph(withMainSteps.childSessionKey)),
        )
      : withMainSteps;
  }

  private refreshRenderItems(state: SessionRuntimeTimelineState): void {
    state.renderItems = buildRenderItemsFromTimeline({
      sessionKey: state.sessionKey,
      timelineEntries: state.timelineEntries,
      executionGraphItems: state.executionGraphItems,
      runtime: state.runtime,
    });
  }

  private rebuildExecutionGraphsFromTimeline(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    state.executionGraphItems = [];
    for (const entry of state.timelineEntries) {
      if (!isTaskCompletionEntry(entry)) {
        continue;
      }
      const triggerEntry = entry.triggerItemKey
        ? state.timelineEntries.find((candidate) => candidate.key === entry.triggerItemKey) ?? entry
        : entry;
      state.executionGraphItems.push(createExecutionGraphItem(entry, triggerEntry));
    }
    this.refreshRenderItems(state);
    for (let index = 0; index < state.executionGraphItems.length; index += 1) {
      this.refreshExecutionGraphItem(state, index, { refreshChildSteps: true });
    }
    this.refreshRenderItems(state);
    this.updateExecutionGraphDependencyIndex(sessionKey, state.executionGraphItems);
  }

  private refreshParentExecutionGraphs(childSessionKey: string): void {
    const parents = this.parentSessionsByChildSessionKey.get(childSessionKey);
    if (!parents || parents.size === 0) {
      return;
    }
    for (const parentSessionKey of parents) {
      const parentState = this.sessionStates.get(parentSessionKey);
      if (!parentState?.hydrated) {
        continue;
      }
      for (let index = 0; index < parentState.executionGraphItems.length; index += 1) {
        const graph = parentState.executionGraphItems[index];
        if (graph?.childSessionKey === childSessionKey) {
          this.refreshExecutionGraphItem(parentState, index, { refreshChildSteps: true });
        }
      }
      this.refreshRenderItems(parentState);
      parentState.window = clampWindowState(parentState.window, parentState.renderItems.length);
    }
  }

  private ensureSessionHydrated(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    if (state.hydrated) {
      return;
    }

    state.timelineEntries = mergeTimelineEntries(
      this.readTranscriptTimelineEntries(sessionKey),
      state.timelineEntries,
    );
    state.hydrated = true;
    this.rebuildExecutionGraphsFromTimeline(sessionKey, state);
    state.window = createLatestWindowState(state.renderItems.length);
    this.refreshParentExecutionGraphs(sessionKey);
  }

  private reconcileSessionTranscript(
    sessionKey: string,
    options: {
      runId?: string | null;
    } = {},
  ): void {
    const state = this.getSessionState(sessionKey);
    if (!state.hydrated) {
      this.ensureSessionHydrated(sessionKey, state);
      return;
    }
    state.timelineEntries = this.reconcileTranscriptTimelineEntries({
      sessionKey,
      existingEntries: state.timelineEntries,
      runId: options.runId,
    });
    this.rebuildExecutionGraphsFromTimeline(sessionKey, state);
    state.window = createLatestWindowState(state.renderItems.length);
    this.refreshParentExecutionGraphs(sessionKey);
    this.persistStore();
  }

  private activateSession(
    sessionKey: string,
    options: {
      hydrate?: boolean;
      resetWindowToLatest?: boolean;
    } = {},
  ): SessionRuntimeTimelineState {
    const state = this.getSessionState(sessionKey);
    this.activeSessionKey = sessionKey;
    if (options.hydrate) {
      this.ensureSessionHydrated(sessionKey, state);
    }
    this.refreshRenderItems(state);
    if (options.resetWindowToLatest) {
      state.window = createLatestWindowState(state.renderItems.length);
    }
    this.persistStore();
    return state;
  }

  private upsertTimelineEntries(sessionKey: string, entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
    const state = this.getSessionState(sessionKey);
    if (!state.hydrated) {
      this.ensureSessionHydrated(sessionKey, state);
    }
    const mergedEntries: SessionTimelineEntry[] = [];
    let touchedExecutionGraphs = false;
    for (const entry of entries) {
      state.timelineEntries = upsertTimelineEntry(state.timelineEntries, entry);
      const mergedIndex = findTimelineEntryIndex(state.timelineEntries, entry);
      if (mergedIndex >= 0) {
        const mergedEntry = structuredClone(state.timelineEntries[mergedIndex]!);
        mergedEntries.push(mergedEntry);
        if (mergedEntry.kind === 'task-completion') {
          touchedExecutionGraphs = true;
        }
      }
    }
    if (touchedExecutionGraphs) {
      this.rebuildExecutionGraphsFromTimeline(sessionKey, state);
    } else {
      this.refreshRenderItems(state);
      for (let index = 0; index < state.executionGraphItems.length; index += 1) {
        this.refreshExecutionGraphItem(state, index);
      }
      this.refreshRenderItems(state);
    }
    state.window = createLatestWindowState(state.renderItems.length);
    this.refreshParentExecutionGraphs(sessionKey);
    this.persistStore();
    return mergedEntries;
  }

  private buildSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      items?: SessionRenderItem[];
      window?: SessionWindowStateSnapshot;
      replayComplete?: boolean;
    } = {},
  ): SessionStateSnapshot {
    const allItems = options.items ?? state.renderItems;
    const baseWindow = cloneSessionWindowState(
      options.window
      ?? (state.window.isAtLatest ? createLatestWindowState(allItems.length) : state.window),
    );
    const start = Math.max(0, Math.min(baseWindow.windowStartOffset, allItems.length));
    const end = Math.max(start, Math.min(baseWindow.windowEndOffset, allItems.length));
    const window = createWindowStateSnapshot({
      totalItemCount: allItems.length,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < allItems.length,
      isAtLatest: end >= allItems.length,
    });
    return {
      sessionKey,
      catalog: buildSessionCatalogItem({
        sessionKey,
        timelineEntries: state.timelineEntries,
        runtime: state.runtime,
      }),
      items: cloneRenderItems(allItems.slice(start, end)),
      replayComplete: options.replayComplete ?? true,
      runtime: cloneSessionRuntimeState(state.runtime),
      window,
    };
  }

  private buildLatestSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): SessionStateSnapshot {
    return this.buildSnapshot(sessionKey, state, {
      items: state.renderItems,
      window: createLatestWindowState(state.renderItems.length),
      replayComplete: true,
    });
  }

  private buildWindowSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    input: {
      mode: SessionWindowMode;
      limit: number;
      offset: number | null;
    },
  ): SessionStateSnapshot {
    const allItems = state.renderItems;
    const totalItemCount = allItems.length;
    const { start, end } = buildWindowRange({
      totalItemCount,
      mode: input.mode,
      limit: input.limit,
      offset: input.offset,
    });
    const window = createWindowStateSnapshot({
      totalItemCount,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < totalItemCount,
      isAtLatest: end >= totalItemCount,
    });
    state.window = window;
    this.persistStore();
    return this.buildSnapshot(sessionKey, state, {
      items: allItems,
      window,
      replayComplete: true,
    });
  }

  private setSessionRuntime(
    sessionKey: string,
    patch: Partial<SessionRuntimeStateSnapshot>,
  ): SessionRuntimeStateSnapshot {
    const state = this.getSessionState(sessionKey);
    state.runtime = {
      ...state.runtime,
      ...patch,
      updatedAt: Date.now(),
    };
    this.refreshRenderItems(state);
    for (let index = 0; index < state.executionGraphItems.length; index += 1) {
      this.refreshExecutionGraphItem(state, index);
    }
    this.refreshRenderItems(state);
    this.persistStore();
    return cloneSessionRuntimeState(state.runtime);
  }

  private resolvePrimaryItemFromSnapshot(
    snapshot: SessionStateSnapshot,
    candidate: SessionTimelineEntry | null,
    fallbackEntries: SessionTimelineEntry[],
  ): SessionRenderItem | null {
    const source = candidate ?? fallbackEntries[fallbackEntries.length - 1] ?? null;
    if (!source) {
      return null;
    }
    if (isAssistantTimelineEntry(source)) {
      return snapshot.items.find((item) => (
        item.kind === 'assistant-turn'
        && item.turnKey === source.turnKey
        && item.laneKey === source.laneKey
      )) ?? null;
    }
    return snapshot.items.find((item) => item.key === source.key) ?? null;
  }

  private resolveLifecycleRuntime(
    sessionKey: string,
    input: {
      phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
      runId: string | null;
    },
  ): SessionRuntimeStateSnapshot {
    switch (input.phase) {
      case 'started':
        return this.setSessionRuntime(sessionKey, {
          sending: true,
          activeRunId: input.runId,
          runPhase: 'submitted',
          pendingTurnKey: input.runId ? `main:${input.runId}` : this.getSessionState(sessionKey).runtime.pendingTurnKey,
          pendingTurnLaneKey: 'main',
        });
      case 'final':
        return this.setSessionRuntime(sessionKey, {
          sending: false,
          activeRunId: null,
          runPhase: 'done',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          pendingFinal: false,
        });
      case 'error':
        return this.setSessionRuntime(sessionKey, {
          sending: false,
          activeRunId: null,
          runPhase: 'error',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          pendingFinal: false,
        });
      case 'aborted':
        return this.setSessionRuntime(sessionKey, {
          sending: false,
          activeRunId: null,
          runPhase: 'aborted',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          pendingFinal: false,
        });
      default:
        return cloneSessionRuntimeState(this.getSessionState(sessionKey).runtime);
    }
  }

  private resolveMessageRuntime(
    sessionKey: string,
    input: {
      runId: string | null;
      entry: SessionTimelineEntry;
      sessionUpdate: 'agent_message_chunk' | 'agent_message';
    },
  ): SessionRuntimeStateSnapshot {
    const currentState = this.getSessionState(sessionKey);
    const messageTimestamp = input.entry.createdAt != null ? input.entry.createdAt : null;
    if (input.sessionUpdate === 'agent_message_chunk') {
      const anchorItemKey = resolveAssistantTurnItemKeyFromTimelineEntry(input.entry);
      return this.setSessionRuntime(sessionKey, {
        sending: true,
        activeRunId: input.runId,
        runPhase: 'streaming',
        activeTurnItemKey: anchorItemKey
          ?? currentState.runtime.activeTurnItemKey,
        pendingTurnKey: normalizeString(input.entry.turnKey) || currentState.runtime.pendingTurnKey,
        pendingTurnLaneKey: normalizeString(input.entry.laneKey) || currentState.runtime.pendingTurnLaneKey,
        pendingFinal: false,
        lastUserMessageAt: input.entry.role === 'user' && typeof messageTimestamp === 'number'
          ? messageTimestamp
          : currentState.runtime.lastUserMessageAt,
      });
    }

    if (input.entry.role === 'user') {
      return this.setSessionRuntime(sessionKey, {
        sending: Boolean(input.runId),
        activeRunId: input.runId,
        runPhase: input.runId ? 'submitted' : currentState.runtime.runPhase,
        pendingTurnKey: input.runId ? `main:${input.runId}` : currentState.runtime.pendingTurnKey,
        pendingTurnLaneKey: input.runId ? 'main' : currentState.runtime.pendingTurnLaneKey,
        lastUserMessageAt: typeof messageTimestamp === 'number'
          ? messageTimestamp
          : currentState.runtime.lastUserMessageAt,
      });
    }

    if (input.entry.kind === 'tool-activity' && input.entry.status !== 'streaming') {
      return this.setSessionRuntime(sessionKey, {
        sending: true,
        activeRunId: input.runId,
        runPhase: 'waiting_tool',
        activeTurnItemKey: null,
        pendingTurnKey: normalizeString(input.entry.turnKey) || currentState.runtime.pendingTurnKey,
        pendingTurnLaneKey: normalizeString(input.entry.laneKey) || currentState.runtime.pendingTurnLaneKey,
        pendingFinal: true,
      });
    }

    return this.setSessionRuntime(sessionKey, {
      sending: false,
      activeRunId: null,
      runPhase: 'done',
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: false,
    });
  }

  private buildPromptUserEntry(input: {
    sessionKey: string;
    promptId: string;
    message: string;
    media?: SessionPromptMediaPayload[];
  }): SessionTimelineEntry {
    const state = this.getSessionState(input.sessionKey);
    if (!state.hydrated) {
      this.ensureSessionHydrated(input.sessionKey, state);
    }
    const timestamp = Date.now();
    const message: SessionTranscriptMessage = {
      role: 'user',
      content: input.message || (input.media && input.media.length > 0 ? '(file attached)' : ''),
      id: input.promptId,
      status: 'sending',
      timestamp,
      ...(input.media && input.media.length > 0
        ? {
            _attachedFiles: input.media.map((item) => ({
              fileName: item.fileName,
              mimeType: item.mimeType,
              fileSize: item.fileSize,
              preview: item.preview ?? null,
              filePath: item.filePath,
            })),
          }
        : {}),
    };
    return buildTimelineEntriesFromTranscriptMessage(input.sessionKey, message, {
      index: state.timelineEntries.length,
      status: 'pending',
      existingRows: state.timelineEntries,
    })[0]!;
  }

  consumeGatewayConversationEvent(payload: unknown): SessionUpdateEvent[] {
    const currentSessionKey = isRecord(payload) && isRecord(payload.event) && typeof payload.event.sessionKey === 'string'
      ? payload.event.sessionKey
      : '';
    const currentState = currentSessionKey ? this.getSessionState(currentSessionKey) : null;
    const translated = buildSessionUpdateEventsFromGatewayConversationEvent(payload, {
      existingEntries: currentState?.timelineEntries,
    });
    return translated.map((event) => {
      const sessionKey = normalizeString(event.sessionKey);
      if (!sessionKey) {
        const emptySnapshot: SessionStateSnapshot = {
          sessionKey: '',
          catalog: buildSessionCatalogItem({
            sessionKey: '',
            timelineEntries: [],
            runtime: createEmptySessionRuntimeState(),
          }),
          items: [],
          replayComplete: true,
          runtime: createEmptySessionRuntimeState(),
          window: createLatestWindowState(0),
        };
        if (event.sessionUpdate === 'session_info_update') {
          return {
            sessionUpdate: 'session_info_update',
            sessionKey: event.sessionKey,
            runId: event.runId,
            phase: event.phase,
            snapshot: emptySnapshot,
            ...(event._meta ? { _meta: event._meta } : {}),
          };
        }
        return {
          sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
          sessionKey: event.sessionKey,
          runId: event.runId,
          item: null,
          snapshot: emptySnapshot,
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }
      this.activateSession(sessionKey);
      if (event.sessionUpdate === 'session_info_update') {
        if (event.phase === 'final' || event.phase === 'error' || event.phase === 'aborted') {
          this.reconcileSessionTranscript(sessionKey, {
            runId: event.runId,
          });
        }
        this.resolveLifecycleRuntime(sessionKey, {
          phase: event.phase,
          runId: event.runId,
        });
        const state = this.getSessionState(sessionKey);
        const snapshot = this.buildSnapshot(sessionKey, state, {
          window: state.window.totalItemCount > 0
            ? state.window
            : createLatestWindowState(state.renderItems.length),
          replayComplete: true,
        });
        return {
          sessionUpdate: 'session_info_update',
          sessionKey: event.sessionKey,
          runId: event.runId,
          phase: event.phase,
          snapshot,
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }

      const state = this.getSessionState(sessionKey);
      const mergedEntries = this.upsertTimelineEntries(sessionKey, event.entries);
      const runtimeSourceEntry = mergedEntries[mergedEntries.length - 1] ?? event.entries[event.entries.length - 1] ?? null;
      if (runtimeSourceEntry) {
        this.resolveMessageRuntime(sessionKey, {
          runId: event.runId,
          entry: runtimeSourceEntry,
          sessionUpdate: event.sessionUpdate,
        });
      }
      state.window = createLatestWindowState(state.renderItems.length);
      const snapshot = this.buildSnapshot(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: true,
      });
      const item = this.resolvePrimaryItemFromSnapshot(snapshot, runtimeSourceEntry, event.entries);
      return {
        sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
        sessionKey: event.sessionKey,
        runId: event.runId,
        item,
        snapshot,
        ...(event._meta ? { _meta: event._meta } : {}),
      };
    });
  }

  async createSession(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionNewPayload : {};
    const explicitSessionKey = normalizeString(body.sessionKey);
    const agentId = normalizeString(body.agentId) || 'main';
    const canonicalPrefix = normalizeString(body.canonicalPrefix) || `agent:${agentId}`;
    const sessionKey = explicitSessionKey || `${canonicalPrefix}:session-${Date.now()}`;
    const state = this.activateSession(sessionKey, {
      hydrate: true,
      resetWindowToLatest: true,
    });
    const result: SessionNewResult = {
      success: true,
      sessionKey,
      snapshot: this.buildLatestSnapshot(sessionKey, state),
    };
    return {
      status: 200,
      data: result,
    };
  }

  async deleteSession(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionDeletePayload : {};
    const sessionKey = normalizeString(body.sessionKey);
    if (!sessionKey || !sessionKey.startsWith('agent:')) {
      return {
        status: 400,
        data: { success: false, error: `Invalid sessionKey: ${sessionKey}` },
      };
    }
    const storageDescriptor = this.findStorageDescriptor(sessionKey);
    if (!this.sessionStates.has(sessionKey) && !storageDescriptor) {
      return {
        status: 404,
        data: { success: false, error: `Unknown sessionKey: ${sessionKey}` },
      };
    }

    if (storageDescriptor) {
      if (storageDescriptor.transcriptPath && existsSync(storageDescriptor.transcriptPath)) {
        const deletedPath = this.deps.resolveDeletedPath?.(storageDescriptor.transcriptPath);
        if (deletedPath && deletedPath !== storageDescriptor.transcriptPath) {
          mkdirSync(dirname(deletedPath), { recursive: true });
          renameSync(storageDescriptor.transcriptPath, deletedPath);
        } else {
          rmSync(storageDescriptor.transcriptPath, { force: true });
        }
      }

      if (storageDescriptor.sessionsJson && storageDescriptor.sessionsJsonPath) {
        const nextSessionsJson = pruneStorageIndex(storageDescriptor.sessionsJson, sessionKey);
        writeFileSync(storageDescriptor.sessionsJsonPath, JSON.stringify(nextSessionsJson, null, 2), 'utf8');
      }
    }

    this.sessionStates.delete(sessionKey);
    if (this.activeSessionKey === sessionKey) {
      this.activeSessionKey = null;
    }
    this.persistStore();
    return {
      status: 200,
      data: { success: true },
    };
  }

  async listSessions() {
    const sessionsByKey = new Map<string, SessionCatalogItem>();

    for (const descriptor of this.listStorageDescriptors()) {
      if (!descriptor.transcriptPath || !existsSync(descriptor.transcriptPath)) {
        continue;
      }
      const timelineEntries = this.readTranscriptTimelineEntries(descriptor.sessionKey);
      if (timelineEntries.length === 0) {
        continue;
      }
      sessionsByKey.set(descriptor.sessionKey, buildSessionCatalogItem({
        sessionKey: descriptor.sessionKey,
        timelineEntries,
        runtime: createEmptySessionRuntimeState(),
      }));
    }

    for (const [sessionKey, state] of this.sessionStates.entries()) {
      if (
        !this.findStorageDescriptor(sessionKey)
        && !shouldExposeRuntimeOnlySession(state.runtime)
      ) {
        continue;
      }
      sessionsByKey.set(sessionKey, buildSessionCatalogItem({
        sessionKey,
        timelineEntries: state.timelineEntries,
        runtime: state.runtime,
      }));
    }

    const sessions = Array.from(sessionsByKey.values());
    sessions.sort((left, right) => {
      const leftUpdatedAt = typeof left.updatedAt === 'number' ? left.updatedAt : 0;
      const rightUpdatedAt = typeof right.updatedAt === 'number' ? right.updatedAt : 0;
      if (leftUpdatedAt !== rightUpdatedAt) {
        return rightUpdatedAt - leftUpdatedAt;
      }
      return left.key.localeCompare(right.key);
    });

    const result: SessionListResult = { sessions };
    return {
      status: 200,
      data: result,
    };
  }

  async loadSession(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionLoadPayload : {};
    const sessionKey = normalizeString(body.sessionKey);
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }

    const state = this.activateSession(sessionKey, {
      hydrate: true,
      resetWindowToLatest: true,
    });
    const result: SessionLoadResult = {
      snapshot: this.buildLatestSnapshot(sessionKey, state),
    };
    return {
      status: 200,
      data: result,
    };
  }

  async resumeSession(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionLoadPayload : {};
    const sessionKey = normalizeString(body.sessionKey);
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }

    const state = this.activateSession(sessionKey, {
      hydrate: true,
      resetWindowToLatest: false,
    });
    const result: SessionLoadResult = {
      snapshot: this.buildSnapshot(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: true,
      }),
    };
    return {
      status: 200,
      data: result,
    };
  }

  async switchSession(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionLoadPayload : {};
    const sessionKey = normalizeString(body.sessionKey);
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }

    const state = this.activateSession(sessionKey, {
      hydrate: true,
      resetWindowToLatest: true,
    });
    const result: SessionLoadResult = {
      snapshot: this.buildLatestSnapshot(sessionKey, state),
    };
    return {
      status: 200,
      data: result,
    };
  }

  async getSessionStateSnapshot(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionLoadPayload : {};
    const sessionKey = normalizeString(body.sessionKey) || this.activeSessionKey || '';
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }
    const state = this.activateSession(sessionKey, { hydrate: true });
    const data: SessionLoadResult = {
      snapshot: this.buildSnapshot(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: true,
      }),
    };
    return {
      status: 200,
      data,
    };
  }

  async getSessionWindow(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionWindowPayload : {};
    const sessionKey = normalizeString(body.sessionKey);
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }

    const mode = normalizeWindowMode(body.mode);
    const limit = normalizeWindowLimit(body.limit);
    const offset = normalizeWindowOffset(body.offset);
    void normalizeIncludeCanonical(body.includeCanonical);
    if ((mode === 'older' || mode === 'newer') && offset == null) {
      return {
        status: 400,
        data: { success: false, error: `offset is required for mode: ${mode}` },
      };
    }

    const state = this.activateSession(sessionKey, { hydrate: true });
    const result: SessionWindowResult = {
      snapshot: this.buildWindowSnapshot(sessionKey, state, {
        mode,
        limit,
        offset,
      }),
    };

    return {
      status: 200,
      data: result,
    };
  }

  async abortSessionRuntime(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionAbortRuntimePayload : {};
    const sessionKey = normalizeString(body.sessionKey) || this.activeSessionKey || '';
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }

    const runtime = this.resolveLifecycleRuntime(sessionKey, {
      phase: 'aborted',
      runId: null,
    });
    const state = this.activateSession(sessionKey, {
      hydrate: true,
      resetWindowToLatest: true,
    });
    const result: SessionLoadResult & { success: boolean } = {
      success: true,
      snapshot: {
        ...this.buildLatestSnapshot(sessionKey, state),
        runtime,
      },
    };
    return {
      status: 200,
      data: result,
    };
  }

  async promptSession(payload: unknown) {
    const directBody = isRecord(payload) ? payload as SessionPromptPayload : {};
    const mediaBody = normalizeSendWithMediaInput(payload);
    const sessionKey = normalizeString(directBody.sessionKey ?? mediaBody?.sessionKey);
    const message = typeof directBody.message === 'string'
      ? directBody.message
      : (mediaBody?.message ?? '');
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }
    if (!message.trim() && !(Array.isArray(mediaBody?.media) && mediaBody.media.length > 0)) {
      return {
        status: 400,
        data: { success: false, error: 'message is required' },
      };
    }

    const promptId = normalizeString(
      directBody.promptId
      ?? directBody.runId
      ?? directBody.idempotencyKey
      ?? mediaBody?.idempotencyKey,
    ) || randomUUID();

    const sendResult = mediaBody
      ? await sendWithMediaViaOpenClawBridge(this.deps.openclawBridge, {
          ...mediaBody,
          sessionKey,
          message,
          idempotencyKey: promptId,
        })
      : await sendWithMediaViaOpenClawBridge(this.deps.openclawBridge, {
          sessionKey,
          message,
          idempotencyKey: promptId,
          ...(typeof directBody.deliver === 'boolean' ? { deliver: directBody.deliver } : {}),
        });

    if (!sendResult.success) {
      return {
        status: 500,
        data: {
          success: false,
          error: sendResult.error ?? 'Failed to prompt session',
        },
      };
    }

    const resultRecord = isRecord(sendResult.result) ? sendResult.result : {};
    const runId = normalizeString(resultRecord.runId);
    const media = Array.isArray(mediaBody?.media)
      ? mediaBody.media as SessionPromptMediaPayload[]
      : undefined;
    const state = this.activateSession(sessionKey, {
      hydrate: true,
      resetWindowToLatest: true,
    });
    const [entry] = this.upsertTimelineEntries(sessionKey, [this.buildPromptUserEntry({
      sessionKey,
      promptId,
      message,
      media,
    })]);
    const runtime = this.setSessionRuntime(sessionKey, {
      sending: true,
      activeRunId: runId || null,
      runPhase: 'submitted',
      activeTurnItemKey: null,
      pendingTurnKey: runId ? `main:${runId}` : `main:prompt:${promptId}`,
      pendingTurnLaneKey: 'main',
      pendingFinal: false,
      lastUserMessageAt: entry?.createdAt ?? Date.now(),
    });
    state.window = createLatestWindowState(state.renderItems.length);
    const snapshot = {
      ...this.buildLatestSnapshot(sessionKey, state),
      runtime,
    };
    const result: SessionPromptResult = {
      success: true,
      sessionKey,
      runId: runId || null,
      promptId,
      item: snapshot.items.find((candidate) => candidate.key === entry?.key) ?? null,
      snapshot,
    };
    return {
      status: 200,
      data: result,
    };
  }
}
