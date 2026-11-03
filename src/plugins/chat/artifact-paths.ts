import { useMemo } from 'react';
import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import { buildArtifactPreviewTargetFromPath, DIRECTORY_MIME_TYPE } from '@/plugins/files/types';
import { builtinFileFormats, type FileFormatContribution } from '@/plugins/files/file-types';
import { fileFormats } from '@/plugins/files/extensions';
import { useContributions } from '@/plugin-host/react';
import { fileNameFromMediaReference, isOpenClawGatewayMediaReference } from '@/plugins/chat/store/media-projection';
import { localPathFromMarkdownHref, mapMarkdownLinks, mapMediaDirectives } from '@/plugins/message-rendering/md-link';

function fileNameFromPath(filePath: string): string {
  return filePath.replace(/[\\/]+$/u, '').split(/[\\/]/).pop() || filePath;
}

function trimPathTerminators(filePath: string): string {
  return filePath.replace(/[，。；;,.!?）)\]}]+$/u, '');
}

function buildAttachedPathRef(filePath: string, mimeType: string): AttachedFileMeta {
  return {
    fileName: fileNameFromPath(filePath),
    mimeType,
    fileSize: 0,
    preview: null,
    filePath,
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

function createArtifactRefExtractor(formats: readonly FileFormatContribution[]) {
  const unixRegex = /(?<![\p{L}\p{N}\p{M}_./:\\~])((?:\/(?!\/)|~[\\/])[^\s\n"'()`[\],<>，。；！？：、（）]+)/gu;
  const windowsRegex = /(?<![\p{L}\p{N}\p{M}_/\\])((?:[A-Za-z]:[\\/]|\\\\)[^\s\n"'()`[\],<>，。；！？：、（）]+)/gu;
  const pathRegexes = [unixRegex, windowsRegex];
  const mimeFromPath = (filePath: string, fallback = 'application/octet-stream'): string => {
    if (/[\\/]$/u.test(filePath)) return DIRECTORY_MIME_TYPE;
    const path = filePath.split(/[?#]/, 1)[0] || filePath;
    const { mimeType } = buildArtifactPreviewTargetFromPath(path, formats);
    return mimeType === 'application/octet-stream' ? fallback : mimeType;
  };

  return (text: string): AttachedFileMeta[] => {
    if (!text) return [];
    for (const regex of pathRegexes) regex.lastIndex = 0;
    const refs: AttachedFileMeta[] = [];
    const seen = new Set<string>();
    const pushRef = (filePath: string) => {
      if (!filePath || seen.has(filePath)) return;
      seen.add(filePath);
      refs.push(buildAttachedPathRef(filePath, mimeFromPath(filePath)));
    };
    const pushGatewayRef = (gatewayUrl: string) => {
      if (!gatewayUrl || seen.has(gatewayUrl)) return;
      seen.add(gatewayUrl);
      refs.push(buildAttachedGatewayRef(gatewayUrl, mimeFromPath(gatewayUrl, 'image/png')));
    };

    const workingText = mapMarkdownLinks(text, (full, label, reference) => {
      const localPath = localPathFromMarkdownHref(reference);
      if (label.startsWith('!') && reference.startsWith('/api/') && isOpenClawGatewayMediaReference(reference)) {
        pushGatewayRef(reference);
      } else if (localPath !== undefined) {
        pushRef(localPath);
      }
      return ' '.repeat(full.length);
    }, (code, kind) => {
      const inlinePath = kind === 'code_inline' ? /^(`+)([^`\n]+)\1$/u.exec(code)?.[2] : undefined;
      if (inlinePath && /^(?:\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|\\\\)[^\s]+$/u.test(inlinePath)
        && /[^\\/]/u.test(inlinePath.replace(/^(?:[A-Za-z]:|~)/u, ''))) pushRef(inlinePath);
      return ' '.repeat(code.length);
    }, (chunk) => mapMediaDirectives(chunk, (reference) => {
      if (isOpenClawGatewayMediaReference(reference)) pushGatewayRef(reference);
      else if (!/^https?:\/\//i.test(reference)) pushRef(reference);
      return ' '.repeat(reference.length);
    }));

    for (const regex of pathRegexes) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(workingText)) !== null) pushRef(trimPathTerminators(match[1]));
    }
    return refs;
  };
}

const extractBuiltinArtifactRefs = createArtifactRefExtractor(builtinFileFormats);

export function extractArtifactRefsFromAssistantText(
  text: string,
  formats: readonly FileFormatContribution[] = builtinFileFormats,
): AttachedFileMeta[] {
  return (formats === builtinFileFormats
    ? extractBuiltinArtifactRefs
    : createArtifactRefExtractor(formats))(text);
}

export function useArtifactRefExtractor(): (text: string) => AttachedFileMeta[] {
  const formats = useContributions(fileFormats);
  return useMemo(() => createArtifactRefExtractor(formats), [formats]);
}
