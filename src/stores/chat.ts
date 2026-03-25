/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import intermediateToolFillerBlacklistConfig from '@/constants/intermediate-tool-filler-blacklist.json';
import { useGatewayStore } from './gateway';
import { buildCronSessionHistoryPath, isCronSessionKey } from './chat/cron-session-utils';

// ── Types ────────────────────────────────────────────────────────

/** Metadata for locally-attached files (not from Gateway) */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  filePath?: string;
}

/** Raw message from OpenClaw chat.history */
export interface RawMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult';
  content: unknown; // string | ContentBlock[]
  timestamp?: number;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  /** Local-only: file metadata for user-uploaded attachments (not sent to/from Gateway) */
  _attachedFiles?: AttachedFileMeta[];
}

/** Content block inside a message */
export interface ContentBlock {
  type: 'text' | 'image' | 'thinking' | 'tool_use' | 'tool_result' | 'toolCall' | 'toolResult';
  text?: string;
  thinking?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  /** Flat image format from Gateway tool results (no source wrapper) */
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

/** Session from sessions.list */
export interface ChatSession {
  key: string;
  label?: string;
  displayName?: string;
  thinkingLevel?: string;
  model?: string;
  updatedAt?: number;
}

export interface ToolStatus {
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  summary?: string;
  updatedAt: number;
}

export type ApprovalStatus = 'idle' | 'awaiting_approval';
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface ApprovalItem {
  id: string;
  sessionKey: string;
  runId?: string;
  toolName?: string;
  createdAtMs: number;
  expiresAtMs?: number;
  decision?: ApprovalDecision;
}

interface SessionRuntimeSnapshot {
  messages: RawMessage[];
  sending: boolean;
  activeRunId: string | null;
  streamingText: string;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  pendingToolImages: AttachedFileMeta[];
  approvalStatus: ApprovalStatus;
}

interface ChatState {
  // Messages
  messages: RawMessage[];
  loading: boolean;
  error: string | null;

  // Streaming
  sending: boolean;
  activeRunId: string | null;
  streamingText: string;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  /** Images collected from tool results, attached to the next assistant message */
  pendingToolImages: AttachedFileMeta[];
  approvalStatus: ApprovalStatus;
  pendingApprovalsBySession: Record<string, ApprovalItem[]>;

  // Sessions
  sessions: ChatSession[];
  currentSessionKey: string;
  /** First user message text per session key, used as display label */
  sessionLabels: Record<string, string>;
  /** Last message timestamp (ms) per session key, used for sorting */
  sessionLastActivity: Record<string, number>;
  /** Per-session runtime snapshot to avoid blank UI while switching sessions */
  sessionRuntimeByKey: Record<string, SessionRuntimeSnapshot>;

  // Thinking
  showThinking: boolean;
  thinkingLevel: string | null;

  // Actions
  loadSessions: () => Promise<void>;
  switchSession: (key: string) => void;
  newSession: (agentId?: string) => void;
  deleteSession: (key: string) => Promise<void>;
  cleanupEmptySession: () => void;
  loadHistory: (quiet?: boolean) => Promise<void>;
  sendMessage: (text: string, attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>) => Promise<void>;
  abortRun: () => Promise<void>;
  handleApprovalRequested: (payload: Record<string, unknown>) => void;
  handleApprovalResolved: (payload: Record<string, unknown>) => void;
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  syncPendingApprovals: (sessionKeyHint?: string) => Promise<void>;
  handleChatEvent: (event: Record<string, unknown>) => void;
  toggleThinking: () => void;
  refresh: () => Promise<void>;
  clearError: () => void;
}

// Module-level timestamp tracking the last chat event received.
// Used by the safety timeout to avoid false-positive "no response" errors
// during tool-use conversations where streamingMessage is temporarily cleared
// between tool-result finals and the next delta.
let _lastChatEventAt = 0;

/** Normalize a timestamp to milliseconds. Handles both seconds and ms. */
function toMs(ts: number): number {
  // Timestamps < 1e12 are in seconds (before ~2033); >= 1e12 are milliseconds
  return ts < 1e12 ? ts * 1000 : ts;
}

function scheduleNextFrame(task: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => task());
    return;
  }
  setTimeout(task, 16);
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function areAttachedFilesEqual(
  left: AttachedFileMeta[] | undefined,
  right: AttachedFileMeta[] | undefined,
): boolean {
  const leftItems = Array.isArray(left) ? left : [];
  const rightItems = Array.isArray(right) ? right : [];
  if (leftItems.length !== rightItems.length) {
    return false;
  }
  for (let index = 0; index < leftItems.length; index += 1) {
    const a = leftItems[index];
    const b = rightItems[index];
    if (
      a.fileName !== b.fileName
      || a.mimeType !== b.mimeType
      || a.fileSize !== b.fileSize
      || (a.preview ?? null) !== (b.preview ?? null)
      || (a.filePath ?? null) !== (b.filePath ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function areMessagesEquivalent(left: RawMessage[], right: RawMessage[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      (a.id ?? null) !== (b.id ?? null)
      || a.role !== b.role
      || (a.timestamp ?? null) !== (b.timestamp ?? null)
      || (a.toolCallId ?? null) !== (b.toolCallId ?? null)
      || (a.toolName ?? null) !== (b.toolName ?? null)
      || (a.isError ?? null) !== (b.isError ?? null)
    ) {
      return false;
    }
    if (safeStableStringify(a.content) !== safeStableStringify(b.content)) {
      return false;
    }
    if (!areAttachedFilesEqual(a._attachedFiles, b._attachedFiles)) {
      return false;
    }
  }

  return true;
}

function areSessionsEquivalent(left: ChatSession[], right: ChatSession[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.key !== b.key
      || (a.label ?? null) !== (b.label ?? null)
      || (a.displayName ?? null) !== (b.displayName ?? null)
      || (a.thinkingLevel ?? null) !== (b.thinkingLevel ?? null)
      || (a.model ?? null) !== (b.model ?? null)
      || (a.updatedAt ?? null) !== (b.updatedAt ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function buildHistoryFingerprint(messages: RawMessage[], thinkingLevel: string | null): string {
  const count = messages.length;
  const first = count > 0 ? messages[0] : null;
  const last = count > 0 ? messages[count - 1] : null;
  return [
    count,
    thinkingLevel ?? '',
    first?.id ?? '',
    first?.role ?? '',
    first?.timestamp ?? '',
    last?.id ?? '',
    last?.role ?? '',
    last?.timestamp ?? '',
  ].join('|');
}

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function buildQuickRawHistoryFingerprint(messages: RawMessage[], thinkingLevel: string | null): string {
  const count = messages.length;
  if (count === 0) {
    return hashStringDjb2(`0|${thinkingLevel ?? ''}`);
  }

  const sampleStride = Math.max(1, Math.floor(count / 6));
  const parts: string[] = [String(count), String(sampleStride), thinkingLevel ?? ''];
  for (let index = 0; index < count; index += sampleStride) {
    const msg = messages[index];
    parts.push([
      msg?.id ?? '',
      msg?.role ?? '',
      msg?.timestamp ?? '',
      msg?.toolCallId ?? '',
      msg?.toolName ?? '',
      msg?.isError ? '1' : '0',
    ].join(':'));
  }
  if ((count - 1) % sampleStride !== 0) {
    const tail = messages[count - 1];
    parts.push([
      tail?.id ?? '',
      tail?.role ?? '',
      tail?.timestamp ?? '',
      tail?.toolCallId ?? '',
      tail?.toolName ?? '',
      tail?.isError ? '1' : '0',
    ].join(':'));
  }

  return hashStringDjb2(parts.join('|'));
}

// Timer for fallback history polling during active sends.
// If no streaming events arrive within a few seconds, we periodically
// poll chat.history to surface intermediate tool-call turns.
let _historyPollTimer: ReturnType<typeof setTimeout> | null = null;
const CHAT_HISTORY_FULL_LIMIT = 200;
const CHAT_HISTORY_QUIET_PROBE_LIMIT = 64;
const CHAT_HISTORY_QUIET_FULL_LIMIT = 120;
const _historyFingerprintBySession = new Map<string, string>();
const _historyProbeFingerprintBySession = new Map<string, string>();
const _historyQuickFingerprintBySession = new Map<string, string>();

// Timer for delayed error finalization. When the Gateway reports a mid-stream
// error (e.g. "terminated"), it may retry internally and recover. We wait
// before committing the error to give the recovery path a chance.
let _errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

function clearErrorRecoveryTimer(): void {
  if (_errorRecoveryTimer) {
    clearTimeout(_errorRecoveryTimer);
    _errorRecoveryTimer = null;
  }
}

function clearHistoryPoll(): void {
  if (_historyPollTimer) {
    clearTimeout(_historyPollTimer);
    _historyPollTimer = null;
  }
}

const DEFAULT_CANONICAL_PREFIX = 'agent:main';
const DEFAULT_SESSION_KEY = `${DEFAULT_CANONICAL_PREFIX}:main`;
const SESSION_HYDRATE_HEAD_LIMIT = 80;
const SESSION_HYDRATE_BACKGROUND_LIMIT = 80;
const SESSION_HYDRATE_HEAD_BATCH_SIZE = 2;
const SESSION_HYDRATE_BACKGROUND_DELAY_MS = 120;

interface SessionHydrationRecord {
  sessionKey: string;
  label: string | null;
  lastActivity: number | null;
}

let _sessionHydrationRunId = 0;
let _sessionHydrationTimer: ReturnType<typeof setTimeout> | null = null;

function clearSessionHydrationTimer(): void {
  if (_sessionHydrationTimer) {
    clearTimeout(_sessionHydrationTimer);
    _sessionHydrationTimer = null;
  }
}

async function fetchSessionHydrationRecord(
  sessionKey: string,
  limit: number,
): Promise<SessionHydrationRecord | null> {
  try {
    const response = await useGatewayStore.getState().rpc<Record<string, unknown>>(
      'chat.history',
      { sessionKey, limit },
    );
    const messages = Array.isArray(response.messages) ? response.messages as RawMessage[] : [];
    const lastMessage = messages[messages.length - 1];
    const resolvedLabel = resolveSessionLabelFromMessages(messages);
    const lastActivity = lastMessage?.timestamp ? toMs(lastMessage.timestamp) : null;
    return {
      sessionKey,
      label: resolvedLabel || null,
      lastActivity,
    };
  } catch {
    return null;
  }
}

// ── Local image cache ─────────────────────────────────────────
// The Gateway doesn't store image attachments in session content blocks,
// so we cache them locally keyed by staged file path (which appears in the
// [media attached: <path> ...] reference in the Gateway's user message text).
// Keying by path avoids the race condition of keying by runId (which is only
// available after the RPC returns, but history may load before that).
const IMAGE_CACHE_KEY = 'clawx:image-cache';
const IMAGE_CACHE_MAX = 100; // max entries to prevent unbounded growth

function loadImageCache(): Map<string, AttachedFileMeta> {
  try {
    const raw = localStorage.getItem(IMAGE_CACHE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as Array<[string, AttachedFileMeta]>;
      return new Map(entries);
    }
  } catch { /* ignore parse errors */ }
  return new Map();
}

function saveImageCache(cache: Map<string, AttachedFileMeta>): void {
  try {
    // Evict oldest entries if over limit
    const entries = Array.from(cache.entries());
    const trimmed = entries.length > IMAGE_CACHE_MAX
      ? entries.slice(entries.length - IMAGE_CACHE_MAX)
      : entries;
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(trimmed));
  } catch { /* ignore quota errors */ }
}

const _imageCache = loadImageCache();
const SESSION_LABEL_MAX_LENGTH = 50;
const ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS: RegExp[] = [
  /^a new session was started via\b/i,
  /^##\s*task manager\b/i,
  /^task manager.*(恢复提示|动态切换建议)/i,
  /^检测到多个待确认任务/i,
];
const INTERMEDIATE_TOOL_FILLER_BLACKLIST = buildIntermediateToolFillerBlacklist(
  intermediateToolFillerBlacklistConfig,
);
const INTERMEDIATE_TOOL_PHRASE_STATS_KEY = 'clawx:intermediate-tool-phrase-stats:v1';
const INTERMEDIATE_TOOL_PHRASE_STATS_MAX_ITEMS = 200;
const INTERMEDIATE_TOOL_PHRASE_TRACK_MAX_LENGTH = 120;
const INTERMEDIATE_TOOL_PHRASE_REPORT_COUNTS = new Set([3, 5, 10, 20, 50]);

interface IntermediateToolPhraseStat {
  sample: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

type IntermediateToolPhraseStats = Record<string, IntermediateToolPhraseStat>;

function buildIntermediateToolFillerBlacklist(source: unknown): Set<string> {
  if (!Array.isArray(source)) return new Set<string>();
  const normalized = source
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeIntermediateToolPhrase(item))
    .filter((item) => item.length > 0);
  return new Set<string>(normalized);
}

function loadIntermediateToolPhraseStats(): IntermediateToolPhraseStats {
  try {
    const raw = localStorage.getItem(INTERMEDIATE_TOOL_PHRASE_STATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as IntermediateToolPhraseStats;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveIntermediateToolPhraseStats(stats: IntermediateToolPhraseStats): void {
  try {
    const entries = Object.entries(stats);
    entries.sort((a, b) => {
      const countDiff = (b[1]?.count ?? 0) - (a[1]?.count ?? 0);
      if (countDiff !== 0) return countDiff;
      return (b[1]?.lastSeenAt ?? 0) - (a[1]?.lastSeenAt ?? 0);
    });
    const trimmed = entries.slice(0, INTERMEDIATE_TOOL_PHRASE_STATS_MAX_ITEMS);
    localStorage.setItem(INTERMEDIATE_TOOL_PHRASE_STATS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // 忽略 localStorage 配额或序列化错误
  }
}

/** Extract plain text from message content (string or content blocks) */
function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n');
  }
  return '';
}

function getAssistantText(message: RawMessage | undefined): string {
  if (!message || typeof message !== 'object') return '';
  const fromContent = getMessageText(message.content).trim();
  if (fromContent) return fromContent;
  const row = message as unknown as Record<string, unknown>;
  return typeof row.text === 'string' ? row.text.trim() : '';
}

function hasAssistantToolCall(message: RawMessage | undefined): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_use' || block.type === 'toolCall') return true;
    }
  }
  const row = message as unknown as Record<string, unknown>;
  const toolCalls = row.tool_calls ?? row.toolCalls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function normalizeIntermediateToolPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'“”]/g, '')
    .replace(/[，。！!？?、,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldTrackIntermediateToolPhrase(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > INTERMEDIATE_TOOL_PHRASE_TRACK_MAX_LENGTH) return false;
  return !trimmed.includes('\n');
}

function recordIntermediateToolPhrase(text: string): void {
  if (!shouldTrackIntermediateToolPhrase(text)) return;
  const normalized = normalizeIntermediateToolPhrase(text);
  if (!normalized) return;

  const now = Date.now();
  const stats = loadIntermediateToolPhraseStats();
  const current = stats[normalized];
  const nextCount = (current?.count ?? 0) + 1;
  stats[normalized] = {
    sample: text.trim().slice(0, INTERMEDIATE_TOOL_PHRASE_TRACK_MAX_LENGTH),
    count: nextCount,
    firstSeenAt: current?.firstSeenAt ?? now,
    lastSeenAt: now,
  };
  saveIntermediateToolPhraseStats(stats);

  if (INTERMEDIATE_TOOL_PHRASE_REPORT_COUNTS.has(nextCount)) {
    console.info(`[chat] 中间工具套话高频出现 (${nextCount}): ${stats[normalized].sample}`);
  }
}

function isBlacklistedIntermediateToolPhrase(text: string): boolean {
  const normalized = normalizeIntermediateToolPhrase(text);
  return normalized.length > 0 && INTERMEDIATE_TOOL_FILLER_BLACKLIST.has(normalized);
}

function stripAssistantTextForToolFiller(message: RawMessage): RawMessage {
  const row = message as unknown as Record<string, unknown>;
  const nextRow: Record<string, unknown> = { ...row };
  let changed = false;

  if (typeof nextRow.content === 'string') {
    if (nextRow.content.trim().length > 0) {
      nextRow.content = '';
      changed = true;
    }
  } else if (Array.isArray(nextRow.content)) {
    const nextContent = (nextRow.content as ContentBlock[]).filter((block) => block.type !== 'text');
    if (nextContent.length !== nextRow.content.length) {
      nextRow.content = nextContent;
      changed = true;
    }
  }

  if (typeof nextRow.text === 'string' && nextRow.text.trim().length > 0) {
    nextRow.text = '';
    changed = true;
  }

  return changed ? nextRow as unknown as RawMessage : message;
}

function createIntermediateToolTurnSnapshot(
  message: RawMessage,
  id: string,
): RawMessage {
  const normalizedMessage: RawMessage = {
    ...message,
    role: 'assistant',
    id,
  };
  if (!hasAssistantToolCall(normalizedMessage)) {
    return normalizedMessage;
  }
  return stripAssistantTextForToolFiller(normalizedMessage);
}

function shouldTreatAsIntermediateToolTurn(
  message: RawMessage | undefined,
  nextMessage?: RawMessage,
  requireFollower = false,
): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (!hasAssistantToolCall(message)) return false;
  if (!getAssistantText(message)) return false;
  if (!requireFollower) return true;
  if (!nextMessage) return false;
  if (isToolResultRole(nextMessage.role)) return true;
  return nextMessage.role === 'assistant';
}

function sanitizeIntermediateToolFillerMessage(
  message: RawMessage,
  options?: {
    nextMessage?: RawMessage;
    requireFollower?: boolean;
    trackPhrase?: boolean;
  },
): RawMessage {
  const requireFollower = options?.requireFollower ?? false;
  if (!shouldTreatAsIntermediateToolTurn(message, options?.nextMessage, requireFollower)) {
    return message;
  }

  const text = getAssistantText(message);
  if (!text) return message;
  if (options?.trackPhrase) {
    recordIntermediateToolPhrase(text);
  }
  if (!isBlacklistedIntermediateToolPhrase(text)) {
    return message;
  }
  return stripAssistantTextForToolFiller(message);
}

function normalizeSessionLabelText(text: string): string {
  const cleaned = text
    .replace(/\[media attached:[^\]]+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '(file attached)') {
    return '';
  }
  if (cleaned.length <= SESSION_LABEL_MAX_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, SESSION_LABEL_MAX_LENGTH)}…`;
}

function shouldIgnoreAssistantSessionLabel(text: string): boolean {
  if (!text) {
    return true;
  }
  return ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

function resolveSessionLabelFromMessages(messages: RawMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const candidate = normalizeSessionLabelText(getMessageText(message.content));
    if (candidate) {
      return candidate;
    }
  }
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const candidate = normalizeSessionLabelText(getMessageText(message.content));
    if (candidate && !shouldIgnoreAssistantSessionLabel(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Extract media file refs from [media attached: <path> (<mime>) | ...] patterns */
function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

/** Map common file extensions to MIME types */
function mimeFromExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
    'svg': 'image/svg+xml',
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'md': 'text/markdown',
    'rtf': 'application/rtf',
    'epub': 'application/epub+zip',
    // Archives
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
    'rar': 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    // Video
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'm4v': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Extract raw file paths from message text.
 * Detects absolute paths (Unix: / or ~/, Windows: C:\ etc.) ending with common file extensions.
 * Handles both image and non-image files, consistent with channel push message behavior.
 */
function extractRawFilePaths(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const seen = new Set<string>();
  const exts = 'png|jpe?g|gif|webp|bmp|avif|svg|pdf|docx?|xlsx?|pptx?|txt|csv|md|rtf|epub|zip|tar|gz|rar|7z|mp3|wav|ogg|aac|flac|m4a|mp4|mov|avi|mkv|webm|m4v';
  // Unix absolute paths (/... or ~/...) — lookbehind rejects mid-token slashes
  // (e.g. "path/to/file.mp4", "https://example.com/file.mp4")
  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  // Windows absolute paths (C:\... D:\...) — lookbehind rejects drive letter glued to a word
  const winRegex = new RegExp(`(?<![\\w])([A-Za-z]:\\\\[^\\s\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  for (const regex of [unixRegex, winRegex]) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        refs.push({ filePath: p, mimeType: mimeFromExtension(p) });
      }
    }
  }
  return refs;
}

/**
 * Extract images from a content array (including nested tool_result content).
 * Converts them to AttachedFileMeta entries with preview set to data URL or remote URL.
 */
function extractImagesAsAttachedFiles(content: unknown): AttachedFileMeta[] {
  if (!Array.isArray(content)) return [];
  const files: AttachedFileMeta[] = [];

  for (const block of content as ContentBlock[]) {
    if (block.type === 'image') {
      // Path 1: Anthropic source-wrapped format {source: {type, media_type, data}}
      if (block.source) {
        const src = block.source;
        const mimeType = src.media_type || 'image/jpeg';

        if (src.type === 'base64' && src.data) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: `data:${mimeType};base64,${src.data}`,
          });
        } else if (src.type === 'url' && src.url) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: src.url,
          });
        }
      }
      // Path 2: Flat format from Gateway tool results {data, mimeType}
      else if (block.data) {
        const mimeType = block.mimeType || 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
        });
      }
    }
    // Recurse into tool_result content blocks
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content) {
      files.push(...extractImagesAsAttachedFiles(block.content));
    }
  }
  return files;
}

/**
 * Build an AttachedFileMeta entry for a file ref, using cache if available.
 */
function makeAttachedFile(ref: { filePath: string; mimeType: string }): AttachedFileMeta {
  const cached = _imageCache.get(ref.filePath);
  if (cached) return { ...cached, filePath: ref.filePath };
  const fileName = ref.filePath.split(/[\\/]/).pop() || 'file';
  return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath };
}

/**
 * Extract file path from a tool call's arguments by toolCallId.
 * Searches common argument names: file_path, filePath, path, file.
 */
function getToolCallFilePath(msg: RawMessage, toolCallId: string): string | undefined {
  if (!toolCallId) return undefined;

  // Anthropic/normalized format — toolCall blocks in content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id === toolCallId) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
          if (typeof fp === 'string') return fp;
        }
      }
    }
  }

  // OpenAI format — tool_calls array on the message itself
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      if (tc.id !== toolCallId) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
        if (typeof fp === 'string') return fp;
      }
    }
  }

  return undefined;
}

/**
 * Collect all tool call file paths from a message into a Map<toolCallId, filePath>.
 */
function collectToolCallPaths(msg: RawMessage, paths: Map<string, string>): void {
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
          if (typeof fp === 'string') paths.set(block.id, fp);
        }
      }
    }
  }
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const id = typeof tc.id === 'string' ? tc.id : '';
      if (!id) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
        if (typeof fp === 'string') paths.set(id, fp);
      }
    }
  }
}

/**
 * Before filtering tool_result messages from history, scan them for any file/image
 * content and attach those to the immediately following assistant message.
 * This mirrors channel push message behavior where tool outputs surface files to the UI.
 * Handles:
 *   - Image content blocks (base64 / url)
 *   - [media attached: path (mime) | path] text patterns in tool result output
 *   - Raw file paths in tool result text
 */
function enrichWithToolResultFiles(messages: RawMessage[]): RawMessage[] {
  const pending: AttachedFileMeta[] = [];
  const toolCallPaths = new Map<string, string>();

  return messages.map((msg) => {
    // Track file paths from assistant tool call arguments for later matching
    if (msg.role === 'assistant') {
      collectToolCallPaths(msg, toolCallPaths);
    }

    if (isToolResultRole(msg.role)) {
      // Resolve file path from the matching tool call
      const matchedPath = msg.toolCallId ? toolCallPaths.get(msg.toolCallId) : undefined;

      // 1. Image/file content blocks in the structured content array
      const imageFiles = extractImagesAsAttachedFiles(msg.content);
      if (matchedPath) {
        for (const f of imageFiles) {
          if (!f.filePath) {
            f.filePath = matchedPath;
            f.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
          }
        }
      }
      pending.push(...imageFiles);

      // 2. [media attached: ...] patterns in tool result text output
      const text = getMessageText(msg.content);
      if (text) {
        const mediaRefs = extractMediaRefs(text);
        const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
        for (const ref of mediaRefs) {
          pending.push(makeAttachedFile(ref));
        }
        // 3. Raw file paths in tool result text (documents, audio, video, etc.)
        for (const ref of extractRawFilePaths(text)) {
          if (!mediaRefPaths.has(ref.filePath)) {
            pending.push(makeAttachedFile(ref));
          }
        }
      }

      return msg; // will be filtered later
    }

    if (msg.role === 'assistant' && pending.length > 0) {
      const toAttach = pending.splice(0);
      // Deduplicate against files already on the assistant message
      const existingPaths = new Set(
        (msg._attachedFiles || []).map(f => f.filePath).filter(Boolean),
      );
      const newFiles = toAttach.filter(f => !f.filePath || !existingPaths.has(f.filePath));
      if (newFiles.length === 0) return msg;
      return {
        ...msg,
        _attachedFiles: [...(msg._attachedFiles || []), ...newFiles],
      };
    }

    return msg;
  });
}

/**
 * Restore _attachedFiles for messages loaded from history.
 * Handles:
 *   1. [media attached: path (mime) | path] patterns (attachment-button flow)
 *   2. Raw image file paths typed in message text (e.g. /Users/.../image.png)
 * Uses local cache for previews when available; missing previews are loaded async.
 */
function enrichWithCachedImages(messages: RawMessage[]): RawMessage[] {
  return messages.map((msg, idx) => {
    // Only process user and assistant messages; skip if already enriched
    if ((msg.role !== 'user' && msg.role !== 'assistant') || msg._attachedFiles) return msg;
    const text = getMessageText(msg.content);

    // Path 1: [media attached: path (mime) | path] — guaranteed format from attachment button
    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));

    // Path 2: Raw file paths.
    // For assistant messages: scan own text AND the nearest preceding user message text,
    // but only for non-tool-only assistant messages (i.e. the final answer turn).
    // Tool-only messages (thinking + tool calls) should not show file previews — those
    // belong to the final answer message that comes after the tool results.
    // User messages never get raw-path previews so the image is not shown twice.
    let rawRefs: Array<{ filePath: string; mimeType: string }> = [];
    if (msg.role === 'assistant' && !isToolOnlyMessage(msg)) {
      // Own text
      rawRefs = extractRawFilePaths(text).filter(r => !mediaRefPaths.has(r.filePath));

      // Nearest preceding user message text (look back up to 5 messages)
      const seenPaths = new Set(rawRefs.map(r => r.filePath));
      for (let i = idx - 1; i >= Math.max(0, idx - 5); i--) {
        const prev = messages[i];
        if (!prev) break;
        if (prev.role === 'user') {
          const prevText = getMessageText(prev.content);
          for (const ref of extractRawFilePaths(prevText)) {
            if (!mediaRefPaths.has(ref.filePath) && !seenPaths.has(ref.filePath)) {
              seenPaths.add(ref.filePath);
              rawRefs.push(ref);
            }
          }
          break; // only use the nearest user message
        }
      }
    }

    const allRefs = [...mediaRefs, ...rawRefs];
    if (allRefs.length === 0) return msg;

    const files: AttachedFileMeta[] = allRefs.map(ref => {
      const cached = _imageCache.get(ref.filePath);
      if (cached) return { ...cached, filePath: ref.filePath };
      const fileName = ref.filePath.split(/[\\/]/).pop() || 'file';
      return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath };
    });
    return { ...msg, _attachedFiles: files };
  });
}

/**
 * Async: load missing previews from disk via IPC for messages that have
 * _attachedFiles with null previews. Updates messages in-place and triggers re-render.
 * Handles both [media attached: ...] patterns and raw filePath entries.
 */
async function loadMissingPreviews(messages: RawMessage[]): Promise<boolean> {
  // Collect all image paths that need previews
  const needPreview: Array<{ filePath: string; mimeType: string }> = [];
  const seenPaths = new Set<string>();

  for (const msg of messages) {
    if (!msg._attachedFiles) continue;

    // Path 1: files with explicit filePath field (raw path detection or enriched refs)
    for (const file of msg._attachedFiles) {
      const fp = file.filePath;
      if (!fp || seenPaths.has(fp)) continue;
      // Images: need preview. Non-images: need file size (for FileCard display).
      const needsLoad = file.mimeType.startsWith('image/')
        ? !file.preview
        : file.fileSize === 0;
      if (needsLoad) {
        seenPaths.add(fp);
        needPreview.push({ filePath: fp, mimeType: file.mimeType });
      }
    }

    // Path 2: [media attached: ...] patterns (legacy — in case filePath wasn't stored)
    if (msg.role === 'user') {
      const text = getMessageText(msg.content);
      const refs = extractMediaRefs(text);
      for (let i = 0; i < refs.length; i++) {
        const file = msg._attachedFiles[i];
        const ref = refs[i];
        if (!file || !ref || seenPaths.has(ref.filePath)) continue;
        const needsLoad = ref.mimeType.startsWith('image/') ? !file.preview : file.fileSize === 0;
        if (needsLoad) {
          seenPaths.add(ref.filePath);
          needPreview.push(ref);
        }
      }
    }
  }

  if (needPreview.length === 0) return false;

  try {
    const thumbnails = await hostApiFetch<Record<string, { preview: string | null; fileSize: number }>>(
      '/api/files/thumbnails',
      {
        method: 'POST',
        body: JSON.stringify({ paths: needPreview }),
      },
    );

    let updated = false;
    for (const msg of messages) {
      if (!msg._attachedFiles) continue;

      // Update files that have filePath
      for (const file of msg._attachedFiles) {
        const fp = file.filePath;
        if (!fp) continue;
        const thumb = thumbnails[fp];
        if (thumb && (thumb.preview || thumb.fileSize)) {
          if (thumb.preview) file.preview = thumb.preview;
          if (thumb.fileSize) file.fileSize = thumb.fileSize;
          _imageCache.set(fp, { ...file });
          updated = true;
        }
      }

      // Legacy: update by index for [media attached: ...] refs
      if (msg.role === 'user') {
        const text = getMessageText(msg.content);
        const refs = extractMediaRefs(text);
        for (let i = 0; i < refs.length; i++) {
          const file = msg._attachedFiles[i];
          const ref = refs[i];
          if (!file || !ref || file.filePath) continue; // skip if already handled via filePath
          const thumb = thumbnails[ref.filePath];
          if (thumb && (thumb.preview || thumb.fileSize)) {
            if (thumb.preview) file.preview = thumb.preview;
            if (thumb.fileSize) file.fileSize = thumb.fileSize;
            _imageCache.set(ref.filePath, { ...file });
            updated = true;
          }
        }
      }
    }
    if (updated) saveImageCache(_imageCache);
    return updated;
  } catch (err) {
    console.warn('[loadMissingPreviews] Failed:', err);
    return false;
  }
}

function hasPendingPreviewLoads(messages: RawMessage[]): boolean {
  return messages.some((msg) => {
    if (!msg._attachedFiles || msg._attachedFiles.length === 0) {
      return false;
    }
    return msg._attachedFiles.some((file) => {
      if (!file.filePath) {
        return false;
      }
      if (file.mimeType.startsWith('image/')) {
        return !file.preview;
      }
      return file.fileSize === 0;
    });
  });
}

function getCanonicalPrefixFromSessions(
  sessions: ChatSession[],
  preferredSessionKey?: string,
): string | null {
  const candidate = preferredSessionKey && preferredSessionKey.startsWith('agent:')
    ? preferredSessionKey
    : sessions.find((s) => s.key.startsWith('agent:'))?.key;
  if (!candidate) return null;
  const parts = candidate.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

function resolveCanonicalPrefixForAgent(agentId?: string): string | null {
  if (typeof agentId !== 'string') {
    return null;
  }
  const normalized = agentId.trim();
  if (!normalized) {
    return null;
  }
  return `agent:${normalized}`;
}

function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toMs(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function loadCronFallbackMessages(sessionKey: string, limit = 200): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const response = await hostApiFetch<{ messages?: RawMessage[] }>(
      buildCronSessionHistoryPath(sessionKey, limit),
    );
    return Array.isArray(response.messages) ? response.messages : [];
  } catch (error) {
    console.warn('Failed to load cron fallback history:', error);
    return [];
  }
}

function isToolOnlyMessage(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (isToolResultRole(message.role)) return true;

  const msg = message as unknown as Record<string, unknown>;
  const content = message.content;

  // Check OpenAI-format tool_calls field (real-time streaming from OpenAI-compatible models)
  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  const hasOpenAITools = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (!Array.isArray(content)) {
    // Content is not an array — check if there's OpenAI-format tool_calls
    if (hasOpenAITools) {
      // Has tool calls but content might be empty/string — treat as tool-only
      // if there's no meaningful text content
      const textContent = typeof content === 'string' ? content.trim() : '';
      return textContent.length === 0;
    }
    return false;
  }

  let hasTool = hasOpenAITools;
  let hasText = false;
  let hasNonToolContent = false;

  for (const block of content as ContentBlock[]) {
    if (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'toolCall' || block.type === 'toolResult') {
      hasTool = true;
      continue;
    }
    if (block.type === 'text' && block.text && block.text.trim()) {
      hasText = true;
      continue;
    }
    // Only actual image output disqualifies a tool-only message.
    // Thinking blocks are internal reasoning that can accompany tool_use — they
    // should NOT prevent the message from being treated as an intermediate tool step.
    if (block.type === 'image') {
      hasNonToolContent = true;
    }
  }

  return hasTool && !hasText && !hasNonToolContent;
}

function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result';
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function summarizeToolOutput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const summaryLines = lines.slice(0, 2);
  let summary = summaryLines.join(' / ');
  if (summary.length > 160) {
    summary = `${summary.slice(0, 157)}...`;
  }
  return summary;
}

function normalizeToolStatus(rawStatus: unknown, fallback: 'running' | 'completed'): ToolStatus['status'] {
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'completed' || status === 'success' || status === 'done') return 'completed';
  return fallback;
}

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractToolUseUpdates(message: unknown): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const updates: ToolStatus[] = [];

  // Path 1: Anthropic/normalized format — tool blocks inside content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type !== 'tool_use' && block.type !== 'toolCall') || !block.name) continue;
      updates.push({
        id: block.id || block.name,
        toolCallId: block.id,
        name: block.name,
        status: 'running',
        updatedAt: Date.now(),
      });
    }
  }

  // Path 2: OpenAI format — tool_calls array on the message itself
  if (updates.length === 0) {
    const toolCalls = msg.tool_calls ?? msg.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? tc) as Record<string, unknown>;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) continue;
        const id = typeof tc.id === 'string' ? tc.id : name;
        updates.push({
          id,
          toolCallId: typeof tc.id === 'string' ? tc.id : undefined,
          name,
          status: 'running',
          updatedAt: Date.now(),
        });
      }
    }
  }

  return updates;
}

function extractToolResultBlocks(message: unknown, eventState: string): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const updates: ToolStatus[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_result' && block.type !== 'toolResult') continue;
    const outputText = extractTextFromContent(block.content ?? block.text ?? '');
    const summary = summarizeToolOutput(outputText);
    updates.push({
      id: block.id || block.name || 'tool',
      toolCallId: block.id,
      name: block.name || block.id || 'tool',
      status: normalizeToolStatus(undefined, eventState === 'delta' ? 'running' : 'completed'),
      summary,
      updatedAt: Date.now(),
    });
  }

  return updates;
}

function extractToolResultUpdate(message: unknown, eventState: string): ToolStatus | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
  if (!isToolResultRole(role)) return null;

  const toolName = typeof msg.toolName === 'string' ? msg.toolName : (typeof msg.name === 'string' ? msg.name : '');
  const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined;
  const details = (msg.details && typeof msg.details === 'object') ? msg.details as Record<string, unknown> : undefined;
  const rawStatus = (msg.status ?? details?.status);
  const fallback = eventState === 'delta' ? 'running' : 'completed';
  const status = normalizeToolStatus(rawStatus, fallback);
  const durationMs = parseDurationMs(details?.durationMs ?? details?.duration ?? (msg as Record<string, unknown>).durationMs);

  const outputText = (details && typeof details.aggregated === 'string')
    ? details.aggregated
    : extractTextFromContent(msg.content);
  const summary = summarizeToolOutput(outputText) ?? summarizeToolOutput(String(details?.error ?? msg.error ?? ''));

  const name = toolName || toolCallId || 'tool';
  const id = toolCallId || name;

  return {
    id,
    toolCallId,
    name,
    status,
    durationMs,
    summary,
    updatedAt: Date.now(),
  };
}

function mergeToolStatus(existing: ToolStatus['status'], incoming: ToolStatus['status']): ToolStatus['status'] {
  const order: Record<ToolStatus['status'], number> = { running: 0, completed: 1, error: 2 };
  return order[incoming] >= order[existing] ? incoming : existing;
}

function upsertToolStatuses(current: ToolStatus[], updates: ToolStatus[]): ToolStatus[] {
  if (updates.length === 0) return current;
  const next = [...current];
  for (const update of updates) {
    const key = update.toolCallId || update.id || update.name;
    if (!key) continue;
    const index = next.findIndex((tool) => (tool.toolCallId || tool.id || tool.name) === key);
    if (index === -1) {
      next.push(update);
      continue;
    }
    const existing = next[index];
    next[index] = {
      ...existing,
      ...update,
      name: update.name || existing.name,
      status: mergeToolStatus(existing.status, update.status),
      durationMs: update.durationMs ?? existing.durationMs,
      summary: update.summary ?? existing.summary,
      updatedAt: update.updatedAt || existing.updatedAt,
    };
  }
  return next;
}

function collectToolUpdates(message: unknown, eventState: string): ToolStatus[] {
  const updates: ToolStatus[] = [];
  const toolResultUpdate = extractToolResultUpdate(message, eventState);
  if (toolResultUpdate) updates.push(toolResultUpdate);
  updates.push(...extractToolResultBlocks(message, eventState));
  updates.push(...extractToolUseUpdates(message));
  return updates;
}

function hasNonToolAssistantContent(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (typeof message.content === 'string' && message.content.trim()) return true;

  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text && block.text.trim()) return true;
      if (block.type === 'thinking' && block.thinking && block.thinking.trim()) return true;
      if (block.type === 'image') return true;
    }
  }

  const msg = message as unknown as Record<string, unknown>;
  if (typeof msg.text === 'string' && msg.text.trim()) return true;

  return false;
}

function cloneAttachedFiles(files: AttachedFileMeta[] | undefined): AttachedFileMeta[] | undefined {
  if (!files) return undefined;
  return files.map((file) => ({ ...file }));
}

function cloneMessages(messages: RawMessage[]): RawMessage[] {
  return messages.map((message) => ({
    ...message,
    _attachedFiles: cloneAttachedFiles(message._attachedFiles),
  }));
}

function cloneStreamingTools(streamingTools: ToolStatus[]): ToolStatus[] {
  return streamingTools.map((tool) => ({ ...tool }));
}

function createEmptySessionRuntime(): SessionRuntimeSnapshot {
  return {
    messages: [],
    sending: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    approvalStatus: 'idle',
  };
}

function snapshotCurrentSessionRuntime(state: ChatState): SessionRuntimeSnapshot {
  return {
    messages: cloneMessages(state.messages),
    sending: state.sending,
    activeRunId: state.activeRunId,
    streamingText: state.streamingText,
    streamingMessage: state.streamingMessage,
    streamingTools: cloneStreamingTools(state.streamingTools),
    pendingFinal: state.pendingFinal,
    lastUserMessageAt: state.lastUserMessageAt,
    pendingToolImages: cloneAttachedFiles(state.pendingToolImages) ?? [],
    approvalStatus: state.approvalStatus,
  };
}

function resolveSessionRuntime(snapshot: SessionRuntimeSnapshot | undefined): SessionRuntimeSnapshot {
  if (!snapshot) return createEmptySessionRuntime();
  return {
    messages: cloneMessages(snapshot.messages),
    sending: snapshot.sending,
    activeRunId: snapshot.activeRunId,
    streamingText: snapshot.streamingText,
    streamingMessage: snapshot.streamingMessage,
    streamingTools: cloneStreamingTools(snapshot.streamingTools),
    pendingFinal: snapshot.pendingFinal,
    lastUserMessageAt: snapshot.lastUserMessageAt,
    pendingToolImages: cloneAttachedFiles(snapshot.pendingToolImages) ?? [],
    approvalStatus: snapshot.approvalStatus ?? 'idle',
  };
}

function normalizeApprovalDecision(value: unknown): ApprovalDecision | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'allow-once') return 'allow-once';
  if (normalized === 'allow-always') return 'allow-always';
  if (normalized === 'deny') return 'deny';
  return undefined;
}

function normalizeApprovalTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return toMs(value);
}

function resolveApprovalSessionKey(payload: Record<string, unknown>): string | undefined {
  const directSessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  if (directSessionKey) return directSessionKey;

  const request = (payload.request && typeof payload.request === 'object')
    ? payload.request as Record<string, unknown>
    : undefined;
  const nestedSessionKey = typeof request?.sessionKey === 'string' ? request.sessionKey.trim() : '';
  if (nestedSessionKey) return nestedSessionKey;

  return undefined;
}

function hasTimeoutSignal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Error & { code?: unknown };
  const msg = String(err.message || error);
  const code = typeof err.code === 'string' ? err.code.toUpperCase() : '';
  return code.includes('TIMEOUT') || msg.toLowerCase().includes('timeout');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeApprovalItemFromGateway(value: unknown): ApprovalItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const request = asRecord(record.request);
  const id = asNonEmptyString(record.id)
    ?? asNonEmptyString(record.approvalId)
    ?? asNonEmptyString(record.requestId)
    ?? asNonEmptyString(request?.id);
  const sessionKey = asNonEmptyString(record.sessionKey)
    ?? asNonEmptyString(request?.sessionKey);
  if (!id || !sessionKey) return null;

  const runId = asNonEmptyString(record.runId)
    ?? asNonEmptyString(request?.runId);
  const toolName = asNonEmptyString(record.toolName)
    ?? asNonEmptyString(request?.toolName);
  const createdAtMs = normalizeApprovalTimestampMs(record.createdAt)
    ?? normalizeApprovalTimestampMs(record.createdAtMs)
    ?? normalizeApprovalTimestampMs(record.requestedAt)
    ?? normalizeApprovalTimestampMs(request?.createdAt)
    ?? normalizeApprovalTimestampMs(request?.requestedAt)
    ?? Date.now();
  const expiresAtMs = normalizeApprovalTimestampMs(record.expiresAt)
    ?? normalizeApprovalTimestampMs(record.expiresAtMs)
    ?? normalizeApprovalTimestampMs(request?.expiresAt);

  return {
    id,
    sessionKey,
    ...(runId ? { runId } : {}),
    ...(toolName ? { toolName } : {}),
    createdAtMs,
    ...(expiresAtMs ? { expiresAtMs } : {}),
  };
}

function parseGatewayApprovalResponse(
  payload: unknown,
): { recognized: boolean; items: ApprovalItem[] } {
  const rawRecords: unknown[] = [];
  let recognized = false;

  const collect = (candidate: unknown, forceObjectMap = false): void => {
    if (Array.isArray(candidate)) {
      recognized = true;
      rawRecords.push(...candidate);
      return;
    }
    const objectCandidate = asRecord(candidate);
    if (!objectCandidate) return;
    if (normalizeApprovalItemFromGateway(objectCandidate)) {
      recognized = true;
      rawRecords.push(objectCandidate);
      return;
    }
    if (!forceObjectMap) return;
    rawRecords.push(...Object.values(objectCandidate));
    recognized = true;
  };

  if (Array.isArray(payload)) {
    collect(payload);
  } else {
    const root = asRecord(payload);
    if (root) {
      const listKeys = ['approvals', 'items', 'pending', 'list', 'records', 'requests'];
      for (const key of listKeys) {
        if (Object.prototype.hasOwnProperty.call(root, key)) {
          collect(root[key], true);
        }
      }
      const containerKeys = ['data', 'result', 'payload'];
      for (const key of containerKeys) {
        const nested = asRecord(root[key]);
        if (!nested) continue;
        for (const listKey of listKeys) {
          if (Object.prototype.hasOwnProperty.call(nested, listKey)) {
            collect(nested[listKey], true);
          }
        }
      }
      if (!recognized) {
        collect(root);
      }
    }
  }

  if (!recognized) {
    return { recognized: false, items: [] };
  }

  const dedup = new Map<string, ApprovalItem>();
  for (const entry of rawRecords) {
    const normalized = normalizeApprovalItemFromGateway(entry);
    if (!normalized) continue;
    dedup.set(`${normalized.sessionKey}::${normalized.id}`, normalized);
  }

  return {
    recognized: true,
    items: [...dedup.values()].sort((a, b) => a.createdAtMs - b.createdAtMs),
  };
}

// ── Store ────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  loading: false,
  error: null,

  sending: false,
  activeRunId: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
  approvalStatus: 'idle',
  pendingApprovalsBySession: {},

  sessions: [],
  currentSessionKey: DEFAULT_SESSION_KEY,
  sessionLabels: {},
  sessionLastActivity: {},
  sessionRuntimeByKey: {},

  showThinking: true,
  thinkingLevel: null,

  // ── Load sessions via sessions.list ──

  loadSessions: async () => {
    try {
      const data = await useGatewayStore.getState().rpc<Record<string, unknown>>('sessions.list', {});
      if (data) {
        const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
        const sessions: ChatSession[] = rawSessions.map((s: Record<string, unknown>) => ({
          key: String(s.key || ''),
          label: s.label ? String(s.label) : undefined,
          displayName: s.displayName ? String(s.displayName) : undefined,
          thinkingLevel: s.thinkingLevel ? String(s.thinkingLevel) : undefined,
          model: s.model ? String(s.model) : undefined,
          updatedAt: parseSessionUpdatedAtMs(s.updatedAt),
        })).filter((s: ChatSession) => s.key);

        const canonicalBySuffix = new Map<string, string>();
        for (const session of sessions) {
          if (!session.key.startsWith('agent:')) continue;
          const parts = session.key.split(':');
          if (parts.length < 3) continue;
          const suffix = parts.slice(2).join(':');
          if (suffix && !canonicalBySuffix.has(suffix)) {
            canonicalBySuffix.set(suffix, session.key);
          }
        }

        // Deduplicate: if both short and canonical existed, keep canonical only
        const seen = new Set<string>();
        const dedupedSessions = sessions.filter((s) => {
          if (!s.key.startsWith('agent:') && canonicalBySuffix.has(s.key)) return false;
          if (seen.has(s.key)) return false;
          seen.add(s.key);
          return true;
        });

        const { currentSessionKey } = get();
        let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
        if (!nextSessionKey.startsWith('agent:')) {
          const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
          if (canonicalMatch) {
            nextSessionKey = canonicalMatch;
          }
        }
        if (!dedupedSessions.find((s) => s.key === nextSessionKey) && dedupedSessions.length > 0) {
          // Current session not found in the backend list
          const isNewEmptySession = get().messages.length === 0;
          if (!isNewEmptySession) {
            nextSessionKey = dedupedSessions[0].key;
          }
        }

        const sessionsWithCurrent = !dedupedSessions.find((s) => s.key === nextSessionKey) && nextSessionKey
          ? [
            ...dedupedSessions,
            { key: nextSessionKey, displayName: nextSessionKey },
          ]
          : dedupedSessions;

        const discoveredActivity = Object.fromEntries(
          sessionsWithCurrent
            .filter((session) => typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt))
            .map((session) => [session.key, session.updatedAt!]),
        );

        const snapshot = get();
        const sessionsChanged = !areSessionsEquivalent(snapshot.sessions, sessionsWithCurrent);
        const sessionKeyChanged = snapshot.currentSessionKey !== nextSessionKey;
        const discoveredActivityChanged = Object.entries(discoveredActivity).some(
          ([sessionKey, updatedAt]) => snapshot.sessionLastActivity[sessionKey] !== updatedAt,
        );

        if (sessionsChanged || sessionKeyChanged || discoveredActivityChanged) {
          set((state) => {
            const next: Partial<ChatState> = {};

            if (sessionsChanged) {
              next.sessions = sessionsWithCurrent;
            }
            if (sessionKeyChanged) {
              next.currentSessionKey = nextSessionKey;
            }
            if (discoveredActivityChanged) {
              next.sessionLastActivity = {
                ...state.sessionLastActivity,
                ...discoveredActivity,
              };
            }

            return next;
          });
        }

        if (currentSessionKey !== nextSessionKey) {
          get().loadHistory();
        }

        const hydrationRunId = ++_sessionHydrationRunId;
        clearSessionHydrationTimer();

        // Background: hydrate missing session title + activity from history.
        // Avoid re-fetching sessions that already have label/activity to reduce
        // sidebar thrash when Chat page periodically refreshes sessions.
        const snapshotAfterListUpdate = get();
        const sessionsToHydrate = sessionsWithCurrent.filter((session) => {
          if (session.key.endsWith(':main')) {
            return false;
          }
          const hasLabel = Boolean(snapshotAfterListUpdate.sessionLabels[session.key]);
          const hasActivity = typeof snapshotAfterListUpdate.sessionLastActivity[session.key] === 'number';
          return !hasLabel || !hasActivity;
        });

        if (sessionsToHydrate.length > 0) {
          void (async () => {
            const applyHydrationRecords = (records: SessionHydrationRecord[]): void => {
              const validRecords = records.filter((item): item is SessionHydrationRecord => Boolean(item));
              if (validRecords.length === 0 || hydrationRunId !== _sessionHydrationRunId) {
                return;
              }

              set((state) => {
                let nextLabels = state.sessionLabels;
                let labelsChanged = false;
                let nextActivity = state.sessionLastActivity;
                let activityChanged = false;

                for (const record of validRecords) {
                  if (record.label && state.sessionLabels[record.sessionKey] !== record.label) {
                    if (!labelsChanged) {
                      nextLabels = { ...state.sessionLabels };
                      labelsChanged = true;
                    }
                    nextLabels[record.sessionKey] = record.label;
                  }
                  if (
                    typeof record.lastActivity === 'number'
                    && state.sessionLastActivity[record.sessionKey] !== record.lastActivity
                  ) {
                    if (!activityChanged) {
                      nextActivity = { ...state.sessionLastActivity };
                      activityChanged = true;
                    }
                    nextActivity[record.sessionKey] = record.lastActivity;
                  }
                }

                const next: Partial<ChatState> = {};
                if (labelsChanged) {
                  next.sessionLabels = nextLabels;
                }
                if (activityChanged) {
                  next.sessionLastActivity = nextActivity;
                }
                return next;
              });
            };

            const prioritizedCurrentSession = sessionsToHydrate.find((session) => session.key === nextSessionKey);
            const remainingSessions = sessionsToHydrate.filter((session) => session.key !== prioritizedCurrentSession?.key);
            const headBatchSessions = remainingSessions.slice(0, SESSION_HYDRATE_HEAD_BATCH_SIZE);
            const backgroundQueue = remainingSessions.slice(SESSION_HYDRATE_HEAD_BATCH_SIZE);

            if (prioritizedCurrentSession) {
              const primaryRecord = await fetchSessionHydrationRecord(
                prioritizedCurrentSession.key,
                SESSION_HYDRATE_HEAD_LIMIT,
              );
              if (primaryRecord) {
                applyHydrationRecords([primaryRecord]);
              }
            }

            if (hydrationRunId !== _sessionHydrationRunId) {
              return;
            }

            if (headBatchSessions.length > 0) {
              const headRecords = await Promise.all(
                headBatchSessions.map((session) => fetchSessionHydrationRecord(session.key, SESSION_HYDRATE_HEAD_LIMIT)),
              );
              applyHydrationRecords(headRecords.filter((record): record is SessionHydrationRecord => Boolean(record)));
            }

            if (hydrationRunId !== _sessionHydrationRunId || backgroundQueue.length === 0) {
              return;
            }

            const runBackgroundHydration = async () => {
              if (hydrationRunId !== _sessionHydrationRunId || backgroundQueue.length === 0) {
                return;
              }

              const session = backgroundQueue.shift();
              if (!session) {
                return;
              }

              const record = await fetchSessionHydrationRecord(session.key, SESSION_HYDRATE_BACKGROUND_LIMIT);
              if (record) {
                applyHydrationRecords([record]);
              }

              if (hydrationRunId !== _sessionHydrationRunId || backgroundQueue.length === 0) {
                return;
              }

              _sessionHydrationTimer = setTimeout(() => {
                void runBackgroundHydration();
              }, SESSION_HYDRATE_BACKGROUND_DELAY_MS);
            };

            _sessionHydrationTimer = setTimeout(() => {
              void runBackgroundHydration();
            }, SESSION_HYDRATE_BACKGROUND_DELAY_MS);
          })();
        }
      }
    } catch (err) {
      console.warn('Failed to load sessions:', err);
    }
  },

  // ── Switch session ──

  switchSession: (key: string) => {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    const state = get();
    const { currentSessionKey, messages } = state;
    const leavingEmpty = !currentSessionKey.endsWith(':main') && messages.length === 0;
    if (leavingEmpty) {
      _historyFingerprintBySession.delete(currentSessionKey);
      _historyProbeFingerprintBySession.delete(currentSessionKey);
      _historyQuickFingerprintBySession.delete(currentSessionKey);
    }
    const nextSessionRuntimeByKey = { ...state.sessionRuntimeByKey };

    if (leavingEmpty) {
      delete nextSessionRuntimeByKey[currentSessionKey];
    } else {
      nextSessionRuntimeByKey[currentSessionKey] = snapshotCurrentSessionRuntime(state);
    }
    const targetRuntime = resolveSessionRuntime(nextSessionRuntimeByKey[key]);
    const targetPendingApprovals = state.pendingApprovalsBySession[key] ?? [];
    const targetApprovalStatus: ApprovalStatus = targetPendingApprovals.length > 0
      ? 'awaiting_approval'
      : targetRuntime.approvalStatus;

    set((s) => ({
      currentSessionKey: key,
      messages: targetRuntime.messages,
      sending: targetRuntime.sending,
      streamingText: targetRuntime.streamingText,
      streamingMessage: targetRuntime.streamingMessage,
      streamingTools: targetRuntime.streamingTools,
      activeRunId: targetRuntime.activeRunId,
      error: null,
      pendingFinal: targetRuntime.pendingFinal,
      lastUserMessageAt: targetRuntime.lastUserMessageAt,
      pendingToolImages: targetRuntime.pendingToolImages,
      approvalStatus: targetApprovalStatus,
      sessionRuntimeByKey: nextSessionRuntimeByKey,
      ...(leavingEmpty ? {
        sessions: s.sessions.filter((s) => s.key !== currentSessionKey),
        sessionLabels: Object.fromEntries(
          Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
        ),
        sessionLastActivity: Object.fromEntries(
          Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
        ),
      } : {}),
    }));
    // 切回正在运行的会话时，重启历史轮询，避免 UI 卡在旧快照状态
    if (targetRuntime.sending) {
      const POLL_INTERVAL = 4_000;
      const pollHistory = () => {
        const current = get();
        if (!current.sending) {
          clearHistoryPoll();
          return;
        }
        if (!current.streamingMessage) {
          void current.loadHistory(true);
        }
        _historyPollTimer = setTimeout(pollHistory, POLL_INTERVAL);
      };
      _historyPollTimer = setTimeout(pollHistory, 1_000);
    }
    scheduleNextFrame(() => {
      void get().loadHistory(true);
    });
  },

  // ── Delete session ──
  //
  // NOTE: The OpenClaw Gateway does NOT expose a sessions.delete (or equivalent)
  // RPC — confirmed by inspecting client.ts, protocol.ts and the full codebase.
  // Deletion is therefore a local-only UI operation: the session is removed from
  // the sidebar list and its labels/activity maps are cleared.  The underlying
  // JSONL history file on disk is intentionally left intact, consistent with the
  // newSession() design that avoids sessions.reset to preserve history.

  deleteSession: async (key: string) => {
    // Soft-delete the session's JSONL transcript on disk.
    // The main process renames <suffix>.jsonl → <suffix>.deleted.jsonl so that
    // sessions.list and token-usage queries both skip it automatically.
    try {
      const result = await hostApiFetch<{
        success: boolean;
        error?: string;
      }>('/api/sessions/delete', {
        method: 'POST',
        body: JSON.stringify({ sessionKey: key }),
      });
      if (!result.success) {
        console.warn(`[deleteSession] IPC reported failure for ${key}:`, result.error);
      }
    } catch (err) {
      console.warn(`[deleteSession] IPC call failed for ${key}:`, err);
    }

    const { currentSessionKey, sessions } = get();
    const remaining = sessions.filter((s) => s.key !== key);
    _historyFingerprintBySession.delete(key);
    _historyProbeFingerprintBySession.delete(key);
    _historyQuickFingerprintBySession.delete(key);

    if (currentSessionKey === key) {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      // Switched away from deleted session — pick the first remaining or create new
      const next = remaining[0];
      set((s) => ({
        ...(function buildNextState() {
          const runtimeMap = Object.fromEntries(
            Object.entries(s.sessionRuntimeByKey).filter(([sessionKey]) => sessionKey !== key),
          );
          const nextRuntime = resolveSessionRuntime(runtimeMap[next?.key ?? '']);
          return {
            sessionRuntimeByKey: runtimeMap,
            messages: nextRuntime.messages,
            sending: nextRuntime.sending,
            streamingText: nextRuntime.streamingText,
            streamingMessage: nextRuntime.streamingMessage,
            streamingTools: nextRuntime.streamingTools,
            activeRunId: nextRuntime.activeRunId,
            pendingFinal: nextRuntime.pendingFinal,
            lastUserMessageAt: nextRuntime.lastUserMessageAt,
            pendingToolImages: nextRuntime.pendingToolImages,
            approvalStatus: nextRuntime.approvalStatus,
          };
        })(),
        sessions: remaining,
        sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
        sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== key),
        ),
        error: null,
        currentSessionKey: next?.key ?? DEFAULT_SESSION_KEY,
      }));
      if (next) {
        get().loadHistory();
      }
    } else {
      set((s) => ({
        sessions: remaining,
        sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
        sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
        sessionRuntimeByKey: Object.fromEntries(Object.entries(s.sessionRuntimeByKey).filter(([k]) => k !== key)),
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== key),
        ),
      }));
    }
  },

  // ── New session ──

  newSession: (agentId?: string) => {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    // Generate a new unique session key and switch to it.
    // NOTE: We intentionally do NOT call sessions.reset on the old session.
    // sessions.reset archives (renames) the session JSONL file, making old
    // conversation history inaccessible when the user switches back to it.
    const { currentSessionKey, messages } = get();
    const leavingEmpty = !currentSessionKey.endsWith(':main') && messages.length === 0;
    if (leavingEmpty) {
      _historyFingerprintBySession.delete(currentSessionKey);
      _historyProbeFingerprintBySession.delete(currentSessionKey);
      _historyQuickFingerprintBySession.delete(currentSessionKey);
    }
    const prefix = resolveCanonicalPrefixForAgent(agentId)
      ?? getCanonicalPrefixFromSessions(get().sessions, currentSessionKey)
      ?? DEFAULT_CANONICAL_PREFIX;
    const newKey = `${prefix}:session-${Date.now()}`;
    const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
    set((s) => ({
      sessionRuntimeByKey: (() => {
        const next = { ...s.sessionRuntimeByKey };
        if (leavingEmpty) {
          delete next[currentSessionKey];
        } else {
          next[currentSessionKey] = snapshotCurrentSessionRuntime(s);
        }
        delete next[newKey];
        return next;
      })(),
      currentSessionKey: newKey,
      sessions: [
        ...(leavingEmpty ? s.sessions.filter((sess) => sess.key !== currentSessionKey) : s.sessions),
        newSessionEntry,
      ],
      sessionLabels: leavingEmpty
        ? Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey))
        : s.sessionLabels,
      sessionLastActivity: leavingEmpty
        ? Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey))
        : s.sessionLastActivity,
      pendingApprovalsBySession: (() => {
        if (!leavingEmpty) return s.pendingApprovalsBySession;
        return Object.fromEntries(
          Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== currentSessionKey),
        );
      })(),
      ...createEmptySessionRuntime(),
      error: null,
    }));
  },

  // ── Cleanup empty session on navigate away ──

  cleanupEmptySession: () => {
    const { currentSessionKey, messages } = get();
    // Only remove non-main sessions that were never used (no messages sent).
    // This mirrors the "leavingEmpty" logic in switchSession so that creating
    // a new session and immediately navigating away doesn't leave a ghost entry
    // in the sidebar.
    const isEmptyNonMain = !currentSessionKey.endsWith(':main') && messages.length === 0;
    if (!isEmptyNonMain) return;
    _historyFingerprintBySession.delete(currentSessionKey);
    _historyProbeFingerprintBySession.delete(currentSessionKey);
    _historyQuickFingerprintBySession.delete(currentSessionKey);
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.key !== currentSessionKey),
      sessionLabels: Object.fromEntries(
        Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
      ),
      sessionLastActivity: Object.fromEntries(
        Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
      ),
      sessionRuntimeByKey: Object.fromEntries(
        Object.entries(s.sessionRuntimeByKey).filter(([k]) => k !== currentSessionKey),
      ),
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== currentSessionKey),
      ),
    }));
  },

  // ── Load chat history ──

  loadHistory: async (quiet = false) => {
    const requestedSessionKey = get().currentSessionKey;
    if (!quiet) set({ loading: true, error: null });

    const applyLoadedMessages = (rawMessages: RawMessage[], thinkingLevel: string | null) => {
      const quickFingerprint = buildQuickRawHistoryFingerprint(rawMessages, thinkingLevel);
      const previousQuickFingerprint = _historyQuickFingerprintBySession.get(requestedSessionKey) ?? null;
      const currentStateForQuickPath = get();
      const canSkipWithQuickFingerprint = (
        previousQuickFingerprint === quickFingerprint
        && currentStateForQuickPath.currentSessionKey === requestedSessionKey
        && currentStateForQuickPath.messages.length > 0
        && currentStateForQuickPath.thinkingLevel === thinkingLevel
      );
      if (canSkipWithQuickFingerprint) {
        if (!quiet && currentStateForQuickPath.loading) {
          set({ loading: false });
        }
        return;
      }
      _historyQuickFingerprintBySession.set(requestedSessionKey, quickFingerprint);

      // Before filtering: attach images/files from tool_result messages to the next assistant message
      const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
      const filteredMessages: RawMessage[] = [];
      for (let i = 0; i < messagesWithToolImages.length; i += 1) {
        const current = messagesWithToolImages[i];
        if (isToolResultRole(current.role)) continue;
        const next = i + 1 < messagesWithToolImages.length ? messagesWithToolImages[i + 1] : undefined;
        filteredMessages.push(
          sanitizeIntermediateToolFillerMessage(current, {
            nextMessage: next,
            requireFollower: true,
            trackPhrase: false,
          }),
        );
      }
      // Restore file attachments for user/assistant messages (from cache + text patterns)
      const enrichedMessages = enrichWithCachedImages(filteredMessages);

      // Preserve the optimistic user message during an active send.
      // The Gateway may not include the user's message in chat.history
      // until the run completes, causing it to flash out of the UI.
      let finalMessages = enrichedMessages;
      const userMsgAt = get().lastUserMessageAt;
      if (get().sending && userMsgAt) {
        const userMsMs = toMs(userMsgAt);
        const hasRecentUser = enrichedMessages.some(
          (m) => m.role === 'user' && m.timestamp && Math.abs(toMs(m.timestamp) - userMsMs) < 5000,
        );
        if (!hasRecentUser) {
          const currentMsgs = get().messages;
          const optimistic = [...currentMsgs].reverse().find(
            (m) => m.role === 'user' && m.timestamp && Math.abs(toMs(m.timestamp) - userMsMs) < 5000,
          );
          if (optimistic) {
            finalMessages = [...enrichedMessages, optimistic];
          }
        }
      }

      const isMainSession = requestedSessionKey.endsWith(':main');
      const resolvedLabel = !isMainSession
        ? resolveSessionLabelFromMessages(finalMessages)
        : '';
      const lastMsg = finalMessages[finalMessages.length - 1];
      const lastAt = lastMsg?.timestamp ? toMs(lastMsg.timestamp) : null;

      const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();

      // If we're sending but haven't received streaming events, check
      // whether the loaded history reveals intermediate tool-call activity.
      // This surfaces progress via the pendingFinal → ActivityIndicator path.
      const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
      const isAfterUserMsg = (msg: RawMessage): boolean => {
        if (!userMsTs || !msg.timestamp) return true;
        return toMs(msg.timestamp) >= userMsTs;
      };

      const hasRecentAssistantActivity = isSendingNow && !pendingFinal
        ? [...filteredMessages].reverse().some((msg) => msg.role === 'assistant' && isAfterUserMsg(msg))
        : false;

      // If pendingFinal, check whether the AI produced a final text response.
      const hasRecentFinalAssistantMessage = [...filteredMessages].reverse().some((msg) => {
        if (msg.role !== 'assistant') return false;
        if (!hasNonToolAssistantContent(msg)) return false;
        return isAfterUserMsg(msg);
      });

      let didMessageListChange = false;
      set((state) => {
        if (state.currentSessionKey !== requestedSessionKey) {
          return state;
        }
        const nextStatePatch: Partial<ChatState> = {};
        let changed = false;

        if (!areMessagesEquivalent(state.messages, finalMessages)) {
          nextStatePatch.messages = finalMessages;
          didMessageListChange = true;
          changed = true;
        }
        if (state.thinkingLevel !== thinkingLevel) {
          nextStatePatch.thinkingLevel = thinkingLevel;
          changed = true;
        }
        if (state.loading) {
          nextStatePatch.loading = false;
          changed = true;
        }
        if (resolvedLabel && state.sessionLabels[requestedSessionKey] !== resolvedLabel) {
          nextStatePatch.sessionLabels = {
            ...state.sessionLabels,
            [requestedSessionKey]: resolvedLabel,
          };
          changed = true;
        }
        if (lastAt != null && state.sessionLastActivity[requestedSessionKey] !== lastAt) {
          nextStatePatch.sessionLastActivity = {
            ...state.sessionLastActivity,
            [requestedSessionKey]: lastAt,
          };
          changed = true;
        }
        if (hasRecentAssistantActivity && state.sending && !state.pendingFinal) {
          nextStatePatch.pendingFinal = true;
          changed = true;
        }
        if (hasRecentFinalAssistantMessage && (state.sending || state.activeRunId != null || state.pendingFinal)) {
          nextStatePatch.sending = false;
          nextStatePatch.activeRunId = null;
          nextStatePatch.pendingFinal = false;
          changed = true;
        }

        return changed ? nextStatePatch : state;
      });

      if (hasRecentFinalAssistantMessage) {
        clearHistoryPoll();
      }

      // Async: load missing image previews from disk (updates in background)
      if (didMessageListChange && hasPendingPreviewLoads(finalMessages)) {
        void loadMissingPreviews(finalMessages).then((updated) => {
          if (!updated) {
            return;
          }
          set((state) => {
            if (state.currentSessionKey !== requestedSessionKey) {
              return state;
            }
            if (state.messages !== finalMessages) {
              return state;
            }
            return {
              messages: finalMessages.map((msg) => (
                msg._attachedFiles
                  ? { ...msg, _attachedFiles: msg._attachedFiles.map((file) => ({ ...file })) }
                  : msg
              )),
            };
          });
        });
      }
    };

    const fetchHistoryWindow = async (
      limit: number,
    ): Promise<{ rawMessages: RawMessage[]; thinkingLevel: string | null }> => {
      const data = await useGatewayStore.getState().rpc<Record<string, unknown>>(
        'chat.history',
        { sessionKey: requestedSessionKey, limit },
      );
      let rawMessages = Array.isArray(data?.messages) ? data.messages as RawMessage[] : [];
      const thinkingLevel = data?.thinkingLevel ? String(data.thinkingLevel) : null;
      if (rawMessages.length === 0) {
        rawMessages = await loadCronFallbackMessages(requestedSessionKey, limit);
      }
      return { rawMessages, thinkingLevel };
    };

    try {
      if (quiet) {
        const probe = await fetchHistoryWindow(CHAT_HISTORY_QUIET_PROBE_LIMIT);
        if (get().currentSessionKey !== requestedSessionKey) {
          return;
        }
        const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
        const previousProbeFingerprint = _historyProbeFingerprintBySession.get(requestedSessionKey) ?? null;
        _historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);

        const hasKnownFullSnapshot = _historyFingerprintBySession.has(requestedSessionKey);
        const hasRenderableMessages = get().messages.length > 0;
        if (
          previousProbeFingerprint === probeFingerprint
          && hasKnownFullSnapshot
          && hasRenderableMessages
        ) {
          return;
        }

        const shouldUseProbeAsFinal = probe.rawMessages.length < CHAT_HISTORY_QUIET_PROBE_LIMIT;
        if (shouldUseProbeAsFinal) {
          const fullFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
          _historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
          applyLoadedMessages(probe.rawMessages, probe.thinkingLevel);
          return;
        }

        const full = await fetchHistoryWindow(CHAT_HISTORY_QUIET_FULL_LIMIT);
        if (get().currentSessionKey !== requestedSessionKey) {
          return;
        }
        const fullFingerprint = buildHistoryFingerprint(full.rawMessages, full.thinkingLevel);
        _historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
        _historyProbeFingerprintBySession.set(requestedSessionKey, fullFingerprint);
        applyLoadedMessages(full.rawMessages, full.thinkingLevel);
        return;
      }

      const full = await fetchHistoryWindow(CHAT_HISTORY_FULL_LIMIT);
      // 防止异步竞态：请求返回时若用户已切到其它会话，直接丢弃本次结果。
      if (get().currentSessionKey !== requestedSessionKey) {
        set({ loading: false });
        return;
      }
      const fullFingerprint = buildHistoryFingerprint(full.rawMessages, full.thinkingLevel);
      _historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
      _historyProbeFingerprintBySession.set(requestedSessionKey, fullFingerprint);
      applyLoadedMessages(full.rawMessages, full.thinkingLevel);
    } catch (err) {
      console.warn('Failed to load chat history:', err);
      const fallbackMessages = await loadCronFallbackMessages(requestedSessionKey, CHAT_HISTORY_FULL_LIMIT);
      if (get().currentSessionKey !== requestedSessionKey) {
        if (!quiet) {
          set({ loading: false });
        }
        return;
      }
      if (fallbackMessages.length > 0) {
        const fallbackFingerprint = buildHistoryFingerprint(fallbackMessages, null);
        _historyFingerprintBySession.set(requestedSessionKey, fallbackFingerprint);
        _historyProbeFingerprintBySession.set(requestedSessionKey, fallbackFingerprint);
        applyLoadedMessages(fallbackMessages, null);
      } else if (!quiet) {
        const emptyFingerprint = buildHistoryFingerprint([], null);
        _historyFingerprintBySession.set(requestedSessionKey, emptyFingerprint);
        _historyProbeFingerprintBySession.set(requestedSessionKey, emptyFingerprint);
        _historyQuickFingerprintBySession.set(requestedSessionKey, buildQuickRawHistoryFingerprint([], null));
        set({ messages: [], loading: false });
      }
    }
  },

  // ── Send message ──

  syncPendingApprovals: async (sessionKeyHint?: string) => {
    try {
      const payload = await useGatewayStore.getState().rpc<unknown>('exec.approvals.get', {});
      const parsed = parseGatewayApprovalResponse(payload);
      if (!parsed.recognized) return;

      const grouped: Record<string, ApprovalItem[]> = {};
      for (const item of parsed.items) {
        if (!grouped[item.sessionKey]) grouped[item.sessionKey] = [];
        grouped[item.sessionKey].push(item);
      }
      for (const [sessionKey, items] of Object.entries(grouped)) {
        grouped[sessionKey] = [...items].sort((a, b) => a.createdAtMs - b.createdAtMs);
      }

      set((state) => {
        const normalizedHint = typeof sessionKeyHint === 'string' ? sessionKeyHint.trim() : '';
        const nextApprovals = normalizedHint
          ? { ...state.pendingApprovalsBySession, [normalizedHint]: grouped[normalizedHint] ?? [] }
          : grouped;
        const currentPending = nextApprovals[state.currentSessionKey] ?? [];
        const nextApprovalStatus: ApprovalStatus = currentPending.length > 0 ? 'awaiting_approval' : 'idle';
        const nextActiveRunId = state.activeRunId ?? currentPending.find((item) => typeof item.runId === 'string')?.runId ?? null;
        return {
          pendingApprovalsBySession: nextApprovals,
          approvalStatus: nextApprovalStatus,
          sending: currentPending.length > 0 ? true : state.sending,
          pendingFinal: currentPending.length > 0 ? true : state.pendingFinal,
          activeRunId: nextActiveRunId,
        };
      });
    } catch {
      // ignore
    }
  },

  // ── Send message ──

  sendMessage: async (text: string, attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>) => {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;

    const { currentSessionKey } = get();

    // Add user message optimistically (with local file metadata for UI display)
    const nowMs = Date.now();
    const userMsg: RawMessage = {
      role: 'user',
      content: trimmed || (attachments?.length ? '(file attached)' : ''),
      timestamp: nowMs / 1000,
      id: crypto.randomUUID(),
      _attachedFiles: attachments?.map(a => ({
        fileName: a.fileName,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        preview: a.preview,
        filePath: a.stagedPath,
      })),
    };
    set((s) => ({
      messages: [...s.messages, userMsg],
      sending: true,
      error: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: nowMs,
      approvalStatus: 'idle',
    }));

    // 统一会话标题提取：优先用户有效文本；纯附件消息会等待 assistant 响应兜底。
    const { sessionLabels, messages } = get();
    if (!currentSessionKey.endsWith(':main') && !sessionLabels[currentSessionKey]) {
      const resolvedLabel = resolveSessionLabelFromMessages(messages);
      if (resolvedLabel) {
        set((s) => ({ sessionLabels: { ...s.sessionLabels, [currentSessionKey]: resolvedLabel } }));
      }
    }

    // Mark this session as most recently active
    set((s) => ({ sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: nowMs } }));

    // Start the history poll and safety timeout IMMEDIATELY (before the
    // RPC await) because the gateway's chat.send RPC may block until the
    // entire agentic conversation finishes — the poll must run in parallel.
    _lastChatEventAt = Date.now();
    clearHistoryPoll();
    clearErrorRecoveryTimer();

    const POLL_START_DELAY = 3_000;
    const POLL_INTERVAL = 4_000;
    const pollHistory = () => {
      const state = get();
      if (!state.sending) { clearHistoryPoll(); return; }
      if (state.streamingMessage) {
        _historyPollTimer = setTimeout(pollHistory, POLL_INTERVAL);
        return;
      }
      state.loadHistory(true);
      void state.syncPendingApprovals(state.currentSessionKey);
      _historyPollTimer = setTimeout(pollHistory, POLL_INTERVAL);
    };
    _historyPollTimer = setTimeout(pollHistory, POLL_START_DELAY);

    const SAFETY_TIMEOUT_MS = 90_000;
    const checkStuck = () => {
      const state = get();
      if (!state.sending) return;
      if (state.streamingMessage || state.streamingText) return;
      if (state.pendingFinal) {
        setTimeout(checkStuck, 10_000);
        return;
      }
      if (Date.now() - _lastChatEventAt < SAFETY_TIMEOUT_MS) {
        setTimeout(checkStuck, 10_000);
        return;
      }
      clearHistoryPoll();
      set({
        error: 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.',
        sending: false,
        activeRunId: null,
        lastUserMessageAt: null,
      });
    };
    setTimeout(checkStuck, 30_000);

    try {
      const idempotencyKey = crypto.randomUUID();
      const hasMedia = attachments && attachments.length > 0;
      if (hasMedia) {
        console.log('[sendMessage] Media paths:', attachments!.map(a => a.stagedPath));
      }

      // Cache image attachments BEFORE the IPC call to avoid race condition:
      // history may reload (via Gateway event) before the RPC returns.
      // Keyed by staged file path which appears in [media attached: <path> ...].
      if (hasMedia && attachments) {
        for (const a of attachments) {
          _imageCache.set(a.stagedPath, {
            fileName: a.fileName,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            preview: a.preview,
          });
        }
        saveImageCache(_imageCache);
      }

      let result: { success: boolean; result?: { runId?: string }; error?: string };

      // Longer timeout for chat sends to tolerate high-latency networks (avoids connect error)
      const CHAT_SEND_TIMEOUT_MS = 120_000;

      if (hasMedia) {
        result = await hostApiFetch<{ success: boolean; result?: { runId?: string }; error?: string }>(
          '/api/chat/send-with-media',
          {
            method: 'POST',
            body: JSON.stringify({
              sessionKey: currentSessionKey,
              message: trimmed || 'Process the attached file(s).',
              deliver: false,
              idempotencyKey,
              media: attachments.map((a) => ({
                filePath: a.stagedPath,
                mimeType: a.mimeType,
                fileName: a.fileName,
              })),
            }),
          },
        );
      } else {
        const rpcResult = await useGatewayStore.getState().rpc<{ runId?: string }>(
          'chat.send',
          {
            sessionKey: currentSessionKey,
            message: trimmed,
            deliver: false,
            idempotencyKey,
          },
          CHAT_SEND_TIMEOUT_MS,
        );
        result = { success: true, result: rpcResult };
      }

      console.log(`[sendMessage] RPC result: success=${result.success}, runId=${result.result?.runId || 'none'}`);

      if (!result.success) {
        await get().syncPendingApprovals(currentSessionKey);
        const state = get();
        const pendingApprovals = state.pendingApprovalsBySession[currentSessionKey] ?? [];
        if (pendingApprovals.length > 0) {
          set({
            error: null,
            sending: true,
            pendingFinal: true,
            approvalStatus: 'awaiting_approval',
          });
          return;
        }
        clearHistoryPoll();
        set({ error: result.error || 'Failed to send message', sending: false });
      } else if (result.result?.runId) {
        set({ activeRunId: result.result.runId });
      }
    } catch (err) {
      if (hasTimeoutSignal(err)) {
        await get().syncPendingApprovals(currentSessionKey);
      }
      const state = get();
      const pendingApprovals = state.pendingApprovalsBySession[currentSessionKey] ?? [];
      const hasApprovalEvidence = pendingApprovals.length > 0
        || state.approvalStatus === 'awaiting_approval'
        || state.activeRunId != null;
      if (hasTimeoutSignal(err) && hasApprovalEvidence) {
        set({
          error: null,
          sending: true,
          pendingFinal: true,
          approvalStatus: 'awaiting_approval',
        });
        return;
      }
      clearHistoryPoll();
      set({ error: String(err), sending: false, approvalStatus: 'idle' });
    }
  },

  // ── Abort active run ──

  abortRun: async () => {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    const { currentSessionKey, pendingApprovalsBySession } = get();
    const pendingApprovals = pendingApprovalsBySession[currentSessionKey] ?? [];
    set({
      sending: false,
      streamingText: '',
      streamingMessage: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle',
    });
    set({ streamingTools: [] });

    try {
      for (const approval of pendingApprovals) {
        await useGatewayStore.getState().rpc(
          'exec.approval.resolve',
          { id: approval.id, decision: 'deny' },
        );
      }
      set((s) => ({
        pendingApprovalsBySession: {
          ...s.pendingApprovalsBySession,
          [currentSessionKey]: [],
        },
      }));
      await useGatewayStore.getState().rpc(
        'chat.abort',
        { sessionKey: currentSessionKey },
      );
    } catch (err) {
      set({ error: String(err) });
    }
  },

  handleApprovalRequested: (payload: Record<string, unknown>) => {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const sessionKey = resolveApprovalSessionKey(payload);
    if (!id || !sessionKey) return;

    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : undefined;
    const toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : undefined;
    const createdAtMs = normalizeApprovalTimestampMs(payload.createdAt)
      ?? normalizeApprovalTimestampMs(payload.requestedAt)
      ?? Date.now();
    const expiresAtMs = normalizeApprovalTimestampMs(payload.expiresAt);

    set((state) => {
      const isCurrentSession = sessionKey === state.currentSessionKey;
      const existing = state.pendingApprovalsBySession[sessionKey] ?? [];
      const filtered = existing.filter((item) => item.id !== id);
      const nextItem: ApprovalItem = {
        id,
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(toolName ? { toolName } : {}),
        createdAtMs,
        ...(expiresAtMs ? { expiresAtMs } : {}),
      };
      const nextSessionItems = [...filtered, nextItem].sort((a, b) => a.createdAtMs - b.createdAtMs);
      const nextApprovals = {
        ...state.pendingApprovalsBySession,
        [sessionKey]: nextSessionItems,
      };

      return {
        pendingApprovalsBySession: nextApprovals,
        approvalStatus: isCurrentSession ? 'awaiting_approval' : state.approvalStatus,
        sending: isCurrentSession ? true : state.sending,
        pendingFinal: isCurrentSession ? true : state.pendingFinal,
        // 进入审批等待态后，清理流式占位，避免工具条占位导致审批按钮不显示。
        streamingMessage: isCurrentSession ? null : state.streamingMessage,
        streamingText: isCurrentSession ? '' : state.streamingText,
        streamingTools: isCurrentSession ? [] : state.streamingTools,
        activeRunId: isCurrentSession && runId
          ? (state.activeRunId ?? runId)
          : state.activeRunId,
      };
    });
  },

  handleApprovalResolved: (payload: Record<string, unknown>) => {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (!id) return;

    const resolvedSessionKey = resolveApprovalSessionKey(payload);
    const decision = normalizeApprovalDecision(payload.decision);

    set((state) => {
      let matchedSessionKey = resolvedSessionKey ?? '';
      if (!matchedSessionKey) {
        for (const [sessionKey, approvals] of Object.entries(state.pendingApprovalsBySession)) {
          if (approvals.some((item) => item.id === id)) {
            matchedSessionKey = sessionKey;
            break;
          }
        }
      }
      if (!matchedSessionKey) return {};

      const nextApprovals = { ...state.pendingApprovalsBySession };
      const sessionApprovals = nextApprovals[matchedSessionKey] ?? [];
      nextApprovals[matchedSessionKey] = sessionApprovals.filter((item) => item.id !== id);

      const stillPendingCurrent = (nextApprovals[state.currentSessionKey] ?? []).length > 0;
      return {
        pendingApprovalsBySession: nextApprovals,
        approvalStatus: stillPendingCurrent ? 'awaiting_approval' : 'idle',
        ...(decision === 'deny' && matchedSessionKey === state.currentSessionKey
          ? { pendingFinal: false, sending: false, activeRunId: null }
          : {}),
      };
    });
  },

  resolveApproval: async (id: string, decision: ApprovalDecision) => {
    const approvalId = id.trim();
    if (!approvalId) return;
    try {
      await useGatewayStore.getState().rpc(
        'exec.approval.resolve',
        { id: approvalId, decision },
      );
      get().handleApprovalResolved({
        id: approvalId,
        decision,
        sessionKey: get().currentSessionKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isStaleApprovalError = /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
      if (isStaleApprovalError) {
        get().handleApprovalResolved({
          id: approvalId,
          decision: 'deny',
          sessionKey: get().currentSessionKey,
        });
      }
      set({ error: message });
      await get().syncPendingApprovals(get().currentSessionKey);
    }
  },

  // ── Handle incoming chat events from Gateway ──

  handleChatEvent: (event: Record<string, unknown>) => {
    const runId = String(event.runId || '');
    const eventState = String(event.state || '');
    const eventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
    const { activeRunId, currentSessionKey } = get();

    // Only process events for the current session (when sessionKey is present)
    if (eventSessionKey != null && eventSessionKey !== currentSessionKey) return;

    // Only process events for the active run (or if no active run set)
    if (activeRunId && runId && runId !== activeRunId) return;

    _lastChatEventAt = Date.now();

    // Defensive: if state is missing but we have a message, try to infer state.
    let resolvedState = eventState;
    if (!resolvedState && event.message && typeof event.message === 'object') {
      const msg = event.message as Record<string, unknown>;
      const stopReason = msg.stopReason ?? msg.stop_reason;
      if (stopReason) {
        resolvedState = 'final';
      } else if (msg.role || msg.content) {
        resolvedState = 'delta';
      }
    }

    // Only pause the history poll when we receive actual streaming data.
    // The gateway sends "agent" events with { phase, startedAt } that carry
    // no message — these must NOT kill the poll, since the poll is our only
    // way to track progress when the gateway doesn't stream intermediate turns.
    const hasUsefulData = resolvedState === 'delta' || resolvedState === 'final'
      || resolvedState === 'error' || resolvedState === 'aborted';
    if (hasUsefulData) {
      clearHistoryPoll();
      // Adopt run started from another client (e.g. console at 127.0.0.1:18789):
      // show loading/streaming in the app when this session has an active run.
      const { sending } = get();
      if (!sending && runId) {
        set({ sending: true, activeRunId: runId, error: null });
      }
    }

    switch (resolvedState) {
      case 'started': {
        // Run just started (e.g. from console); show loading immediately.
        const { sending: currentSending } = get();
        if (!currentSending && runId) {
          set({ sending: true, activeRunId: runId, error: null });
        }
        break;
      }
      case 'delta': {
        // If we're receiving new deltas, the Gateway has recovered from any
        // prior error — cancel the error finalization timer and clear the
        // stale error banner so the user sees the live stream again.
        if (_errorRecoveryTimer) {
          clearErrorRecoveryTimer();
          set({ error: null });
        }
        const updates = collectToolUpdates(event.message, resolvedState);
        set((s) => ({
          streamingMessage: (() => {
            if (event.message && typeof event.message === 'object') {
              const msgRole = (event.message as RawMessage).role;
              if (isToolResultRole(msgRole)) return s.streamingMessage;
            }
            return event.message ?? s.streamingMessage;
          })(),
          streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
        }));
        break;
      }
      case 'final': {
        clearErrorRecoveryTimer();
        if (get().error) set({ error: null });
        // Message complete - add to history and clear streaming
        const finalMsg = event.message as RawMessage | undefined;
        if (finalMsg) {
          const updates = collectToolUpdates(finalMsg, resolvedState);
          if (isToolResultRole(finalMsg.role)) {
            // Resolve file path from the streaming assistant message's matching tool call
            const currentStreamForPath = get().streamingMessage as RawMessage | null;
            const matchedPath = (currentStreamForPath && finalMsg.toolCallId)
              ? getToolCallFilePath(currentStreamForPath, finalMsg.toolCallId)
              : undefined;

            // Mirror enrichWithToolResultFiles: collect images + file refs for next assistant msg
            const toolFiles: AttachedFileMeta[] = [
              ...extractImagesAsAttachedFiles(finalMsg.content),
            ];
            if (matchedPath) {
              for (const f of toolFiles) {
                if (!f.filePath) {
                  f.filePath = matchedPath;
                  f.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
                }
              }
            }
            const text = getMessageText(finalMsg.content);
            if (text) {
              const mediaRefs = extractMediaRefs(text);
              const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
              for (const ref of mediaRefs) toolFiles.push(makeAttachedFile(ref));
              for (const ref of extractRawFilePaths(text)) {
                if (!mediaRefPaths.has(ref.filePath)) toolFiles.push(makeAttachedFile(ref));
              }
            }
            set((s) => {
              // Snapshot the current streaming assistant message (thinking + tool_use) into
              // messages[] before clearing it. The Gateway does NOT send separate 'final'
              // events for intermediate tool-use turns — it only sends deltas and then the
              // tool result. Without snapshotting here, the intermediate thinking+tool steps
              // would be overwritten by the next turn's deltas and never appear in the UI.
              const currentStream = s.streamingMessage as RawMessage | null;
              const snapshotMsgs: RawMessage[] = [];
                if (currentStream) {
                  const streamRole = currentStream.role;
                  if (streamRole === 'assistant' || streamRole === undefined) {
                    // Use message's own id if available, otherwise derive a stable one from runId
                    const snapId = currentStream.id
                      || `${runId || 'run'}-turn-${s.messages.length}`;
                    if (!s.messages.some(m => m.id === snapId)) {
                      const snapshot = sanitizeIntermediateToolFillerMessage(
                        createIntermediateToolTurnSnapshot(currentStream as RawMessage, snapId),
                        { trackPhrase: true },
                      );
                      snapshotMsgs.push(snapshot);
                    }
                  }
                }
              return {
                messages: snapshotMsgs.length > 0 ? [...s.messages, ...snapshotMsgs] : s.messages,
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                pendingToolImages: toolFiles.length > 0
                  ? [...s.pendingToolImages, ...toolFiles]
                  : s.pendingToolImages,
                streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
              };
            });
            break;
          }
          const toolOnly = isToolOnlyMessage(finalMsg);
          const hasOutput = hasNonToolAssistantContent(finalMsg);
          const msgId = finalMsg.id || (toolOnly ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
          set((s) => {
            const nextTools = updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools;
            const streamingTools = hasOutput ? [] : nextTools;

            // Attach any images collected from preceding tool results
            const pendingImgs = s.pendingToolImages;
            const msgWithImages: RawMessage = pendingImgs.length > 0
              ? {
                ...finalMsg,
                role: (finalMsg.role || 'assistant') as RawMessage['role'],
                id: msgId,
                _attachedFiles: [...(finalMsg._attachedFiles || []), ...pendingImgs],
              }
              : { ...finalMsg, role: (finalMsg.role || 'assistant') as RawMessage['role'], id: msgId };
            const clearPendingImages = { pendingToolImages: [] as AttachedFileMeta[] };

            // Check if message already exists (prevent duplicates)
            const alreadyExists = s.messages.some(m => m.id === msgId);
            if (alreadyExists) {
              return toolOnly ? {
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools,
                ...clearPendingImages,
              } : {
                streamingText: '',
                streamingMessage: null,
                sending: hasOutput ? false : s.sending,
                activeRunId: hasOutput ? null : s.activeRunId,
                pendingFinal: hasOutput ? false : true,
                streamingTools,
                ...clearPendingImages,
              };
            }
            return toolOnly ? {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              streamingTools,
              ...clearPendingImages,
            } : {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              sending: hasOutput ? false : s.sending,
              activeRunId: hasOutput ? null : s.activeRunId,
              pendingFinal: hasOutput ? false : true,
              streamingTools,
              ...clearPendingImages,
            };
          });
          // After the final response, quietly reload history to surface all intermediate
          // tool-use turns (thinking + tool blocks) from the Gateway's authoritative record.
          if (hasOutput && !toolOnly) {
            clearHistoryPoll();
            const hasPendingApprovals = (get().pendingApprovalsBySession[get().currentSessionKey] ?? []).length > 0;
            if (!hasPendingApprovals) {
              set({ approvalStatus: 'idle' });
            }
            void get().loadHistory(true);
          }
        } else {
          // No message in final event - reload history to get complete data
          set({ streamingText: '', streamingMessage: null, pendingFinal: true });
          get().loadHistory();
        }
        break;
      }
      case 'error': {
        const errorMsg = String(event.errorMessage || 'An error occurred');
        const wasSending = get().sending;

        // Snapshot the current streaming message into messages[] so partial
        // content ("Let me get that written down...") is preserved in the UI
        // rather than being silently discarded.
        const currentStream = get().streamingMessage as RawMessage | null;
        if (currentStream && (currentStream.role === 'assistant' || currentStream.role === undefined)) {
          const snapId = (currentStream as RawMessage).id
            || `error-snap-${Date.now()}`;
            const alreadyExists = get().messages.some(m => m.id === snapId);
            if (!alreadyExists) {
              const snapshot = sanitizeIntermediateToolFillerMessage(
                createIntermediateToolTurnSnapshot(currentStream, snapId),
                { trackPhrase: true },
              );
              set((s) => ({
                messages: [...s.messages, snapshot],
              }));
          }
        }

        set({
          error: errorMsg,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          pendingToolImages: [],
          approvalStatus: 'idle',
        });

        // Don't immediately give up: the Gateway often retries internally
        // after transient API failures (e.g. "terminated"). Keep `sending`
        // true for a grace period so that recovery events are processed and
        // the agent-phase-completion handler can still trigger loadHistory.
        if (wasSending) {
          clearErrorRecoveryTimer();
          const ERROR_RECOVERY_GRACE_MS = 15_000;
          _errorRecoveryTimer = setTimeout(() => {
            _errorRecoveryTimer = null;
            const state = get();
            if (state.sending && !state.streamingMessage) {
              clearHistoryPoll();
              // Grace period expired with no recovery — finalize the error
              set({
                sending: false,
                activeRunId: null,
                lastUserMessageAt: null,
              });
              // One final history reload in case the Gateway completed in the
              // background and we just missed the event.
              state.loadHistory(true);
            }
          }, ERROR_RECOVERY_GRACE_MS);
        } else {
          clearHistoryPoll();
          set({ sending: false, activeRunId: null, lastUserMessageAt: null });
        }
        break;
      }
      case 'aborted': {
        clearHistoryPoll();
        clearErrorRecoveryTimer();
        set({
          sending: false,
          activeRunId: null,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          approvalStatus: 'idle',
        });
        break;
      }
      default: {
        // Unknown or empty state — if we're currently sending and receive an event
        // with a message, attempt to process it as streaming data. This handles
        // edge cases where the Gateway sends events without a state field.
        const { sending } = get();
        if (sending && event.message && typeof event.message === 'object') {
          console.warn(`[handleChatEvent] Unknown event state "${resolvedState}", treating message as streaming delta. Event keys:`, Object.keys(event));
          const updates = collectToolUpdates(event.message, 'delta');
          set((s) => ({
            streamingMessage: event.message ?? s.streamingMessage,
            streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
          }));
        }
        break;
      }
    }
  },

  // ── Toggle thinking visibility ──

  toggleThinking: () => set((s) => ({ showThinking: !s.showThinking })),

  // ── Refresh: reload history + sessions ──

  refresh: async () => {
    const { loadHistory, loadSessions } = get();
    await Promise.all([loadHistory(), loadSessions()]);
  },

  clearError: () => set({ error: null }),
}));
