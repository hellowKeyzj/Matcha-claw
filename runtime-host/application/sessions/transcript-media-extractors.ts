import type { SessionRenderAttachedFile } from '../../shared/session-adapter-types';
import type {
  ContentBlockLike,
  SessionTranscriptMessage,
} from './transcript-types';

export function readAttachedFiles(message: SessionTranscriptMessage): SessionRenderAttachedFile[] {
  const attachedFiles = message._attachedFiles;
  if (!Array.isArray(attachedFiles)) {
    return [];
  }
  return attachedFiles.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const fileName = typeof row.fileName === 'string' ? row.fileName : 'file';
    const mimeType = typeof row.mimeType === 'string' ? row.mimeType : 'application/octet-stream';
    const fileSize = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize) ? row.fileSize : 0;
    const preview = typeof row.preview === 'string' ? row.preview : null;
    const filePath = typeof row.filePath === 'string' && row.filePath.trim() ? row.filePath : undefined;
    const gatewayUrl = typeof row.gatewayUrl === 'string' && row.gatewayUrl.trim() ? row.gatewayUrl.trim() : undefined;
    const source = row.source === 'user-upload' || row.source === 'tool-result' || row.source === 'message-ref'
      ? row.source
      : undefined;
    return [{
      fileName,
      mimeType,
      fileSize,
      preview,
      ...(source ? { source } : {}),
      ...(filePath ? { filePath } : {}),
      ...(gatewayUrl ? { gatewayUrl } : {}),
    }];
  });
}

export function readMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

export function extractImagesAsAttachedFiles(
  content: unknown,
  source: SessionRenderAttachedFile['source'] = 'message-ref',
): SessionRenderAttachedFile[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const files: SessionRenderAttachedFile[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'image') {
      if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
        files.push({
          fileName: 'image',
          mimeType: block.source.media_type,
          fileSize: 0,
          preview: `data:${block.source.media_type};base64,${block.source.data}`,
          source,
        });
      } else if (block.source?.type === 'url' && typeof block.source.url === 'string') {
        files.push({
          fileName: 'image',
          mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
          fileSize: 0,
          preview: block.source.url,
          source,
        });
      } else if (typeof block.data === 'string') {
        const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
          source,
        });
      } else if (typeof block.url === 'string' && block.url.trim()) {
        files.push({
          fileName: typeof block.alt === 'string' && block.alt.trim() ? block.alt.trim() : 'image',
          mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
          fileSize: 0,
          preview: null,
          gatewayUrl: block.url.trim(),
          source: 'tool-result',
        });
      }
    }
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content !== undefined) {
      files.push(...extractImagesAsAttachedFiles(block.content, 'tool-result'));
    }
  }
  return files;
}

export function mergeAttachedFiles(
  existingFiles: ReadonlyArray<SessionRenderAttachedFile>,
  incomingFiles: ReadonlyArray<SessionRenderAttachedFile>,
): SessionRenderAttachedFile[] {
  const merged = existingFiles.map((file) => ({ ...file }));
  for (const file of incomingFiles) {
    const exists = merged.some((candidate) => (
      candidate.fileName === file.fileName
      && candidate.mimeType === file.mimeType
      && candidate.fileSize === file.fileSize
      && (candidate.preview ?? null) === (file.preview ?? null)
      && (candidate.filePath ?? null) === (file.filePath ?? null)
      && (candidate.source ?? null) === (file.source ?? null)
    ));
    if (!exists) {
      merged.push({ ...file });
    }
  }
  return merged;
}
