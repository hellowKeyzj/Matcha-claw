import type { AttachedFileMeta } from '@/stores/chat';

const FILE_LINK_EXTENSIONS = 'md|txt|json|ya?ml|csv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|mp4|mov|avi|mkv|webm|mp3|wav|ogg|aac|zip|tar|gz|rar|7z';
const FILE_HINT_RE = new RegExp(
  String.raw`(^|[^\p{L}\p{N}_./\\-])((?:\.{1,2}[\\/])?[\p{L}\p{N}_./\\-]+?\.(?:${FILE_LINK_EXTENSIONS}))(?=$|[^\p{L}\p{N}_./\\-])`,
  'giu',
);
const MARKDOWN_LINK_SEGMENT_RE = /^!?\[[^\]\n]+\]\([^)]+\)$/u;
const FILE_PATH_WITH_EXT_RE = new RegExp(String.raw`\.(?:${FILE_LINK_EXTENSIONS})(?:$|[?#])`, 'iu');
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;
const LOCAL_RELATIVE_PATH_RE = /^\.{1,2}[\\/]/;

export type FileHintPathResolver = (displayPath: string) => string | undefined;

export function decodeMaybeEncodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function getFileNameFromPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0];
  const parts = withoutQuery.split(/[\\/]/);
  return parts[parts.length - 1] || withoutQuery;
}

function isAbsoluteLikePath(path: string): boolean {
  const normalized = path.trim();
  return (
    normalized.startsWith('/')
    || normalized.startsWith('~/')
    || normalized.startsWith('\\\\')
    || WINDOWS_ABSOLUTE_PATH_RE.test(normalized)
  );
}

function looksLikeAbsoluteFilePath(path: string): boolean {
  const normalized = decodeMaybeEncodedPath(path.trim());
  if (!isAbsoluteLikePath(normalized)) {
    return false;
  }
  return FILE_PATH_WITH_EXT_RE.test(normalized);
}

export function createFileHintPathResolver(
  attachedFiles: AttachedFileMeta[],
): FileHintPathResolver | undefined {
  const nameToAbsolutePaths = new Map<string, string[]>();
  const attachedAbsolutePaths = new Set<string>();

  const addAbsolutePath = (candidate?: string): void => {
    if (!candidate) {
      return;
    }
    const normalized = decodeMaybeEncodedPath(candidate.trim());
    if (!looksLikeAbsoluteFilePath(normalized)) {
      return;
    }
    attachedAbsolutePaths.add(normalized);
    const fileName = getFileNameFromPath(normalized).toLowerCase();
    if (!fileName) {
      return;
    }
    const existingPaths = nameToAbsolutePaths.get(fileName);
    if (!existingPaths) {
      nameToAbsolutePaths.set(fileName, [normalized]);
      return;
    }
    if (!existingPaths.includes(normalized)) {
      existingPaths.push(normalized);
    }
  };

  for (const file of attachedFiles) {
    addAbsolutePath(file.filePath);
  }

  if (nameToAbsolutePaths.size === 0) {
    return undefined;
  }

  return (displayPath: string): string | undefined => {
    const normalized = decodeMaybeEncodedPath(displayPath.trim());
    if (!normalized) {
      return undefined;
    }
    if (isAbsoluteLikePath(normalized)) {
      return attachedAbsolutePaths.has(normalized) ? normalized : undefined;
    }
    const fileName = getFileNameFromPath(normalized).toLowerCase();
    const candidates = nameToAbsolutePaths.get(fileName);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    return candidates[0];
  };
}

function shouldMigrateLegacyLocalMarkdownHref(rawHref: string): boolean {
  const href = rawHref.trim();
  if (!href || href.startsWith('#') || href.startsWith('filehint:')) {
    return false;
  }

  const decoded = decodeMaybeEncodedPath(href);
  if (/^(https?:\/\/|mailto:|tel:|data:|javascript:)/i.test(decoded)) {
    return false;
  }

  const isWindowsAbsolutePath = WINDOWS_ABSOLUTE_PATH_RE.test(decoded);
  if (URI_SCHEME_RE.test(decoded) && !isWindowsAbsolutePath) {
    return false;
  }

  if (
    isWindowsAbsolutePath
    || decoded.startsWith('\\\\')
    || decoded.startsWith('/')
    || decoded.startsWith('~/')
    || LOCAL_RELATIVE_PATH_RE.test(decoded)
  ) {
    return true;
  }

  return FILE_PATH_WITH_EXT_RE.test(decoded);
}

export function migrateLegacyMarkdownFileLinks(text: string, resolveFileHintPath?: FileHintPathResolver): string {
  if (!text) return text;
  const chunks = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return chunks.map((chunk) => {
    if (chunk.startsWith('```') || (chunk.startsWith('`') && chunk.endsWith('`'))) {
      return chunk;
    }
    return chunk.replace(/(!?\[[^\]\n]+\])\(([^)\n]+)\)/g, (full, label: string, href: string) => {
      if (!shouldMigrateLegacyLocalMarkdownHref(href)) {
        return full;
      }
      const normalized = decodeMaybeEncodedPath(href.trim());
      const resolvedPath = resolveFileHintPath?.(normalized);
      if (!resolvedPath || !looksLikeAbsoluteFilePath(resolvedPath)) {
        return normalized;
      }
      return `${label}(filehint:${encodeURIComponent(resolvedPath)})`;
    });
  }).join('');
}

export function linkifyFileHintsInMarkdown(text: string, resolveFileHintPath?: FileHintPathResolver): string {
  if (!text) return text;
  const chunks = text.split(/(```[\s\S]*?```|`[^`\n]*`|!?\[[^\]\n]+\]\([^)]+\))/g);
  return chunks.map((chunk) => {
    if (
      chunk.startsWith('```')
      || (chunk.startsWith('`') && chunk.endsWith('`'))
      || MARKDOWN_LINK_SEGMENT_RE.test(chunk)
    ) {
      return chunk;
    }
    return chunk.replace(FILE_HINT_RE, (full, prefix: string, path: string) => {
      if (!path || path.includes('://')) {
        return full;
      }
      const normalized = path.trim();
      const resolvedPath = resolveFileHintPath?.(normalized);
      if (!resolvedPath || !looksLikeAbsoluteFilePath(resolvedPath)) {
        return full;
      }
      return `${prefix}[${normalized}](filehint:${encodeURIComponent(resolvedPath)})`;
    });
  }).join('');
}
