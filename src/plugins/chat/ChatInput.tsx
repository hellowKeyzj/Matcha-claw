/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC. Inline attachments send opaque staged IDs;
 * larger local files keep their source path for prompt-side reads.
 */
import { memo, useId, useState, useRef, useEffect, useLayoutEffect, useImperativeHandle, useCallback, useMemo, type ReactNode, type Ref, type RefObject, type CSSProperties, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Send, Square, X, FileText, Film, Music, FileArchive, File, Loader2, ImageIcon, AlertCircle, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  buildSessionIdentityKey,
  buildCapabilityScopeKey,
  type AgentScope,
  type RuntimeInstanceScope,
  type SessionIdentity,
} from '@/types/desktop/runtime-address';
import { invokeIpc } from '@/lib/api-client';
import { useSkillsStore } from '@/plugins/skills/stores/skills';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CHAT_LAYOUT_TOKENS } from '@/plugins/chat/chat-layout-tokens';
import { ChatImageLightbox } from '@/plugins/message-rendering/ChatImageLightbox';
import { ChatInputStatus, ChatInputToolbar } from '@/plugins/chat/components/ChatInputToolbar';
import type { ModelPickerState } from '@/plugins/chat/components/ChatModelPicker';
import { AgentSkillManagerDialog, type AgentSkillPreviewState } from '@/plugins/chat/components/AgentSkillManagerDialog';
import type { AgentSkillOption } from '@/plugins/chat/components/AgentSkillConfigPanel';
import { collectDroppedFiles } from '@/plugins/chat/collect-dropped-files';
import type { ChatSendAttachment, ChatSendResult } from '@/plugins/chat/store';
import { CHAT_INLINE_ATTACHMENT_MAX_BYTES } from '@/plugins/chat/store/types';
import { resolveChatSendGateForPayload, type ChatSendGate } from '@/plugins/chat/store/send-gate';
import { isDirectoryAttachment, isReadableChatAttachment, isUnsupportedGoalStartAttachment } from '@/plugins/chat/store/send-transport';
import type { ChatContextUsageViewModel } from '@/plugins/chat/context-usage';
import type { PermissionPickerState } from '@/plugins/chat/useChatPermissions';
import { useComposerDraftStore, readComposerDraftSnapshot, clampComposerDraftSelection, type ComposerMode, type ComposerDraftSelection, type ComposerSkill } from '@/plugins/chat/composer-drafts';
import type { SessionRunPhase } from '@/types/session/runtime-state';
import { createSessionTraceId, isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity } from '@/lib/session-trace';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  stagedAttachmentId: string;
  entryKind?: 'file' | 'directory';
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;    // data URL for images, null for others
  sourcePath?: string;
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

interface DialogStagedAttachmentPayload {
  stagedAttachmentId?: string;
  entryKind?: 'file' | 'directory';
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  sourcePath?: string;
}

interface StageOpenAttachmentsResult {
  canceled: boolean;
  selectedFiles?: Array<{
    fileName: string;
    mimeType?: string;
    fileSize?: number;
  }>;
  attachments?: DialogStagedAttachmentPayload[];
}

export interface MentionCandidate {
  id: string;
  label?: string;
  insertText?: string;
}

type SelectedSkill = ComposerSkill;

type SlashItem = (SelectedSkill & { kind: 'skill' }) | { kind: 'goal'; id: 'goal'; name: string };

interface SkillManagerState {
  label: string;
  title: string;
  options: AgentSkillOption[];
  loading: boolean;
  savingSkillId: string | null;
  selectedSkillIds: string[];
  skillPreview: AgentSkillPreviewState | null;
  onToggleSkill: (skillId: string, checked: boolean) => void;
  onPreviewSkill: (skill: SelectedSkill) => void;
  onClearSkillPreview: () => void;
  onClose?: () => void;
}

const STAGE_BUFFER_CONCURRENCY = 3;
const STAGE_BUFFER_MAX_BYTES = CHAT_INLINE_ATTACHMENT_MAX_BYTES;
const QUICK_PHRASE_STORAGE_KEY = 'matchaclaw:chat:quick-phrases';

interface QuickPhrase {
  id: string;
  text: string;
}

const DEFAULT_QUICK_PHRASES: QuickPhrase[] = [];
const EMPTY_SKILLS: ReturnType<typeof useSkillsStore.getState>['skills'] = [];

export interface ChatInputHandle {
  replaceText: (text: string) => void;
  focus: () => void;
}

interface ChatInputProps {
  ref?: Ref<ChatInputHandle>;
  onSend: (text: string, attachments?: ChatSendAttachment[], operationId?: string) => ChatSendResult | Promise<ChatSendResult>;
  onStop?: () => void;
  goal?: { supported: boolean; mode: ComposerMode | null; busy: boolean; unknown: boolean; canDiscard: boolean; error: string | null; onStart: () => void; onCancel: () => void; onRefresh: () => void; onSubmit: (text: string, attachments?: ChatSendAttachment[]) => Promise<ChatSendResult> };
  goalDock?: ReactNode;
  topContent?: ReactNode;
  draft?: string;
  draftKey?: string;
  onDraftChange?: (update: SetStateAction<string>) => void;
  onDraftSelectionChange?: (selection: ComposerDraftSelection) => void;
  draftSelection?: ComposerDraftSelection | null;
  stopping?: boolean;
  skillsScope: AgentScope | RuntimeInstanceScope | null;
  skillManager?: SkillManagerState | null;
  modelPicker?: ModelPickerState | null;
  permissionPicker?: PermissionPickerState | null;
  contextUsage?: ChatContextUsageViewModel | null;
  composerContent?: ReactNode;
  disabled?: boolean;
  reconnecting?: boolean;
  sending?: boolean;
  imageGenerationActive?: boolean;
  sendGate: ChatSendGate;
  approvalWaiting?: boolean;
  mentionCandidates?: MentionCandidate[];
  allowedSkillIds?: string[] | null;
  sessionIdentity: SessionIdentity | null;
  endpointSessionId?: string | null;
  activeRunId?: string | null;
  runPhase?: SessionRunPhase | null;
}

function resolveInputPlaceholder(
  disabled: boolean,
  approvalWaiting: boolean,
  translate: (key: string) => string,
): string {
  if (disabled) {
    return translate('input.gatewayDisconnectedPlaceholder');
  }
  if (approvalWaiting) {
    return translate('input.approvalWaitingPlaceholder');
  }
  return translate('input.messagePlaceholder');
}

// ── Helpers ──────────────────────────────────────────────────────

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

/**
 * Read a browser File object as base64 string (without the data URL prefix).
 */
function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl || !dataUrl.includes(',')) {
        reject(new Error(`Invalid data URL from FileReader for ${file.name}`));
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (!base64) {
        reject(new Error(`Empty base64 data for ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const normalizedConcurrency = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  };

  const workerCount = Math.min(items.length, normalizedConcurrency);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function detectMentionRange(inputText: string, cursor: number): { start: number; end: number; query: string } | null {
  const safeCursor = Math.max(0, Math.min(cursor, inputText.length));
  const beforeCursor = inputText.slice(0, safeCursor);
  const atIndex = beforeCursor.lastIndexOf('@');
  if (atIndex < 0) {
    return null;
  }
  if (atIndex > 0 && !/\s/.test(beforeCursor[atIndex - 1])) {
    return null;
  }
  const query = beforeCursor.slice(atIndex + 1);
  if (/[\s\r\n\t]/.test(query)) {
    return null;
  }
  return { start: atIndex, end: safeCursor, query };
}

function detectSlashRange(inputText: string, cursor: number): { start: number; end: number; query: string } | null {
  const safeCursor = Math.max(0, Math.min(cursor, inputText.length));
  const beforeCursor = inputText.slice(0, safeCursor);
  const slashIndex = beforeCursor.lastIndexOf('/');
  if (slashIndex < 0) {
    return null;
  }
  if (slashIndex > 0 && !/\s/.test(beforeCursor[slashIndex - 1])) {
    return null;
  }
  const query = beforeCursor.slice(slashIndex + 1);
  if (/[\s\r\n\t]/.test(query)) {
    return null;
  }
  return { start: slashIndex, end: safeCursor, query };
}

function buildSkillPrefixedMessage(text: string, selectedSkills: SelectedSkill[]): string {
  if (selectedSkills.length === 0) {
    return text;
  }
  const skillNames = selectedSkills.map((skill) => skill.name).join('、');
  const prefix = `[已选择技能: ${skillNames}]`;
  if (!text) {
    return prefix;
  }
  return `${prefix}\n${text}`;
}

function insertQuickPhraseText(inputText: string, phrase: string, selectionStart: number, selectionEnd: number): { nextValue: string; caret: number } {
  const safeStart = Math.max(0, Math.min(selectionStart, inputText.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd, inputText.length));
  const before = inputText.slice(0, safeStart);
  const after = inputText.slice(safeEnd);
  const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  const insertion = `${prefix}${phrase}${suffix}`;
  return {
    nextValue: `${before}${insertion}${after}`,
    caret: before.length + prefix.length + phrase.length + suffix.length,
  };
}

function loadQuickPhrases(): QuickPhrase[] {
  if (typeof window === 'undefined') {
    return DEFAULT_QUICK_PHRASES;
  }
  try {
    const raw = window.localStorage.getItem(QUICK_PHRASE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_QUICK_PHRASES;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return DEFAULT_QUICK_PHRASES;
    }
    return parsed
      .filter((item): item is QuickPhrase => (
        Boolean(item)
        && typeof item === 'object'
        && typeof item.id === 'string'
        && typeof item.text === 'string'
        && item.text.trim().length > 0
      ))
      .map((item) => ({ id: item.id, text: item.text.trim() }));
  } catch {
    return DEFAULT_QUICK_PHRASES;
  }
}

function saveQuickPhrases(phrases: QuickPhrase[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(QUICK_PHRASE_STORAGE_KEY, JSON.stringify(phrases));
  } catch {
    // ignore localStorage failures
  }
}

function createQuickPhraseId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `quick-phrase-${Date.now()}`;
}

function buildStagingAttachment(
  stagedAttachmentId: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
): FileAttachment {
  return {
    stagedAttachmentId,
    fileName,
    mimeType,
    fileSize,
    preview: null,
    status: 'staging',
  };
}

function isPreviewableImageAttachment(attachment: FileAttachment): boolean {
  return attachment.status === 'ready'
    && !isDirectoryAttachment(attachment)
    && attachment.mimeType.startsWith('image/')
    && typeof attachment.preview === 'string'
    && attachment.preview.length > 0;
}

function waitForAttachmentPlaceholderFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function ComposerSuggestions({ anchorRef, children }: {
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top - 20;
      const below = window.innerHeight - rect.bottom - 20;
      const showAbove = above >= Math.min(224, below);
      const width = Math.min(rect.width, window.innerWidth - 24);
      setPosition({
        width,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        ...(showAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: Math.max(0, Math.min(224, showAbove ? above : below)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (anchorRef.current) observer.observe(anchorRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);
  return createPortal(
    <div role="listbox" style={position} className="fixed z-50 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-elevated">{children}</div>,
    document.body,
  );
}

// ── Component ────────────────────────────────────────────────────

export const ChatInput = memo(function ChatInput({
  ref,
  onSend,
  onStop,
  goal,
  goalDock,
  topContent,
  draft,
  draftKey,
  onDraftChange,
  onDraftSelectionChange,
  draftSelection,
  stopping = false,
  skillsScope,
  skillManager = null,
  modelPicker = null,
  permissionPicker = null,
  contextUsage = null,
  composerContent,
  disabled = false,
  reconnecting = false,
  sending = false,
  imageGenerationActive = false,
  sendGate,
  approvalWaiting = false,
  mentionCandidates = [],
  allowedSkillIds = null,
  sessionIdentity,
  activeRunId = null,
  runPhase = null,
}: ChatInputProps) {
  const { t } = useTranslation('chat');
  const composerId = useId();
  const composerAnchorName = `--chat-composer-${composerId.replace(/:/g, '')}`;
  const usesStoredDraft = Boolean(draftKey && !onDraftChange);
  const storedDraft = useComposerDraftStore((state) => draftKey && usesStoredDraft ? state.drafts[draftKey] ?? '' : '');
  const storedSelection = useComposerDraftStore((state) => draftKey && usesStoredDraft ? state.selections[draftKey] ?? null : null);
  const submission = useComposerDraftStore((state) => draftKey ? state.submissions[draftKey] : undefined);
  const storedDraftChange = useCallback((update: SetStateAction<string>) => {
    if (draftKey) useComposerDraftStore.getState().setDraft(draftKey, update);
  }, [draftKey]);
  const storedSelectionChange = useCallback((selection: ComposerDraftSelection) => {
    if (draftKey) useComposerDraftStore.getState().setSelection(draftKey, selection);
  }, [draftKey]);
  if (draftKey && !onDraftChange) {
    draft = storedDraft;
    draftSelection = clampComposerDraftSelection(storedSelection, storedDraft);
    onDraftChange = storedDraftChange;
    onDraftSelectionChange = storedSelectionChange;
  }
  const [uncontrolledInput, setUncontrolledInput] = useState('');
  const input = onDraftChange ? (draft ?? '') : uncontrolledInput;
  const inputRevisionRef = useRef(0);
  const setInput = useCallback((update: SetStateAction<string>) => {
    inputRevisionRef.current += 1;
    if (onDraftChange) onDraftChange(update);
    else setUncontrolledInput(update);
  }, [onDraftChange]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const committedAttachmentsRef = useRef(attachments);
  const ownedStagedAttachmentIdsRef = useRef(new Set<string>());
  const canceledStagingKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const sessionIdentityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const composerScope = useMemo(() => ({ draftKey, sessionIdentityKey }), [draftKey, sessionIdentityKey]);
  const currentScopeRef = useRef<typeof composerScope | null>(null);
  type SendOperation = {
    scope: typeof composerScope;
    attachmentIds: ReadonlySet<string>;
    initializationId: string | null;
    handoffScope: typeof composerScope | null;
    retired: boolean;
  };
  const sendOperationRef = useRef<SendOperation | null>(null);
  const [pendingSend, setPendingSend] = useState<SendOperation | null>(null);
  const isCurrentScope = useCallback(() => (
    mountedRef.current && currentScopeRef.current === composerScope
  ), [composerScope]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionEnd, setMentionEnd] = useState(-1);
  const [mentionItems, setMentionItems] = useState<MentionCandidate[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashStart, setSlashStart] = useState(-1);
  const [slashEnd, setSlashEnd] = useState(-1);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [selectedSkills, setSelectedSkills] = useState<SelectedSkill[]>([]);
  const [quickPhrases, setQuickPhrases] = useState<QuickPhrase[]>(() => loadQuickPhrases());
  const [quickPhraseOpen, setQuickPhraseOpen] = useState(false);
  const [quickPhraseAddOpen, setQuickPhraseAddOpen] = useState(false);
  const [quickPhraseDraft, setQuickPhraseDraft] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [permissionPickerOpen, setPermissionPickerOpen] = useState(false);
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
  const [lightboxAttachment, setLightboxAttachment] = useState<{
    src: string;
    fileName: string;
    filePath?: string;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
  const [reuseSelection, setReuseSelection] = useState<ComposerDraftSelection | null>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const isComposingRef = useRef(false);
  const draftSelectionRef = useRef<ComposerDraftSelection | null>(null);
  const lastRestoredDraftKeyRef = useRef<string | null>(null);
  draftSelectionRef.current = draftSelection ?? null;
  const skillsScopeKey = skillsScope ? buildCapabilityScopeKey(skillsScope) : null;
  const storedSkills = useSkillsStore((state) => state.skills);
  const skillsScopeMatches = useSkillsStore((state) => skillsScopeKey !== null && state.scopeKey === skillsScopeKey);
  const skills = skillsScopeMatches ? storedSkills : EMPTY_SKILLS;
  const skillsSnapshotReady = useSkillsStore((state) => skillsScopeMatches && state.snapshotReady);
  const skillsInitialLoading = useSkillsStore((state) => skillsScopeMatches && state.initialLoading);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const allowedSkillIdSet = useMemo(() => {
    if (!Array.isArray(allowedSkillIds)) {
      return null;
    }
    return new Set(allowedSkillIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()));
  }, [allowedSkillIds]);

  const slashItems = useMemo<SlashItem[]>(() => {
    if (!slashOpen || slashStart < 0 || slashEnd < slashStart) {
      return [];
    }
    const query = normalizeSearchText(input.slice(slashStart + 1, slashEnd));
    const selectedIds = new Set(selectedSkills.map((skill) => skill.id));
    const skillItems = skills
      .filter((skill) => (
        skill.enabled
        && skill.eligible === true
        && !selectedIds.has(skill.id)
        && (!allowedSkillIdSet || allowedSkillIdSet.has(skill.id))
      ))
      .filter((skill) => {
        if (!query) {
          return true;
        }
        const fields = [skill.id, skill.slug ?? '', skill.name, skill.description];
        return fields.some((field) => normalizeSearchText(field).includes(query));
      })
      .map((skill) => ({
        kind: 'skill' as const,
        id: skill.id,
        name: skill.name,
        icon: skill.icon || '🧩',
        filePath: skill.filePath,
        baseDir: skill.baseDir,
      }));
    const goalItems: SlashItem[] = goal?.supported && !goal.mode && (!query || 'goal'.includes(query))
      ? [{ kind: 'goal', id: 'goal', name: t('goal.set') }] : [];
    return [...goalItems, ...skillItems];
  }, [allowedSkillIdSet, goal?.mode, goal?.supported, input, selectedSkills, skills, slashEnd, slashOpen, slashStart, t]);
  const slashSkillsLoading = slashOpen && !skillsSnapshotReady;

  const rememberDraftSelection = useCallback((textarea = textareaRef.current) => {
    if (!onDraftSelectionChange || !textarea || !textarea.value) return;
    onDraftSelectionChange({
      start: textarea.selectionStart ?? 0,
      end: textarea.selectionEnd ?? 0,
      direction: textarea.selectionDirection ?? 'none',
    });
  }, [onDraftSelectionChange]);

  const setInputAndSelection = useCallback((nextValue: string, selection: ComposerDraftSelection) => {
    setInput(nextValue);
    if (nextValue) onDraftSelectionChange?.(selection);
  }, [onDraftSelectionChange, setInput]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useLayoutEffect(() => {
    if (disabled || !textareaRef.current) return;
    const textarea = textareaRef.current;
    textarea.focus();
    if (lastRestoredDraftKeyRef.current === (draftKey ?? null)) return;
    lastRestoredDraftKeyRef.current = draftKey ?? null;
    const savedSelection = draftSelectionRef.current;
    const fallbackPosition = savedSelection ? 0 : textarea.value.length;
    const start = Math.max(0, Math.min(savedSelection?.start ?? fallbackPosition, textarea.value.length));
    const end = Math.max(start, Math.min(savedSelection?.end ?? start, textarea.value.length));
    textarea.setSelectionRange(start, end, savedSelection?.direction ?? 'none');
  }, [disabled, draftKey]);

  useEffect(() => {
    if (!slashOpen || !skillsScope || skillsSnapshotReady || skillsInitialLoading) {
      return;
    }
    void fetchSkills({ scope: skillsScope });
  }, [fetchSkills, skillsInitialLoading, skillsScope, skillsSnapshotReady, slashOpen]);

  useEffect(() => {
    if (!slashOpen || slashItems.length === 0) {
      slashItemRefs.current = [];
      return;
    }
    const activeNode = slashItemRefs.current[slashActiveIndex];
    activeNode?.scrollIntoView?.({ block: 'center' });
  }, [slashActiveIndex, slashItems.length, slashOpen]);

  useEffect(() => {
    if (!allowedSkillIdSet) {
      return;
    }
    setSelectedSkills((prev) => {
      const next = prev.filter((skill) => allowedSkillIdSet.has(skill.id));
      return next.length === prev.length ? prev : next;
    });
  }, [allowedSkillIdSet]);

  useEffect(() => {
    setModelPickerOpen(false);
    setPermissionPickerOpen(false);
  }, [draftKey, sessionIdentityKey]);

  useEffect(() => {
    if (!modelPicker) setModelPickerOpen(false);
  }, [modelPicker]);

  useEffect(() => {
    if (!permissionPicker || permissionPicker.disabled || permissionPicker.busy || permissionPicker.options.length === 0) {
      setPermissionPickerOpen(false);
    }
  }, [permissionPicker]);

  useEffect(() => {
    if (!skillManager) {
      setSkillManagerOpen(false);
    }
  }, [skillManager]);

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionItems([]);
    setMentionActiveIndex(0);
    setMentionStart(-1);
    setMentionEnd(-1);
  }, []);

  const closeSlash = useCallback(() => {
    setSlashOpen(false);
    setSlashActiveIndex(0);
    setSlashStart(-1);
    setSlashEnd(-1);
  }, []);

  const closeQuickPhrase = useCallback(() => {
    setQuickPhraseOpen(false);
    setQuickPhraseAddOpen(false);
    setQuickPhraseDraft('');
  }, []);

  const closeSkillManager = useCallback(() => {
    setSkillManagerOpen(false);
    skillManager?.onClose?.();
  }, [skillManager]);

  const closeComposerPopovers = useCallback(() => {
    closeMention();
    closeSlash();
    closeQuickPhrase();
    setModelPickerOpen(false);
    setPermissionPickerOpen(false);
  }, [closeMention, closeQuickPhrase, closeSlash]);

  const startGoal = useCallback(() => {
    closeComposerPopovers();
    goal?.onStart();
    textareaRef.current?.focus();
  }, [closeComposerPopovers, goal]);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus({ preventScroll: true }),
    replaceText: (text) => {
      const selection: ComposerDraftSelection = { start: text.length, end: text.length, direction: 'none' };
      setInputAndSelection(text, selection);
      closeComposerPopovers();
      setReuseSelection(selection);
    },
  }), [closeComposerPopovers, setInputAndSelection]);

  useLayoutEffect(() => {
    if (!reuseSelection) return;
    textareaRef.current?.focus({ preventScroll: true });
    textareaRef.current?.setSelectionRange(reuseSelection.start, reuseSelection.end);
  }, [reuseSelection]);

  const refreshMentionCandidates = useCallback((nextInput: string, cursor: number) => {
    if (mentionCandidates.length === 0) {
      closeMention();
      return;
    }
    const range = detectMentionRange(nextInput, cursor);
    if (!range) {
      closeMention();
      return;
    }
    const query = normalizeSearchText(range.query);
    const matched = mentionCandidates.filter((item) => {
      const idMatched = normalizeSearchText(item.id).includes(query);
      const labelMatched = normalizeSearchText(item.label ?? '').includes(query);
      return idMatched || labelMatched;
    });
    if (matched.length === 0) {
      closeMention();
      return;
    }
    setMentionOpen(true);
    setMentionStart(range.start);
    setMentionEnd(range.end);
    setMentionItems(matched);
    setMentionActiveIndex((prev) => (prev >= matched.length ? 0 : prev));
    closeSlash();
    closeQuickPhrase();
  }, [closeMention, closeQuickPhrase, closeSlash, mentionCandidates]);

  const applyMentionSelection = useCallback((candidate: MentionCandidate) => {
    if (!textareaRef.current || mentionStart < 0 || mentionEnd < mentionStart) {
      return;
    }
    const insertion = candidate.insertText ?? `@${candidate.id} `;
    const nextValue = `${input.slice(0, mentionStart)}${insertion}${input.slice(mentionEnd)}`;
    const caret = mentionStart + insertion.length;
    setInputAndSelection(nextValue, { start: caret, end: caret, direction: 'none' });
    closeMention();
    requestAnimationFrame(() => {
      if (!isCurrentScope()) return;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }, [closeMention, input, isCurrentScope, mentionEnd, mentionStart, setInputAndSelection]);

  const refreshSlashCandidates = useCallback((nextInput: string, cursor: number) => {
    const range = detectSlashRange(nextInput, cursor);
    if (!range) {
      closeSlash();
      return;
    }
    setSlashOpen(true);
    setSlashStart(range.start);
    setSlashEnd(range.end);
    setSlashActiveIndex(0);
    closeMention();
    closeQuickPhrase();
  }, [closeMention, closeQuickPhrase, closeSlash]);

  const applySlashSelection = useCallback((candidate: SlashItem) => {
    if (!textareaRef.current || slashStart < 0 || slashEnd < slashStart) {
      return;
    }
    const before = input.slice(0, slashStart);
    const after = input.slice(slashEnd);
    let nextValue = `${before}${after}`;
    if (before.length > 0 && after.length > 0 && !/\s$/.test(before) && !/^\s/.test(after)) {
      nextValue = `${before} ${after}`;
    }
    if (candidate.kind === 'skill') nextValue = nextValue.replace(/\s{2,}/g, ' ');
    const caret = before.length;
    setInputAndSelection(nextValue, { start: caret, end: caret, direction: 'none' });
    if (candidate.kind === 'goal') goal?.onStart();
    else setSelectedSkills((prev) => (prev.some((item) => item.id === candidate.id) ? prev : [...prev, candidate]));
    closeSlash();
    requestAnimationFrame(() => {
      if (!isCurrentScope()) return;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }, [closeSlash, goal, input, isCurrentScope, setInputAndSelection, slashEnd, slashStart]);

  const toggleQuickPhrase = useCallback(() => {
    setQuickPhraseOpen((open) => !open);
    setQuickPhraseAddOpen(false);
    setQuickPhraseDraft('');
    setSkillManagerOpen(false);
    closeMention();
    closeSlash();
  }, [closeMention, closeSlash]);

  const openSkillManager = useCallback(() => {
    if (!skillManager) {
      return;
    }
    closeComposerPopovers();
    skillManager.onClearSkillPreview();
    setSkillManagerOpen(true);
  }, [closeComposerPopovers, skillManager]);

  const previewSelectedSkill = useCallback((skill: SelectedSkill) => {
    if (!skillManager) {
      return;
    }
    closeComposerPopovers();
    setSkillManagerOpen(true);
    skillManager.onPreviewSkill(skill);
  }, [closeComposerPopovers, skillManager]);

  const applyQuickPhrase = useCallback((phrase: string) => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? input.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const { nextValue, caret } = insertQuickPhraseText(input, phrase, selectionStart, selectionEnd);
    setInputAndSelection(nextValue, { start: caret, end: caret, direction: 'none' });
    closeQuickPhrase();
    requestAnimationFrame(() => {
      if (!isCurrentScope()) return;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }, [closeQuickPhrase, input, isCurrentScope, setInputAndSelection]);

  const commitQuickPhraseList = useCallback((nextPhrases: QuickPhrase[]) => {
    setQuickPhrases(nextPhrases);
    saveQuickPhrases(nextPhrases);
  }, []);

  const moveQuickPhrase = useCallback((phraseId: string, direction: -1 | 1) => {
    const index = quickPhrases.findIndex((phrase) => phrase.id === phraseId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= quickPhrases.length) {
      return;
    }
    const nextPhrases = [...quickPhrases];
    const [phrase] = nextPhrases.splice(index, 1);
    nextPhrases.splice(targetIndex, 0, phrase);
    commitQuickPhraseList(nextPhrases);
  }, [commitQuickPhraseList, quickPhrases]);

  const removeQuickPhrase = useCallback((phraseId: string) => {
    commitQuickPhraseList(quickPhrases.filter((phrase) => phrase.id !== phraseId));
  }, [commitQuickPhraseList, quickPhrases]);

  const addQuickPhrase = useCallback(() => {
    const text = quickPhraseDraft.trim();
    if (!text) {
      return;
    }
    commitQuickPhraseList([...quickPhrases, { id: createQuickPhraseId(), text }]);
    setQuickPhraseDraft('');
    setQuickPhraseAddOpen(false);
  }, [commitQuickPhraseList, quickPhraseDraft, quickPhrases]);

  const releaseStagedAttachmentIds = useCallback((stagedAttachmentIds: readonly string[], ownedOnly = false) => {
    const uniqueIds = [...new Set(stagedAttachmentIds)].filter((id): id is string => typeof id === 'string' && id.length > 0);
    const idsToRelease = ownedOnly
      ? uniqueIds.filter((id) => ownedStagedAttachmentIdsRef.current.has(id))
      : uniqueIds;
    if (idsToRelease.length === 0) {
      return;
    }
    idsToRelease.forEach((id) => ownedStagedAttachmentIdsRef.current.delete(id));
    void invokeIpc('dialog:releaseStagedAttachments', idsToRelease).catch(() => undefined);
  }, []);

  const registerStagedAttachment = useCallback((stagedAttachmentId: string, stagingKey: string): boolean => {
    if (!isCurrentScope() || canceledStagingKeysRef.current.has(stagingKey)) {
      releaseStagedAttachmentIds([stagedAttachmentId]);
      return false;
    }
    canceledStagingKeysRef.current.delete(stagingKey);
    ownedStagedAttachmentIdsRef.current.add(stagedAttachmentId);
    return true;
  }, [isCurrentScope, releaseStagedAttachmentIds]);

  useLayoutEffect(() => {
    currentScopeRef.current = composerScope;
    const operation = sendOperationRef.current;
    if (operation && operation.scope !== composerScope && operation.handoffScope !== composerScope) {
      const initialization = draftKey ? useComposerDraftStore.getState().initializations[draftKey] : null;
      if (!operation.retired && !operation.handoffScope && !operation.scope.sessionIdentityKey && composerScope.sessionIdentityKey
        && initialization?.kind === 'pending' && initialization.operationId === operation.initializationId) {
        operation.handoffScope = composerScope;
      } else operation.retired = true;
    }
    const retainedIds = new Set(committedAttachmentsRef.current
      .filter((attachment) => attachment.status !== 'staging')
      .map((attachment) => attachment.stagedAttachmentId));
    releaseStagedAttachmentIds([...ownedStagedAttachmentIdsRef.current].filter((id) => !retainedIds.has(id)));
    setAttachments((current) => {
      const retained = current.filter((attachment) => attachment.status !== 'staging' && retainedIds.has(attachment.stagedAttachmentId));
      return retained.length === current.length ? current : retained;
    });
    return () => {
      currentScopeRef.current = null;
    };
  }, [composerScope, draftKey, releaseStagedAttachmentIds]);

  useLayoutEffect(() => {
    committedAttachmentsRef.current = attachments;
  }, [attachments]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const ownedStagedAttachmentIds = ownedStagedAttachmentIdsRef.current;
    const canceledStagingKeys = canceledStagingKeysRef.current;
    return () => {
      mountedRef.current = false;
      const stagedAttachmentIds = [...ownedStagedAttachmentIds];
      ownedStagedAttachmentIds.clear();
      canceledStagingKeys.clear();
      if (stagedAttachmentIds.length > 0) {
        void invokeIpc('dialog:releaseStagedAttachments', stagedAttachmentIds).catch(() => undefined);
      }
    };
  }, []);

  // ── File staging via native dialog ─────────────────────────────

  const stageSelectedDialogAttachments = useCallback(async () => {
    if (!isCurrentScope()) return;
    const tempIds: string[] = [];
    let stagingAttachments: FileAttachment[] = [];
    let stagedAttachmentIdsFromResult: string[] = [];

    try {
      const result = await invokeIpc<StageOpenAttachmentsResult>('dialog:stageOpenAttachments', {
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.attachments || result.attachments.length === 0) {
        return;
      }
      stagedAttachmentIdsFromResult = result.attachments
        .map((attachment) => attachment.stagedAttachmentId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (!isCurrentScope()) {
        releaseStagedAttachmentIds(stagedAttachmentIdsFromResult);
        return;
      }

      stagingAttachments = result.attachments.map((attachment) => {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        return buildStagingAttachment(
          tempId,
          attachment.fileName,
          attachment.mimeType,
          attachment.fileSize,
        );
      });
      setAttachments((prev) => isCurrentScope() ? [...prev, ...stagingAttachments] : prev);
      await waitForAttachmentPlaceholderFrame();
      if (!isCurrentScope()) {
        releaseStagedAttachmentIds(stagedAttachmentIdsFromResult);
        return;
      }

      const updatesByTempId = new Map<string, FileAttachment>();
      for (let i = 0; i < tempIds.length; i++) {
        const tempId = tempIds[i];
        const attachment = result.attachments[i];
        const registered = attachment.stagedAttachmentId
          ? registerStagedAttachment(attachment.stagedAttachmentId, tempId)
          : !canceledStagingKeysRef.current.has(tempId);
        updatesByTempId.set(tempId, registered
          ? { ...attachment, stagedAttachmentId: attachment.stagedAttachmentId ?? tempId, status: 'ready' }
          : { ...stagingAttachments[i], status: 'error', error: 'Attachment removed' });
      }
      if (isCurrentScope()) {
        setAttachments((prev) => isCurrentScope() ? prev.map((attachment) => (
          updatesByTempId.get(attachment.stagedAttachmentId) ?? attachment
        )) : prev);
      }
    } catch (err) {
      if (stagedAttachmentIdsFromResult.length > 0) {
        releaseStagedAttachmentIds(stagedAttachmentIdsFromResult);
      }
      if (tempIds.length === 0) {
        console.error('[stageSelectedDialogAttachments] Failed to stage selected attachments:', err);
        return;
      }
      const failedIds = new Set(tempIds);
      if (isCurrentScope()) {
        setAttachments((prev) => isCurrentScope() ? prev.map((attachment) => (
          failedIds.has(attachment.stagedAttachmentId)
            ? { ...attachment, status: 'error', error: String(err) }
            : attachment
        )) : prev);
      }
    }
  }, [isCurrentScope, registerStagedAttachment, releaseStagedAttachmentIds]);

  const stageDroppedPathFiles = useCallback(async (filePaths: string[]) => {
    if (!isCurrentScope() || filePaths.length === 0) {
      return;
    }
    const tempIds: string[] = filePaths.map(() => crypto.randomUUID());
    let stagedAttachmentIdsFromResult: string[] = [];
    const stagingAttachments = filePaths.map((filePath, index) => {
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      return buildStagingAttachment(tempIds[index], fileName, 'application/octet-stream', 0);
    });
    setAttachments((prev) => isCurrentScope() ? [...prev, ...stagingAttachments] : prev);

    try {
      const result = await invokeIpc<{ attachments?: DialogStagedAttachmentPayload[] }>(
        'dialog:stageDroppedAttachments',
        filePaths,
      );
      const stagedAttachments = result.attachments ?? [];
      stagedAttachmentIdsFromResult = stagedAttachments
        .map((attachment) => attachment.stagedAttachmentId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (!isCurrentScope()) {
        releaseStagedAttachmentIds(stagedAttachmentIdsFromResult);
        return;
      }
      const updatesByTempId = new Map<string, FileAttachment>();
      for (let i = 0; i < tempIds.length; i++) {
        const tempId = tempIds[i];
        const data = stagedAttachments[i];
        if (!data) {
          updatesByTempId.set(tempId, { ...stagingAttachments[i], status: 'error', error: 'Staging failed' });
          continue;
        }
        const registered = data.stagedAttachmentId
          ? registerStagedAttachment(data.stagedAttachmentId, tempId)
          : !canceledStagingKeysRef.current.has(tempId);
        updatesByTempId.set(tempId, registered
          ? { ...data, stagedAttachmentId: data.stagedAttachmentId ?? tempId, status: 'ready' }
          : { ...stagingAttachments[i], status: 'error', error: 'Attachment removed' });
      }
      if (isCurrentScope()) {
        setAttachments((prev) => isCurrentScope() ? prev.map((attachment) => (
          updatesByTempId.get(attachment.stagedAttachmentId) ?? attachment
        )) : prev);
      }
    } catch (err) {
      if (stagedAttachmentIdsFromResult.length > 0) {
        releaseStagedAttachmentIds(stagedAttachmentIdsFromResult);
      }
      const failedIds = new Set(tempIds);
      if (isCurrentScope()) {
        setAttachments((prev) => isCurrentScope() ? prev.map((attachment) => (
          failedIds.has(attachment.stagedAttachmentId)
            ? { ...attachment, status: 'error', error: String(err) }
            : attachment
        )) : prev);
      }
    }
  }, [isCurrentScope, registerStagedAttachment, releaseStagedAttachmentIds]);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    if (!isCurrentScope() || files.length === 0) {
      return;
    }

    const queue = files.map((file) => ({
      file,
      tempId: crypto.randomUUID(),
      fallback: buildStagingAttachment(
        '',
        file.name,
        file.type || 'application/octet-stream',
        file.size,
      ),
    }));
    const placeholders = queue.map(({ file, tempId }) => (
      buildStagingAttachment(
        tempId,
        file.name,
        file.type || 'application/octet-stream',
        file.size,
      )
    ));
    setAttachments((prev) => isCurrentScope() ? [...prev, ...placeholders] : prev);

    const results = await mapWithConcurrency(
      queue,
      STAGE_BUFFER_CONCURRENCY,
      async ({ file, tempId, fallback }) => {
        try {
          if (!isCurrentScope()) throw new Error('Attachment removed');
          if (file.size > STAGE_BUFFER_MAX_BYTES) {
            throw new Error('tooLarge');
          }
          const base64 = await readFileAsBase64(file);
          if (!isCurrentScope()) throw new Error('Attachment removed');
          const staged = await invokeIpc<DialogStagedAttachmentPayload>('dialog:stageRendererBufferAttachment', {
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          });
          const stagedAttachmentId = staged.stagedAttachmentId;
          if (!stagedAttachmentId) {
            throw new Error('Missing staged attachment id');
          }
          if (!registerStagedAttachment(stagedAttachmentId, tempId)) {
            return {
              tempId,
              attachment: {
                ...fallback,
                stagedAttachmentId: tempId,
                status: 'error' as const,
                error: 'Attachment removed',
              },
            };
          }
          return { tempId, attachment: { ...staged, stagedAttachmentId, status: 'ready' as const } };
        } catch (err) {
          return {
            tempId,
            attachment: {
              ...fallback,
              stagedAttachmentId: tempId,
              status: 'error' as const,
              error: String(err),
            },
          };
        }
      },
    );

    if (!isCurrentScope()) {
      return;
    }
    const updatesByTempId = new Map<string, FileAttachment>(
      results.map((result) => [result.tempId, result.attachment] as const),
    );
    setAttachments((prev) => isCurrentScope() ? prev.map((attachment) => (
      updatesByTempId.get(attachment.stagedAttachmentId) ?? attachment
    )) : prev);
  }, [isCurrentScope, registerStagedAttachment]);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((stagedAttachmentId: string) => {
    canceledStagingKeysRef.current.add(stagedAttachmentId);
    setAttachments((prev) => prev.filter((attachment) => attachment.stagedAttachmentId !== stagedAttachmentId));
    releaseStagedAttachmentIds([stagedAttachmentId], true);
  }, [releaseStagedAttachmentIds]);

  const openAttachment = useCallback((attachment: FileAttachment) => {
    if (attachment.status !== 'ready' || !isPreviewableImageAttachment(attachment)) {
      return;
    }

    setLightboxAttachment({
      src: attachment.preview!,
      fileName: attachment.fileName,
      filePath: attachment.sourcePath,
    });
  }, []);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const hasFailedAttachments = attachments.some((a) => a.status === 'error');
  const readableAttachmentCount = attachments.filter(isReadableChatAttachment).length;
  const payloadGate = resolveChatSendGateForPayload(sendGate, {
    text: input,
    attachmentCount: readableAttachmentCount,
    selectedSkillCount: selectedSkills.length,
  });
  const invalidGoalAttachments = Boolean(goal?.mode) && attachments.some((attachment) => isUnsupportedGoalStartAttachment(attachment) || Boolean(goal?.mode?.goalId));
  const editingGoal = Boolean(goal?.mode?.goalId);
  const effectiveSending = sending && !editingGoal;
  const sendPending = Boolean(submission) || pendingSend?.scope === composerScope
    || attachments.some((attachment) => pendingSend?.attachmentIds.has(attachment.stagedAttachmentId));
  const canSend = (payloadGate.canSend || editingGoal && !payloadGate.canSend && (payloadGate.reason === 'active' || payloadGate.reason === 'stopping'))
    && (!goal?.mode || Boolean(input.trim()) && goal.supported && !goal.busy && !goal.unknown && !invalidGoalAttachments)
    && allReady
    && !sendPending
    && !disabled
    && (editingGoal || !approvalWaiting)
    && (editingGoal || !imageGenerationActive);
  const canStop = sending && !stopping && !disabled && !!onStop;
  const modelPickerDisabled = !modelPicker
    || modelPicker.disabled
    || modelPicker.loading
    || modelPicker.switching
    || modelPicker.options.length === 0;
  const permissionPickerDisabled = !permissionPicker
    || permissionPicker.disabled
    || permissionPicker.busy
    || permissionPicker.options.length === 0;
  const composerTraceRef = useRef<{ signature: string; state: Record<string, unknown> } | null>(null);
  const handleModelPickerOpenChange = useCallback((open: boolean) => {
    logSessionTrace('session.composer.model-open', 'session-composer-boundary', () => ({
      ...composerTraceRef.current?.state, requestedOpen: open, disabled: modelPickerDisabled,
    }));
    if (open) {
      setPermissionPickerOpen(false);
      setSkillManagerOpen(false);
    }
    setModelPickerOpen(open);
  }, [modelPickerDisabled]);
  const handlePermissionPickerOpenChange = useCallback((open: boolean) => {
    if (open && permissionPickerDisabled) return;
    if (open) {
      setModelPickerOpen(false);
      setSkillManagerOpen(false);
    }
    setPermissionPickerOpen(open);
  }, [permissionPickerDisabled]);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    const state = {
      identity: summarizeSessionIdentity(sessionIdentity), draftKey: summarizeIdentifier(draftKey),
      disabled, reconnecting, sending, stopping, runPhase, activeRun: summarizeIdentifier(activeRunId), approvalWaiting,
      sendPending, canSend, canStop, sendGateReason: sendGate.canSend ? null : sendGate.reason,
      payloadGateReason: payloadGate.canSend ? null : payloadGate.reason,
      allAttachmentsReady: allReady, imageGenerationActive,
      goal: {
        mode: goal?.mode ? (editingGoal ? 'edit' : 'create') : null, busy: goal?.busy ?? false,
        supported: goal?.supported ?? false, unknown: goal?.unknown ?? false,
        invalidAttachments: invalidGoalAttachments, hasText: !!input.trim(),
      },
      model: {
        present: !!modelPicker, disabled: modelPickerDisabled, blockedByParent: modelPicker?.disabled ?? false,
        loading: modelPicker?.loading ?? false, switching: modelPicker?.switching ?? false,
        optionCount: modelPicker?.options.length ?? 0, selected: summarizeIdentifier(modelPicker?.currentModelId), open: modelPickerOpen,
      },
      permission: {
        present: !!permissionPicker, disabled: permissionPickerDisabled, blockedByParent: permissionPicker?.disabled ?? false,
        busy: permissionPicker?.busy ?? false, optionCount: permissionPicker?.options.length ?? 0, open: permissionPickerOpen,
      },
      skillManagerOpen, quickPhraseOpen,
    };
    const signature = JSON.stringify(state);
    if (composerTraceRef.current?.signature === signature) return;
    composerTraceRef.current = { signature, state };
    logSessionTrace('session.composer.state', 'session-composer-boundary', () => state);
  });
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    // Native capture still sees disabled controls and clicks intercepted outside the React subtree.
    const onPointerDown = (event: PointerEvent) => {
      const root = composerRootRef.current;
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0 || event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      const controls = ['input', 'permission', 'goal', 'skills', 'model', 'quick-phrase', 'attach', 'send'];
      const intendedControl = Array.from(root.querySelectorAll<HTMLElement>('[data-chat-control]')).find((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      const controlName = intendedControl?.dataset.chatControl;
      const target = event.target instanceof Element ? event.target : null;
      logSessionTrace('session.composer.pointer', 'session-composer-boundary', () => ({
        ...composerTraceRef.current?.state,
        control: controlName && controls.includes(controlName) ? controlName : 'other',
        controlDisabled: intendedControl?.matches(':disabled') ?? null,
        receivedBy: target && root.contains(target) ? 'composer'
          : target?.closest('[data-testid="chat-switchboard-backdrop"]') ? 'switchboard-backdrop' : 'outside-composer',
        bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
        composerPointerEvents: getComputedStyle(root).pointerEvents,
        switchboardOpen: !!document.querySelector('[data-testid="chat-switchboard"]'),
        button: event.button,
      }));
    };
    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const handleSend = useCallback(async () => {
    const pendingOperation = sendOperationRef.current;
    if (!canSend || !isCurrentScope() || pendingOperation && (pendingOperation.scope === composerScope
      || attachments.some((attachment) => pendingOperation.attachmentIds.has(attachment.stagedAttachmentId)))) return;
    const readyAttachments = attachments.filter((attachment) => attachment.status === 'ready');
    const rawText = input.trim();
    const textToSend = goal?.mode ? input : buildSkillPrefixedMessage(rawText, selectedSkills);
    const attachmentsToSend = readyAttachments.length > 0
      ? readyAttachments.map(({ stagedAttachmentId, entryKind, fileName, mimeType, fileSize, preview, sourcePath }) => ({
          stagedAttachmentId,
          ...(entryKind ? { entryKind } : {}),
          fileName,
          mimeType,
          fileSize,
          preview,
          ...(sourcePath ? { sourcePath } : {}),
        })) as ChatSendAttachment[]
      : undefined;
    const stagedIdsToSend = readyAttachments
      .map((attachment) => attachment.stagedAttachmentId)
      .filter((id) => ownedStagedAttachmentIdsRef.current.has(id));
    const sentAttachmentIds = new Set(readyAttachments.map((attachment) => attachment.stagedAttachmentId));
    const inputRevision = inputRevisionRef.current;
    const drafts = useComposerDraftStore.getState();
    const draftRevision = draftKey ? drafts.revisions[draftKey] : undefined;
    const ownsDraftSnapshot = draftKey && onDraftChange && (drafts.drafts[draftKey] ?? '') === input;
    const operationId = !goal?.mode && ownsDraftSnapshot ? crypto.randomUUID() : undefined;
    if (operationId && !drafts.prepareSubmission(draftKey!, {
      operationId, snapshot: readComposerDraftSnapshot(draftKey!), skills: selectedSkills,
      attachments: attachmentsToSend ?? [], ownedAttachmentIds: stagedIdsToSend, status: 'prepared',
    })) return;
    const operation: SendOperation = {
      scope: composerScope, attachmentIds: sentAttachmentIds, initializationId: null, handoffScope: null, retired: false,
    };
    sendOperationRef.current = operation;
    setPendingSend(operation);
    const ownsSend = () => isCurrentScope() && sendOperationRef.current === operation;
    // The send invocation owns this batch before optimistic rendering can unmount the draft.
    stagedIdsToSend.forEach((id) => ownedStagedAttachmentIdsRef.current.delete(id));
    let result: ChatSendResult;
    let retainAttachments = false;
    try {
      try {
        const send = goal?.mode ? goal.onSubmit(textToSend, attachmentsToSend) : onSend(textToSend, attachmentsToSend, operationId);
        operation.initializationId = draftKey ? useComposerDraftStore.getState().initializations[draftKey]?.operationId ?? null : null;
        if (operationId && useComposerDraftStore.getState().submissions[draftKey!]?.status !== 'prepared') {
          setAttachments((current) => current.filter((attachment) => !sentAttachmentIds.has(attachment.stagedAttachmentId)));
          setSelectedSkills((current) => current.filter((skill) => !selectedSkills.includes(skill)));
          closeMention();
          closeSlash();
          closeQuickPhrase();
        }
        result = await send;
      } catch {
        if (!operationId) releaseStagedAttachmentIds(stagedIdsToSend);
        return;
      }
      if (operationId) return;
      if (!result.accepted) {
        if (result.dispatch === 'not-dispatched') {
          const currentScope = currentScopeRef.current;
          retainAttachments = mountedRef.current && sendOperationRef.current === operation && !operation.retired
            && (currentScope === operation.scope || currentScope === operation.handoffScope
              && currentScope?.draftKey === result.sessionRecordKey);
          if (retainAttachments) {
            const retainedIds = new Set(stagedIdsToSend.filter((id) => !canceledStagingKeysRef.current.has(id)
              && committedAttachmentsRef.current.some((attachment) => attachment.stagedAttachmentId === id)));
            retainedIds.forEach((id) => ownedStagedAttachmentIdsRef.current.add(id));
            releaseStagedAttachmentIds(stagedIdsToSend.filter((id) => !retainedIds.has(id)));
          } else releaseStagedAttachmentIds(stagedIdsToSend);
        } else if (result.outcome !== 'unknown') {
          // An unknown receipt can precede Main's materialization completion.
          releaseStagedAttachmentIds(stagedIdsToSend);
        }
        return;
      }
      const inputUnchanged = inputRevisionRef.current === inputRevision;
      if (!goal?.mode) {
        if (ownsDraftSnapshot) useComposerDraftStore.getState().settleDraft(draftKey, draftRevision);
        else if (ownsSend() && inputUnchanged) {
          setInput((current) => isCurrentScope() && current === input ? '' : current);
        }
      }
      if (!ownsSend()) return;
      setSelectedSkills((current) => isCurrentScope() ? current.filter((skill) => !selectedSkills.includes(skill)) : current);
      if (!inputUnchanged) return;
      closeMention();
      closeSlash();
      closeQuickPhrase();
    } finally {
      const current = operationId && draftKey ? useComposerDraftStore.getState().submissions[draftKey] : undefined;
      if (current && current.operationId === operationId && current.status === 'prepared') {
        useComposerDraftStore.getState().removeSubmission(draftKey!, operationId!);
        retainAttachments = ownsSend();
        if (retainAttachments) stagedIdsToSend.forEach((id) => ownedStagedAttachmentIdsRef.current.add(id));
        else releaseStagedAttachmentIds(stagedIdsToSend);
      }
      if (mountedRef.current) {
        if (!retainAttachments) setAttachments((current) => current.filter((attachment) => !sentAttachmentIds.has(attachment.stagedAttachmentId)));
        setPendingSend((current) => current === operation ? null : current);
      }
      if (sendOperationRef.current === operation) sendOperationRef.current = null;
    }
  }, [attachments, canSend, closeMention, closeQuickPhrase, closeSlash, composerScope, draftKey, goal, input, isCurrentScope, onDraftChange, onSend, releaseStagedAttachmentIds, selectedSkills, setInput]);

  const restoreFailedSubmission = useCallback(() => {
    if (!draftKey || !submission || submission.status !== 'failed' || input || goal?.mode || attachments.length || selectedSkills.length) return;
    const drafts = useComposerDraftStore.getState();
    if (!drafts.restoreSubmission(draftKey, submission.operationId)) return;
    submission.ownedAttachmentIds.forEach((id) => ownedStagedAttachmentIdsRef.current.add(id));
    setAttachments(submission.attachments.map((attachment) => ({
      ...attachment,
      status: submission.attachmentReselectionRequired && !isDirectoryAttachment(attachment) && attachment.fileSize <= CHAT_INLINE_ATTACHMENT_MAX_BYTES ? 'error' : 'ready',
      ...(submission.attachmentReselectionRequired && !isDirectoryAttachment(attachment) && attachment.fileSize <= CHAT_INLINE_ATTACHMENT_MAX_BYTES
        ? { error: t('input.attachmentReselectionRequired') } : {}),
    })));
    setSelectedSkills(submission.skills);
    drafts.removeSubmission(draftKey, submission.operationId);
  }, [attachments.length, draftKey, goal?.mode, input, selectedSkills.length, submission, t]);
  useEffect(() => {
    if (submission?.status === 'failed' && !pendingSend && draftKey
      && !submission.attachments.length && !submission.skills.length
      && useComposerDraftStore.getState().revisions[draftKey] === submission.revision) restoreFailedSubmission();
  }, [draftKey, pendingSend, restoreFailedSubmission, submission]);

  const handleStop = useCallback(() => {
    logSessionTrace('stop.intent', createSessionTraceId('stop-intent'), () => ({
      canStop,
      sending,
      stopping,
      disabled,
      runPhase,
      runId: summarizeIdentifier(activeRunId),
      sessionIdentity: summarizeSessionIdentity(sessionIdentity),
    }));
    if (!canStop) return;
    onStop?.();
  }, [activeRunId, canStop, disabled, onStop, runPhase, sending, sessionIdentity, stopping]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mentionOpen && mentionItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionActiveIndex((prev) => (prev + 1) % mentionItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionActiveIndex((prev) => (prev - 1 + mentionItems.length) % mentionItems.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyMentionSelection(mentionItems[mentionActiveIndex] ?? mentionItems[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMention();
          return;
        }
      }

      if (slashOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (slashItems.length > 0) {
            setSlashActiveIndex((prev) => Math.min(prev + 1, slashItems.length - 1));
          }
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (slashItems.length > 0) {
            setSlashActiveIndex((prev) => Math.max(prev - 1, 0));
          }
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && slashItems.length > 0) {
          e.preventDefault();
          applySlashSelection(slashItems[slashActiveIndex] ?? slashItems[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSlash();
          return;
        }
      }

      if (quickPhraseOpen && e.key === 'Escape') {
        e.preventDefault();
        closeQuickPhrase();
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        handleSend();
      }
    },
    [
      applyMentionSelection,
      applySlashSelection,
      closeMention,
      closeQuickPhrase,
      closeSlash,
      handleSend,
      mentionActiveIndex,
      mentionItems,
      mentionOpen,
      quickPhraseOpen,
      slashActiveIndex,
      slashItems,
      slashOpen,
    ],
  );

  // Handle paste (Ctrl/Cmd+V with files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: globalThis.File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        stageBufferFiles(pastedFiles);
      }
    },
    [stageBufferFiles],
  );

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (!e.dataTransfer) {
        return;
      }
      const { pathFiles, bufferFiles } = collectDroppedFiles(e.dataTransfer);
      if (pathFiles.length > 0) {
        void stageDroppedPathFiles(pathFiles);
      }
      if (bufferFiles.length > 0) {
        stageBufferFiles(bufferFiles);
      }
    },
    [stageBufferFiles, stageDroppedPathFiles],
  );

  const placeholderText = reconnecting ? t('input.gatewayRecoveringNotice')
    : goal?.mode && !disabled && !approvalWaiting ? t('goal.placeholder') : resolveInputPlaceholder(disabled, approvalWaiting, t);

  return (
    <div
      ref={composerRootRef}
      data-testid="chat-composer"
      className="w-full text-left"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`${CHAT_LAYOUT_TOKENS.inputRail} chat-scroll-sync-input-inner`}>
        {goalDock}
        {composerContent}
        {/* Input Row */}
        <div
          style={{ anchorName: composerAnchorName }}
          className={cn(
            CHAT_LAYOUT_TOKENS.inputCard,
            topContent && 'bg-muted/50',
            dragOver && 'border-ring shadow-[var(--shadow-focus)]',
          )}
        >
          <div className={cn(CHAT_LAYOUT_TOKENS.inputTopContent, 'empty:hidden')} data-chat-composer-wheel-local="true">{topContent}</div>
          <div className={cn(CHAT_LAYOUT_TOKENS.inputBody, CHAT_LAYOUT_TOKENS.inputCardMinHeight, 'chat-input-card', topContent && 'border-t border-border/55')}>
          <div className="relative min-w-0">
            <div className="px-2 pt-1.5">
              {submission && (submission.status === 'failed' || submission.status === 'unknown') ? <div role="alert" className="mb-2 space-y-1 text-xs">
                <p className="text-destructive">{submission.error || t('input.submissionFailed')}</p>
                <p className="max-h-24 overflow-y-auto whitespace-pre-wrap">{submission.snapshot.draft}</p>
                {submission.skills.length ? <p>{submission.skills.map((skill) => skill.name).join(' / ')}</p> : null}
                {submission.attachments.length ? <p>{submission.attachments.map((attachment) => attachment.fileName).join(' / ')}</p> : null}
                {submission.attachmentReselectionRequired ? <p>{t('input.attachmentReselectionRequired')}</p> : null}
                <div className="flex gap-3">
                  <Button type="button" variant="link" className="h-auto p-0 text-xs" disabled={submission.status === 'unknown' || Boolean(input || goal?.mode || attachments.length || selectedSkills.length)} onClick={restoreFailedSubmission}>{t('reuseMessage')}</Button>
                  <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => {
                    useComposerDraftStore.getState().discardSubmission(draftKey!, submission.operationId);
                  }}>{t('input.remove')}</Button>
                </div>
              </div> : null}
              {goal?.mode ? (
                <div className="mb-2 space-y-1">
                  <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs">
                    <Target aria-hidden="true" className="h-3.5 w-3.5" />
                    {t(goal.mode.goalId ? 'goal.edit' : 'goal.set')}
                    <button type="button" className="rounded-full p-1 focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('goal.cancel')} disabled={goal.busy || goal.unknown && !goal.canDiscard} onClick={goal.onCancel}><X aria-hidden="true" className="h-3 w-3" /></button>
                  </span>
                  {invalidGoalAttachments ? <p role="alert" className="text-xs text-destructive">{t(goal.mode.goalId ? 'goal.noAttachmentsOnEdit' : 'goal.inlineOnly')}</p> : null}
                  {goal.unknown ? <div role="alert" className="flex items-center gap-2 text-xs text-destructive"><span>{t('goal.errors.unknown')}</span><Button type="button" variant="link" className="h-auto text-xs" disabled={goal.busy} onClick={goal.onRefresh}>{t('goal.refresh')}</Button></div> : null}
                  {goal.error && !goal.unknown ? <p role="alert" className="text-xs text-destructive">{t(`goal.errors.${goal.error}`, { defaultValue: goal.error })}</p> : null}
                  {!goal.supported ? <p role="status" className="text-xs text-muted-foreground">{t('goal.errors.unsupported')}</p> : null}
                </div>
              ) : null}
              {attachments.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.stagedAttachmentId}
                      attachment={attachment}
                      onActivate={() => openAttachment(attachment)}
                      onRemove={() => removeAttachment(attachment.stagedAttachmentId)}
                    />
                  ))}
                </div>
              )}
              {selectedSkills.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {selectedSkills.map((skill) => (
                    <span
                      key={skill.id}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-none"
                    >
                      {skillManager ? (
                        <button
                          type="button"
                          className="inline-flex min-w-0 items-center gap-1 rounded-full text-left transition-colors hover:text-primary"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => previewSelectedSkill(skill)}
                          title={t('skillPreviewTooltip')}
                          aria-label={t('skillPreviewTooltip')}
                          data-testid="chat-selected-skill-preview"
                        >
                          <span>{skill.icon}</span>
                          <span className="truncate">{skill.name}</span>
                        </button>
                      ) : (
                        <>
                          <span>{skill.icon}</span>
                          <span className="truncate">{skill.name}</span>
                        </>
                      )}
                      <button
                        type="button"
                        className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background/90 hover:text-foreground"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setSelectedSkills((prev) => prev.filter((item) => item.id !== skill.id));
                        }}
                        aria-label={`remove skill ${skill.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  const cursor = e.target.selectionStart ?? nextValue.length;
                  setInput(nextValue);
                  rememberDraftSelection(e.currentTarget);
                  refreshMentionCandidates(nextValue, cursor);
                  refreshSlashCandidates(nextValue, cursor);
                }}
                onSelect={(e) => rememberDraftSelection(e.currentTarget)}
                onClick={(e) => rememberDraftSelection(e.currentTarget)}
                onBlur={(e) => rememberDraftSelection(e.currentTarget)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                placeholder={placeholderText}
                disabled={disabled || Boolean(goal?.mode && goal.busy)}
                className={cn(
                  CHAT_LAYOUT_TOKENS.inputTextarea,
                  'placeholder:text-muted-foreground',
                )}
                rows={1}
                data-testid="chat-composer-input"
                data-chat-control="input"
              />
            </div>
            {mentionOpen && mentionItems.length > 0 && (
              <ComposerSuggestions anchorRef={textareaRef}>
                {mentionItems.map((item, index) => {
                  const isActive = index === mentionActiveIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                  className={cn(
                        'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-xs transition-colors',
                        isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted/70',
                      )}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyMentionSelection(item);
                      }}
                    >
                      <span className="font-medium">@{item.id}</span>
                      {item.label && <span className="ml-2 truncate text-muted-foreground">{item.label}</span>}
                    </button>
                  );
                })}
              </ComposerSuggestions>
            )}
            {slashOpen && (
              <ComposerSuggestions anchorRef={textareaRef}>
                {slashSkillsLoading && slashItems.length === 0 ? (
                  <div className="px-2.5 py-2 text-xs text-muted-foreground">{t('skillConfigDialog.loading')}</div>
                ) : slashItems.length === 0 ? (
                  <div className="px-2.5 py-2 text-xs text-muted-foreground">{t('input.noSkillsFound')}</div>
                ) : (
                  slashItems.map((item, index) => {
                    const isActive = index === slashActiveIndex;
                    return (
                      <button
                        key={item.id}
                        ref={(node) => {
                          slashItemRefs.current[index] = node;
                        }}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className={cn(
                          'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-xs transition-colors',
                          isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted/70',
                        )}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applySlashSelection(item);
                        }}
                      >
                        <span className="mr-2">{item.kind === 'goal' ? <Target aria-hidden="true" className="h-3.5 w-3.5" /> : item.icon}</span>
                        <span className="flex-1 truncate font-medium">{item.name}</span>
                        <span className="ml-2 truncate text-muted-foreground">/{item.id}</span>
                      </button>
                    );
                  })
                )}
              </ComposerSuggestions>
            )}
          </div>

          <div className={cn(CHAT_LAYOUT_TOKENS.inputActionsRow, 'chat-input-actions border-t border-border/35 pt-1.5')}>
            <ChatInputStatus contextUsage={contextUsage} imageGenerationActive={!sending && imageGenerationActive} />
            <div className="chat-input-toolbar w-full min-w-0">
              <ChatInputToolbar
                key={`${draftKey ?? ''}:${sessionIdentityKey ?? ''}`}
                composerAnchorName={composerAnchorName}
                scopeKey={`${draftKey ?? ''}:${sessionIdentityKey ?? ''}`}
                sessionIdentity={sessionIdentity}
                activeRunId={activeRunId}
                runPhase={runPhase}
                disabled={disabled}
                sending={sending}
                approvalWaiting={approvalWaiting}
                permissionPicker={permissionPicker}
                permissionPickerOpen={permissionPickerOpen}
                permissionPickerDisabled={permissionPickerDisabled}
                onPermissionPickerOpenChange={handlePermissionPickerOpenChange}
                goalSupported={goal?.supported === true}
                goalDisabled={disabled || sending || Boolean(goal?.busy || goal?.mode)}
                onStartGoal={startGoal}
                skillManagerLabel={skillManager?.label}
                skillManagerOpen={skillManagerOpen}
                onOpenSkillManager={openSkillManager}
                modelPicker={modelPicker}
                modelPickerOpen={modelPickerOpen}
                onModelPickerOpenChange={handleModelPickerOpenChange}
                quickPhraseOpen={quickPhraseOpen}
                onToggleQuickPhrase={toggleQuickPhrase}
                onAttachFiles={stageSelectedDialogAttachments}
              />

              <Button
                onClick={effectiveSending ? handleStop : handleSend}
                data-chat-control="send"
                disabled={effectiveSending ? !canStop : !canSend}
                size="icon"
                className={cn(
                  CHAT_LAYOUT_TOKENS.inputSendButton,
                  'chat-send-button rounded-full',
                )}
                variant={effectiveSending ? 'destructive' : 'default'}
                aria-label={t(effectiveSending ? 'input.stop' : 'input.send')}
                title={t(effectiveSending ? 'input.stop' : 'input.send')}
              >
                {stopping && !editingGoal ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : effectiveSending ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          </div>
        </div>
        {skillManagerOpen && skillManager && typeof document !== 'undefined' ? createPortal((
          <AgentSkillManagerDialog
            label={skillManager.label}
            title={skillManager.title}
            skillOptions={skillManager.options}
            skillsLoading={skillManager.loading}
            savingSkillId={skillManager.savingSkillId}
            selectedSkillIds={skillManager.selectedSkillIds}
            skillPreview={skillManager.skillPreview}
            onToggleSkill={skillManager.onToggleSkill}
            onClearSkillPreview={skillManager.onClearSkillPreview}
            onClose={closeSkillManager}
          />
        ), document.body) : null}
        <Dialog.Root open={quickPhraseOpen} onOpenChange={(open) => { if (!open) closeQuickPhrase(); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[120] bg-[hsl(var(--shell-scrim))]" />
            <Dialog.Content aria-describedby={undefined}
              onCloseAutoFocus={(event) => { event.preventDefault(); textareaRef.current?.focus(); }}
              className="fixed left-1/2 top-1/2 z-[120] max-h-[calc(100dvh-24px)] w-[min(54rem,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-elevated outline-none">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-base font-semibold text-foreground">
                    {t(quickPhraseAddOpen ? 'input.addQuickPhrase' : 'input.quickPhrases')}
                  </Dialog.Title>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {quickPhraseAddOpen
                      ? t('input.quickPhraseAddDescription')
                      : t('input.quickPhraseDescription')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-full"
                  onClick={closeQuickPhrase}
                  aria-label={t('input.closePanel')}
                  title={t('input.closePanel')}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="mt-4 border-t border-border/45 pt-4">
                {quickPhraseAddOpen ? (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="quick-phrase-draft">
                      {t('input.addQuickPhrase')}
                    </label>
                    <Textarea
                      id="quick-phrase-draft"
                      value={quickPhraseDraft}
                      onChange={(event) => setQuickPhraseDraft(event.target.value)}
                      placeholder={t('input.quickPhrasePlaceholder')}
                      className="mt-2 min-h-[6.5rem] resize-none rounded-xl border-border bg-background text-sm shadow-sm focus-visible:ring-2 focus-visible:ring-ring/35"
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        className="rounded-xl"
                        onClick={() => {
                          setQuickPhraseAddOpen(false);
                          setQuickPhraseDraft('');
                        }}
                      >
                        {t('input.cancel')}
                      </Button>
                      <Button
                        type="button"
                        className="rounded-xl"
                        disabled={!quickPhraseDraft.trim()}
                        onClick={addQuickPhrase}
                      >
                        {t('input.saveQuickPhrase')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">{t('input.quickPhraseList')}</span>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 rounded-xl px-3 text-xs"
                        onClick={() => setQuickPhraseAddOpen(true)}
                      >
                        {t('input.addQuickPhrase')}
                      </Button>
                    </div>
                    {quickPhrases.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border bg-background px-4 py-6 text-center text-sm text-muted-foreground">
                        {t('input.quickPhraseEmpty')}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {quickPhrases.map((phrase, index) => (
                          <div
                            key={phrase.id}
                            className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 shadow-sm"
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => applyQuickPhrase(phrase.text)}
                            >
                              <div className="text-xs font-semibold text-primary">{t('input.quickPhraseNumber', { count: index + 1 })}</div>
                              <div className="mt-0.5 truncate text-sm text-foreground">{phrase.text}</div>
                            </button>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon"
                                className="h-7 w-7 rounded-lg"
                                disabled={index === 0}
                                onClick={() => moveQuickPhrase(phrase.id, -1)}
                                aria-label={t('input.movePhraseUp', { phrase: phrase.text })}
                                title={t('input.moveUp')}
                              >
                                ↑
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon"
                                className="h-7 w-7 rounded-lg"
                                disabled={index === quickPhrases.length - 1}
                                onClick={() => moveQuickPhrase(phrase.id, 1)}
                                aria-label={t('input.movePhraseDown', { phrase: phrase.text })}
                                title={t('input.moveDown')}
                              >
                                ↓
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon"
                                className="h-7 w-7 rounded-lg text-destructive hover:text-destructive"
                                onClick={() => removeQuickPhrase(phrase.id)}
                                aria-label={t('input.removePhrase', { phrase: phrase.text })}
                                title={t('input.remove')}
                              >
                                ×
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {hasFailedAttachments && (
          <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
            {attachments.some((attachment) => attachment.error === t('input.attachmentReselectionRequired')) ? <span>{t('input.attachmentReselectionRequired')}</span> : null}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => {
                setAttachments((prev) => prev.filter((att) => att.status !== 'error'));
                void stageSelectedDialogAttachments();
              }}
            >
              Retry failed attachments
            </Button>
          </div>
        )}
        {lightboxAttachment && (
          <ChatImageLightbox
            src={lightboxAttachment.src}
            fileName={lightboxAttachment.fileName}
            filePath={lightboxAttachment.filePath}
            onClose={() => setLightboxAttachment(null)}
          />
        )}
      </div>
    </div>
  );
});

// ── Attachment Preview ───────────────────────────────────────────

function AttachmentChip({
  attachment,
  onActivate,
  onRemove,
}: {
  attachment: FileAttachment;
  onActivate: () => void;
  onRemove: () => void;
}) {
  const previewableImage = isPreviewableImageAttachment(attachment);
  const canOpen = attachment.status === 'ready' && previewableImage;
  const actionLabel = `Preview ${attachment.fileName}`;

  let leading: ReactNode;
  if (attachment.status === 'staging') {
    leading = <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />;
  } else if (attachment.status === 'error') {
    leading = <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />;
  } else if (previewableImage) {
    leading = (
      <img
        src={attachment.preview!}
        alt=""
        aria-hidden="true"
        className="h-5 w-5 shrink-0 rounded-full object-cover"
      />
    );
  } else if (attachment.mimeType.startsWith('image/')) {
    leading = <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />;
  } else {
    leading = <FileIcon mimeType={attachment.mimeType} className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }

  return (
    <div className="inline-flex w-[120px] max-w-full items-center rounded-full border border-border/50 bg-background pr-1 shadow-none">
      {canOpen ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50"
          onClick={onActivate}
          aria-label={actionLabel}
          title={actionLabel}
        >
          {leading}
          <span className="min-w-0 truncate text-xs font-medium text-foreground">{attachment.fileName}</span>
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5">
          {leading}
          <span className="min-w-0 truncate text-xs font-medium text-foreground">{attachment.fileName}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        aria-label={`Remove ${attachment.fileName}`}
        title={`Remove ${attachment.fileName}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
