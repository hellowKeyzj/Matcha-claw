import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeOptionalString } from '../../shared/chat-message-normalization';
import type {
  SessionExecutionGraphRow,
  SessionCatalogItem,
  SessionCatalogKind,
  SessionLoadResult,
  SessionMessageRow,
  SessionPendingAssistantRow,
  SessionListResult,
  SessionNewResult,
  SessionPromptResult,
  SessionRenderRow,
  SessionRuntimeStateSnapshot,
  SessionStateSnapshot,
  SessionToolActivityRow,
  SessionUpdateEvent,
  SessionWindowStateSnapshot,
  SessionWindowResult,
} from '../../shared/session-adapter-types';
import {
  buildRowsFromTranscriptMessage,
  materializeTranscriptRows,
  parseTranscriptMessages,
  resolveSessionLabelDetailsFromRows,
  type SessionTranscriptMessage,
} from './transcript-utils';
import {
  attachExecutionGraphReply,
  createExecutionGraphRow,
  deriveExecutionGraphSteps,
  isAssistantActivityRow as isExecutionGraphAssistantActivityRow,
  isTaskCompletionRow,
  updateExecutionGraphChildSteps,
  updateExecutionGraphMainSteps,
} from './execution-graphs';
import { buildSessionUpdateEventsFromGatewayConversationEvent } from './gateway-ingress';
import {
  findRowIndex,
  mergeRows,
  resolveLastActivityAt,
  upsertRow,
} from './row-state';
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

interface SessionPromptMediaPayload {
  filePath: string;
  mimeType: string;
  fileName: string;
  fileSize?: number;
  preview?: string | null;
}

interface SessionRuntimeTimelineState {
  rows: SessionRenderRow[];
  executionGraphs: SessionExecutionGraphRow[];
  pendingRows: SessionPendingAssistantRow[];
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
  version: 2;
  activeSessionKey: string | null;
  liveSessions: Array<{
    sessionKey: string;
    runtime: SessionRuntimeStateSnapshot;
  }>;
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
    streamingMessageId: null,
    pendingFinal: false,
    lastUserMessageAt: null,
    updatedAt: null,
  };
}

function createWindowStateSnapshot(input: {
  totalRowCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}): SessionWindowStateSnapshot {
  return {
    totalRowCount: input.totalRowCount,
    windowStartOffset: input.windowStartOffset,
    windowEndOffset: input.windowEndOffset,
    hasMore: input.hasMore,
    hasNewer: input.hasNewer,
    isAtLatest: input.isAtLatest,
  };
}

function createLatestWindowState(totalRowCount: number): SessionWindowStateSnapshot {
  return createWindowStateSnapshot({
    totalRowCount,
    windowStartOffset: 0,
    windowEndOffset: totalRowCount,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  });
}

function createEmptyTimelineState(
  patch: Partial<SessionRuntimeTimelineState> = {},
): SessionRuntimeTimelineState {
  return {
    rows: [],
    executionGraphs: [],
    pendingRows: [],
    hydrated: false,
    runtime: createEmptySessionRuntimeState(),
    window: createLatestWindowState(0),
    ...patch,
  };
}

function cloneSessionRuntimeState(
  runtime: SessionRuntimeStateSnapshot,
): SessionRuntimeStateSnapshot {
  return { ...runtime };
}

function cloneSessionWindowState(
  window: SessionWindowStateSnapshot,
): SessionWindowStateSnapshot {
  return { ...window };
}

function cloneRenderRows(rows: SessionRenderRow[]): SessionRenderRow[] {
  return structuredClone(rows);
}

function isAssistantContentRow(
  row: SessionRenderRow,
): row is SessionMessageRow | SessionToolActivityRow {
  return row.role === 'assistant' && (row.kind === 'message' || row.kind === 'tool-activity');
}

function isProtocolDerivedRow(
  row: SessionRenderRow,
): row is SessionPendingAssistantRow | SessionExecutionGraphRow {
  return row.kind === 'pending-assistant' || row.kind === 'execution-graph';
}

function filterCoreRows(rows: SessionRenderRow[]): SessionRenderRow[] {
  return rows.filter((row) => !isProtocolDerivedRow(row));
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
  rows: SessionRenderRow[];
  runtime: SessionRuntimeStateSnapshot;
}): SessionCatalogItem {
  const agentId = parseSessionKeyAgent(input.sessionKey) ?? 'main';
  const sourceRows = filterCoreRows(input.rows);
  const rows = sourceRows.length > 0 ? sourceRows : input.rows;
  const label = resolveSessionLabelDetailsFromRows(rows);
  const updatedAt = resolveLastActivityAt(rows, input.runtime);
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

interface AssistantTurnLaneState {
  laneKey: string;
  turnKey: string;
  agentId: string | null;
  row: SessionMessageRow | SessionToolActivityRow;
}

interface AssistantTurnSnapshot {
  turnKey: string;
  lanes: AssistantTurnLaneState[];
  latestRow: SessionMessageRow | SessionToolActivityRow;
}

function collectAssistantTurns(rows: SessionRenderRow[]): AssistantTurnSnapshot[] {
  interface MutableTurn {
    turnKey: string;
    latestRow: SessionMessageRow | SessionToolActivityRow;
    lanesByKey: Map<string, AssistantTurnLaneState>;
  }

  const turns: MutableTurn[] = [];
  const turnIndexByKey = new Map<string, number>();
  for (const row of rows) {
    if (!isAssistantContentRow(row)) {
      continue;
    }
    const turnKey = normalizeString(row.turnKey);
    const laneKey = normalizeString(row.laneKey);
    if (!turnKey || !laneKey) {
      continue;
    }

    let turn = (() => {
      const existingIndex = turnIndexByKey.get(turnKey);
      return existingIndex != null ? turns[existingIndex] : undefined;
    })();
    if (!turn) {
      turn = {
        turnKey,
        latestRow: row,
        lanesByKey: new Map<string, AssistantTurnLaneState>(),
      };
      turnIndexByKey.set(turnKey, turns.length);
      turns.push(turn);
    }

    turn.latestRow = row;
    turn.lanesByKey.set(laneKey, {
      laneKey,
      turnKey,
      agentId: normalizeString(row.agentId) || null,
      row,
    });
  }

  return turns.map((turn) => ({
    turnKey: turn.turnKey,
    lanes: Array.from(turn.lanesByKey.values()),
    latestRow: turn.latestRow,
  }));
}

function findCurrentStreamingTurn(
  rows: SessionRenderRow[],
  streamingMessageId: string | null | undefined,
): SessionMessageRow | SessionToolActivityRow | null {
  const normalizedStreamingMessageId = normalizeString(streamingMessageId);
  if (normalizedStreamingMessageId) {
    const matched = rows.find((row) => row.rowId === normalizedStreamingMessageId);
    if (matched && isAssistantContentRow(matched)) {
      return matched;
    }
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && isAssistantContentRow(row) && row.status === 'streaming') {
      return row;
    }
  }
  return null;
}

function buildPendingAssistantProtocolRows(input: {
  sessionKey: string;
  rows: SessionRenderRow[];
  runtime: SessionRuntimeStateSnapshot;
}): SessionPendingAssistantRow[] {
  if (!input.runtime.sending) {
    return [];
  }

  const turns = collectAssistantTurns(input.rows);
  const currentStreamingTurn = findCurrentStreamingTurn(
    input.rows,
    input.runtime.streamingMessageId,
  );
  const activeTurnKey = currentStreamingTurn
    ? normalizeString(currentStreamingTurn.turnKey)
    : (turns[turns.length - 1]?.turnKey ?? '');
  const activeTurn = activeTurnKey
    ? turns.find((turn) => turn.turnKey === activeTurnKey) ?? null
    : null;
  const activeLanes = activeTurn?.lanes ?? [];

  const activityRows = activeLanes
    .filter((lane) => lane.row.status !== 'streaming')
    .filter((lane) => input.runtime.pendingFinal || lane.row.toolStatuses.length > 0)
    .map((lane) => ({
      key: `session:${input.sessionKey}|pending:${lane.turnKey}:${lane.laneKey}`,
      kind: 'pending-assistant' as const,
      sessionKey: input.sessionKey,
      role: 'assistant' as const,
      text: '',
      createdAt: lane.row.createdAt,
      status: 'pending' as const,
      runId: lane.row.runId,
      sequenceId: lane.row.sequenceId,
      laneKey: lane.laneKey,
      turnKey: lane.turnKey,
      agentId: lane.agentId ?? undefined,
      assistantTurnKey: lane.turnKey,
      assistantLaneKey: lane.laneKey,
      assistantLaneAgentId: lane.agentId,
      pendingState: 'activity' as const,
    } satisfies SessionPendingAssistantRow));
  if (activityRows.length > 0) {
    return activityRows;
  }

  if (activeTurn?.lanes.some((lane) => lane.row.status === 'streaming')) {
    return [];
  }

  const fallbackRow = activeTurn?.latestRow
    ?? [...input.rows].reverse().find((row) => isAssistantContentRow(row))
    ?? null;
  return [{
    key: `session:${input.sessionKey}|pending:default`,
    kind: 'pending-assistant',
    sessionKey: input.sessionKey,
    role: 'assistant',
    text: '',
    createdAt: fallbackRow?.createdAt,
    status: 'pending',
    runId: fallbackRow?.runId ?? input.runtime.activeRunId ?? undefined,
    sequenceId: fallbackRow?.sequenceId,
    laneKey: fallbackRow?.laneKey,
    turnKey: fallbackRow?.turnKey,
    agentId: fallbackRow?.agentId,
    assistantTurnKey: fallbackRow?.turnKey ?? null,
    assistantLaneKey: fallbackRow?.laneKey ?? null,
    assistantLaneAgentId: fallbackRow?.agentId ?? null,
    pendingState: input.runtime.pendingFinal ? 'activity' : 'typing',
  } satisfies SessionPendingAssistantRow];
}

function sortPendingAssistantRows(rows: SessionPendingAssistantRow[]): SessionPendingAssistantRow[] {
  return [...rows].sort((left, right) => {
    const leftCreatedAt = typeof left.createdAt === 'number' ? left.createdAt : 0;
    const rightCreatedAt = typeof right.createdAt === 'number' ? right.createdAt : 0;
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.key.localeCompare(right.key);
  });
}

function anchorExecutionGraphRows(
  baseRows: SessionRenderRow[],
  executionGraphs: SessionExecutionGraphRow[],
): SessionRenderRow[] {
  const rows = cloneRenderRows(baseRows);
  const insertionsByAnchorKey = new Map<string, SessionExecutionGraphRow[]>();
  const tailGraphs: SessionExecutionGraphRow[] = [];
  for (const graphRow of sortExecutionGraphs(executionGraphs)) {
    const anchorKey = normalizeString(graphRow.anchorRowKey);
    if (!anchorKey) {
      tailGraphs.push(graphRow);
      continue;
    }
    const current = insertionsByAnchorKey.get(anchorKey);
    if (current) {
      current.push(graphRow);
    } else {
      insertionsByAnchorKey.set(anchorKey, [graphRow]);
    }
  }

  const visibleRows: SessionRenderRow[] = [];
  for (const row of rows) {
    visibleRows.push(row);
    const anchored = insertionsByAnchorKey.get(row.key);
    if (anchored?.length) {
      visibleRows.push(...anchored);
    }
  }
  if (tailGraphs.length > 0) {
    visibleRows.push(...tailGraphs);
  }
  return visibleRows;
}

function sortExecutionGraphs(graphs: SessionExecutionGraphRow[]): SessionExecutionGraphRow[] {
  return [...graphs].sort((left, right) => {
    const leftCreatedAt = typeof left.createdAt === 'number' ? left.createdAt : 0;
    const rightCreatedAt = typeof right.createdAt === 'number' ? right.createdAt : 0;
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.key.localeCompare(right.key);
  });
}

function clampWindowState(
  window: SessionWindowStateSnapshot,
  totalRowCount: number,
): SessionWindowStateSnapshot {
  const start = Math.max(0, Math.min(window.windowStartOffset, totalRowCount));
  const end = Math.max(start, Math.min(window.windowEndOffset, totalRowCount));
  return createWindowStateSnapshot({
    totalRowCount,
    windowStartOffset: start,
    windowEndOffset: end,
    hasMore: start > 0,
    hasNewer: end < totalRowCount,
    isAtLatest: end >= totalRowCount,
  });
}

function shouldPersistLiveRuntimeState(runtime: SessionRuntimeStateSnapshot): boolean {
  return (
    runtime.sending
    || runtime.pendingFinal
    || runtime.activeRunId != null
    || runtime.streamingMessageId != null
    || (runtime.runPhase !== 'idle' && runtime.runPhase !== 'done' && runtime.runPhase !== 'error' && runtime.runPhase !== 'aborted')
  );
}

function shouldExposeRuntimeOnlySession(runtime: SessionRuntimeStateSnapshot): boolean {
  return shouldPersistLiveRuntimeState(runtime)
    || typeof runtime.updatedAt === 'number';
}

function buildWindowRange(input: {
  totalRowCount: number;
  mode: SessionWindowMode;
  limit: number;
  offset: number | null;
}): { start: number; end: number } {
  const { totalRowCount, mode, limit, offset } = input;
  if (mode === 'older') {
    const anchor = Math.min(Math.max(offset ?? totalRowCount, 0), totalRowCount);
    return {
      start: Math.max(0, anchor - limit),
      end: Math.min(totalRowCount, anchor + limit),
    };
  }
  if (mode === 'newer') {
    const start = Math.min(Math.max(offset ?? totalRowCount, 0), totalRowCount);
    return {
      start,
      end: Math.min(totalRowCount, start + limit),
    };
  }
  return {
    start: Math.max(0, totalRowCount - limit),
    end: totalRowCount,
  };
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
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 2 || !Array.isArray(parsed.liveSessions)) {
        return;
      }
      this.activeSessionKey = typeof parsed.activeSessionKey === 'string' && parsed.activeSessionKey.trim()
        ? parsed.activeSessionKey.trim()
        : null;
      for (const session of parsed.liveSessions) {
        if (!session || typeof session !== 'object' || Array.isArray(session)) {
          continue;
        }
        const sessionKey = normalizeString((session as { sessionKey?: unknown }).sessionKey);
        if (!sessionKey) {
          continue;
        }
        const runtime = isRecord((session as { runtime?: unknown }).runtime)
          ? {
              ...createEmptySessionRuntimeState(),
              ...((session as { runtime: SessionRuntimeStateSnapshot }).runtime),
            }
          : createEmptySessionRuntimeState();
        if (!shouldPersistLiveRuntimeState(runtime) && typeof runtime.updatedAt !== 'number') {
          continue;
        }
        this.sessionStates.set(sessionKey, createEmptyTimelineState({
          runtime,
        }));
      }
    } catch {
      // ignore invalid persisted store
    }
  }

  private persistStore(): void {
    const payload: PersistedSessionRuntimeStoreFile = {
      version: 2,
      activeSessionKey: this.activeSessionKey,
      liveSessions: Array.from(this.sessionStates.entries())
        .filter(([, state]) => shouldPersistLiveRuntimeState(state.runtime))
        .map(([sessionKey, state]) => ({
          sessionKey,
          runtime: cloneSessionRuntimeState(state.runtime),
        })),
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

  private readTranscriptRows(sessionKey: string): SessionRenderRow[] {
    const descriptor = this.findStorageDescriptor(sessionKey);
    if (!descriptor?.transcriptPath || !existsSync(descriptor.transcriptPath)) {
      return [];
    }

    let content = '';
    try {
      content = readFileSync(descriptor.transcriptPath, 'utf8');
    } catch {
      return [];
    }

    return materializeTranscriptRows(sessionKey, parseTranscriptMessages(content));
  }

  private resolveStorageDescriptorForDeletion(sessionKey: string): SessionStorageDescriptor | null {
    const descriptor = this.findStorageDescriptor(sessionKey);
    if (!descriptor) {
      return null;
    }
    if (!descriptor.sessionsJsonPath || !descriptor.sessionsJson) {
      return descriptor;
    }
    return descriptor;
  }

  private resolveChildRowsForExecutionGraph(childSessionKey: string): SessionRenderRow[] {
    const childState = this.getSessionState(childSessionKey);
    if (!childState.hydrated) {
      this.ensureSessionHydrated(childSessionKey, childState);
    }
    return filterCoreRows(childState.rows);
  }

  private updateExecutionGraphDependencyIndex(
    sessionKey: string,
    graphs: SessionExecutionGraphRow[],
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

  private findExecutionGraphRowIndex(
    state: SessionRuntimeTimelineState,
    completionRowKey: string,
  ): number {
    return state.executionGraphs.findIndex((graph) => graph.completionRowKey === completionRowKey);
  }

  private findExecutionGraphReplyRow(
    rows: SessionRenderRow[],
    completionRowKey: string,
  ): SessionMessageRow | SessionToolActivityRow | null {
    const completionIndex = rows.findIndex((row) => row.key === completionRowKey);
    if (completionIndex < 0) {
      return null;
    }
    for (let index = completionIndex + 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row && isExecutionGraphAssistantActivityRow(row)) {
        return row;
      }
    }
    return null;
  }

  private buildExecutionGraphMainRows(
    rows: SessionRenderRow[],
    graph: SessionExecutionGraphRow,
  ): SessionRenderRow[] {
    const triggerIndex = rows.findIndex((row) => row.key === graph.triggerRowKey);
    if (triggerIndex < 0) {
      return [];
    }
    const replyIndex = graph.replyRowKey
      ? rows.findIndex((row) => row.key === graph.replyRowKey)
      : -1;
    const endExclusive = replyIndex >= 0 ? replyIndex + 1 : rows.length;
    return rows.slice(triggerIndex, Math.max(triggerIndex, endExclusive));
  }

  private refreshExecutionGraphRow(
    state: SessionRuntimeTimelineState,
    graphIndex: number,
    rows: SessionRenderRow[],
    options: {
      refreshChildSteps?: boolean;
    } = {},
  ): void {
    const current = state.executionGraphs[graphIndex];
    if (!current) {
      return;
    }
    const next = attachExecutionGraphReply(
      current,
      this.findExecutionGraphReplyRow(rows, current.completionRowKey),
    );
    const withMainSteps = updateExecutionGraphMainSteps(
      next,
      deriveExecutionGraphSteps(this.buildExecutionGraphMainRows(rows, next)),
    );
    state.executionGraphs[graphIndex] = options.refreshChildSteps
      ? updateExecutionGraphChildSteps(
          withMainSteps,
          deriveExecutionGraphSteps(this.resolveChildRowsForExecutionGraph(withMainSteps.childSessionKey)),
        )
      : withMainSteps;
  }

  private rebuildExecutionGraphsFromRows(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    const rows = filterCoreRows(state.rows);
    state.executionGraphs = [];
    for (const row of rows) {
      if (!isTaskCompletionRow(row)) {
        continue;
      }
      const triggerRow = row.triggerRowKey
        ? rows.find((candidate) => candidate.key === row.triggerRowKey) ?? row
        : row;
      state.executionGraphs.push(createExecutionGraphRow(row, triggerRow));
    }
    for (let index = 0; index < state.executionGraphs.length; index += 1) {
      this.refreshExecutionGraphRow(state, index, rows, { refreshChildSteps: true });
    }
    this.updateExecutionGraphDependencyIndex(sessionKey, state.executionGraphs);
  }

  private markExecutionGraphsAffectedByRow(
    state: SessionRuntimeTimelineState,
    rows: SessionRenderRow[],
    rowKey: string,
    affectedCompletionRowKeys: Set<string>,
  ): void {
    const rowIndex = rows.findIndex((row) => row.key === rowKey);
    if (rowIndex < 0) {
      return;
    }
    for (const graph of state.executionGraphs) {
      const triggerIndex = rows.findIndex((row) => row.key === graph.triggerRowKey);
      if (triggerIndex < 0 || rowIndex < triggerIndex) {
        continue;
      }
      const replyIndex = graph.replyRowKey
        ? rows.findIndex((row) => row.key === graph.replyRowKey)
        : -1;
      const rangeEnd = replyIndex >= 0 ? replyIndex : rows.length - 1;
      if (rowIndex <= rangeEnd) {
        affectedCompletionRowKeys.add(graph.completionRowKey);
      }
    }
  }

  private reduceExecutionGraphsForRowUpsert(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    row: SessionRenderRow,
    rows: SessionRenderRow[],
    affectedCompletionRowKeys: Set<string>,
  ): void {
    if (isTaskCompletionRow(row)) {
      const triggerRow = row.triggerRowKey
        ? rows.find((candidate) => candidate.key === row.triggerRowKey) ?? row
        : row;
      const nextGraph = createExecutionGraphRow(row, triggerRow);
      const existingIndex = this.findExecutionGraphRowIndex(state, row.key);
      if (existingIndex >= 0) {
        state.executionGraphs[existingIndex] = nextGraph;
      } else {
        state.executionGraphs.push(nextGraph);
      }
      affectedCompletionRowKeys.add(row.key);
      this.updateExecutionGraphDependencyIndex(sessionKey, state.executionGraphs);
    }

    if (isExecutionGraphAssistantActivityRow(row)) {
      const replyIndex = rows.findIndex((candidate) => candidate.key === row.key);
      for (let index = 0; index < state.executionGraphs.length; index += 1) {
        const graph = state.executionGraphs[index];
        if (!graph || graph.replyRowKey) {
          continue;
        }
        const completionIndex = rows.findIndex((candidate) => candidate.key === graph.completionRowKey);
        if (completionIndex >= 0 && completionIndex < replyIndex) {
          state.executionGraphs[index] = attachExecutionGraphReply(graph, row);
          affectedCompletionRowKeys.add(graph.completionRowKey);
        }
      }
    }

    this.markExecutionGraphsAffectedByRow(state, rows, row.key, affectedCompletionRowKeys);
  }

  private refreshExecutionGraphs(
    state: SessionRuntimeTimelineState,
    rows: SessionRenderRow[],
    affectedCompletionRowKeys: Set<string>,
    options: {
      refreshChildSteps?: boolean;
    } = {},
  ): void {
    for (const completionRowKey of affectedCompletionRowKeys) {
      const graphIndex = this.findExecutionGraphRowIndex(state, completionRowKey);
      if (graphIndex >= 0) {
        this.refreshExecutionGraphRow(state, graphIndex, rows, options);
      }
    }
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
      const rows = filterCoreRows(parentState.rows);
      const affectedCompletionRowKeys = new Set<string>();
      for (const graph of parentState.executionGraphs) {
        if (graph.childSessionKey === childSessionKey) {
          affectedCompletionRowKeys.add(graph.completionRowKey);
        }
      }
      if (affectedCompletionRowKeys.size === 0) {
        continue;
      }
      this.refreshExecutionGraphs(parentState, rows, affectedCompletionRowKeys, {
        refreshChildSteps: true,
      });
      parentState.rows = this.materializeProtocolRows(parentSessionKey, parentState);
      parentState.window = clampWindowState(parentState.window, parentState.rows.length);
    }
  }

  private syncPendingAssistantRows(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    state.pendingRows = sortPendingAssistantRows(buildPendingAssistantProtocolRows({
      sessionKey,
      rows: filterCoreRows(state.rows),
      runtime: state.runtime,
    }));
  }

  private materializeProtocolRows(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): SessionRenderRow[] {
    const coreRows = filterCoreRows(state.rows);
    const baseRows = [...coreRows, ...state.pendingRows];
    return anchorExecutionGraphRows(baseRows, state.executionGraphs);
  }

  private recomposeSessionRows(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    state.rows = this.materializeProtocolRows(sessionKey, state);
  }

  private ensureSessionHydrated(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    if (state.hydrated) {
      return;
    }

    state.rows = mergeRows(
      this.readTranscriptRows(sessionKey),
      filterCoreRows(state.rows),
    );
    state.hydrated = true;
    this.rebuildExecutionGraphsFromRows(sessionKey, state);
    this.syncPendingAssistantRows(sessionKey, state);
    this.recomposeSessionRows(sessionKey, state);
    state.window = createLatestWindowState(state.rows.length);
    this.refreshParentExecutionGraphs(sessionKey);
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
    this.syncPendingAssistantRows(sessionKey, state);
    this.recomposeSessionRows(sessionKey, state);
    if (options.resetWindowToLatest) {
      state.window = createLatestWindowState(state.rows.length);
    }
    this.persistStore();
    return state;
  }

  private upsertSessionRows(sessionKey: string, rows: SessionRenderRow[]): SessionRenderRow[] {
    const state = this.getSessionState(sessionKey);
    if (!state.hydrated) {
      this.ensureSessionHydrated(sessionKey, state);
    }
    state.rows = filterCoreRows(state.rows);
    const mergedRows: SessionRenderRow[] = [];
    const affectedCompletionRowKeys = new Set<string>();
    for (const row of rows) {
      state.rows = upsertRow(state.rows, row);
      const mergedIndex = findRowIndex(state.rows, row);
      if (mergedIndex >= 0) {
        const mergedRow = structuredClone(state.rows[mergedIndex]!);
        mergedRows.push(mergedRow);
        this.reduceExecutionGraphsForRowUpsert(
          sessionKey,
          state,
          mergedRow,
          state.rows,
          affectedCompletionRowKeys,
        );
      }
    }
    this.refreshExecutionGraphs(state, state.rows, affectedCompletionRowKeys);
    this.syncPendingAssistantRows(sessionKey, state);
    this.recomposeSessionRows(sessionKey, state);
    state.window = createLatestWindowState(state.rows.length);
    this.refreshParentExecutionGraphs(sessionKey);
    this.persistStore();
    return mergedRows;
  }

  private buildSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      rows?: SessionRenderRow[];
      window?: SessionWindowStateSnapshot;
      replayComplete?: boolean;
    } = {},
  ): SessionStateSnapshot {
    const allRows = options.rows ?? state.rows;
    const baseWindow = cloneSessionWindowState(
      options.window
      ?? (state.window.isAtLatest ? createLatestWindowState(allRows.length) : state.window),
    );
    const start = Math.max(0, Math.min(baseWindow.windowStartOffset, allRows.length));
    const end = Math.max(start, Math.min(baseWindow.windowEndOffset, allRows.length));
    const window = createWindowStateSnapshot({
      totalRowCount: allRows.length,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < allRows.length,
      isAtLatest: end >= allRows.length,
    });
    return {
      sessionKey,
      catalog: buildSessionCatalogItem({
        sessionKey,
        rows: allRows,
        runtime: state.runtime,
      }),
      rows: cloneRenderRows(allRows.slice(start, end)),
      replayComplete: options.replayComplete ?? true,
      runtime: cloneSessionRuntimeState(state.runtime),
      window,
    };
  }

  private buildLatestSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): SessionStateSnapshot {
    const rows = state.rows;
    return this.buildSnapshot(sessionKey, state, {
      rows,
      window: createLatestWindowState(rows.length),
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
    const allRows = state.rows;
    const totalRowCount = allRows.length;
    const { start, end } = buildWindowRange({
      totalRowCount,
      mode: input.mode,
      limit: input.limit,
      offset: input.offset,
    });
    const window = createWindowStateSnapshot({
      totalRowCount,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < totalRowCount,
      isAtLatest: end >= totalRowCount,
    });
    state.window = window;
    this.persistStore();
    return this.buildSnapshot(sessionKey, state, {
      rows: allRows,
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
    this.syncPendingAssistantRows(sessionKey, state);
    this.recomposeSessionRows(sessionKey, state);
    this.persistStore();
    return cloneSessionRuntimeState(state.runtime);
  }

  private resolvePrimaryRowFromSnapshot(
    snapshot: SessionStateSnapshot,
    candidate: SessionRenderRow | null,
    fallbackRows: SessionRenderRow[],
  ): SessionRenderRow | null {
    const primaryRowId = candidate?.rowId ?? fallbackRows[0]?.rowId ?? null;
    const primaryKey = candidate?.key ?? fallbackRows[0]?.key ?? null;
    return snapshot.rows.find((row) => (
      (primaryRowId && row.rowId === primaryRowId)
      || (primaryKey && row.key === primaryKey)
    )) ?? null;
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
        });
      case 'final':
        return this.setSessionRuntime(sessionKey, {
          sending: false,
          activeRunId: null,
          runPhase: 'done',
          streamingMessageId: null,
          pendingFinal: false,
        });
      case 'error':
        return this.setSessionRuntime(sessionKey, {
          sending: false,
          activeRunId: null,
          runPhase: 'error',
          streamingMessageId: null,
          pendingFinal: false,
        });
      case 'aborted':
        return this.setSessionRuntime(sessionKey, {
          sending: false,
          activeRunId: null,
          runPhase: 'aborted',
          streamingMessageId: null,
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
      row: SessionRenderRow;
      sessionUpdate: 'agent_message_chunk' | 'agent_message';
    },
  ): SessionRuntimeStateSnapshot {
    const currentState = this.getSessionState(sessionKey);
    const messageTimestamp = input.row.createdAt != null ? input.row.createdAt : null;
    if (input.sessionUpdate === 'agent_message_chunk') {
      return this.setSessionRuntime(sessionKey, {
        sending: true,
        activeRunId: input.runId,
        runPhase: 'streaming',
        streamingMessageId: input.row.rowId ?? currentState.runtime.streamingMessageId,
        pendingFinal: false,
        lastUserMessageAt: input.row.role === 'user' && typeof messageTimestamp === 'number'
          ? messageTimestamp
          : currentState.runtime.lastUserMessageAt,
      });
    }

    if (input.row.role === 'user') {
      return this.setSessionRuntime(sessionKey, {
        sending: Boolean(input.runId),
        activeRunId: input.runId,
        runPhase: input.runId ? 'submitted' : currentState.runtime.runPhase,
        lastUserMessageAt: typeof messageTimestamp === 'number'
          ? messageTimestamp
          : currentState.runtime.lastUserMessageAt,
      });
    }

    if (input.row.kind === 'tool-activity' && input.row.status !== 'streaming') {
      return this.setSessionRuntime(sessionKey, {
        sending: true,
        activeRunId: input.runId,
        runPhase: 'waiting_tool',
        streamingMessageId: null,
        pendingFinal: true,
      });
    }

    return this.setSessionRuntime(sessionKey, {
      sending: false,
      activeRunId: null,
      runPhase: 'done',
      streamingMessageId: null,
      pendingFinal: false,
    });
  }

  private buildPromptUserRow(input: {
    sessionKey: string;
    promptId: string;
    message: string;
    media?: SessionPromptMediaPayload[];
  }): SessionRenderRow {
    const state = this.getSessionState(input.sessionKey);
    if (!state.hydrated) {
      this.ensureSessionHydrated(input.sessionKey, state);
    }
    const timestamp = Date.now();
    const message: SessionTranscriptMessage = {
      role: 'user' as const,
      content: input.message || (input.media && input.media.length > 0 ? '(file attached)' : ''),
      id: input.promptId,
      status: 'sending' as const,
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
    return buildRowsFromTranscriptMessage(input.sessionKey, message, {
      index: filterCoreRows(state.rows).length,
      status: 'pending',
      existingRows: filterCoreRows(state.rows),
    })[0]!;
  }

  consumeGatewayConversationEvent(payload: unknown): SessionUpdateEvent[] {
    const currentSessionKey = isRecord(payload) && isRecord(payload.event) && typeof payload.event.sessionKey === 'string'
      ? payload.event.sessionKey
      : '';
    const currentState = currentSessionKey ? this.getSessionState(currentSessionKey) : null;
    const translated = buildSessionUpdateEventsFromGatewayConversationEvent(payload, {
      existingRows: currentState ? filterCoreRows(currentState.rows) : undefined,
    });
    return translated.map((event) => {
      const sessionKey = normalizeString(event.sessionKey);
      if (!sessionKey) {
        const emptySnapshot: SessionStateSnapshot = {
          sessionKey: '',
          catalog: buildSessionCatalogItem({
            sessionKey: '',
            rows: [],
            runtime: createEmptySessionRuntimeState(),
          }),
          rows: [],
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
          sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_row_chunk' : 'session_row',
          sessionKey: event.sessionKey,
          runId: event.runId,
          row: null,
          snapshot: emptySnapshot,
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }
      this.activateSession(sessionKey);
      if (event.sessionUpdate === 'session_info_update') {
        this.resolveLifecycleRuntime(sessionKey, {
          phase: event.phase,
          runId: event.runId,
        });
        const state = this.getSessionState(sessionKey);
        const snapshot = this.buildSnapshot(sessionKey, state, {
          window: state.window.totalRowCount > 0
            ? state.window
            : createLatestWindowState(state.rows.length),
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
      const mergedRows = this.upsertSessionRows(sessionKey, event.rows);
      const runtimeSourceRow = mergedRows[mergedRows.length - 1] ?? event.rows[event.rows.length - 1] ?? null;
      if (runtimeSourceRow) {
        this.resolveMessageRuntime(sessionKey, {
          runId: event.runId,
          row: runtimeSourceRow,
          sessionUpdate: event.sessionUpdate,
        });
      }
      state.window = createLatestWindowState(state.rows.length);
      const snapshot = this.buildSnapshot(sessionKey, state, {
        window: state.window.totalRowCount > 0
          ? state.window
          : createLatestWindowState(state.rows.length),
        replayComplete: true,
      });
      const row = this.resolvePrimaryRowFromSnapshot(snapshot, runtimeSourceRow, event.rows);
      return {
        sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_row_chunk' : 'session_row',
        sessionKey: event.sessionKey,
        runId: event.runId,
        row,
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
      const rows = this.readTranscriptRows(descriptor.sessionKey);
      if (rows.length === 0) {
        continue;
      }
      sessionsByKey.set(descriptor.sessionKey, buildSessionCatalogItem({
        sessionKey: descriptor.sessionKey,
        rows,
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
        rows: state.rows,
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
        window: state.window.totalRowCount > 0
          ? state.window
          : createLatestWindowState(state.rows.length),
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
    return {
      status: 200,
      data: {
        snapshot: this.buildSnapshot(sessionKey, state, {
          window: state.window.totalRowCount > 0
            ? state.window
            : createLatestWindowState(state.rows.length),
          replayComplete: true,
        }),
      } satisfies SessionLoadResult,
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
    const [row] = this.upsertSessionRows(sessionKey, [this.buildPromptUserRow({
      sessionKey,
      promptId,
      message,
      media,
    })]);
    const runtime = this.setSessionRuntime(sessionKey, {
      sending: true,
      activeRunId: runId || null,
      runPhase: 'submitted',
      streamingMessageId: null,
      pendingFinal: false,
      lastUserMessageAt: row?.createdAt ?? Date.now(),
    });
    state.window = createLatestWindowState(state.rows.length);
    const snapshot = {
      ...this.buildLatestSnapshot(sessionKey, state),
      runtime,
    };
    const result: SessionPromptResult = {
      success: true,
      sessionKey,
      runId: runId || null,
      promptId,
      row: snapshot.rows.find((candidate) => (
        (row?.rowId && candidate.rowId === row.rowId)
        || (row?.key && candidate.key === row.key)
      )) ?? null,
      snapshot,
    };
    return {
      status: 200,
      data: result,
    };
  }
}
