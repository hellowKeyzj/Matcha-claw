import { useMemo } from 'react';
import type { AttachedFileMeta } from '@/plugins/chat/store';
import { buildArtifactPreviewTargetFromAttachedFile, buildArtifactPreviewTargetFromPath, DIRECTORY_MIME_TYPE, type ArtifactPreviewTarget } from '@/plugins/files/types';
import { builtinFileFormats, type FileFormatContribution } from '@/plugins/files/file-types';
import { builtinFileReaders } from '@/plugins/files/plugin';
import { fileFormats, fileReaders, findFileReader, type FileReaderContribution } from '@/plugins/files/extensions';
import { useContributions } from '@/plugin-host/react';
import { fileNameFromMediaReference, isOpenClawGatewayMediaReference } from '@/plugins/chat/store/media-projection';

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

function createArtifactRefExtractor(formats: readonly FileFormatContribution[], readers: readonly FileReaderContribution[]) {
  const exts = [...new Set(formats.flatMap((format) => format.extensions))]
    .sort((left, right) => right.length - left.length)
    .map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') || '(?!)';
  const taggedGatewayRegex = /(?<![A-Za-z0-9/\\])(?:MEDIA|media):((?:https?:\/\/|\/api\/chat\/media\/outgoing\/)[^\s\n"'()[\],<>]+)/g;
  const taggedRegex = new RegExp(`(?<![A-Za-z0-9/\\\\])(?:MEDIA|media):((?:\\/|~\\/|[A-Za-z]:\\\\)[^\\n"'()\\[\\],<>]*?(?:${exts}))(?=$|[\\s\\n"'()\\[\\],<>]|[，。；;,.!?])`, 'gi');
  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\`\\[\\],<>]*?(?:${exts}))`, 'gi');
  const windowsRegex = new RegExp(`(?<![\\w/])([A-Za-z]:\\\\[^\\s\\n"'()\`\\[\\],<>]*?(?:${exts}))`, 'gi');
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
  const markdownImageRegex = /!\[[^\]\n]*\]\(([^)\s]+)\)/g;
  const pathRegexes = [unixRegex, windowsRegex, skillMarkdownRegex, skillDirRegex];
  const regexes = [markdownImageRegex, taggedGatewayRegex, taggedRegex, ...pathRegexes];
  const previewMimeFromPath = (filePath: string): string | null => {
    const path = filePath.split(/[?#]/, 1)[0] || filePath;
    const target = buildArtifactPreviewTargetFromPath(path, formats);
    return findFileReader(readers, target, 'preview') ? target.mimeType : null;
  };

  return (text: string): AttachedFileMeta[] => {
    if (!text) return [];
    for (const regex of regexes) regex.lastIndex = 0;
    const refs: AttachedFileMeta[] = [];
    const seen = new Set<string>();
    const pushRef = (filePath: string, mimeType: string) => {
      const normalizedPath = trimPathTerminators(filePath);
      if (!normalizedPath || seen.has(normalizedPath)) return;
      seen.add(normalizedPath);
      refs.push(buildAttachedPathRef(normalizedPath, mimeType));
    };
    const pushGatewayRef = (gatewayUrl: string, mimeType: string) => {
      if (!gatewayUrl || seen.has(gatewayUrl)) return;
      seen.add(gatewayUrl);
      refs.push(buildAttachedGatewayRef(gatewayUrl, mimeType));
    };

    let workingText = text;
    let markdownMatch: RegExpExecArray | null;
    while ((markdownMatch = markdownImageRegex.exec(text)) !== null) {
      const reference = markdownMatch[1];
      if (isOpenClawGatewayMediaReference(reference)) {
        pushGatewayRef(reference, previewMimeFromPath(reference) ?? 'image/png');
      } else if (reference.startsWith('/') || reference.startsWith('~/') || /^[A-Za-z]:\\/.test(reference)) {
        const mimeType = previewMimeFromPath(reference);
        if (mimeType) pushRef(reference, mimeType);
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
      if (mimeType) pushRef(filePath, mimeType);
      const start = taggedMatch.index;
      const end = start + taggedMatch[0].length;
      workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
    }

    for (const regex of pathRegexes) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(workingText)) !== null) {
        const filePath = match[1];
        const mimeType = regex === skillDirRegex ? DIRECTORY_MIME_TYPE : previewMimeFromPath(filePath);
        if (mimeType) pushRef(filePath, mimeType);
      }
    }
    return refs;
  };
}

const extractBuiltinArtifactRefs = createArtifactRefExtractor(builtinFileFormats, builtinFileReaders);

export function extractArtifactRefsFromAssistantText(
  text: string,
  formats: readonly FileFormatContribution[] = builtinFileFormats,
  readers: readonly FileReaderContribution[] = builtinFileReaders,
): AttachedFileMeta[] {
  return (formats === builtinFileFormats && readers === builtinFileReaders
    ? extractBuiltinArtifactRefs
    : createArtifactRefExtractor(formats, readers))(text);
}

export function useArtifactRefExtractor(): (text: string) => AttachedFileMeta[] {
  const formats = useContributions(fileFormats);
  const readers = useContributions(fileReaders);
  return useMemo(() => createArtifactRefExtractor(formats, readers), [formats, readers]);
}

export function shouldKeepAssistantAttachmentVisible(
  file: AttachedFileMeta,
  supportsPreview: (file: ArtifactPreviewTarget) => boolean,
): boolean {
  if (file.mimeType.toLowerCase() === DIRECTORY_MIME_TYPE) return true;
  const target = buildArtifactPreviewTargetFromAttachedFile(file);
  return !!target && supportsPreview(target);
}
