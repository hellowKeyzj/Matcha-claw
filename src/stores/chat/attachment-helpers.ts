import { hostApiFetch } from '@/lib/host-api';
import { isToolResultRole } from './event-helpers';
import { throwIfHistoryLoadAborted } from './history-abort';
import { getMessageText } from './message-helpers';
import type { AttachedFileMeta, ChatSendAttachment, ContentBlock } from './types';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

// ── Local image cache ─────────────────────────────────────────
// The Gateway doesn't store image attachments in session content blocks,
// so we cache them locally keyed by staged file path (which appears in the
// [media attached: <path> ...] reference in the Gateway's user message text).
// Keying by path avoids the race condition of keying by runId (which is only
// available after the RPC returns, but history may load before that).
const IMAGE_CACHE_KEY = 'clawx:image-cache';
const IMAGE_CACHE_MAX = 100; // max entries to prevent unbounded growth
const HISTORY_ENRICH_YIELD_INTERVAL = 64;

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

const imageCache = loadImageCache();

export interface AttachmentImageCacheStats {
  entryCount: number;
  previewCharCount: number;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) {
    return;
  }
  throwIfHistoryLoadAborted(signal);
}

/** Extract media file refs from [media attached: <path> (<mime>) | ...] patterns */
export function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

/**
 * Extract images from a content array (including nested tool_result content).
 * Converts them to AttachedFileMeta entries with preview set to data URL or remote URL.
 */
export function extractImagesAsAttachedFiles(content: unknown): AttachedFileMeta[] {
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
export function makeAttachedFile(ref: { filePath: string; mimeType: string }): AttachedFileMeta {
  const cached = imageCache.get(ref.filePath);
  if (cached) return { ...cached, filePath: ref.filePath };
  const fileName = ref.filePath.split(/[\\/]/).pop() || 'file';
  return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath };
}

function collectTimelineEntryToolCallPaths(entry: SessionTimelineEntry, paths: Map<string, string>): void {
  const content = entry.message.content;
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
  const toolCalls = entry.message.tool_calls ?? entry.message.toolCalls;
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

function attachPendingToolResultFilesToTimelineEntries(entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
  const pending: AttachedFileMeta[] = [];
  const toolCallPaths = new Map<string, string>();
  let changed = false;

  const nextEntries = entries.map((entry) => {
    if (entry.role === 'assistant') {
      collectTimelineEntryToolCallPaths(entry, toolCallPaths);
    }

    if (isToolResultRole(entry.role)) {
      const matchedPath = entry.message.toolCallId ? toolCallPaths.get(entry.message.toolCallId) : undefined;

      const imageFiles = extractImagesAsAttachedFiles(entry.message.content);
      if (matchedPath) {
        for (const f of imageFiles) {
          if (!f.filePath) {
            f.filePath = matchedPath;
            f.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
          }
        }
      }
      pending.push(...imageFiles);

      const text = getMessageText(entry.message.content);
      if (text) {
        const mediaRefs = extractMediaRefs(text);
        for (const ref of mediaRefs) {
          pending.push(makeAttachedFile(ref));
        }
      }

      return entry;
    }

    if (entry.role === 'assistant' && pending.length > 0) {
      const toAttach = pending.splice(0);
      const existingPaths = new Set(
        (readTimelineEntryAttachedFiles(entry)).map((f) => f.filePath).filter(Boolean),
      );
      const newFiles = toAttach.filter((f) => !f.filePath || !existingPaths.has(f.filePath));
      if (newFiles.length === 0) return entry;
      changed = true;
      return {
        ...entry,
        message: {
          ...entry.message,
          _attachedFiles: [...readTimelineEntryAttachedFiles(entry), ...newFiles].map((file) => ({ ...file })),
        },
      };
    }

    return entry;
  });

  return changed ? nextEntries : entries;
}

async function attachPendingToolResultFilesToTimelineEntriesIncremental(
  entries: SessionTimelineEntry[],
  chunkSize = HISTORY_ENRICH_YIELD_INTERVAL,
  abortSignal?: AbortSignal,
): Promise<SessionTimelineEntry[]> {
  throwIfAborted(abortSignal);
  if (entries.length === 0) {
    return entries;
  }

  const pending: AttachedFileMeta[] = [];
  const toolCallPaths = new Map<string, string>();
  const enriched = new Array<SessionTimelineEntry>(entries.length);
  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize));
  let changed = false;

  for (let index = 0; index < entries.length; index += 1) {
    throwIfAborted(abortSignal);
    const entry = entries[index];
    let nextEntry = entry;

    if (entry.role === 'assistant') {
      collectTimelineEntryToolCallPaths(entry, toolCallPaths);
    }

    if (isToolResultRole(entry.role)) {
      const matchedPath = entry.message.toolCallId ? toolCallPaths.get(entry.message.toolCallId) : undefined;

      const imageFiles = extractImagesAsAttachedFiles(entry.message.content);
      if (matchedPath) {
        for (const f of imageFiles) {
          if (!f.filePath) {
            f.filePath = matchedPath;
            f.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
          }
        }
      }
      pending.push(...imageFiles);

      const text = getMessageText(entry.message.content);
      if (text) {
        const mediaRefs = extractMediaRefs(text);
        for (const ref of mediaRefs) {
          pending.push(makeAttachedFile(ref));
        }
      }
    } else if (entry.role === 'assistant' && pending.length > 0) {
      const toAttach = pending.splice(0);
      const existingPaths = new Set(
        readTimelineEntryAttachedFiles(entry).map((f) => f.filePath).filter(Boolean),
      );
      const newFiles = toAttach.filter((f) => !f.filePath || !existingPaths.has(f.filePath));
      if (newFiles.length > 0) {
        nextEntry = {
          ...entry,
          message: {
            ...entry.message,
            _attachedFiles: [...readTimelineEntryAttachedFiles(entry), ...newFiles].map((file) => ({ ...file })),
          },
        };
        changed = true;
      }
    }

    enriched[index] = nextEntry;

    if ((index + 1) % normalizedChunkSize === 0) {
      throwIfAborted(abortSignal);
      await yieldToEventLoop();
    }
  }

  return changed ? enriched : entries;
}

function readTimelineEntryAttachedFiles(entry: SessionTimelineEntry): AttachedFileMeta[] {
  const attachedFiles = entry.message._attachedFiles;
  return Array.isArray(attachedFiles)
    ? attachedFiles as unknown as AttachedFileMeta[]
    : [];
}

export function hydrateAttachedFilesFromTimelineEntries(
  entries: SessionTimelineEntry[],
): SessionTimelineEntry[] {
  const withToolResultFiles = attachPendingToolResultFilesToTimelineEntries(entries);
  let changed = withToolResultFiles !== entries;
  const nextEntries = withToolResultFiles.map((entry) => {
    const attachedFiles = readTimelineEntryAttachedFiles(entry);
    if (attachedFiles.length === 0) {
      return entry;
    }

    let entryChanged = false;
    const nextFiles = attachedFiles.map((file) => {
      const filePath = file.filePath;
      if (!filePath) {
        return file;
      }
      const cached = imageCache.get(filePath);
      if (!cached) {
        return file;
      }

      const nextPreview = file.preview ?? cached.preview ?? null;
      const nextFileSize = file.fileSize > 0 ? file.fileSize : (cached.fileSize ?? 0);
      const nextFileName = file.fileName || cached.fileName;
      const nextMimeType = file.mimeType || cached.mimeType;

      if (
        nextPreview === (file.preview ?? null)
        && nextFileSize === file.fileSize
        && nextFileName === file.fileName
        && nextMimeType === file.mimeType
      ) {
        return file;
      }

      entryChanged = true;
      return {
        ...file,
        preview: nextPreview,
        fileSize: nextFileSize,
        fileName: nextFileName,
        mimeType: nextMimeType,
      } satisfies AttachedFileMeta;
    });

    if (!entryChanged) {
      return entry;
    }

    changed = true;
    return {
      ...entry,
      message: {
        ...entry.message,
        _attachedFiles: nextFiles.map((file) => ({ ...file })),
      },
    };
  });

  return changed ? nextEntries : entries;
}

export function hasPendingTimelineEntryPreviewLoads(
  entries: SessionTimelineEntry[],
): boolean {
  return entries.some((entry) => {
    const attachedFiles = readTimelineEntryAttachedFiles(entry);
    if (attachedFiles.length === 0) {
      return false;
    }
    return attachedFiles.some((file) => {
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

export async function loadMissingTimelineEntryPreviews(
  entries: SessionTimelineEntry[],
): Promise<SessionTimelineEntry[] | null> {
  const normalizedEntries = await attachPendingToolResultFilesToTimelineEntriesIncremental(entries);
  const needPreview: Array<{ filePath: string; mimeType: string }> = [];
  const seenPaths = new Set<string>();

  for (const entry of normalizedEntries) {
    const attachedFiles = readTimelineEntryAttachedFiles(entry);
    if (attachedFiles.length === 0) {
      continue;
    }

    for (const file of attachedFiles) {
      const filePath = file.filePath;
      if (!filePath || seenPaths.has(filePath)) {
        continue;
      }
      const needsLoad = file.mimeType.startsWith('image/')
        ? !file.preview
        : file.fileSize === 0;
      if (needsLoad) {
        seenPaths.add(filePath);
        needPreview.push({ filePath, mimeType: file.mimeType });
      }
    }

    if (entry.role !== 'user') {
      continue;
    }
    const refs = extractMediaRefs(getMessageText(entry.message.content));
    for (let index = 0; index < refs.length; index += 1) {
      const file = attachedFiles[index];
      const ref = refs[index];
      if (!file || !ref || seenPaths.has(ref.filePath)) {
        continue;
      }
      const needsLoad = ref.mimeType.startsWith('image/') ? !file.preview : file.fileSize === 0;
      if (needsLoad) {
        seenPaths.add(ref.filePath);
        needPreview.push(ref);
      }
    }
  }

  if (needPreview.length === 0) {
    return null;
  }

  try {
    const thumbnails = await hostApiFetch<Record<string, { preview: string | null; fileSize: number }>>(
      '/api/files/thumbnails',
      {
        method: 'POST',
        body: JSON.stringify({ paths: needPreview }),
      },
    );

    let changed = false;
    const nextEntries = normalizedEntries.map((entry) => {
      const attachedFiles = readTimelineEntryAttachedFiles(entry);
      if (attachedFiles.length === 0) {
        return entry;
      }

      const userRefs = entry.role === 'user'
        ? extractMediaRefs(getMessageText(entry.message.content))
        : [];
      let entryChanged = false;
      const nextFiles = attachedFiles.map((file, index) => {
        const fallbackPath = !file.filePath && entry.role === 'user'
          ? userRefs[index]?.filePath
          : undefined;
        const filePath = file.filePath ?? fallbackPath;
        if (!filePath) {
          return file;
        }
        const thumb = thumbnails[filePath];
        if (!thumb || (!thumb.preview && !thumb.fileSize)) {
          return file;
        }

        const nextPreview = thumb.preview ?? file.preview ?? null;
        const nextFileSize = thumb.fileSize || file.fileSize;
        if (nextPreview === (file.preview ?? null) && nextFileSize === file.fileSize) {
          return file;
        }

        const nextFile: AttachedFileMeta = {
          ...file,
          ...(file.filePath ? {} : { filePath }),
          preview: nextPreview,
          fileSize: nextFileSize,
        };
        imageCache.set(filePath, { ...nextFile });
        entryChanged = true;
        return nextFile;
      });

      if (!entryChanged) {
        return entry;
      }

      changed = true;
      return {
        ...entry,
        message: {
          ...entry.message,
          _attachedFiles: nextFiles.map((file) => ({ ...file })),
        },
      };
    });

    if (changed) {
      saveImageCache(imageCache);
      return nextEntries;
    }
    return normalizedEntries === entries ? null : normalizedEntries;
  } catch {
    return normalizedEntries === entries ? null : normalizedEntries;
  }
}

export function getAttachmentImageCacheStats(): AttachmentImageCacheStats {
  let previewCharCount = 0;
  for (const file of imageCache.values()) {
    previewCharCount += typeof file.preview === 'string' ? file.preview.length : 0;
  }

  return {
    entryCount: imageCache.size,
    previewCharCount,
  };
}

export function cacheSendAttachments(attachments: ChatSendAttachment[]): void {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return;
  }
  for (const attachment of attachments) {
    imageCache.set(attachment.stagedPath, {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      preview: attachment.preview,
      filePath: attachment.stagedPath,
    });
  }
  saveImageCache(imageCache);
}
