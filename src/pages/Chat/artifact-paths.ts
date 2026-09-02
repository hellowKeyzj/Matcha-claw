import type { AttachedFileMeta } from '@/stores/chat';
import { DIRECTORY_MIME_TYPE } from '@/components/file-preview/types';
import { fileNameFromMediaReference, isOpenClawGatewayMediaReference } from '@/stores/chat/media-projection';

function previewMimeFromPath(filePath: string): string | null {
  const lower = (filePath.split(/[?#]/, 1)[0] || filePath).toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) return 'text/markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.ts')) return 'text/typescript';
  if (lower.endsWith('.tsx')) return 'text/typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'text/javascript';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  return null;
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || 'file';
}

function trimPathTerminators(filePath: string): string {
  return filePath.replace(/[，。；;,.!?）)\]}]+$/u, '');
}

function buildAttachedPathRef(filePath: string, mimeType: string): AttachedFileMeta {
  const normalizedPath = trimPathTerminators(filePath);
  return {
    fileName: fileNameFromPath(normalizedPath),
    mimeType,
    fileSize: 0,
    preview: null,
    filePath: normalizedPath,
    source: 'message-ref',
  };
}

function buildAttachedGatewayRef(gatewayUrl: string, mimeType: string): AttachedFileMeta {
  return {
    fileName: fileNameFromMediaReference(gatewayUrl),
    mimeType,
    fileSize: 0,
    preview: null,
    gatewayUrl,
    source: 'message-ref',
  };
}

export function extractArtifactRefsFromAssistantText(text: string): AttachedFileMeta[] {
  if (!text) {
    return [];
  }

  const refs: AttachedFileMeta[] = [];
  const seen = new Set<string>();
  const pushRef = (filePath: string, mimeType: string) => {
    const normalizedPath = trimPathTerminators(filePath);
    if (!normalizedPath || seen.has(normalizedPath)) {
      return;
    }
    seen.add(normalizedPath);
    refs.push(buildAttachedPathRef(normalizedPath, mimeType));
  };
  const pushGatewayRef = (gatewayUrl: string, mimeType: string) => {
    if (!gatewayUrl || seen.has(gatewayUrl)) {
      return;
    }
    seen.add(gatewayUrl);
    refs.push(buildAttachedGatewayRef(gatewayUrl, mimeType));
  };

  const exts = 'html?|pdf|xlsx?|csv|md|mdx|png|jpe?g|gif|webp|svg|bmp|ts|tsx|js|jsx|json|txt|log|HTML?|PDF|XLSX?|CSV|MD|MDX|PNG|JPE?G|GIF|WEBP|SVG|BMP|TSX?|JSX?|JSON|TXT|LOG';
  const taggedGatewayRegex = /(?<![A-Za-z0-9/\\])(?:MEDIA|media):((?:https?:\/\/|\/api\/chat\/media\/outgoing\/)[^\s\n"'()[\],<>]+)/g;
  const taggedRegex = new RegExp(`(?<![A-Za-z0-9/\\\\])(?:MEDIA|media):((?:\\/|~\\/|[A-Za-z]:\\\\)[^\\n"'()\\[\\],<>]*?\\.(?:${exts}))(?=$|[\\s\\n"'()\\[\\],<>]|[，。；;,.!?])`, 'g');
  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\`\\[\\],<>]*?\\.(?:${exts}))`, 'g');
  const windowsRegex = new RegExp(`(?<![\\w/])([A-Za-z]:\\\\[^\\s\\n"'()\`\\[\\],<>]*?\\.(?:${exts}))`, 'g');
  const skillPathBoundary = '(?=$|\\s|[\\x5b\\x5d"\'`()<>，。；;,.!?])';
  const skillPathPart = '[^\\\\/\\s\\n"\'`()\\x5b\\x5d,<>]+';
  const skillPathTail = '[^\\s\\n"\'`()\\x5b\\x5d,<>]*?';
  const skillDirRegex = new RegExp(
    `(?<![\\w./:])((?:~[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart})|(?:(?:\\/|[A-Za-z]:\\\\)${skillPathTail}[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart}))${skillPathBoundary}`,
    'gi',
  );
  const skillMarkdownRegex = new RegExp(
    `(?<![\\w./:])((?:~[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathTail}\\.md)|(?:(?:\\/|[A-Za-z]:\\\\)${skillPathTail}[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathTail}\\.md))${skillPathBoundary}`,
    'gi',
  );

  let workingText = text;
  const markdownImageRegex = /!\[[^\]\n]*\]\(([^)\s]+)\)/g;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownImageRegex.exec(text)) !== null) {
    const reference = markdownMatch[1];
    if (isOpenClawGatewayMediaReference(reference)) {
      pushGatewayRef(reference, previewMimeFromPath(reference) ?? 'image/png');
    } else if (reference.startsWith('/') || reference.startsWith('~/') || /^[A-Za-z]:\\/.test(reference)) {
      const mimeType = previewMimeFromPath(reference);
      if (mimeType) {
        pushRef(reference, mimeType);
      }
    }
    const start = markdownMatch.index;
    const end = start + markdownMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }

  let taggedGatewayMatch: RegExpExecArray | null;
  while ((taggedGatewayMatch = taggedGatewayRegex.exec(text)) !== null) {
    const reference = trimPathTerminators(taggedGatewayMatch[1]);
    if (isOpenClawGatewayMediaReference(reference)) {
      pushGatewayRef(reference, previewMimeFromPath(reference) ?? 'image/png');
    }
    const start = taggedGatewayMatch.index;
    const end = start + taggedGatewayMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }

  let taggedMatch: RegExpExecArray | null;
  while ((taggedMatch = taggedRegex.exec(workingText)) !== null) {
    const filePath = taggedMatch[1];
    const mimeType = previewMimeFromPath(filePath);
    if (mimeType) {
      pushRef(filePath, mimeType);
    }
    const start = taggedMatch.index;
    const end = start + taggedMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }

  for (const regex of [unixRegex, windowsRegex, skillMarkdownRegex, skillDirRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(workingText)) !== null) {
      const filePath = match[1];
      const mimeType = regex === skillDirRegex ? DIRECTORY_MIME_TYPE : previewMimeFromPath(filePath);
      if (mimeType) {
        pushRef(filePath, mimeType);
      }
    }
  }

  return refs;
}

export function shouldKeepAssistantAttachmentVisible(file: AttachedFileMeta): boolean {
  const mime = file.mimeType.toLowerCase();
  if (mime === DIRECTORY_MIME_TYPE) {
    return true;
  }
  return mime === 'application/pdf'
    || mime === 'application/vnd.ms-excel'
    || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || mime === 'text/markdown'
    || mime === 'text/html'
    || mime === 'text/csv'
    || mime.startsWith('image/');
}
