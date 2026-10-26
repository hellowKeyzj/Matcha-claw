import { useCallback, type ComponentType } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import { useContributions } from '@/plugin-host/react';
import { classifyFileContentType, getMimeTypeForExt, type FileFormatContribution } from './file-types';
import type { ArtifactPreviewTarget } from './types';

export type FilePreviewMode = 'preview' | 'diff';

export interface TextFileReaderProps {
  file: ArtifactPreviewTarget;
  text: string;
}

export interface BinaryFileReaderProps {
  file: ArtifactPreviewTarget;
  data: ArrayBuffer;
}

export interface SnapshotFileReaderProps {
  file: ArtifactPreviewTarget;
}

export type FileReaderContribution = {
  readonly id: string;
  readonly priority: number;
  readonly mode: FilePreviewMode;
  readonly matches: (file: ArtifactPreviewTarget) => boolean;
} & (
  | { readonly source: 'text'; readonly component: ComponentType<TextFileReaderProps> }
  | { readonly source: 'binary'; readonly component: ComponentType<BinaryFileReaderProps> }
  | { readonly source: 'snapshot'; readonly component: ComponentType<SnapshotFileReaderProps> }
);

export const fileFormats = defineExtensionPoint<FileFormatContribution>('files.formats');
export const fileReaders = defineExtensionPoint<FileReaderContribution>('files.readers');

export function resolveFilePreviewTarget(file: ArtifactPreviewTarget, formats: readonly FileFormatContribution[]): ArtifactPreviewTarget {
  const mimeType = !file.mimeType || file.mimeType === 'application/octet-stream'
    ? getMimeTypeForExt(file.ext, formats)
    : file.mimeType;
  const contentType = classifyFileContentType(file.ext, mimeType, formats);
  return mimeType === file.mimeType && contentType === file.contentType ? file : { ...file, mimeType, contentType };
}

export function findFileReader(
  readers: readonly FileReaderContribution[],
  file: ArtifactPreviewTarget,
  mode: FilePreviewMode,
): FileReaderContribution | undefined {
  if (file.isDirectory) return undefined;
  let matched: FileReaderContribution | undefined;
  for (const reader of readers) {
    if (reader.mode === mode && reader.matches(file) && (!matched || reader.priority > matched.priority)) matched = reader;
  }
  return matched;
}

export function useFilePreviewSupport(mode: FilePreviewMode): (file: ArtifactPreviewTarget) => boolean {
  const formats = useContributions(fileFormats);
  const readers = useContributions(fileReaders);
  return useCallback((file) => !!findFileReader(readers, resolveFilePreviewTarget(file, formats), mode), [formats, readers, mode]);
}
