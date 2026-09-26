import type { AttachedFileMeta } from '@/stores/chat';
import type {
  SessionIdentity,
} from '../../types/desktop/runtime-address';
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
  relativePath?: string;
}

function normalizeWorkspacePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function trimWorkspaceRootTrailingSeparators(value: string): string {
  if (/^[A-Za-z]:\/+$/u.test(value)) {
    return `${value.slice(0, 2)}/`;
  }
  if (/^\/+$/u.test(value)) {
    return '/';
  }
  return value.replace(/\/+$/u, '');
}

type ParsedWorkspacePath = {
  kind: 'drive' | 'posix' | 'unc' | 'relative';
  segments: string[];
  normalized: string;
};

function parseWorkspacePath(value: string, trimTrailingSeparators = false): ParsedWorkspacePath | null {
  if (value.includes('\0')) {
    return null;
  }

  const source = normalizeWorkspacePathSeparators(value);
  const normalized = trimTrailingSeparators ? trimWorkspaceRootTrailingSeparators(source) : source;
  if (normalized.includes(':') && !/^[A-Za-z]:\//u.test(normalized)) {
    return null;
  }

  let kind: ParsedWorkspacePath['kind'] = 'relative';
  let remainder = normalized;
  if (/^[A-Za-z]:\//u.test(normalized)) {
    kind = 'drive';
    remainder = normalized.slice(3);
  } else if (normalized.startsWith('//')) {
    kind = 'unc';
    remainder = normalized.slice(2);
  } else if (normalized.startsWith('/')) {
    kind = 'posix';
    remainder = normalized.slice(1);
  } else if (/^[A-Za-z]:/u.test(normalized)) {
    return null;
  }

  if (remainder.length === 0) {
    return { kind, segments: [], normalized };
  }
  const segments = remainder.split('/');
  if (segments.some((segment) => (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.includes(':')
  ))) {
    return null;
  }
  return { kind, segments, normalized };
}

function workspacePathSegmentsEqual(left: string[], right: string[], caseInsensitive: boolean): boolean {
  return left.length === right.length
    && left.every((segment, index) => caseInsensitive
      ? segment.toLowerCase() === right[index]?.toLowerCase()
      : segment === right[index]);
}

/** Resolve a display path to a safe workspace-relative transport path. */
export function resolveWorkspaceRelativePath(
  displayPath: string,
  workspaceRoot?: string,
): string | null {
  const candidate = parseWorkspacePath(displayPath);
  if (!candidate) {
    return null;
  }
  if (candidate.kind === 'relative') {
    return candidate.normalized;
  }
  if (!workspaceRoot) {
    return null;
  }

  const root = parseWorkspacePath(workspaceRoot, true);
  if (!root || root.kind !== candidate.kind) {
    return null;
  }
  const caseInsensitive = root.kind === 'drive' || root.kind === 'unc';
  if (candidate.segments.length < root.segments.length) {
    return null;
  }
  if (!workspacePathSegmentsEqual(
    root.segments,
    candidate.segments.slice(0, root.segments.length),
    caseInsensitive,
  )) {
    return null;
  }
  return candidate.segments.slice(root.segments.length).join('/');
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
