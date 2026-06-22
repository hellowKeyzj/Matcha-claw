/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { memo, useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Send, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, Loader2, ImageIcon, AlertCircle, Check, ChevronDown, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { hostFileStageBuffer, hostFileStagePaths, type WorkspaceFileContext } from '@/lib/host-api';
import type { SessionIdentity } from '../../../runtime-host/shared/runtime-address';
import { invokeIpc } from '@/lib/api-client';
import { useSkillsStore } from '@/stores/skills';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import { collectDroppedFiles } from '@/lib/collect-dropped-files';
import type { ChatSendResult } from '@/stores/chat';
import type { ChatContextUsageViewModel } from './context-usage';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;        // disk path for gateway
  preview: string | null;    // data URL for images, null for others
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

interface DialogStagedAttachmentPayload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
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

interface SelectedSkill {
  id: string;
  name: string;
  icon: string;
  filePath?: string;
  baseDir?: string;
}

interface ModelPickerOption {
  id: string;
  label: string;
}

interface ModelPickerState {
  currentModelId: string;
  currentLabel: string;
  options: ModelPickerOption[];
  loading: boolean;
  switching: boolean;
  disabled?: boolean;
  onSelect: (modelId: string) => void;
}

const STAGE_BUFFER_CONCURRENCY = 3;
const STAGE_BUFFER_MAX_BYTES = 50 * 1024 * 1024;
const QUICK_PHRASE_STORAGE_KEY = 'matchaclaw:chat:quick-phrases';

interface QuickPhrase {
  id: string;
  text: string;
}

const DEFAULT_QUICK_PHRASES: QuickPhrase[] = [];

interface ChatInputProps {
  onSend: (text: string, attachments?: FileAttachment[]) => ChatSendResult | Promise<ChatSendResult>;
  onStop?: () => void;
  stopping?: boolean;
  onPreviewSkill?: (skill: SelectedSkill) => void;
  modelPicker?: ModelPickerState | null;
  contextUsage?: ChatContextUsageViewModel | null;
  disabled?: boolean;
  reconnecting?: boolean;
  sending?: boolean;
  approvalWaiting?: boolean;
  mentionCandidates?: MentionCandidate[];
  allowedSkillIds?: string[] | null;
  sessionIdentity: SessionIdentity | null;
  workspaceContext?: WorkspaceFileContext;
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

function resolveInputStatusText(
  disabled: boolean,
  approvalWaiting: boolean,
  selectedSkillCount: number,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (disabled) {
    return translate('input.gatewayDisconnectedPlaceholder');
  }
  if (approvalWaiting) {
    return translate('input.approvalWaitingPlaceholder');
  }
  if (selectedSkillCount > 1) {
    return translate('input.skillsActive', { count: selectedSkillCount });
  }
  if (selectedSkillCount === 1) {
    return translate('input.skillActive', { count: selectedSkillCount });
  }
  return null;
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
  id: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
): FileAttachment {
  return {
    id,
    fileName,
    mimeType,
    fileSize,
    stagedPath: '',
    preview: null,
    status: 'staging',
  };
}

function isPreviewableImageAttachment(attachment: FileAttachment): boolean {
  return attachment.status === 'ready'
    && attachment.mimeType.startsWith('image/')
    && typeof attachment.preview === 'string'
    && attachment.preview.length > 0;
}

function waitForAttachmentPlaceholderFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// ── Component ────────────────────────────────────────────────────

export const ChatInput = memo(function ChatInput({
  onSend,
  onStop,
  stopping = false,
  onPreviewSkill,
  modelPicker = null,
  contextUsage = null,
  disabled = false,
  reconnecting = false,
  sending = false,
  approvalWaiting = false,
  mentionCandidates = [],
  allowedSkillIds = null,
  sessionIdentity,
  workspaceContext,
}: ChatInputProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionEnd, setMentionEnd] = useState(-1);
  const [mentionItems, setMentionItems] = useState<MentionCandidate[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashStart, setSlashStart] = useState(-1);
  const [slashEnd, setSlashEnd] = useState(-1);
  const [slashItems, setSlashItems] = useState<SelectedSkill[]>([]);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [selectedSkills, setSelectedSkills] = useState<SelectedSkill[]>([]);
  const [quickPhrases, setQuickPhrases] = useState<QuickPhrase[]>(() => loadQuickPhrases());
  const [quickPhraseOpen, setQuickPhraseOpen] = useState(false);
  const [quickPhraseAddOpen, setQuickPhraseAddOpen] = useState(false);
  const [quickPhraseDraft, setQuickPhraseDraft] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [lightboxAttachment, setLightboxAttachment] = useState<{
    src: string;
    fileName: string;
    filePath?: string;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const isComposingRef = useRef(false);
  const skills = useSkillsStore((state) => state.skills);
  const skillsSnapshotReady = useSkillsStore((state) => state.snapshotReady);
  const skillsInitialLoading = useSkillsStore((state) => state.initialLoading);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const allowedSkillIdSet = useMemo(() => {
    if (!Array.isArray(allowedSkillIds)) {
      return null;
    }
    return new Set(allowedSkillIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()));
  }, [allowedSkillIds]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Focus textarea on mount (avoids Windows focus loss after session delete + native dialog)
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (!slashOpen || skillsSnapshotReady || skillsInitialLoading) {
      return;
    }
    void fetchSkills();
  }, [fetchSkills, skillsInitialLoading, skillsSnapshotReady, slashOpen]);

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
    if (!modelPicker) {
      setModelPickerOpen(false);
      return;
    }
    if (modelPicker.disabled || modelPicker.loading || modelPicker.switching || modelPicker.options.length === 0) {
      setModelPickerOpen(false);
    }
  }, [modelPicker]);

  useEffect(() => {
    if (!modelPickerOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (modelPickerRef.current?.contains(target)) {
        return;
      }
      setModelPickerOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModelPickerOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [modelPickerOpen]);

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionItems([]);
    setMentionActiveIndex(0);
    setMentionStart(-1);
    setMentionEnd(-1);
  }, []);

  const closeSlash = useCallback(() => {
    setSlashOpen(false);
    setSlashItems([]);
    setSlashActiveIndex(0);
    setSlashStart(-1);
    setSlashEnd(-1);
  }, []);

  const closeQuickPhrase = useCallback(() => {
    setQuickPhraseOpen(false);
    setQuickPhraseAddOpen(false);
    setQuickPhraseDraft('');
  }, []);

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
    setInput(nextValue);
    closeMention();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }, [closeMention, input, mentionEnd, mentionStart]);

  const refreshSlashCandidates = useCallback((nextInput: string, cursor: number) => {
    const range = detectSlashRange(nextInput, cursor);
    if (!range) {
      closeSlash();
      return;
    }
    const query = normalizeSearchText(range.query);
    const selectedIds = new Set(selectedSkills.map((skill) => skill.id));
    const matched = skills
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
        id: skill.id,
        name: skill.name,
        icon: skill.icon || '🧩',
        filePath: skill.filePath,
        baseDir: skill.baseDir,
      }));
    setSlashOpen(true);
    setSlashStart(range.start);
    setSlashEnd(range.end);
    setSlashItems(matched);
    setSlashActiveIndex((prev) => (prev >= matched.length ? 0 : prev));
    closeMention();
    closeQuickPhrase();
  }, [allowedSkillIdSet, closeMention, closeQuickPhrase, closeSlash, selectedSkills, skills]);

  const applySlashSelection = useCallback((candidate: SelectedSkill) => {
    if (!textareaRef.current || slashStart < 0 || slashEnd < slashStart) {
      return;
    }
    const before = input.slice(0, slashStart);
    const after = input.slice(slashEnd);
    let nextValue = `${before}${after}`;
    if (before.length > 0 && after.length > 0 && !/\s$/.test(before) && !/^\s/.test(after)) {
      nextValue = `${before} ${after}`;
    }
    nextValue = nextValue.replace(/\s{2,}/g, ' ');
    const caret = before.length;
    setInput(nextValue);
    setSelectedSkills((prev) => (prev.some((item) => item.id === candidate.id) ? prev : [...prev, candidate]));
    closeSlash();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }, [closeSlash, input, slashEnd, slashStart]);

  const toggleQuickPhrase = useCallback(() => {
    setQuickPhraseOpen((open) => !open);
    setQuickPhraseAddOpen(false);
    setQuickPhraseDraft('');
    closeMention();
    closeSlash();
  }, [closeMention, closeSlash]);

  const applyQuickPhrase = useCallback((phrase: string) => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? input.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const { nextValue, caret } = insertQuickPhraseText(input, phrase, selectionStart, selectionEnd);
    setInput(nextValue);
    closeQuickPhrase();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }, [closeQuickPhrase, input]);

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

  // ── File staging via native dialog ─────────────────────────────

  const stageSelectedDialogAttachments = useCallback(async () => {
    const tempIds: string[] = [];
    let stagingAttachments: FileAttachment[] = [];

    try {
      const result = await invokeIpc('dialog:stageOpenAttachments', {
        properties: ['openFile', 'multiSelections'],
      }) as StageOpenAttachmentsResult;
      if (result.canceled) {
        return;
      }

      const selectedFiles = result.selectedFiles?.length
        ? result.selectedFiles
        : result.attachments?.map((attachment) => ({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          fileSize: attachment.fileSize,
        })) ?? [];
      if (selectedFiles.length === 0) {
        return;
      }

      stagingAttachments = selectedFiles.map((file) => {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        return buildStagingAttachment(
          tempId,
          file.fileName,
          file.mimeType || 'application/octet-stream',
          file.fileSize ?? 0,
        );
      });
      setAttachments((prev) => [...prev, ...stagingAttachments]);
      await waitForAttachmentPlaceholderFrame();

      const updatesByTempId = new Map<string, FileAttachment>();
      for (let i = 0; i < tempIds.length; i++) {
        const tempId = tempIds[i];
        const attachment = result.attachments?.[i];
        updatesByTempId.set(tempId, attachment
          ? { ...attachment, status: 'ready' }
          : { ...stagingAttachments[i], status: 'error', error: 'Staging failed' });
      }
      setAttachments((prev) => prev.map((attachment) => updatesByTempId.get(attachment.id) ?? attachment));
    } catch (err) {
      if (tempIds.length === 0) {
        console.error('[stageSelectedDialogAttachments] Failed to stage selected attachments:', err);
        return;
      }
      const failedIds = new Set(tempIds);
      setAttachments((prev) => prev.map((attachment) => (
        failedIds.has(attachment.id)
          ? { ...attachment, status: 'error', error: String(err) }
          : attachment
      )));
    }
  }, []);

  const stageDroppedPathFiles = useCallback(async (filePaths: string[]) => {
    if (filePaths.length === 0) {
      return;
    }
    const tempIds: string[] = [];
    const stagingAttachments = filePaths.map((filePath) => {
      const tempId = crypto.randomUUID();
      tempIds.push(tempId);
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      return buildStagingAttachment(tempId, fileName, '', 0);
    });
    setAttachments((prev) => [...prev, ...stagingAttachments]);

    try {
      if (!sessionIdentity) {
        throw new Error('SessionIdentity is required');
      }
      const staged = await hostFileStagePaths({ filePaths, sessionIdentity, ...workspaceContext });
      const updatesByTempId = new Map<string, FileAttachment>();
      for (let i = 0; i < tempIds.length; i++) {
        const tempId = tempIds[i];
        const data = staged[i];
        updatesByTempId.set(tempId, data
          ? { ...data, status: 'ready' }
          : { ...stagingAttachments[i], status: 'error', error: 'Staging failed' });
      }
      setAttachments((prev) => prev.map((attachment) => updatesByTempId.get(attachment.id) ?? attachment));
    } catch (err) {
      const failedIds = new Set(tempIds);
      setAttachments((prev) => prev.map((attachment) => (
        failedIds.has(attachment.id)
          ? { ...attachment, status: 'error', error: String(err) }
          : attachment
      )));
    }
  }, [sessionIdentity, workspaceContext]);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    if (files.length === 0) {
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
    setAttachments((prev) => [...prev, ...placeholders]);

    const results = await mapWithConcurrency(
      queue,
      STAGE_BUFFER_CONCURRENCY,
      async ({ file, tempId, fallback }) => {
        try {
          if (file.size > STAGE_BUFFER_MAX_BYTES) {
            throw new Error('tooLarge');
          }
          const base64 = await readFileAsBase64(file);
          if (!sessionIdentity) {
            throw new Error('SessionIdentity is required');
          }
          const staged = await hostFileStageBuffer({
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            sessionIdentity,
            ...workspaceContext,
          });
          return { tempId, attachment: { ...staged, status: 'ready' as const } };
        } catch (err) {
          return {
            tempId,
            attachment: {
              ...fallback,
              id: tempId,
              status: 'error' as const,
              error: String(err),
            },
          };
        }
      },
    );

    const updatesByTempId = new Map<string, FileAttachment>(
      results.map((result) => [result.tempId, result.attachment] as const),
    );
    setAttachments((prev) => prev.map((attachment) => updatesByTempId.get(attachment.id) ?? attachment));
  }, [sessionIdentity, workspaceContext]);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const openAttachment = useCallback((attachment: FileAttachment) => {
    if (attachment.status !== 'ready') {
      return;
    }

    if (isPreviewableImageAttachment(attachment)) {
      setLightboxAttachment({
        src: attachment.preview!,
        fileName: attachment.fileName,
        filePath: attachment.stagedPath || undefined,
      });
      return;
    }

    if (attachment.stagedPath) {
      void invokeIpc('shell:openPath', attachment.stagedPath);
    }
  }, []);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const hasFailedAttachments = attachments.some((a) => a.status === 'error');
  const canSend = (input.trim() || attachments.length > 0 || selectedSkills.length > 0)
    && allReady
    && !disabled
    && !sending
    && !approvalWaiting;
  const canStop = sending && !stopping && !disabled && !!onStop;
  const modelPickerDisabled = !modelPicker
    || modelPicker.disabled
    || modelPicker.loading
    || modelPicker.switching
    || modelPicker.options.length === 0;

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    const rawText = input.trim();
    const textToSend = buildSkillPrefixedMessage(rawText, selectedSkills);
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    const result = await onSend(textToSend, attachmentsToSend);
    if (!result.accepted) {
      return;
    }
    setInput('');
    closeMention();
    closeSlash();
    closeQuickPhrase();
    setSelectedSkills([]);
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [attachments, canSend, closeMention, closeQuickPhrase, closeSlash, input, onSend, selectedSkills]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

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

  const placeholderText = resolveInputPlaceholder(disabled, approvalWaiting, t);
  const statusText = resolveInputStatusText(
    disabled,
    approvalWaiting,
    selectedSkills.length,
    t,
  );

  return (
    <div
      className="w-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`${CHAT_LAYOUT_TOKENS.inputRail} chat-scroll-sync-input-inner`}>
        {reconnecting ? (
          <div className="mb-2 rounded-full border border-border/45 bg-background/84 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
            {t('input.gatewayRecoveringNotice')}
          </div>
        ) : null}
        {/* Input Row */}
        <div
          className={cn(
            CHAT_LAYOUT_TOKENS.inputCard,
            dragOver && 'border-ring shadow-[var(--shadow-focus)]',
            CHAT_LAYOUT_TOKENS.inputCardMinHeight,
          )}
        >
          <div className="relative min-w-0">
            <div className="px-2 pt-1.5">
              {attachments.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      onActivate={() => openAttachment(attachment)}
                      onRemove={() => removeAttachment(attachment.id)}
                    />
                  ))}
                </div>
              )}
              {selectedSkills.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {selectedSkills.map((skill) => (
                    <span
                      key={skill.id}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm"
                    >
                      {onPreviewSkill ? (
                        <button
                          type="button"
                          className="inline-flex min-w-0 items-center gap-1 rounded-full text-left transition-colors hover:text-primary"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => onPreviewSkill(skill)}
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
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  const cursor = e.target.selectionStart ?? nextValue.length;
                  setInput(nextValue);
                  refreshMentionCandidates(nextValue, cursor);
                  refreshSlashCandidates(nextValue, cursor);
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                placeholder={placeholderText}
                disabled={disabled}
                className={cn(
                  CHAT_LAYOUT_TOKENS.inputTextarea,
                  'placeholder:text-muted-foreground/70',
                )}
                rows={1}
              />
            </div>
            {mentionOpen && mentionItems.length > 0 && (
              <div
                role="listbox"
                className="absolute bottom-full z-50 mb-2 max-h-48 w-full overflow-y-auto rounded-2xl border border-border/60 bg-background/95 p-1.5 shadow-[0_16px_50px_rgba(15,23,42,0.12)] backdrop-blur-xl"
              >
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
              </div>
            )}
            {slashOpen && (
              <div
                role="listbox"
                className="absolute bottom-full z-40 mb-2 max-h-56 w-full overflow-y-auto rounded-2xl border border-border/60 bg-background/95 p-1.5 shadow-[0_16px_50px_rgba(15,23,42,0.12)] backdrop-blur-xl"
              >
                {slashItems.length === 0 ? (
                  <div className="px-2.5 py-2 text-xs text-muted-foreground">No matched skill</div>
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
                        <span className="mr-2">{item.icon}</span>
                        <span className="flex-1 truncate font-medium">{item.name}</span>
                        <span className="ml-2 truncate text-muted-foreground">/{item.id}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <div className={cn(CHAT_LAYOUT_TOKENS.inputActionsRow, 'border-t border-border/35 pt-1.5')}>
            <div className={cn(
              'flex w-full min-w-0 items-end gap-1.5',
              'justify-end',
            )}>
              {contextUsage && (
                <div className="group relative shrink-0" role="status" aria-label={t('input.contextUsageTitle', { detail: contextUsage.detail, pct: contextUsage.pct })}>
                  <div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center',
                      contextUsage.level === 'danger'
                        ? 'text-destructive'
                        : contextUsage.level === 'warning'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-muted-foreground',
                    )}
                  >
                    <svg className="h-4 w-4 -rotate-90" viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.18" />
                      <circle
                        cx="8"
                        cy="8"
                        r="6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        pathLength="100"
                        strokeDasharray={`${contextUsage.pct} 100`}
                      />
                    </svg>
                  </div>
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-xl border border-border/60 bg-popover px-3 py-2 text-xs font-medium text-popover-foreground opacity-0 shadow-[0_12px_36px_rgba(0,0,0,0.28)] transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                    <span>{t('input.contextUsageLabel', { pct: contextUsage.pct })}</span>
                    <span className="mx-1.5 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{contextUsage.detail}</span>
                  </div>
                </div>
              )}
              {modelPicker ? (
                <div ref={modelPickerRef} className="relative min-w-0 flex-none w-[clamp(0px,calc(100%-7.5rem),148px)] max-sm:w-[clamp(0px,calc(100%-7.5rem),132px)]">
                  <button
                    type="button"
                    aria-label={t('input.pickModel')}
                    aria-haspopup="listbox"
                    aria-expanded={modelPickerOpen}
                    title={t('input.modelPickerTitle')}
                    data-testid="chat-model-picker"
                    data-state={modelPickerOpen ? 'open' : 'closed'}
                    disabled={modelPickerDisabled}
                    className={cn(
                      CHAT_LAYOUT_TOKENS.inputModelPickerTrigger,
                      'min-w-0',
                      modelPickerDisabled && 'cursor-not-allowed opacity-55',
                    )}
                    onClick={() => {
                      if (modelPickerDisabled) {
                        return;
                      }
                      setModelPickerOpen((open) => !open);
                    }}
                  >
                    <span className="truncate leading-[1.35] [padding-block:1px]">{modelPicker.currentLabel}</span>
                    {modelPicker.switching ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <ChevronDown
                        className={cn(
                          'mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180',
                          modelPickerOpen && 'rotate-180',
                        )}
                      />
                    )}
                  </button>
                  {modelPickerOpen ? (
                    <div
                      role="listbox"
                      aria-label={t('input.pickModel')}
                      className={CHAT_LAYOUT_TOKENS.inputModelPickerMenu}
                    >
                      {modelPicker.options.map((option) => {
                        const selected = option.id === modelPicker.currentModelId;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={cn(
                              'flex w-full items-center gap-2.5 rounded-[0.85rem] px-2.5 py-2 text-left transition-colors',
                              selected
                                ? 'bg-secondary text-foreground'
                                : 'text-foreground/88 hover:bg-muted/70',
                            )}
                            onClick={() => {
                              setModelPickerOpen(false);
                              if (!selected) {
                                modelPicker.onSelect(option.id);
                              }
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[12px] font-medium leading-5">{option.label}</div>
                            </div>
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                              {selected ? <Check className="h-3.5 w-3.5" /> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  CHAT_LAYOUT_TOKENS.inputAttachButton,
                  'rounded-full border border-border/45 bg-background/74 text-muted-foreground shadow-sm hover:bg-background/88 hover:text-foreground',
                  quickPhraseOpen && 'bg-background/90 text-foreground',
                )}
                onClick={toggleQuickPhrase}
                disabled={disabled || sending || approvalWaiting}
                aria-label="快捷短语"
                title="快捷短语"
                aria-haspopup="dialog"
                aria-expanded={quickPhraseOpen}
              >
                <MessageSquare className="h-4 w-4" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  CHAT_LAYOUT_TOKENS.inputAttachButton,
                  'rounded-full border border-border/45 bg-background/74 text-muted-foreground shadow-sm hover:bg-background/88 hover:text-foreground',
                )}
                onClick={stageSelectedDialogAttachments}
                disabled={disabled || sending || approvalWaiting}
                aria-label="Attach files"
                title="Attach files"
              >
                <Paperclip className="h-4 w-4" />
              </Button>

              <Button
                onClick={sending ? handleStop : handleSend}
                disabled={sending ? !canStop : !canSend}
                size="icon"
                className={cn(
                  CHAT_LAYOUT_TOKENS.inputSendButton,
                  'rounded-full shadow-[0_8px_20px_rgba(15,23,42,0.10)]',
                )}
                variant={sending ? 'destructive' : 'default'}
                aria-label={sending ? 'Stop' : 'Send'}
                title={sending ? 'Stop' : 'Send'}
              >
                {stopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : sending ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
            {statusText ? (
              <div className="min-w-0 px-0.5 text-[11px] text-muted-foreground/78">
                <span className="block truncate">{statusText}</span>
              </div>
            ) : null}
          </div>
        </div>
        {quickPhraseOpen && typeof document !== 'undefined' ? createPortal((
          <div
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-6"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                closeQuickPhrase();
              }
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-label={quickPhraseAddOpen ? '新增快捷短语' : '快捷短语'}
              className="w-full max-w-[54rem] rounded-[1.25rem] border border-border bg-card p-5 shadow-[0_24px_70px_rgba(15,23,42,0.28)]"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    {quickPhraseAddOpen ? '新增快捷短语' : '快捷短语'}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {quickPhraseAddOpen
                      ? '把常用指令单独存起来，后面可以直接复用。'
                      : '这里集中管理你常用的会话指令，点一下就能直接填回当前输入框。'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-full border border-border bg-background shadow-sm hover:bg-secondary"
                  onClick={closeQuickPhrase}
                  aria-label="关闭快捷短语"
                  title="关闭快捷短语"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="mt-4 border-t border-border/45 pt-4">
                {quickPhraseAddOpen ? (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="quick-phrase-draft">
                      新增短语
                    </label>
                    <Textarea
                      id="quick-phrase-draft"
                      value={quickPhraseDraft}
                      onChange={(event) => setQuickPhraseDraft(event.target.value)}
                      placeholder="输入一条常用短语，保存后下次可以直接复用。"
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
                        取消
                      </Button>
                      <Button
                        type="button"
                        className="rounded-xl"
                        disabled={!quickPhraseDraft.trim()}
                        onClick={addQuickPhrase}
                      >
                        添加短语
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">快捷短语列表</span>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 rounded-xl px-3 text-xs"
                        onClick={() => setQuickPhraseAddOpen(true)}
                      >
                        新增短语
                      </Button>
                    </div>
                    {quickPhrases.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border bg-background px-4 py-6 text-center text-sm text-muted-foreground">
                        还没有快捷短语，点“新增短语”添加常用内容。
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
                              <div className="text-xs font-semibold text-primary">第 {index + 1} 条</div>
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
                                aria-label={`上移${phrase.text}`}
                                title="上移"
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
                                aria-label={`下移${phrase.text}`}
                                title="下移"
                              >
                                ↓
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon"
                                className="h-7 w-7 rounded-lg text-destructive hover:text-destructive"
                                onClick={() => removeQuickPhrase(phrase.id)}
                                aria-label={`删除${phrase.text}`}
                                title="删除"
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
            </section>
          </div>
        ), document.body) : null}
        {hasFailedAttachments && (
          <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
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
  const canOpen = attachment.status === 'ready' && (previewableImage || attachment.stagedPath.length > 0);
  const actionLabel = previewableImage ? `Preview ${attachment.fileName}` : `Open ${attachment.fileName}`;

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
    <div className="inline-flex w-[120px] max-w-full items-center rounded-full border border-border/50 bg-background/84 pr-1 shadow-sm backdrop-blur-sm">
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
