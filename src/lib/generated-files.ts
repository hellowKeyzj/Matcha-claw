import type { SessionRenderToolCard } from '../../runtime-host/shared/session-adapter-types';

export type FileContentType =
  | 'code'
  | 'text'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'sheet'
  | 'document'
  | 'archive'
  | 'audio'
  | 'video'
  | 'binary';

export interface GeneratedFileLineStats {
  added: number;
  removed: number;
}

export interface GeneratedFile {
  filePath: string;
  fileName: string;
  ext: string;
  mimeType: string;
  contentType: FileContentType;
  sourceTool: 'write' | 'edit';
  action: 'created' | 'modified';
  baseline: string;
  content: string;
  lineStats: GeneratedFileLineStats;
  toolCallId?: string;
  toolId: string;
}

interface FileMutationPayload {
  filePath: string;
  sourceTool: GeneratedFile['sourceTool'];
  baseline: string;
  content: string;
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.avif',
]);

const MARKDOWN_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
]);

const SHEET_EXTENSIONS = new Set([
  '.csv',
  '.xls',
  '.xlsx',
]);

const PDF_EXTENSIONS = new Set([
  '.pdf',
]);

const ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.7z',
  '.rar',
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.m4v',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.php',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.vue',
  '.svelte',
  '.dockerfile',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
]);

const DOCUMENT_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
]);

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function getTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolveFilePath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'filePath', 'path', 'file']) {
    const resolved = getTrimmedString(input[key]);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function countChangedLines(text: string): number {
  if (!text) {
    return 0;
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length;
}

function buildLineStats(baseline: string, content: string): GeneratedFileLineStats {
  return {
    added: countChangedLines(content),
    removed: countChangedLines(baseline),
  };
}

function extractFileMutation(input: SessionRenderToolCard): FileMutationPayload | null {
  const args = asRecord(input.input);
  if (!args) {
    return null;
  }

  const normalizedName = input.name.trim().toLowerCase();
  if (normalizedName === 'write') {
    const filePath = resolveFilePath(args);
    const content = getString(args.content) ?? '';
    if (!filePath) {
      return null;
    }
    return {
      filePath,
      sourceTool: 'write',
      baseline: '',
      content,
    };
  }

  if (normalizedName === 'edit') {
    const filePath = resolveFilePath(args);
    const baseline = typeof args.old_string === 'string' ? args.old_string : '';
    const content = typeof args.new_string === 'string' ? args.new_string : '';
    if (!filePath) {
      return null;
    }
    return {
      filePath,
      sourceTool: 'edit',
      baseline,
      content,
    };
  }

  return null;
}

export function extnameOf(filePath: string): string {
  if (!filePath) {
    return '';
  }
  const normalizedPath = filePath.replace(/\\/g, '/');
  const lowerPath = normalizedPath.toLowerCase();
  if (lowerPath.endsWith('/dockerfile') || lowerPath === 'dockerfile') {
    return '.dockerfile';
  }
  const slashIndex = lowerPath.lastIndexOf('/');
  const fileName = slashIndex >= 0 ? lowerPath.slice(slashIndex + 1) : lowerPath;
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex) : '';
}

function basenameOf(filePath: string): string {
  if (!filePath) {
    return '';
  }
  const normalizedPath = filePath.replace(/\\/g, '/');
  const slashIndex = normalizedPath.lastIndexOf('/');
  return slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
}

export function getMimeTypeForExt(ext: string): string {
  return EXTENSION_MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function getMimeTypeForPath(filePath: string): string {
  return getMimeTypeForExt(extnameOf(filePath));
}

export function classifyFileContentType(ext: string, mimeType: string): FileContentType {
  const normalizedExt = ext.toLowerCase();
  const normalizedMime = mimeType.toLowerCase();

  if (IMAGE_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('image/')) {
    return 'image';
  }
  if (PDF_EXTENSIONS.has(normalizedExt) || normalizedMime === 'application/pdf') {
    return 'pdf';
  }
  if (SHEET_EXTENSIONS.has(normalizedExt)) {
    return 'sheet';
  }
  if (MARKDOWN_EXTENSIONS.has(normalizedExt)) {
    return 'markdown';
  }
  if (CODE_EXTENSIONS.has(normalizedExt)) {
    return 'code';
  }
  if (TEXT_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('text/')) {
    return 'text';
  }
  if (ARCHIVE_EXTENSIONS.has(normalizedExt) || normalizedMime.includes('zip') || normalizedMime.includes('compressed')) {
    return 'archive';
  }
  if (AUDIO_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('audio/')) {
    return 'audio';
  }
  if (VIDEO_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('video/')) {
    return 'video';
  }
  if (DOCUMENT_EXTENSIONS.has(normalizedExt)) {
    return 'document';
  }
  return 'binary';
}

export function supportsInlineDiff(
  file: Pick<GeneratedFile, 'contentType'> & Partial<Pick<GeneratedFile, 'ext' | 'baseline' | 'content'>>,
): boolean {
  if (typeof file.baseline !== 'string' || typeof file.content !== 'string') {
    return false;
  }
  if (file.contentType === 'sheet') {
    return file.ext === '.csv';
  }
  return file.contentType === 'code'
    || file.contentType === 'text'
    || file.contentType === 'markdown';
}

export function supportsInlineDocumentPreview(ext: string): boolean {
  const contentType = classifyFileContentType(ext, getMimeTypeForExt(ext));
  return contentType === 'code'
    || contentType === 'text'
    || contentType === 'markdown'
    || contentType === 'image'
    || contentType === 'pdf'
    || contentType === 'sheet';
}

export function extractGeneratedFilesFromToolCards(
  tools: ReadonlyArray<SessionRenderToolCard>,
): GeneratedFile[] {
  const filesByPath = new Map<string, GeneratedFile>();

  for (const tool of tools) {
    const mutation = extractFileMutation(tool);
    if (!mutation) {
      continue;
    }
    const ext = extnameOf(mutation.filePath);
    const mimeType = getMimeTypeForExt(ext);
    const contentType = classifyFileContentType(ext, mimeType);
    filesByPath.set(mutation.filePath, {
      filePath: mutation.filePath,
      fileName: basenameOf(mutation.filePath),
      ext,
      mimeType,
      contentType,
      sourceTool: mutation.sourceTool,
      action: mutation.sourceTool === 'write' ? 'created' : 'modified',
      baseline: mutation.baseline,
      content: mutation.content,
      lineStats: buildLineStats(mutation.baseline, mutation.content),
      ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
      toolId: tool.id,
    });
  }

  return [...filesByPath.values()];
}
