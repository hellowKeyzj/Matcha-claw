import { createElement, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FileCode2, FolderTree, GitCompare } from 'lucide-react';
import i18n from '@/i18n';
import { lazyWithPreload } from '@/plugin-host/core';
import { buildCapabilityScopeKey, buildSessionIdentityKey, runtimeEndpointsEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import { useChatStore } from '@/plugins/chat/store';
import { findSessionRecordKey } from '@/plugins/chat/session-catalog';
import { readSessionWorkspaceFileContext } from '@/plugins/chat/session-media';
import type { WorkspaceController, WorkspacePageProps } from '@/plugins/workspace/extensions';
import { hostFileStat, type WorkspaceFileContext } from '@/lib/host-api';
import type { ChatArtifactGroup } from '@/plugins/chat/artifacts';
import type { ArtifactPreviewTarget } from './types';
import { formatWorkspacePathForDisplay, resolveArtifactLocalPath, resolveWorkspaceRelativePath } from './types';
import { useFilePreviewSupport, type FilePreviewMode } from './extensions';
import { artifactFileErrorMessage, openArtifactPathExternally } from './open-file-utils';

export interface FileWorkspacePageProps extends WorkspacePageProps {
  file: ArtifactPreviewTarget;
  workspaceContext: WorkspaceFileContext;
  group: ChatArtifactGroup | null;
  mode: FilePreviewMode;
}

export type FileWorkspaceSection = 'workspace' | 'artifacts' | 'changes';

const FilePage = lazyWithPreload<FileWorkspacePageProps>(() => import('./WorkspacePages').then((module) => ({ default: module.FileWorkspacePage })));
const BrowserPage = lazyWithPreload<WorkspacePageProps & { workspaceContext?: WorkspaceFileContext }>(() => import('./WorkspacePages').then((module) => ({ default: module.FileBrowserPage })));
const ArtifactsPage = lazyWithPreload<WorkspacePageProps & { mode: FilePreviewMode }>(() => import('./WorkspacePages').then((module) => ({ default: module.GeneratedFilesPage })));

function retainFileWorkspacePage(context: WorkspaceFileContext): ((identity: SessionIdentity | null) => boolean) | undefined {
  const scope = context.scope;
  if (scope?.kind !== 'team-run') return undefined;
  return (identity) => {
    if (!identity || !runtimeEndpointsEqual(identity.endpoint, scope.endpoint)) return false;
    const state = useChatStore.getState();
    const key = findSessionRecordKey(state, identity);
    const ownership = key ? state.loadedSessions[key]?.meta.ownership : null;
    return ownership?.kind === 'team' && ownership.teamId === scope.teamId && ownership.teamRunId === scope.runId;
  };
}

function filePageId(workspace: WorkspaceController, file: ArtifactPreviewTarget, context: WorkspaceFileContext): string {
  if (file.mediaSource) {
    return JSON.stringify(['files', workspace.scopeKey, 'media', buildSessionIdentityKey(file.mediaSource.sessionIdentity), file.mediaSource.reference]);
  }
  if (context.scope?.kind === 'team-run') {
    return JSON.stringify(['files', buildCapabilityScopeKey(context.scope), file.relativePath ?? file.filePath]);
  }
  const root = formatWorkspacePathForDisplay(context.workspaceRoot ?? '').replace(/\\/g, '/');
  const relativePath = resolveWorkspaceRelativePath(file.relativePath ?? file.filePath, context.workspaceRoot)
    ?? formatWorkspacePathForDisplay(file.filePath).replace(/\\/g, '/');
  const windows = /^[A-Za-z]:\//u.test(root) || root.startsWith('//');
  const normalizedRoot = root === '/' || /^[A-Za-z]:\/$/u.test(root) ? root : root.replace(/\/+$/u, '');
  return JSON.stringify([
    'files', workspace.scopeKey,
    context.scope ? buildCapabilityScopeKey(context.scope) : null,
    windows ? normalizedRoot.toLowerCase() : normalizedRoot,
    windows ? relativePath.toLowerCase() : relativePath,
  ]);
}

interface OpenFileWorkspaceOptions {
  file: ArtifactPreviewTarget;
  workspaceContext: WorkspaceFileContext;
  group?: ChatArtifactGroup | null;
  mode?: FilePreviewMode;
}

export function useOpenFileWorkspacePage(workspace: WorkspaceController): (options: OpenFileWorkspaceOptions) => void {
  const { t } = useTranslation('chat');
  const supportsPreview = useFilePreviewSupport('preview');
  return useCallback((options) => {
    const { file, workspaceContext, mode = 'preview' } = options;
    if (file.mediaSource) {
      openFileWorkspacePage(workspace, { ...options, mode: 'preview' });
      return;
    }
    const relativePath = resolveWorkspaceRelativePath(file.relativePath ?? file.filePath, workspaceContext.workspaceRoot);
    const isRunWorkspace = workspaceContext.scope?.kind === 'team-run';
    const hasSnapshot = !isRunWorkspace && (mode === 'diff' || (file.sourceTool !== 'write' && !!file.content && supportsPreview(file)));
    if (hasSnapshot) {
      openFileWorkspacePage(workspace, options);
      return;
    }
    void (async () => {
      const scope = workspaceContext.scope;
      if (scope && relativePath) {
        const stat = await hostFileStat({ scope, relativePath });
        if (!stat.ok) {
          if (isRunWorkspace && supportsPreview(file)) {
            openFileWorkspacePage(workspace, { ...options, mode: 'preview' });
            return;
          }
          throw new Error(stat.error ?? 'unavailable');
        }
        const target = { ...file, isDirectory: stat.isDirectory, fileSize: stat.size };
        if (target.isDirectory || supportsPreview(target)) {
          openFileWorkspacePage(workspace, { ...options, file: target });
          return;
        }
      } else if (scope && relativePath === '') {
        openFileWorkspacePage(workspace, { ...options, file: { ...file, isDirectory: true } });
        return;
      }
      const localPath = resolveArtifactLocalPath(file.filePath, workspaceContext.workspaceRoot);
      if (!localPath) {
        toast.error(t('artifacts.localPathUnavailable'));
        return;
      }
      const error = await openArtifactPathExternally(localPath);
      if (error) throw new Error(error);
    })().catch((error: unknown) => {
      toast.error(t('artifacts.openFailed', { error: artifactFileErrorMessage(error, t) }), {
        description: t('artifacts.fileOpenRecovery'),
      });
    });
  }, [supportsPreview, t, workspace]);
}

export function openFileWorkspacePage(workspace: WorkspaceController, options: OpenFileWorkspaceOptions): void {
  const { file, workspaceContext, group = null, mode = 'preview' } = options;
  workspace.openPage({
    id: filePageId(workspace, file, workspaceContext),
    retainOnSessionChange: file.mediaSource ? undefined : retainFileWorkspacePage(workspaceContext),
    providerId: 'files',
    title: file.fileName,
    icon: FileCode2,
    render: (props) => createElement(FilePage, { ...props, file, workspaceContext, group, mode }),
  });
}

export function openFileWorkspaceSection(workspace: WorkspaceController, section: FileWorkspaceSection, workspaceContext?: WorkspaceFileContext): void {
  const currentContext = workspaceContext ?? (workspace.sessionIdentity ? readSessionWorkspaceFileContext(workspace.sessionIdentity) : undefined);
  const runContext = currentContext?.scope?.kind === 'team-run' ? currentContext : undefined;
  const context = workspaceContext ?? runContext;
  const key = section === 'workspace' ? 'artifacts.workspaceTab' : section === 'changes' ? 'artifacts.changesTab' : 'artifacts.sectionLabel';
  workspace.openPage({
    id: JSON.stringify(runContext?.scope ? ['files', buildCapabilityScopeKey(runContext.scope), section]
      : section === 'workspace' ? ['files', section] : ['files', workspace.scopeKey, section]),
    providerId: 'files',
    lifetime: section === 'workspace' && !runContext ? 'workspace' : undefined,
    retainOnSessionChange: runContext ? retainFileWorkspacePage(runContext) : undefined,
    title: i18n.t(`chat:${key}`),
    icon: section === 'workspace' ? FolderTree : section === 'changes' ? GitCompare : FileCode2,
    render: (props) => section === 'workspace'
      ? createElement(BrowserPage, { ...props, workspaceContext: context })
      : createElement(ArtifactsPage, { ...props, mode: section === 'changes' ? 'diff' : 'preview' }),
  });
}
