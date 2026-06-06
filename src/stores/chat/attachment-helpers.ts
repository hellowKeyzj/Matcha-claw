import { hostApiFetch } from '@/lib/host-api';
import { throwIfHistoryLoadAborted } from './history-abort';
import {
  getSessionItems,
  patchSessionRecord,
  reconcileSessionItems,
} from './store-state-helpers';
import type { AttachedFileMeta, ChatSendAttachment, ChatStoreState } from './types';
import type {
  SessionAssistantTurnItem,
  SessionRenderAttachedFile,
  SessionRenderItem,
  SessionRenderUserMessageItem,
} from '../../../runtime-host/shared/session-adapter-types';

const IMAGE_CACHE_KEY = 'matchaclaw:image-cache';
const IMAGE_CACHE_MAX = 100;

function loadImageCache(): Map<string, AttachedFileMeta> {
  try {
    const raw = localStorage.getItem(IMAGE_CACHE_KEY);
    if (raw) {
      return new Map(JSON.parse(raw) as Array<[string, AttachedFileMeta]>);
    }
  } catch {
    // ignore parse errors
  }
  return new Map();
}

function saveImageCache(cache: Map<string, AttachedFileMeta>): void {
  try {
    const entries = Array.from(cache.entries());
    const trimmed = entries.length > IMAGE_CACHE_MAX
      ? entries.slice(entries.length - IMAGE_CACHE_MAX)
      : entries;
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore quota errors
  }
}

const imageCache = loadImageCache();

export interface AttachmentImageCacheStats {
  entryCount: number;
  previewCharCount: number;
}

export function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

function normalizeAttachedFiles(files: ReadonlyArray<SessionRenderAttachedFile>): AttachedFileMeta[] {
  return files.map((file) => ({
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    preview: file.preview,
    ...(file.source ? { source: file.source } : {}),
    ...(file.filePath ? { filePath: file.filePath } : {}),
    ...(file.gatewayUrl ? { gatewayUrl: file.gatewayUrl } : {}),
    ...(file.previewStatus ? { previewStatus: file.previewStatus } : {}),
  }));
}

function getAttachmentRefKey(file: { filePath?: string; gatewayUrl?: string }): string | null {
  if (typeof file.filePath === 'string' && file.filePath.trim()) {
    return file.filePath;
  }
  if (typeof file.gatewayUrl === 'string' && file.gatewayUrl.trim()) {
    return file.gatewayUrl;
  }
  return null;
}

function buildAttachedFileFromRef(ref: { filePath: string; mimeType: string }): AttachedFileMeta {
  const cached = imageCache.get(ref.filePath);
  if (cached) {
    return { ...cached, filePath: ref.filePath };
  }
  return {
    fileName: ref.filePath.split(/[\\/]/).pop() || 'file',
    mimeType: ref.mimeType,
    fileSize: 0,
    preview: null,
    filePath: ref.filePath,
    source: 'message-ref',
  };
}

function isAttachmentBearingItem(item: SessionRenderItem): item is SessionRenderUserMessageItem | SessionAssistantTurnItem {
  return item.kind === 'user-message' || item.kind === 'assistant-turn';
}

function areAttachedFilesEquivalent(
  left: ReadonlyArray<SessionRenderAttachedFile>,
  right: ReadonlyArray<SessionRenderAttachedFile>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.fileName !== b.fileName
      || a.mimeType !== b.mimeType
      || a.fileSize !== b.fileSize
      || a.preview !== b.preview
      || a.previewStatus !== b.previewStatus
      || a.filePath !== b.filePath
      || a.gatewayUrl !== b.gatewayUrl
      || a.source !== b.source
    ) {
      return false;
    }
  }
  return true;
}

function deriveAssistantAttachedFiles(
  segments: SessionAssistantTurnItem['segments'],
): AttachedFileMeta[] {
  return segments.flatMap((segment) => (
    segment.kind === 'media' ? normalizeAttachedFiles(segment.attachedFiles) : []
  ));
}

function mergeUserAttachedFiles(item: SessionRenderUserMessageItem): AttachedFileMeta[] {
  const merged = normalizeAttachedFiles(item.attachedFiles);
  const existingPaths = new Set(merged.map((file) => file.filePath).filter(Boolean));
  for (const ref of extractMediaRefs(item.text)) {
    if (existingPaths.has(ref.filePath)) {
      continue;
    }
    merged.push(buildAttachedFileFromRef(ref));
    existingPaths.add(ref.filePath);
  }
  return merged;
}

function readItemAttachedFiles(item: SessionRenderUserMessageItem | SessionAssistantTurnItem): AttachedFileMeta[] {
  return item.kind === 'assistant-turn'
    ? deriveAssistantAttachedFiles(item.segments)
    : mergeUserAttachedFiles(item);
}

function hydrateFileFromCache(file: AttachedFileMeta): AttachedFileMeta {
  const refKey = getAttachmentRefKey(file);
  if (!refKey) {
    return file;
  }
  const cached = imageCache.get(refKey);
  if (!cached) {
    return file;
  }
  return {
    ...file,
    preview: file.preview ?? cached.preview ?? null,
    fileSize: file.fileSize > 0 ? file.fileSize : (cached.fileSize ?? 0),
    fileName: file.fileName || cached.fileName,
    mimeType: file.mimeType || cached.mimeType,
    source: file.source ?? cached.source,
  } satisfies AttachedFileMeta;
}

function applyFileUpdate(
  files: ReadonlyArray<SessionRenderAttachedFile>,
  update: (file: AttachedFileMeta) => AttachedFileMeta,
): { files: AttachedFileMeta[]; changed: boolean } {
  const normalized = normalizeAttachedFiles(files);
  let changed = !areAttachedFilesEquivalent(files, normalized);
  const nextFiles = normalized.map((file) => {
    const nextFile = update(file);
    if (nextFile !== file && !areAttachedFilesEquivalent([file], [nextFile])) {
      changed = true;
    }
    return nextFile;
  });
  return { files: nextFiles, changed };
}

function normalizeUserAttachmentItem(
  item: SessionRenderUserMessageItem,
  update: (file: AttachedFileMeta) => AttachedFileMeta,
): SessionRenderUserMessageItem {
  const attachedFiles = mergeUserAttachedFiles(item);
  const { files, changed } = applyFileUpdate(attachedFiles, update);
  if (!changed && areAttachedFilesEquivalent(item.attachedFiles, files)) {
    return item;
  }
  return {
    ...item,
    attachedFiles: files,
  };
}

function normalizeAssistantAttachmentItem(
  item: SessionAssistantTurnItem,
  update: (file: AttachedFileMeta) => AttachedFileMeta,
): SessionAssistantTurnItem {
  let changed = false;
  const nextSegments = item.segments.map((segment) => {
    if (segment.kind !== 'media') {
      return segment;
    }
    const nextFiles = applyFileUpdate(segment.attachedFiles, update);
    if (!nextFiles.changed) {
      return segment;
    }
    changed = true;
    return {
      ...segment,
      attachedFiles: nextFiles.files,
    };
  });
  const attachedFiles = deriveAssistantAttachedFiles(nextSegments);
  if (!areAttachedFilesEquivalent(item.attachedFiles, attachedFiles)) {
    changed = true;
  }
  if (!changed) {
    return item;
  }
  return {
    ...item,
    segments: nextSegments,
    attachedFiles,
  };
}

function normalizeAttachmentItem(
  item: SessionRenderUserMessageItem | SessionAssistantTurnItem,
  update: (file: AttachedFileMeta) => AttachedFileMeta,
): SessionRenderUserMessageItem | SessionAssistantTurnItem {
  return item.kind === 'assistant-turn'
    ? normalizeAssistantAttachmentItem(item, update)
    : normalizeUserAttachmentItem(item, update);
}

function hydrateAttachmentItemFromCache(
  item: SessionRenderUserMessageItem | SessionAssistantTurnItem,
): SessionRenderUserMessageItem | SessionAssistantTurnItem {
  return normalizeAttachmentItem(item, hydrateFileFromCache);
}

export function hydrateAttachedFilesFromItems(items: SessionRenderItem[]): SessionRenderItem[] {
  let changed = false;
  const nextItems = items.map((item) => {
    if (!isAttachmentBearingItem(item)) {
      return item;
    }
    const nextItem = hydrateAttachmentItemFromCache(item);
    if (nextItem !== item) {
      changed = true;
    }
    return nextItem;
  });
  return changed ? nextItems : items;
}

function mergeHydratedFileByRef(
  file: AttachedFileMeta,
  hydratedByRef: ReadonlyMap<string, AttachedFileMeta>,
): AttachedFileMeta {
  const refKey = getAttachmentRefKey(file);
  if (!refKey) {
    return file;
  }
  const hydrated = hydratedByRef.get(refKey);
  if (!hydrated) {
    return file;
  }
  const preview = file.preview ?? hydrated.preview ?? null;
  return {
    ...file,
    preview,
    fileSize: file.fileSize > 0 ? file.fileSize : hydrated.fileSize,
    fileName: file.fileName || hydrated.fileName,
    mimeType: file.mimeType || hydrated.mimeType,
    source: file.source ?? hydrated.source,
    ...(preview ? {} : hydrated.previewStatus ? { previewStatus: hydrated.previewStatus } : file.previewStatus ? { previewStatus: file.previewStatus } : {}),
  } satisfies AttachedFileMeta;
}

function mergeHydratedAttachmentItem(
  currentItem: SessionRenderUserMessageItem | SessionAssistantTurnItem,
  hydratedItem: SessionRenderUserMessageItem | SessionAssistantTurnItem,
): SessionRenderUserMessageItem | SessionAssistantTurnItem {
  const hydratedByRef = new Map<string, AttachedFileMeta>();
  for (const file of readItemAttachedFiles(hydratedItem)) {
    const refKey = getAttachmentRefKey(file);
    if (refKey) {
      hydratedByRef.set(refKey, file);
    }
  }
  if (hydratedByRef.size === 0) {
    return currentItem;
  }
  return normalizeAttachmentItem(currentItem, (file) => mergeHydratedFileByRef(file, hydratedByRef));
}

export function reconcileHydratedAttachmentItems(
  currentItems: SessionRenderItem[],
  hydratedItems: SessionRenderItem[],
): SessionRenderItem[] {
  if (currentItems === hydratedItems) {
    return currentItems;
  }

  const hydratedByKey = new Map(
    hydratedItems.map((item) => [item.key, item] as const),
  );
  let changed = false;

  const nextItems = currentItems.map((currentItem) => {
    const hydratedItem = hydratedByKey.get(currentItem.key);
    if (!hydratedItem || hydratedItem.kind !== currentItem.kind) {
      return currentItem;
    }
    if (!isAttachmentBearingItem(currentItem) || !isAttachmentBearingItem(hydratedItem)) {
      return currentItem;
    }
    const nextItem = mergeHydratedAttachmentItem(currentItem, hydratedItem);
    if (nextItem !== currentItem) {
      changed = true;
    }
    return nextItem;
  });

  return changed ? reconcileSessionItems(currentItems, nextItems) : currentItems;
}

export function buildHydratedAttachmentItemsPatch(
  state: ChatStoreState,
  sessionKey: string,
  hydratedItems: SessionRenderItem[],
): Partial<ChatStoreState> | ChatStoreState {
  const currentItems = getSessionItems(state, sessionKey);
  const nextItems = reconcileHydratedAttachmentItems(currentItems, hydratedItems);
  if (currentItems === nextItems) {
    return state;
  }
  return {
    loadedSessions: patchSessionRecord(state, sessionKey, {
      items: nextItems,
    }),
  };
}

function fileNeedsPreviewLoad(file: AttachedFileMeta): boolean {
  if (!getAttachmentRefKey(file)) {
    return false;
  }
  return file.mimeType.startsWith('image/')
    ? !file.preview && file.previewStatus !== 'unavailable'
    : file.fileSize === 0;
}

export function hasPendingItemPreviewLoads(items: SessionRenderItem[]): boolean {
  return items.some((item) => (
    isAttachmentBearingItem(item) && readItemAttachedFiles(item).some(fileNeedsPreviewLoad)
  ));
}

export async function loadMissingItemPreviews(
  items: SessionRenderItem[],
  abortSignal?: AbortSignal,
): Promise<SessionRenderItem[] | null> {
  if (abortSignal) {
    throwIfHistoryLoadAborted(abortSignal);
  }
  const normalizedItems = hydrateAttachedFilesFromItems(items);
  const needPreview: Array<{ filePath?: string; gatewayUrl?: string; mimeType: string }> = [];
  const seenRefs = new Set<string>();

  for (const item of normalizedItems) {
    if (!isAttachmentBearingItem(item)) {
      continue;
    }
    for (const file of readItemAttachedFiles(item)) {
      const refKey = getAttachmentRefKey(file);
      if (!refKey || seenRefs.has(refKey) || !fileNeedsPreviewLoad(file)) {
        continue;
      }
      seenRefs.add(refKey);
      needPreview.push(file.filePath
        ? { filePath: file.filePath, mimeType: file.mimeType }
        : { gatewayUrl: file.gatewayUrl, mimeType: file.mimeType });
    }
  }

  if (needPreview.length === 0) {
    return normalizedItems === items ? null : normalizedItems;
  }

  try {
    const thumbnails = await hostApiFetch<Record<string, { preview: string | null; fileSize: number }>>(
      '/api/files/thumbnails',
      {
        method: 'POST',
        body: JSON.stringify({ paths: needPreview }),
      },
    );

    let changed = normalizedItems !== items;
    const nextItems = normalizedItems.map((item) => {
      if (!isAttachmentBearingItem(item)) {
        return item;
      }
      const nextItem = normalizeAttachmentItem(item, (file) => {
        const refKey = getAttachmentRefKey(file);
        if (!refKey || !seenRefs.has(refKey)) {
          return file;
        }
        const thumb = thumbnails[refKey];
        if (!thumb || (!thumb.preview && !thumb.fileSize)) {
          if (!file.mimeType.startsWith('image/')) {
            return file;
          }
          const nextFile = {
            ...file,
            previewStatus: 'unavailable' as const,
          } satisfies AttachedFileMeta;
          imageCache.set(refKey, { ...nextFile });
          return nextFile;
        }
        const nextFile = {
          ...file,
          preview: thumb.preview ?? file.preview ?? null,
          fileSize: thumb.fileSize || file.fileSize,
          previewStatus: undefined,
        } satisfies AttachedFileMeta;
        imageCache.set(refKey, { ...nextFile });
        return nextFile;
      });
      if (nextItem !== item) {
        changed = true;
      }
      return nextItem;
    });

    if (changed) {
      saveImageCache(imageCache);
      return nextItems;
    }
    return null;
  } catch {
    return normalizedItems === items ? null : normalizedItems;
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
      source: 'user-upload',
    });
  }
  saveImageCache(imageCache);
}
