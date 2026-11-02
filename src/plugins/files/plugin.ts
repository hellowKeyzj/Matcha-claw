import { createElement, useMemo } from 'react';
import { FileCode2, FolderTree, GitCompare } from 'lucide-react';
import { workspaceLaunchers } from '@/plugins/workspace/extensions';
import { openFileWorkspaceSection } from './workspace';
import { contribute, definePlugin, lazyWithPreload, type ApplicationPlugin } from '@/plugin-host/core';
import type { AppReaderManifest, InstalledAppPlugin } from '@/types/desktop/app-plugin';
import { builtinFileFormats, type FileFormatContribution } from './file-types';
import type { InstalledReaderInput, InstalledReaderProps } from './installed-reader';
import {
  fileFormats,
  fileReaders,
  type BinaryFileReaderProps,
  type FileReaderContribution,
  type SnapshotFileReaderProps,
  type TextFileReaderProps,
} from './extensions';

const MarkdownReader = lazyWithPreload<TextFileReaderProps>(() => import('./MarkdownPreview').then(({ MarkdownPreview }) => ({
  default: ({ file, text }: TextFileReaderProps) => createElement(MarkdownPreview, { filePath: file.filePath, markdown: text }),
})));
const HtmlReader = lazyWithPreload<TextFileReaderProps>(() => import('./HtmlPreview').then(({ HtmlPreview }) => ({
  default: ({ file, text }: TextFileReaderProps) => createElement(HtmlPreview, { fileName: file.fileName, source: text }),
})));
const CodeReader = lazyWithPreload<TextFileReaderProps>(() => import('./MonacoViewer').then(({ MonacoViewer }) => ({
  default: ({ file, text }: TextFileReaderProps) => createElement(MonacoViewer, { filePath: file.filePath, value: text, className: 'h-full' }),
})));
const TextReader = lazyWithPreload<TextFileReaderProps>(() => import('./TextReader').then((module) => ({ default: module.TextReader })));
const CsvReader = lazyWithPreload<TextFileReaderProps>(() => import('./CsvReader').then((module) => ({ default: module.CsvReader })));
const ImageReader = lazyWithPreload<BinaryFileReaderProps>(() => import('./ImageReader').then((module) => ({ default: module.ImageReader })));
const PdfReader = lazyWithPreload<BinaryFileReaderProps>(() => import('./PdfViewer').then(({ PdfViewer }) => ({
  default: ({ file, data }: BinaryFileReaderProps) => createElement(PdfViewer, { data, fileName: file.fileName, className: 'h-full' }),
})));
const SheetReader = lazyWithPreload<BinaryFileReaderProps>(() => import('./SheetViewer').then(({ SheetViewer }) => ({
  default: ({ data }: BinaryFileReaderProps) => createElement(SheetViewer, { data, className: 'h-full' }),
})));
const CodeDiffReader = lazyWithPreload<SnapshotFileReaderProps>(() => import('./MonacoDiffViewer').then(({ MonacoDiffViewer }) => ({
  default: ({ file }: SnapshotFileReaderProps) => createElement(MonacoDiffViewer, {
    filePath: file.filePath, original: file.baseline ?? '', modified: file.content ?? '', className: 'h-full',
  }),
})));
const PlainDiffReader = lazyWithPreload<SnapshotFileReaderProps>(() => import('./TextReader').then((module) => ({ default: module.PlainDiffReader })));
const InstalledReader = lazyWithPreload<InstalledReaderProps>(() => import('./installed-reader').then((module) => ({ default: module.InstalledReader })));

function createInstalledReaderContribution(record: InstalledAppPlugin, reader: AppReaderManifest): FileReaderContribution {
  const shared = {
    id: `installed:${record.manifest.id}:${reader.id}:${record.digest}`,
    priority: reader.priority ?? 10,
    mode: 'preview' as const,
    matches: (file: TextFileReaderProps['file']) => reader.extensions.includes(file.ext.toLowerCase())
      || Boolean(reader.mimeTypes?.includes(file.mimeType.toLowerCase())),
  };
  const frameProps = { pluginId: record.manifest.id, digest: record.digest, entry: reader.entry, title: reader.name };
  if (reader.source === 'text') {
    return {
      ...shared,
      source: 'text',
      component: function InstalledTextReader({ file, text }: TextFileReaderProps) {
        const input = useMemo<InstalledReaderInput>(() => ({
          fileName: file.fileName, extension: file.ext, mimeType: file.mimeType, source: 'text', text,
        }), [file.fileName, file.ext, file.mimeType, text]);
        return createElement(InstalledReader, { ...frameProps, input });
      },
    };
  }
  return {
    ...shared,
    source: 'binary',
    component: function InstalledBinaryReader({ file, data }: BinaryFileReaderProps) {
      const input = useMemo<InstalledReaderInput>(() => ({
        fileName: file.fileName, extension: file.ext, mimeType: file.mimeType, source: 'binary', data,
      }), [file.fileName, file.ext, file.mimeType, data]);
      return createElement(InstalledReader, { ...frameProps, input });
    },
  };
}

export const builtinFileReaders: readonly FileReaderContribution[] = [
  { id: 'markdown', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'markdown', source: 'text', component: MarkdownReader },
  { id: 'html', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'html', source: 'text', component: HtmlReader },
  { id: 'code', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'code', source: 'text', component: CodeReader },
  { id: 'text', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'text', source: 'text', component: TextReader },
  { id: 'csv', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'sheet' && file.ext === '.csv', source: 'text', component: CsvReader },
  { id: 'image', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'image', source: 'binary', component: ImageReader },
  { id: 'pdf', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'pdf', source: 'binary', component: PdfReader },
  { id: 'sheet', priority: 0, mode: 'preview', matches: (file) => file.contentType === 'sheet' && (file.ext === '.xls' || file.ext === '.xlsx'), source: 'binary', component: SheetReader },
  {
    id: 'code-diff', priority: 0, mode: 'diff', source: 'snapshot', component: CodeDiffReader,
    matches: (file) => file.contentType === 'code' && file.action !== 'deleted'
      && typeof file.baseline === 'string' && typeof file.content === 'string',
  },
  {
    id: 'text-diff', priority: 0, mode: 'diff', source: 'snapshot', component: PlainDiffReader,
    matches: (file) => typeof file.baseline === 'string' && typeof file.content === 'string'
      && (file.contentType === 'sheet' && file.ext === '.csv'
        || file.action !== 'deleted' && ['text', 'markdown', 'html'].includes(file.contentType)),
  },
];

export function createInstalledReaderPlugin(record: InstalledAppPlugin): ApplicationPlugin {
  const readers = record.manifest.contributes.readers ?? [];
  const builtinExtensions = new Set(builtinFileFormats.flatMap((format) => format.extensions));
  const formats: FileFormatContribution[] = readers.map((reader) => {
    const extensions = reader.extensions.filter((extension) => !builtinExtensions.has(extension));
    const mimeType = reader.mimeTypes?.[0];
    return {
      id: `installed:${record.manifest.id}:${reader.id}`,
      priority: -1,
      contentType: reader.contentType,
      extensions,
      mimeTypes: mimeType ? Object.fromEntries(extensions.map((extension) => [extension, mimeType])) : undefined,
      matchesMime: (mime) => Boolean(reader.mimeTypes?.includes(mime)),
    };
  });
  return definePlugin({
    id: `installed:${record.manifest.id}`,
    requires: ['files'],
    contributes: [
      ...formats.map((format) => contribute(fileFormats, format)),
      ...(record.enabled ? readers.map((reader) => contribute(fileReaders, createInstalledReaderContribution(record, reader))) : []),
    ],
  });
}

export const filesPlugin = definePlugin({
  id: 'files',
  requires: ['app-shell', 'workspace'],
  extensionPoints: [fileFormats, fileReaders],
  contributes: [
    contribute(workspaceLaunchers, { id: 'files', order: 20, label: 'chat:artifacts.workspaceTab', icon: FolderTree,
      execute: ({ workspace }) => openFileWorkspaceSection(workspace, 'workspace') }),
    contribute(workspaceLaunchers, { id: 'artifacts', order: 30, label: 'chat:artifacts.sectionLabel', icon: FileCode2,
      execute: ({ workspace }) => openFileWorkspaceSection(workspace, 'artifacts') }),
    contribute(workspaceLaunchers, { id: 'changes', order: 40, label: 'chat:artifacts.changesTab', icon: GitCompare,
      execute: ({ workspace }) => openFileWorkspaceSection(workspace, 'changes') }),
    ...builtinFileFormats.map((format) => contribute(fileFormats, format)),
    ...builtinFileReaders.map((reader) => contribute(fileReaders, reader)),
  ],
});
