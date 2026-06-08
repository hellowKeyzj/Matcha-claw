import type { AttachedFileMeta } from '@/stores/chat';
import type { SessionIdentity } from '../../../runtime-host/shared/runtime-address';
import {
  classifyFileContentType,
  extnameOf,
  getMimeTypeForPath,
  type FileContentType,
  type GeneratedFile,
  type GeneratedFileLineStats,
} from '@/lib/generated-files';

export const DIRECTORY_MIME_TYPE = 'application/x-directory';

export interface ArtifactPreviewTarget {
  filePath: string;
  fileName: string;
  ext: string;
  mimeType: string;
  contentType: FileContentType;
  isDirectory?: boolean;
  fileSize?: number;
  sourceTool?: GeneratedFile['sourceTool'];
  action?: GeneratedFile['action'];
  baseline?: string;
  content?: string;
  lineStats?: GeneratedFileLineStats;
  toolId?: string;
  sessionIdentity?: SessionIdentity;
  workspaceId?: string;
  sourceId?: string;
}

export function buildArtifactPreviewTargetFromGeneratedFile(file: GeneratedFile): ArtifactPreviewTarget {
  return {
    filePath: file.filePath,
    fileName: file.fileName,
    ext: file.ext,
    mimeType: file.mimeType,
    contentType: file.contentType,
    sourceTool: file.sourceTool,
    action: file.action,
    baseline: file.baseline,
    content: file.content,
    lineStats: file.lineStats,
    toolId: file.toolId,
  };
}

export function buildArtifactPreviewTargetFromAttachedFile(file: AttachedFileMeta): ArtifactPreviewTarget | null {
  if (!file.filePath) {
    return null;
  }
  const isDirectory = file.mimeType === DIRECTORY_MIME_TYPE;
  const ext = extnameOf(file.filePath);
  const mimeType = isDirectory ? DIRECTORY_MIME_TYPE : (file.mimeType || getMimeTypeForPath(file.filePath));
  return {
    filePath: file.filePath,
    fileName: file.fileName || file.filePath.split(/[\\/]/).pop() || 'file',
    ext,
    mimeType,
    contentType: isDirectory ? 'binary' : classifyFileContentType(ext, mimeType),
    isDirectory,
    fileSize: file.fileSize > 0 ? file.fileSize : undefined,
  };
}

export function buildArtifactPreviewTargetFromPath(filePath: string): ArtifactPreviewTarget {
  const ext = extnameOf(filePath);
  const mimeType = getMimeTypeForPath(filePath);
  return {
    filePath,
    fileName: filePath.split(/[\\/]/).pop() || filePath,
    ext,
    mimeType,
    contentType: classifyFileContentType(ext, mimeType),
  };
}
