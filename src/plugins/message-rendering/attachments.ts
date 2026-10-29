import type { SessionRenderAttachedFile } from '@/types/session/tool-card';
import { buildArtifactPreviewTargetFromAttachedFile, DIRECTORY_MIME_TYPE, type ArtifactPreviewTarget } from '@/plugins/files/types';

/** Metadata for chat attachments backed by a local file or Gateway media record. */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  previewStatus?: 'unavailable';
  attachmentStatus?: SessionRenderAttachedFile['attachmentStatus'];
  filePath?: string;
  gatewayUrl?: string;
  mediaReference?: string;
  source?: 'user-upload' | 'tool-result' | 'message-ref';
}

export function shouldKeepAssistantAttachmentVisible(
  file: AttachedFileMeta,
  supportsPreview: (file: ArtifactPreviewTarget) => boolean,
): boolean {
  if (file.mimeType.toLowerCase() === DIRECTORY_MIME_TYPE) return true;
  const target = buildArtifactPreviewTargetFromAttachedFile(file);
  return !!target && supportsPreview(target);
}
