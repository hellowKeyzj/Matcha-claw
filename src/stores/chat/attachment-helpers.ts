import { hostApiFetch } from '@/lib/host-api';
import { throwIfHistoryLoadAborted } from './history-abort';
import type { AttachedFileMeta, ChatSendAttachment } from './types';
import type {
  SessionMessageRow,
  SessionRenderAttachedFile,
  SessionRenderRow,
} from '../../../runtime-host/shared/session-adapter-types';

const IMAGE_CACHE_KEY = 'clawx:image-cache';
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
    ...(file.filePath ? { filePath: file.filePath } : {}),
  }));
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
  };
}

function mergeRowAttachedFiles(row: SessionMessageRow): AttachedFileMeta[] {
  const merged = normalizeAttachedFiles(row.attachedFiles);
  if (row.role !== 'user') {
    return merged;
  }
  const existingPaths = new Set(merged.map((file) => file.filePath).filter(Boolean));
  for (const ref of extractMediaRefs(row.text)) {
    if (existingPaths.has(ref.filePath)) {
      continue;
    }
    merged.push(buildAttachedFileFromRef(ref));
    existingPaths.add(ref.filePath);
  }
  return merged;
}

function hydrateMessageRowFromCache(row: SessionMessageRow): SessionMessageRow {
  const attachedFiles = mergeRowAttachedFiles(row);
  let changed = attachedFiles.length !== row.attachedFiles.length;
  const nextFiles = attachedFiles.map((file) => {
    const filePath = file.filePath;
    if (!filePath) {
      return file;
    }
    const cached = imageCache.get(filePath);
    if (!cached) {
      return file;
    }
    const nextFile = {
      ...file,
      preview: file.preview ?? cached.preview ?? null,
      fileSize: file.fileSize > 0 ? file.fileSize : (cached.fileSize ?? 0),
      fileName: file.fileName || cached.fileName,
      mimeType: file.mimeType || cached.mimeType,
    } satisfies AttachedFileMeta;
    if (
      nextFile.preview !== file.preview
      || nextFile.fileSize !== file.fileSize
      || nextFile.fileName !== file.fileName
      || nextFile.mimeType !== file.mimeType
    ) {
      changed = true;
    }
    return nextFile;
  });
  if (!changed) {
    return row;
  }
  return {
    ...row,
    attachedFiles: nextFiles,
  };
}

export function hydrateAttachedFilesFromRows(rows: SessionRenderRow[]): SessionRenderRow[] {
  let changed = false;
  const nextRows = rows.map((row) => {
    if (row.kind !== 'message') {
      return row;
    }
    const nextRow = hydrateMessageRowFromCache(row);
    if (nextRow !== row) {
      changed = true;
    }
    return nextRow;
  });
  return changed ? nextRows : rows;
}

export function hasPendingRowPreviewLoads(rows: SessionRenderRow[]): boolean {
  return rows.some((row) => {
    if (row.kind !== 'message') {
      return false;
    }
    return mergeRowAttachedFiles(row).some((file) => {
      if (!file.filePath) {
        return false;
      }
      return file.mimeType.startsWith('image/')
        ? !file.preview
        : file.fileSize === 0;
    });
  });
}

export async function loadMissingRowPreviews(
  rows: SessionRenderRow[],
  abortSignal?: AbortSignal,
): Promise<SessionRenderRow[] | null> {
  if (abortSignal) {
    throwIfHistoryLoadAborted(abortSignal);
  }
  const normalizedRows = hydrateAttachedFilesFromRows(rows);
  const needPreview: Array<{ filePath: string; mimeType: string }> = [];
  const seenPaths = new Set<string>();

  for (const row of normalizedRows) {
    if (row.kind !== 'message') {
      continue;
    }
    for (const file of mergeRowAttachedFiles(row)) {
      const filePath = file.filePath;
      if (!filePath || seenPaths.has(filePath)) {
        continue;
      }
      const needsLoad = file.mimeType.startsWith('image/')
        ? !file.preview
        : file.fileSize === 0;
      if (!needsLoad) {
        continue;
      }
      seenPaths.add(filePath);
      needPreview.push({ filePath, mimeType: file.mimeType });
    }
  }

  if (needPreview.length === 0) {
    return normalizedRows === rows ? null : normalizedRows;
  }

  try {
    const thumbnails = await hostApiFetch<Record<string, { preview: string | null; fileSize: number }>>(
      '/api/files/thumbnails',
      {
        method: 'POST',
        body: JSON.stringify({ paths: needPreview }),
      },
    );

    let changed = normalizedRows !== rows;
    const nextRows = normalizedRows.map((row) => {
      if (row.kind !== 'message') {
        return row;
      }
      const attachedFiles = mergeRowAttachedFiles(row);
      let rowChanged = attachedFiles.length !== row.attachedFiles.length;
      const nextFiles = attachedFiles.map((file) => {
        const filePath = file.filePath;
        if (!filePath) {
          return file;
        }
        const thumb = thumbnails[filePath];
        if (!thumb || (!thumb.preview && !thumb.fileSize)) {
          return file;
        }
        const nextFile = {
          ...file,
          preview: thumb.preview ?? file.preview ?? null,
          fileSize: thumb.fileSize || file.fileSize,
        } satisfies AttachedFileMeta;
        if (nextFile.preview !== file.preview || nextFile.fileSize !== file.fileSize) {
          rowChanged = true;
          imageCache.set(filePath, { ...nextFile });
        }
        return nextFile;
      });
      if (!rowChanged) {
        return row;
      }
      changed = true;
      return {
        ...row,
        attachedFiles: nextFiles,
      };
    });

    if (changed) {
      saveImageCache(imageCache);
      return nextRows;
    }
    return null;
  } catch {
    return normalizedRows === rows ? null : normalizedRows;
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
