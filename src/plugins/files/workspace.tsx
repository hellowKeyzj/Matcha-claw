import { createElement } from 'react';
import { FileCode2, FolderTree, GitCompare } from 'lucide-react';
import i18n from '@/i18n';
import { lazyWithPreload } from '@/plugin-host/core';
import { buildCapabilityScopeKey } from '@/types/desktop/runtime-address';
import type { WorkspaceController, WorkspacePageProps } from '@/plugins/workspace/extensions';
import type { WorkspaceFileContext } from '@/lib/host-api';
import type { ChatArtifactGroup } from '@/plugins/chat/artifacts';
import type { ArtifactPreviewTarget } from './types';
import { formatWorkspacePathForDisplay, resolveWorkspaceRelativePath } from './types';
import type { FilePreviewMode } from './extensions';

export interface FileWorkspacePageProps extends WorkspacePageProps {
  file: ArtifactPreviewTarget;
  workspaceContext: WorkspaceFileContext;
  group: ChatArtifactGroup | null;
  mode: FilePreviewMode;
}

export type FileWorkspaceSection = 'workspace' | 'artifacts' | 'changes';

const FilePage = lazyWithPreload<FileWorkspacePageProps>(() => import('./WorkspacePages').then((module) => ({ default: module.FileWorkspacePage })));
const BrowserPage = lazyWithPreload<WorkspacePageProps>(() => import('./WorkspacePages').then((module) => ({ default: module.FileBrowserPage })));
const ArtifactsPage = lazyWithPreload<WorkspacePageProps & { mode: FilePreviewMode }>(() => import('./WorkspacePages').then((module) => ({ default: module.GeneratedFilesPage })));

function filePageId(workspace: WorkspaceController, file: ArtifactPreviewTarget, context: WorkspaceFileContext): string {
  const root = formatWorkspacePathForDisplay(context.workspaceRoot ?? '').replace(/\\/g, '/');
  const relativePath = resolveWorkspaceRelativePath(file.relativePath ?? file.filePath, context.workspaceRoot)
    ?? formatWorkspacePathForDisplay(file.filePath).replace(/\\/g, '/');
  const windows = /^[A-Za-z]:\//u.test(root) || root.startsWith('//');
  const normalizedRoot = root === '/' || /^[A-Za-z]:\/$/u.test(root) ? root : root.replace(/\/+$/u, '');
  return JSON.stringify([
    'files', workspace.scopeKey,
    context.agentScope ? buildCapabilityScopeKey(context.agentScope) : null,
    windows ? normalizedRoot.toLowerCase() : normalizedRoot,
    windows ? relativePath.toLowerCase() : relativePath,
  ]);
}

export function openFileWorkspacePage(workspace: WorkspaceController, options: {
  file: ArtifactPreviewTarget;
  workspaceContext: WorkspaceFileContext;
  group?: ChatArtifactGroup | null;
  mode?: FilePreviewMode;
}): void {
  const { file, workspaceContext, group = null, mode = 'preview' } = options;
  workspace.openPage({
    id: filePageId(workspace, file, workspaceContext),
    providerId: 'files',
    title: file.fileName,
    icon: FileCode2,
    render: (props) => createElement(FilePage, { ...props, file, workspaceContext, group, mode }),
  });
}

export function openFileWorkspaceSection(workspace: WorkspaceController, section: FileWorkspaceSection): void {
  const key = section === 'workspace' ? 'artifacts.workspaceTab' : section === 'changes' ? 'artifacts.changesTab' : 'artifacts.sectionLabel';
  workspace.openPage({
    id: JSON.stringify(['files', workspace.scopeKey, section]),
    providerId: 'files',
    title: i18n.t(`chat:${key}`),
    icon: section === 'workspace' ? FolderTree : section === 'changes' ? GitCompare : FileCode2,
    render: (props) => section === 'workspace'
      ? createElement(BrowserPage, props)
      : createElement(ArtifactsPage, { ...props, mode: section === 'changes' ? 'diff' : 'preview' }),
  });
}
