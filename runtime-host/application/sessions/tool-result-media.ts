import { basename } from 'node:path';
import type { SessionRenderAttachedFile } from '../../shared/session-adapter-types';
import { isRecord, normalizeString } from './session-value-normalization';

const MEDIA_LINE_PATTERN = /^MEDIA:(.+)$/gm;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

export function extractToolResultMediaAttachments(input: {
  output?: unknown;
  outputText?: string;
}): SessionRenderAttachedFile[] {
  const refs = [
    ...readStructuredMediaRefs(input.output),
    ...readMediaProtocolRefs(input.outputText),
  ];
  return dedupeMediaRefs(refs).map(buildAttachedFileFromRef);
}

function readStructuredMediaRefs(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return [
    ...readStringArrayAtPath(value, ['media', 'mediaUrls']),
    ...readStringArrayAtPath(value, ['paths']),
  ];
}

function readStringArrayAtPath(value: Record<string, unknown>, path: string[]): string[] {
  let cursor: unknown = value;
  for (const key of path) {
    if (!isRecord(cursor)) {
      return [];
    }
    cursor = cursor[key];
  }
  if (!Array.isArray(cursor)) {
    return [];
  }
  return cursor.flatMap((item) => {
    const ref = normalizeString(item);
    return ref ? [ref] : [];
  });
}

function readMediaProtocolRefs(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = MEDIA_LINE_PATTERN.exec(text)) !== null) {
    const ref = normalizeString(match[1]);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

function dedupeMediaRefs(refs: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    result.push(ref);
  }
  return result;
}

function buildAttachedFileFromRef(ref: string): SessionRenderAttachedFile {
  const fileName = readFileName(ref);
  const file: SessionRenderAttachedFile = {
    fileName,
    mimeType: inferMimeType(fileName),
    fileSize: 0,
    preview: null,
    source: 'tool-result',
  };
  if (isGatewayUrl(ref)) {
    file.gatewayUrl = ref;
  } else {
    file.filePath = ref;
  }
  return file;
}

function readFileName(ref: string): string {
  try {
    const parsed = new URL(ref);
    const name = basename(parsed.pathname);
    return name || 'media';
  } catch {
    return basename(ref) || 'media';
  }
}

function inferMimeType(fileName: string): string {
  const extension = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    : '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

function isGatewayUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref) || ref.startsWith('/api/');
}
