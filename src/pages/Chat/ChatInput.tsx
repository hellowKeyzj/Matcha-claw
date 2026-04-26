/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { memo, useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { Send, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, Loader2, ImageIcon, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { useChatStore } from '@/stores/chat';
import { selectChatInputSessionKey } from '@/stores/chat/selectors';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import { ChatImageLightbox } from './components/ChatImageLightbox';

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

export interface MentionCandidate {
  id: string;
  label?: string;
  insertText?: string;
}

interface SelectedSkill {
  id: string;
  name: string;
  icon: string;
}

interface StagedFilePayload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
}

const STAGE_BUFFER_CONCURRENCY = 3;

interface ChatInputProps {
  onSend: (text: string, attachments?: FileAttachment[]) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  approvalWaiting?: boolean;
  mentionCandidates?: MentionCandidate[];
  layout?: 'dock' | 'hero';
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

// ── Component ────────────────────────────────────────────────────

export const ChatInput = memo(function ChatInput({
  onSend,
  onStop,
  disabled = false,
  sending = false,
  approvalWaiting = false,
  mentionCandidates = [],
  layout = 'dock',
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
  const [lightboxAttachment, setLightboxAttachment] = useState<{
    src: string;
    fileName: string;
    filePath?: string;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const isComposingRef = useRef(false);
  const skills = useSkillsStore((state) => state.skills);
  const skillsSnapshotReady = useSkillsStore((state) => state.snapshotReady);
  const skillsInitialLoading = useSkillsStore((state) => state.initialLoading);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const currentSessionKey = useChatStore(selectChatInputSessionKey);
  const agents = useSubagentsStore((state) => (
    Array.isArray(state.agentsResource.data) ? state.agentsResource.data : []
  ));
  const allowedSkillIdSet = useMemo(() => {
    const matched = currentSessionKey.match(/^agent:([^:]+):/i);
    const currentAgentId = matched?.[1] ?? 'main';
    const currentAgent = agents.find((agent) => agent.id === currentAgentId);
    if (!Array.isArray(currentAgent?.skills)) {
      return null;
    }
    const normalized = currentAgent.skills
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    return new Set(normalized);
  }, [agents, currentSessionKey]);

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
  }, [closeMention, closeSlash, mentionCandidates]);

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
      }));
    setSlashOpen(true);
    setSlashStart(range.start);
    setSlashEnd(range.end);
    setSlashItems(matched);
    setSlashActiveIndex((prev) => (prev >= matched.length ? 0 : prev));
    closeMention();
  }, [allowedSkillIdSet, closeMention, closeSlash, selectedSkills, skills]);

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

  // ── File staging via native dialog ─────────────────────────────

  const pickFiles = useCallback(async () => {
    let tempIds: string[] = [];
    try {
      const result = await invokeIpc('dialog:open', {
        properties: ['openFile', 'multiSelections'],
      }) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;

      // Add placeholder entries immediately
      const stagingAttachments = result.filePaths.map((filePath) => {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        // Handle both Unix (/) and Windows (\) path separators
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        return buildStagingAttachment(tempId, fileName, '', 0);
      });
      setAttachments((prev) => [...prev, ...stagingAttachments]);

      // Stage all files via IPC
      const staged = await hostApiFetch<StagedFilePayload[]>('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths: result.filePaths }),
      });

      // Update each placeholder with real data
      const updatesByTempId = new Map<string, FileAttachment>();
      for (let i = 0; i < tempIds.length; i++) {
        const tempId = tempIds[i];
        const data = staged[i];
        if (data) {
          updatesByTempId.set(tempId, { ...data, status: 'ready' });
        } else {
          const fallback = stagingAttachments[i];
          updatesByTempId.set(tempId, {
            ...fallback,
            status: 'error',
            error: 'Staging failed',
          });
        }
      }
      setAttachments((prev) => prev.map((attachment) => updatesByTempId.get(attachment.id) ?? attachment));
    } catch (err) {
      // Mark any stuck 'staging' attachments as 'error' so the user can remove them
      // and the send button isn't permanently blocked
      const failedIds = new Set(tempIds);
      setAttachments((prev) => prev.map((attachment) => (
        failedIds.has(attachment.id)
          ? { ...attachment, status: 'error', error: String(err) }
          : attachment
      )));
    }
  }, []);

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
          const base64 = await readFileAsBase64(file);
          const staged = await hostApiFetch<StagedFilePayload>('/api/files/stage-buffer', {
            method: 'POST',
            body: JSON.stringify({
              base64,
              fileName: file.name,
              mimeType: file.type || 'application/octet-stream',
            }),
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
  }, []);

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
  const canStop = sending && !disabled && !!onStop;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    // Capture values before clearing — clear input immediately for snappy UX,
    // but keep attachments available for the async send
    const rawText = input.trim();
    const textToSend = buildSkillPrefixedMessage(rawText, selectedSkills);
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    setInput('');
    closeMention();
    closeSlash();
    setSelectedSkills([]);
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSend(textToSend, attachmentsToSend);
  }, [attachments, canSend, closeMention, closeSlash, input, onSend, selectedSkills]);

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
      closeSlash,
      handleSend,
      mentionActiveIndex,
      mentionItems,
      mentionOpen,
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
      if (e.dataTransfer?.files?.length) {
        stageBufferFiles(Array.from(e.dataTransfer.files));
      }
    },
    [stageBufferFiles],
  );

  return (
    <div
      className={cn(
        layout === 'hero'
          ? 'w-full px-2 pb-3 pt-3 md:px-4'
          : 'border-t border-border/70 px-2 pb-3 pt-3 md:px-4',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={CHAT_LAYOUT_TOKENS.inputRail}>
        {/* Input Row */}
        <div
          className={cn(
            CHAT_LAYOUT_TOKENS.inputCard,
            dragOver && 'border-ring shadow-[var(--shadow-focus)]',
            layout === 'hero'
              ? CHAT_LAYOUT_TOKENS.inputCardHeroMinHeight
              : CHAT_LAYOUT_TOKENS.inputCardDockMinHeight,
          )}
        >
          <div className="relative min-w-0">
            <div className="px-2 pt-1">
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
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
                    >
                      <span>{skill.icon}</span>
                      <span className="truncate">{skill.name}</span>
                      <button
                        type="button"
                        className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
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
                placeholder={disabled
                  ? t('input.gatewayDisconnectedPlaceholder')
                  : approvalWaiting
                    ? t('input.approvalWaitingPlaceholder')
                    : t('input.messagePlaceholder')}
                disabled={disabled}
                className={cn(
                  CHAT_LAYOUT_TOKENS.inputTextarea,
                  layout === 'hero' && CHAT_LAYOUT_TOKENS.inputTextareaHeroMinHeight,
                )}
                rows={1}
              />
            </div>
            {mentionOpen && mentionItems.length > 0 && (
              <div
                role="listbox"
                className="absolute bottom-full z-50 mb-1 max-h-48 w-full overflow-y-auto rounded-md border bg-background p-1 shadow-md"
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
                        'flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs',
                        isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
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
                className="absolute bottom-full z-40 mb-1 max-h-56 w-full overflow-y-auto rounded-md border bg-background p-1 shadow-md"
              >
                {slashItems.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No matched skill</div>
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
                          'flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs',
                          isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
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

          <div className={CHAT_LAYOUT_TOKENS.inputActionsRow}>
            <Button
              variant="ghost"
              size="icon"
              className={CHAT_LAYOUT_TOKENS.inputAttachButton}
              onClick={pickFiles}
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
              className={CHAT_LAYOUT_TOKENS.inputSendButton}
              variant={sending ? 'destructive' : 'default'}
              aria-label={sending ? 'Stop' : 'Send'}
              title={sending ? 'Stop' : 'Send'}
            >
              {sending ? (
                <Square className="h-4 w-4" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
        {hasFailedAttachments && (
          <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => {
                setAttachments((prev) => prev.filter((att) => att.status !== 'error'));
                void pickFiles();
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
    <div className="inline-flex w-[120px] max-w-full items-center rounded-full border border-border/70 bg-muted/35 pr-1 shadow-sm">
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
