import { useCallback, useState } from 'react';
import { ArrowLeft, Copy, Eye, FileCode2, FolderOpen, GitCompare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useChatArtifactContext } from '@/plugins/chat/artifact-context';
import type { ChatArtifactGroup } from '@/plugins/chat/artifacts';
import { resolveArtifactGroupFocusFile } from '@/plugins/chat/artifact-workbench';
import { useWorkspace } from '@/plugins/workspace/context';
import type { WorkspacePageProps } from '@/plugins/workspace/extensions';
import type { GeneratedFile } from './generated-files';
import { useFilePreviewSupport, type FilePreviewMode } from './extensions';
import { FilePreviewBody } from './FilePreviewBody';
import { WorkspaceBrowserBody } from './WorkspaceBrowserBody';
import { buildArtifactPreviewTargetFromGeneratedFile, type ArtifactPreviewTarget } from './types';
import { revealArtifactPathInFileManager } from './open-file-utils';
import { openFileWorkspacePage, type FileWorkspacePageProps } from './workspace';

const EMPTY_FILES: GeneratedFile[] = [];

export function FileBrowserPage({ width }: WorkspacePageProps) {
  const workspace = useWorkspace();
  const { artifactWorkspaceRoot, artifactWorkspaceContext, workspaceRecoveryAction } = useChatArtifactContext();
  const [selectedFile, setSelectedFile] = useState<ArtifactPreviewTarget | null>(null);
  const selectFile = useCallback((file: ArtifactPreviewTarget) => {
    setSelectedFile(file);
    openFileWorkspacePage(workspace, { file, workspaceContext: artifactWorkspaceContext });
  }, [artifactWorkspaceContext, workspace]);
  return <WorkspaceBrowserBody
    browseOnly
    rootPath={artifactWorkspaceRoot}
    selectedFilePath={selectedFile?.filePath ?? null}
    selectedFile={selectedFile}
    workspaceContext={artifactWorkspaceContext}
    recoveryAction={workspaceRecoveryAction}
    availableWidth={width}
    onSelectFile={selectFile}
  />;
}

export function FileWorkspacePage({ file: inputFile, group: inputGroup, mode: inputMode, workspaceContext, width }: FileWorkspacePageProps) {
  const { t } = useTranslation('chat');
  const workspace = useWorkspace();
  const { artifactGroups, workspaceRecoveryAction } = useChatArtifactContext();
  const supportsDiff = useFilePreviewSupport('diff');
  const [selection, setSelection] = useState({ file: inputFile, mode: inputMode });
  if (selection.file !== inputFile) setSelection({ file: inputFile, mode: inputMode });
  const group = artifactGroups.find((entry) => entry.graphItemKey === inputGroup?.graphItemKey
    && entry.files.some((file) => file.filePath === inputFile.filePath && file.toolId === inputFile.toolId)) ?? inputGroup;
  const generated = group?.files.find((entry) => entry.filePath === inputFile.filePath && entry.toolId === inputFile.toolId);
  const file = generated ? buildArtifactPreviewTargetFromGeneratedFile(generated) : inputFile;
  const files = group?.files ?? EMPTY_FILES;
  const index = files.findIndex((entry) => entry.filePath === file.filePath && entry.toolId === file.toolId);
  const canShowDiff = supportsDiff(file);
  const mode = selection.file === inputFile ? selection.mode : inputMode;
  const openFile = useCallback((target: GeneratedFile) => {
    openFileWorkspacePage(workspace, {
      file: buildArtifactPreviewTargetFromGeneratedFile(target),
      group,
      workspaceContext,
      mode: supportsDiff(target) ? mode : 'preview',
    });
  }, [group, mode, supportsDiff, workspace, workspaceContext]);
  const selectWorkspaceFile = useCallback((target: ArtifactPreviewTarget) => {
    openFileWorkspacePage(workspace, { file: target, workspaceContext });
  }, [workspace, workspaceContext]);
  const previous = useCallback(() => { if (index > 0) openFile(files[index - 1]); }, [files, index, openFile]);
  const next = useCallback(() => { if (index >= 0 && index < files.length - 1) openFile(files[index + 1]); }, [files, index, openFile]);
  const toggleMode = useCallback(() => setSelection((current) => ({ ...current, mode: current.mode === 'diff' ? 'preview' : 'diff' })), []);
  if (file.isDirectory) return <WorkspaceBrowserBody
    browseOnly
    rootPath={workspaceContext.workspaceRoot ?? null}
    selectedFilePath={file.filePath}
    selectedFile={file}
    workspaceContext={workspaceContext}
    recoveryAction={workspaceRecoveryAction}
    availableWidth={width}
    onSelectFile={selectWorkspaceFile}
  />;
  return <FilePreviewBody
    file={file}
    mode={canShowDiff ? mode : 'preview'}
    workspaceContext={workspaceContext}
    headerAccessory={<>
      {index >= 0 ? <>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-md" onClick={previous} disabled={index === 0}
          data-testid="artifact-preview-prev-file" title={t('common:actions.previous')} aria-label={t('common:actions.previous')}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="px-1 text-xs text-muted-foreground">{index + 1} / {files.length}</span>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-md" onClick={next} disabled={index === files.length - 1}
          data-testid="artifact-preview-next-file" title={t('common:actions.next')} aria-label={t('common:actions.next')}>
          <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
        </Button>
      </> : null}
      {canShowDiff ? <Button type="button" variant={mode === 'diff' ? 'secondary' : 'ghost'} size="icon" className="h-7 w-7 rounded-md" onClick={toggleMode}
        title={mode === 'diff' ? t('artifacts.previewTab') : t('artifacts.changesTab')}
        aria-label={mode === 'diff' ? t('artifacts.previewTab') : t('artifacts.changesTab')}>
        {mode === 'diff' ? <Eye className="h-3.5 w-3.5" /> : <GitCompare className="h-3.5 w-3.5" />}
      </Button> : null}
    </>}
  />;
}

function GeneratedFileGroup({ group, mode }: { group: ChatArtifactGroup; mode: FilePreviewMode }) {
  const { t } = useTranslation('chat');
  const workspace = useWorkspace();
  const { artifactWorkspaceContext } = useChatArtifactContext();
  const supportsDiff = useFilePreviewSupport('diff');
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const openFile = useCallback((file: GeneratedFile) => {
    setFocusedPath(file.filePath);
    openFileWorkspacePage(workspace, {
      file: buildArtifactPreviewTargetFromGeneratedFile(file),
      workspaceContext: artifactWorkspaceContext,
      group,
      mode: (mode === 'diff' || file.sourceTool === 'edit') && supportsDiff(file) ? 'diff' : 'preview',
    });
  }, [artifactWorkspaceContext, group, mode, supportsDiff, workspace]);
  const openGroup = useCallback(() => {
    const file = resolveArtifactGroupFocusFile(group, focusedPath);
    if (file) openFile(file);
  }, [focusedPath, group, openFile]);
  const copyPaths = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(group.files.map((file) => file.filePath).join('\n'));
      toast.success(t('artifacts.copyPathCopied'));
    } catch (error) {
      toast.error(t('artifacts.copyPathFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [group, t]);
  const revealGroup = useCallback(async () => {
    const file = group.files.at(-1);
    if (!file) return;
    try {
      if (!await revealArtifactPathInFileManager(file.filePath)) toast.error(t('artifacts.revealFailed'));
    } catch {
      toast.error(t('artifacts.revealFailed'));
    }
  }, [group, t]);
  return <div className="rounded-xl border border-border/60 bg-background px-3 py-3">
    <div className="mb-2 flex items-center justify-between gap-2">
      <p className="text-xs font-medium text-muted-foreground">{t('artifacts.groupLabel', { count: group.files.length })}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" data-testid={`artifact-group-open-${group.graphItemKey}`} onClick={openGroup}
          title={t('artifacts.openLatest')} aria-label={t('artifacts.openLatest')}><FileCode2 className="h-3 w-3" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" data-testid={`artifact-group-copy-${group.graphItemKey}`} onClick={copyPaths}
          title={t('artifacts.copyPath')} aria-label={t('artifacts.copyPath')}><Copy className="h-3 w-3" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={revealGroup}
          title={t('artifacts.revealGroup')} aria-label={t('artifacts.revealGroup')}><FolderOpen className="h-3 w-3" /></Button>
      </div>
    </div>
    <div className="space-y-2">{group.files.map((file) => <GeneratedFileRow key={file.filePath} file={file} selected={file.filePath === focusedPath} onOpen={openFile} />)}</div>
  </div>;
}

function GeneratedFileRow({ file, selected, onOpen }: { file: GeneratedFile; selected: boolean; onOpen: (file: GeneratedFile) => void }) {
  const { t } = useTranslation('chat');
  const open = useCallback(() => onOpen(file), [file, onOpen]);
  return <button type="button" onClick={open} className={cn('w-full rounded-lg border px-3 py-2 text-left transition-colors',
    selected ? 'border-border bg-secondary text-foreground' : 'border-border/45 bg-muted/20 hover:bg-secondary')}>
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 truncate text-sm font-medium text-foreground">{file.fileName}</p>
      <div className="shrink-0 text-right">
        <div className="text-[11px] text-muted-foreground">+{file.lineStats.added} / -{file.lineStats.removed}</div>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/75">
          {file.action === 'created' ? t('artifacts.created') : file.action === 'deleted' ? t('artifacts.deleted') : t('artifacts.modified')}
        </div>
      </div>
    </div>
  </button>;
}

export function GeneratedFilesPage({ mode }: WorkspacePageProps & { mode: FilePreviewMode }) {
  const { t } = useTranslation('chat');
  const { artifactGroups } = useChatArtifactContext();
  return <div className="h-full min-h-0 overflow-y-auto bg-muted/[0.16] px-3 py-3">
    {artifactGroups.length === 0
      ? <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-8 text-center text-sm text-muted-foreground">{t('artifacts.empty')}</p>
      : <div className="space-y-4">{artifactGroups.map((group) => <GeneratedFileGroup key={group.graphItemKey} group={group} mode={mode} />)}</div>}
  </div>;
}
