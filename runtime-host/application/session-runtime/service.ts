import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractMessageText, normalizeOptionalString } from '../../shared/chat-message-normalization';
import type {
  SessionCatalogItem,
  SessionLoadResult,
  SessionListResult,
  SessionNewResult,
  SessionPromptResult,
  SessionRuntimeStateSnapshot,
  SessionStateSnapshot,
  SessionTimelineEntry,
  SessionTimelineEntryMessage,
  SessionTimelineEntryStatus,
  SessionUpdateEvent,
  SessionWindowStateSnapshot,
  SessionWindowResult,
} from '../../shared/session-adapter-types';
import {
  parseTranscriptMessages,
  resolveTranscriptSessionLabel,
  type SessionTranscriptMessage,
} from '../sessions/transcript-utils';
import { listIndexedSessions } from '../sessions/session-index';
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

interface GatewayConversationMessagePayload {
  state?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sequenceId?: unknown;
  requestId?: unknown;
  uniqueId?: unknown;
  agentId?: unknown;
  message?: unknown;
}

interface GatewayConversationLifecyclePayload {
  phase?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
}

interface SessionRuntimeTimelineState {
  entries: SessionTimelineEntry[];
  hydrated: boolean;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
}

interface PersistedSessionRuntimeStoreFile {
  version: 2;
  activeSessionKey: string | null;
  liveSessions: Array<{
    sessionKey: string;
    runtime: SessionRuntimeStateSnapshot;
  }>;
}

interface IndexedSessionDescriptor {
  sessionKey: string;
  transcriptPath: string | null;
  sessionsJsonPath: string;
  sessionsJson: Record<string, unknown>;
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

function normalizeSessionPhase(value: unknown): 'started' | 'final' | 'error' | 'aborted' | 'unknown' {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'started' || normalized === 'start') {
    return 'started';
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'finished' || normalized === 'final' || normalized === 'end') {
    return 'final';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'error';
  }
  if (normalized === 'aborted' || normalized === 'abort' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'aborted';
  }
  return 'unknown';
}

function normalizeSessionEntryStatus(value: unknown): SessionTimelineEntryStatus {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'delta' || normalized === 'stream' || normalized === 'streaming') {
    return 'streaming';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'error';
  }
  if (normalized === 'aborted' || normalized === 'abort' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'aborted';
  }
  if (normalized === 'pending') {
    return 'pending';
  }
  return 'final';
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
  totalEntryCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}): SessionWindowStateSnapshot {
  return {
    totalEntryCount: input.totalEntryCount,
    windowStartOffset: input.windowStartOffset,
    windowEndOffset: input.windowEndOffset,
    hasMore: input.hasMore,
    hasNewer: input.hasNewer,
    isAtLatest: input.isAtLatest,
  };
}

function createLatestWindowState(totalEntryCount: number): SessionWindowStateSnapshot {
  return createWindowStateSnapshot({
    totalEntryCount,
    windowStartOffset: 0,
    windowEndOffset: totalEntryCount,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  });
}

function createEmptyTimelineState(
  patch: Partial<SessionRuntimeTimelineState> = {},
): SessionRuntimeTimelineState {
  return {
    entries: [],
    hydrated: false,
    runtime: createEmptySessionRuntimeState(),
    window: createLatestWindowState(0),
    ...patch,
  };
}

function resolveLaneKey(agentId: string): string {
  return agentId ? `member:${agentId}` : 'main';
}

function resolveTurnIdentity(
  message: SessionTimelineEntryMessage,
  options: {
    runId?: string;
  } = {},
): string {
  return normalizeOptionalString(options.runId)
    ?? normalizeOptionalString(message.messageId ?? message.id)
    ?? '';
}

function resolveEntryId(
  message: SessionTimelineEntryMessage,
  index: number,
  options: {
    runId?: string;
    sequenceId?: number;
  } = {},
): string {
  return normalizeOptionalString(
    message.id
    ?? message.messageId,
  ) ?? (() => {
    const runId = normalizeOptionalString(options.runId);
    if (runId && typeof options.sequenceId === 'number' && Number.isFinite(options.sequenceId)) {
      return `run:${runId}:seq:${options.sequenceId}`;
    }
    if (runId) {
      return `run:${runId}:${message.role || 'message'}:${index}`;
    }
    return `entry-${index}`;
  })();
}

function toTimelineEntry(
  sessionKey: string,
  message: SessionTimelineEntryMessage,
  options: {
    runId?: string;
    sequenceId?: number;
    status?: SessionTimelineEntryStatus;
    index: number;
  },
): SessionTimelineEntry {
  const agentId = normalizeString(message.agentId);
  const laneKey = resolveLaneKey(agentId);
  const turnIdentity = resolveTurnIdentity(message, {
    runId: options.runId,
  });
  const entryId = resolveEntryId(message, options.index, {
    runId: options.runId,
    sequenceId: options.sequenceId,
  });
  return {
    entryId,
    sessionKey,
    laneKey,
    turnKey: turnIdentity ? `${laneKey}:${turnIdentity}` : `${laneKey}:entry:${entryId}`,
    role: message.role,
    status: options.status ?? 'final',
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(options.sequenceId != null ? { sequenceId: options.sequenceId } : {}),
    text: extractMessageText(message.content),
    message,
  };
}

function buildWindowRange(input: {
  totalMessageCount: number;
  mode: SessionWindowMode;
  limit: number;
  offset: number | null;
}): { start: number; end: number } {
  const { totalMessageCount, mode, limit, offset } = input;
  if (mode === 'older') {
    const anchor = Math.min(Math.max(offset ?? totalMessageCount, 0), totalMessageCount);
    return {
      start: Math.max(0, anchor - limit),
      end: Math.min(totalMessageCount, anchor + limit),
    };
  }
  if (mode === 'newer') {
    const start = Math.min(Math.max(offset ?? totalMessageCount, 0), totalMessageCount);
    return {
      start,
      end: Math.min(totalMessageCount, start + limit),
    };
  }
  return {
    start: Math.max(0, totalMessageCount - limit),
    end: totalMessageCount,
  };
}

function buildMemberMeta(agentId: string): Record<string, unknown> | undefined {
  if (!agentId) {
    return undefined;
  }
  return {
    'codebuddy.ai/memberEvent': agentId,
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

function cloneTimelineEntryMessage(
  message: SessionTimelineEntryMessage,
): SessionTimelineEntryMessage {
  return {
    ...message,
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls.map((item) => ({ ...item })) } : {}),
    ...(Array.isArray(message.toolCalls) ? { toolCalls: message.toolCalls.map((item) => ({ ...item })) } : {}),
    ...(Array.isArray(message.toolStatuses) ? { toolStatuses: message.toolStatuses.map((item) => ({ ...item })) } : {}),
    ...(Array.isArray(message._attachedFiles) ? { _attachedFiles: message._attachedFiles.map((item) => ({ ...item })) } : {}),
    ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
  };
}

function cloneTimelineEntry(entry: SessionTimelineEntry): SessionTimelineEntry {
  return {
    ...entry,
    message: cloneTimelineEntryMessage(entry.message),
  };
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

function mergeHydratedEntries(
  transcriptEntries: SessionTimelineEntry[],
  liveEntries: SessionTimelineEntry[],
): SessionTimelineEntry[] {
  let mergedEntries = transcriptEntries.map((entry) => cloneTimelineEntry(entry));
  for (const entry of liveEntries) {
    mergedEntries = upsertTimelineEntry(mergedEntries, entry);
  }
  return mergedEntries;
}

function sliceEntriesForWindow(
  entries: SessionTimelineEntry[],
  window: SessionWindowStateSnapshot,
): SessionTimelineEntry[] {
  if (entries.length === 0) {
    return [];
  }
  const start = Math.max(0, Math.min(window.windowStartOffset, entries.length));
  const end = Math.max(start, Math.min(window.windowEndOffset, entries.length));
  if (start === 0 && end === entries.length) {
    return entries.map((entry) => cloneTimelineEntry(entry));
  }
  return entries.slice(start, end).map((entry) => cloneTimelineEntry(entry));
}

function appendMonotonicText(currentText: string, incomingText: string): string {
  if (!incomingText) {
    return currentText;
  }
  if (!currentText) {
    return incomingText;
  }
  if (incomingText.startsWith(currentText)) {
    return incomingText;
  }
  if (currentText.startsWith(incomingText)) {
    return currentText;
  }

  const maxOverlap = Math.min(currentText.length, incomingText.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (currentText.endsWith(incomingText.slice(0, size))) {
      return `${currentText}${incomingText.slice(size)}`;
    }
  }

  return `${currentText}${incomingText}`;
}

function mergeAttachedFileRecords(
  existingFiles: Array<Record<string, unknown>> | undefined,
  incomingFiles: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  const merged: Array<Record<string, unknown>> = [];
  for (const file of existingFiles ?? []) {
    merged.push({ ...file });
  }
  for (const file of incomingFiles ?? []) {
    const exists = merged.some((candidate) => (
      candidate.fileName === file.fileName
      && candidate.mimeType === file.mimeType
      && candidate.fileSize === file.fileSize
      && (candidate.preview ?? null) === (file.preview ?? null)
      && (candidate.filePath ?? null) === (file.filePath ?? null)
    ));
    if (!exists) {
      merged.push({ ...file });
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function resolveMergedEntryText(
  existing: SessionTimelineEntry | null,
  incoming: SessionTimelineEntry,
): string {
  if (!existing) {
    return incoming.text;
  }
  if (incoming.status === 'streaming') {
    return appendMonotonicText(existing.text, incoming.text);
  }
  return incoming.text || existing.text;
}

function resolveMergedEntryContent(
  existing: SessionTimelineEntry | null,
  incoming: SessionTimelineEntry,
  mergedText: string,
): unknown {
  if (Array.isArray(incoming.message.content)) {
    return incoming.message.content;
  }
  if (typeof incoming.message.content === 'string' && incoming.message.content.trim()) {
    return incoming.message.content;
  }
  if (existing && Array.isArray(existing.message.content)) {
    return existing.message.content;
  }
  return mergedText;
}

function findTimelineEntryIndex(
  entries: SessionTimelineEntry[],
  incoming: SessionTimelineEntry,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.entryId === incoming.entryId) {
      return index;
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]!;
    if (
      candidate.role === incoming.role
      && (candidate.runId ?? null) === (incoming.runId ?? null)
      && (candidate.sequenceId ?? null) === (incoming.sequenceId ?? null)
      && candidate.laneKey === incoming.laneKey
      && candidate.turnKey === incoming.turnKey
    ) {
      return index;
    }
  }

  return -1;
}

function mergeTimelineEntry(
  existing: SessionTimelineEntry | null,
  incoming: SessionTimelineEntry,
): SessionTimelineEntry {
  const mergedText = resolveMergedEntryText(existing, incoming);
  const mergedMessage: SessionTimelineEntryMessage = {
    ...(existing ? cloneTimelineEntryMessage(existing.message) : {}),
    ...cloneTimelineEntryMessage(incoming.message),
    content: resolveMergedEntryContent(existing, incoming, mergedText),
    _attachedFiles: mergeAttachedFileRecords(
      existing?.message._attachedFiles,
      incoming.message._attachedFiles,
    ),
  };

  return {
    ...(existing ? cloneTimelineEntry(existing) : cloneTimelineEntry(incoming)),
    ...cloneTimelineEntry(incoming),
    entryId: existing?.entryId ?? incoming.entryId,
    laneKey: incoming.laneKey || existing?.laneKey || 'main',
    turnKey: incoming.turnKey || existing?.turnKey || `${incoming.laneKey || existing?.laneKey || 'main'}:${existing?.entryId ?? incoming.entryId}`,
    status: incoming.status,
    text: mergedText,
    message: mergedMessage,
  };
}

function upsertTimelineEntry(
  entries: SessionTimelineEntry[],
  incoming: SessionTimelineEntry,
): SessionTimelineEntry[] {
  const index = findTimelineEntryIndex(entries, incoming);
  if (index < 0) {
    return [...entries, cloneTimelineEntry(incoming)];
  }
  const nextEntries = [...entries];
  nextEntries[index] = mergeTimelineEntry(entries[index]!, incoming);
  return nextEntries;
}

function toTranscriptMessage(message: SessionTimelineEntryMessage): SessionTranscriptMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(message.id ? { id: message.id } : {}),
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
    ...(message.clientId ? { clientId: message.clientId } : {}),
    ...(message.uniqueId ? { uniqueId: message.uniqueId } : {}),
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.streaming != null ? { streaming: message.streaming } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
    ...(message.toolStatuses ? { toolStatuses: message.toolStatuses } : {}),
    ...(message.isError != null ? { isError: message.isError } : {}),
  };
}

function resolveSessionLabelFromEntries(entries: SessionTimelineEntry[]): string | null {
  return resolveTranscriptSessionLabel(entries.map((entry) => toTranscriptMessage(entry.message)));
}

function resolveLastActivityAt(entries: SessionTimelineEntry[], runtime: SessionRuntimeStateSnapshot): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const timestamp = entries[index]?.timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return typeof runtime.updatedAt === 'number' && Number.isFinite(runtime.updatedAt)
    ? runtime.updatedAt
    : undefined;
}

function resolveTranscriptEntryStatus(message: SessionTranscriptMessage): SessionTimelineEntryStatus {
  if (message.streaming) {
    return 'streaming';
  }
  if (message.isError || message.status === 'error') {
    return 'error';
  }
  if (message.status === 'sending' || message.status === 'timeout') {
    return 'pending';
  }
  return 'final';
}

function normalizeConversationMessagePayload(
  payload: GatewayConversationMessagePayload,
): { sessionKey: string | null; runId: string | null; sequenceId?: number; message: SessionTimelineEntryMessage | null; status: SessionTimelineEntryStatus } {
  const sessionKey = normalizeString(payload.sessionKey) || null;
  const runId = normalizeString(payload.runId) || null;
  const state = normalizeString(payload.state);
  const sequenceId = normalizeFiniteNumber(payload.sequenceId);
  const rawMessage = isRecord(payload.message) ? payload.message : null;
  if (!rawMessage) {
    return {
      sessionKey,
      runId,
      ...(sequenceId != null ? { sequenceId } : {}),
      message: null,
      status: normalizeSessionEntryStatus(state),
    };
  }

  const role = normalizeString(rawMessage.role) as SessionTimelineEntryMessage['role'];
  const content = Object.prototype.hasOwnProperty.call(rawMessage, 'content')
    ? rawMessage.content
    : '';
  const normalizedMessage: SessionTimelineEntryMessage = {
    role,
    content,
    ...(normalizeFiniteNumber(rawMessage.timestamp) != null ? { timestamp: normalizeFiniteNumber(rawMessage.timestamp) } : {}),
    ...(normalizeString(rawMessage.id) ? { id: normalizeString(rawMessage.id) } : {}),
    ...(normalizeString(rawMessage.messageId) ? { messageId: normalizeString(rawMessage.messageId) } : {}),
    ...(normalizeString(rawMessage.originMessageId) ? { originMessageId: normalizeString(rawMessage.originMessageId) } : {}),
    ...(normalizeString(rawMessage.clientId) ? { clientId: normalizeString(rawMessage.clientId) } : {}),
    ...(normalizeString(rawMessage.uniqueId ?? payload.uniqueId) ? { uniqueId: normalizeString(rawMessage.uniqueId ?? payload.uniqueId) } : {}),
    ...(normalizeString(rawMessage.requestId ?? payload.requestId) ? { requestId: normalizeString(rawMessage.requestId ?? payload.requestId) } : {}),
    ...(normalizeString(rawMessage.agentId ?? payload.agentId) ? { agentId: normalizeString(rawMessage.agentId ?? payload.agentId) } : {}),
    ...(normalizeString(rawMessage.toolCallId) ? { toolCallId: normalizeString(rawMessage.toolCallId) } : {}),
    ...(normalizeString(rawMessage.toolName ?? rawMessage.name) ? { toolName: normalizeString(rawMessage.toolName ?? rawMessage.name) } : {}),
    ...(Object.prototype.hasOwnProperty.call(rawMessage, 'details') ? { details: rawMessage.details } : {}),
    ...(typeof rawMessage.isError === 'boolean' ? { isError: rawMessage.isError } : {}),
  };

  return {
    sessionKey,
    runId,
    ...(sequenceId != null ? { sequenceId } : {}),
    message: normalizedMessage,
    status: normalizeSessionEntryStatus(state),
  };
}

export function buildSessionUpdateEventsFromGatewayConversationEvent(
  payload: unknown,
): SessionUpdateEvent[] {
  const input = isRecord(payload) ? payload : null;
  if (!input) {
    return [];
  }

  if (input.type === 'run.phase') {
    const lifecyclePayload = input as GatewayConversationLifecyclePayload;
    const sessionKey = normalizeString(lifecyclePayload.sessionKey) || null;
    const runId = normalizeString(lifecyclePayload.runId) || null;
    const phase = normalizeSessionPhase(lifecyclePayload.phase);
    return [{
      sessionUpdate: 'session_info_update',
      sessionKey,
      runId,
      phase,
      laneKey: 'main',
      runtime: createEmptySessionRuntimeState(),
      window: createLatestWindowState(0),
    }];
  }

  if (input.type !== 'chat.message') {
    return [];
  }

  const conversation = normalizeConversationMessagePayload(input.event as GatewayConversationMessagePayload);
  if (!conversation.message) {
    return [];
  }
  const laneKey = resolveLaneKey(normalizeString(conversation.message.agentId));
  const entry = toTimelineEntry(
    conversation.sessionKey ?? '',
    conversation.message,
    {
      runId: conversation.runId ?? undefined,
      sequenceId: conversation.sequenceId,
      status: conversation.status,
      index: 0,
    },
  );
  const meta = buildMemberMeta(normalizeString(conversation.message.agentId));
  if (conversation.status === 'streaming') {
    return [{
      sessionUpdate: 'agent_message_chunk',
      sessionKey: conversation.sessionKey,
      runId: conversation.runId,
      laneKey,
      entry,
      runtime: createEmptySessionRuntimeState(),
      window: createLatestWindowState(0),
      ...(meta ? { _meta: meta } : {}),
    }];
  }
  return [{
    sessionUpdate: 'agent_message',
    sessionKey: conversation.sessionKey,
    runId: conversation.runId,
    laneKey,
    entry,
    runtime: createEmptySessionRuntimeState(),
    window: createLatestWindowState(0),
    ...(meta ? { _meta: meta } : {}),
  }];
}

export class SessionRuntimeService {
  private readonly sessionStates = new Map<string, SessionRuntimeTimelineState>();
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

  private listIndexedSessionDescriptors(): IndexedSessionDescriptor[] {
    const configDir = this.deps.getOpenClawConfigDir();
    const agentsDir = join(configDir, 'agents');
    if (!existsSync(agentsDir)) {
      return [];
    }

    const descriptors: IndexedSessionDescriptor[] = [];
    for (const agentDirEntry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentDirEntry.isDirectory()) {
        continue;
      }
      const sessionsDir = join(agentsDir, agentDirEntry.name, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');
      if (!existsSync(sessionsJsonPath)) {
        continue;
      }

      let sessionsJson: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(readFileSync(sessionsJsonPath, 'utf8'));
        sessionsJson = isRecord(parsed) ? parsed : null;
      } catch {
        sessionsJson = null;
      }
      if (!sessionsJson) {
        continue;
      }

      for (const indexedSession of listIndexedSessions(sessionsJson, sessionsDir)) {
        descriptors.push({
          sessionKey: indexedSession.sessionKey,
          transcriptPath: indexedSession.transcriptPath,
          sessionsJsonPath,
          sessionsJson,
        });
      }
    }

    return descriptors;
  }

  private findIndexedSessionDescriptor(sessionKey: string): IndexedSessionDescriptor | null {
    return this.listIndexedSessionDescriptors().find((descriptor) => descriptor.sessionKey === sessionKey) ?? null;
  }

  private readTranscriptEntries(sessionKey: string): SessionTimelineEntry[] {
    const descriptor = this.findIndexedSessionDescriptor(sessionKey);
    if (!descriptor?.transcriptPath || !existsSync(descriptor.transcriptPath)) {
      return [];
    }

    let content = '';
    try {
      content = readFileSync(descriptor.transcriptPath, 'utf8');
    } catch {
      return [];
    }

    const messages = parseTranscriptMessages(content);
    return messages.map((message, index) => toTimelineEntry(sessionKey, message, {
      index,
      status: resolveTranscriptEntryStatus(message),
    }));
  }

  private ensureSessionHydrated(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    if (state.hydrated) {
      return;
    }

    state.entries = mergeHydratedEntries(
      this.readTranscriptEntries(sessionKey),
      state.entries,
    );
    state.hydrated = true;
    state.window = createLatestWindowState(state.entries.length);
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
    if (options.resetWindowToLatest) {
      state.window = createLatestWindowState(state.entries.length);
    }
    this.persistStore();
    return state;
  }

  private upsertSessionEntry(sessionKey: string, entry: SessionTimelineEntry): SessionTimelineEntry {
    const state = this.getSessionState(sessionKey);
    if (!state.hydrated) {
      this.ensureSessionHydrated(sessionKey, state);
    }
    state.entries = upsertTimelineEntry(state.entries, entry);
    state.window = createLatestWindowState(state.entries.length);
    this.persistStore();
    return cloneTimelineEntry(state.entries[findTimelineEntryIndex(state.entries, entry)]!);
  }

  private buildSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      entries?: SessionTimelineEntry[];
      window?: SessionWindowStateSnapshot;
      replayComplete?: boolean;
    } = {},
  ): SessionStateSnapshot {
    const window = cloneSessionWindowState(options.window ?? state.window);
    const entries = options.entries ?? sliceEntriesForWindow(state.entries, window);
    return {
      sessionKey,
      entries: entries.map((entry) => cloneTimelineEntry(entry)),
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
      entries: state.entries,
      window: createLatestWindowState(state.entries.length),
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
    const allEntries = state.entries.map((entry) => cloneTimelineEntry(entry));
    const totalEntryCount = allEntries.length;
    const { start, end } = buildWindowRange({
      totalMessageCount: totalEntryCount,
      mode: input.mode,
      limit: input.limit,
      offset: input.offset,
    });
    const window = createWindowStateSnapshot({
      totalEntryCount,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < totalEntryCount,
      isAtLatest: end >= totalEntryCount,
    });
    state.window = window;
    this.persistStore();
    return this.buildSnapshot(sessionKey, state, {
      entries: allEntries.slice(start, end),
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
    this.persistStore();
    return cloneSessionRuntimeState(state.runtime);
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
      entry: SessionTimelineEntry;
      sessionUpdate: 'agent_message_chunk' | 'agent_message';
    },
  ): SessionRuntimeStateSnapshot {
    const currentState = this.getSessionState(sessionKey);
    const messageTimestamp = input.entry.timestamp != null ? input.entry.timestamp : null;
    if (input.sessionUpdate === 'agent_message_chunk') {
      return this.setSessionRuntime(sessionKey, {
        sending: true,
        activeRunId: input.runId,
        runPhase: 'streaming',
        streamingMessageId: input.entry.entryId,
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
        lastUserMessageAt: typeof messageTimestamp === 'number'
          ? messageTimestamp
          : currentState.runtime.lastUserMessageAt,
      });
    }

    if (input.entry.role === 'tool_result' || input.entry.role === 'toolresult') {
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
    const message = {
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
    return toTimelineEntry(input.sessionKey, message, {
      index: state.entries.length,
      status: 'pending',
    });
  }

  consumeGatewayConversationEvent(payload: unknown): SessionUpdateEvent[] {
    const translated = buildSessionUpdateEventsFromGatewayConversationEvent(payload);
    return translated.map((event) => {
      const sessionKey = normalizeString(event.sessionKey);
      if (!sessionKey) {
        return event;
      }
      this.activateSession(sessionKey);
      if (event.sessionUpdate === 'session_info_update') {
        const runtime = this.resolveLifecycleRuntime(sessionKey, {
          phase: event.phase,
          runId: event.runId,
        });
        const state = this.getSessionState(sessionKey);
        return {
          ...event,
          runtime,
          window: cloneSessionWindowState(state.window),
        };
      }

      const mergedEntry = this.upsertSessionEntry(sessionKey, event.entry);
      const runtime = this.resolveMessageRuntime(sessionKey, {
        runId: event.runId,
        entry: mergedEntry,
        sessionUpdate: event.sessionUpdate,
      });
      const state = this.getSessionState(sessionKey);
      return {
        ...event,
        entry: mergedEntry,
        runtime,
        window: cloneSessionWindowState(state.window),
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
    const indexedDescriptor = this.findIndexedSessionDescriptor(sessionKey);
    if (!this.sessionStates.has(sessionKey) && !indexedDescriptor) {
      return {
        status: 404,
        data: { success: false, error: `Unknown sessionKey: ${sessionKey}` },
      };
    }

    if (indexedDescriptor) {
      if (indexedDescriptor.transcriptPath && existsSync(indexedDescriptor.transcriptPath)) {
        const deletedPath = this.deps.resolveDeletedPath?.(indexedDescriptor.transcriptPath);
        if (deletedPath && deletedPath !== indexedDescriptor.transcriptPath) {
          mkdirSync(dirname(deletedPath), { recursive: true });
          renameSync(indexedDescriptor.transcriptPath, deletedPath);
        } else {
          rmSync(indexedDescriptor.transcriptPath, { force: true });
        }
      }

      const nextSessionsJson = Array.isArray(indexedDescriptor.sessionsJson.sessions)
        ? {
            ...indexedDescriptor.sessionsJson,
            sessions: indexedDescriptor.sessionsJson.sessions.filter((candidate) => {
              if (!isRecord(candidate)) {
                return true;
              }
              const candidateKey = typeof candidate.key === 'string'
                ? candidate.key.trim()
                : (typeof candidate.sessionKey === 'string' ? candidate.sessionKey.trim() : '');
              return candidateKey !== sessionKey;
            }),
          }
        : Object.fromEntries(
            Object.entries(indexedDescriptor.sessionsJson).filter(([candidateKey]) => candidateKey !== sessionKey),
          );
      writeFileSync(indexedDescriptor.sessionsJsonPath, JSON.stringify(nextSessionsJson, null, 2), 'utf8');
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

    for (const descriptor of this.listIndexedSessionDescriptors()) {
      if (!descriptor.transcriptPath || !existsSync(descriptor.transcriptPath)) {
        continue;
      }
      const entries = this.readTranscriptEntries(descriptor.sessionKey);
      if (entries.length === 0) {
        continue;
      }
      const label = resolveSessionLabelFromEntries(entries) ?? undefined;
      const updatedAt = resolveLastActivityAt(entries, createEmptySessionRuntimeState());
      sessionsByKey.set(descriptor.sessionKey, {
        key: descriptor.sessionKey,
        ...(label ? { label } : {}),
        displayName: descriptor.sessionKey,
        ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
      });
    }

    for (const [sessionKey, state] of this.sessionStates.entries()) {
      if (
        !this.findIndexedSessionDescriptor(sessionKey)
        && !shouldExposeRuntimeOnlySession(state.runtime)
      ) {
        continue;
      }
      const label = state.entries.length > 0
        ? resolveSessionLabelFromEntries(state.entries) ?? undefined
        : undefined;
      const updatedAt = resolveLastActivityAt(state.entries, state.runtime);
      sessionsByKey.set(sessionKey, {
        key: sessionKey,
        ...(label ? { label } : {}),
        displayName: sessionKey,
        ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
      });
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
        window: state.window.totalEntryCount > 0
          ? state.window
          : createLatestWindowState(state.entries.length),
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
          window: state.window.totalEntryCount > 0
            ? state.window
            : createLatestWindowState(state.entries.length),
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
    const entry = this.upsertSessionEntry(sessionKey, this.buildPromptUserEntry({
      sessionKey,
      promptId,
      message,
      media,
    }));
    const runtime = this.setSessionRuntime(sessionKey, {
      sending: true,
      activeRunId: runId || null,
      runPhase: 'submitted',
      streamingMessageId: null,
      pendingFinal: false,
      lastUserMessageAt: entry.timestamp ?? Date.now(),
    });
    const result: SessionPromptResult = {
      success: true,
      sessionKey,
      runId: runId || null,
      promptId,
      entry,
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
}
