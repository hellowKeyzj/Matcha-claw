import { useMemo } from 'react';
import { ArrowLeft, Copy, Eye, FileCode2, FolderOpen, FolderTree, GitCompare, Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { FilePreviewBody } from '@/plugins/files/FilePreviewBody';
import { WorkspaceBrowserBody } from '@/plugins/files/WorkspaceBrowserBody';
import { useFilePreviewSupport } from '@/plugins/files/extensions';
import { buildCapabilityScopeKey } from '@/types/desktop/runtime-address';
import type { ChatPanelProps } from '../extensions';
import { useChatArtifactContext, type ChatArtifactContextValue } from '../artifact-context';

const ARTIFACT_GROUP_RAIL_MIN_WIDTH = 240;
const ARTIFACT_GROUP_RAIL_DEFAULT_WIDTH = 320;
const ARTIFACT_WORKBENCH_SPLIT_MIN_WIDTH = 620;
const SIDE_PANEL_SECTION_MIN_ITEM_WIDTH = 76;
const SIDE_PANEL_CONTENT_PAD_X = 'px-3';
const SIDE_PANEL_CONTENT_PAD_Y = 'py-3';
const SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME = 'min-w-0 rounded-full border-0 bg-transparent text-xs font-medium text-muted-foreground !shadow-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:!ring-0 focus-visible:!ring-offset-0 data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:!shadow-none';


export function ChatArtifactPanel({ width }: ChatPanelProps) {
  const {
    artifactWorkbenchFullscreen, onToggleArtifactWorkbenchFullscreen,
    artifactGroups, artifactFocusedGroupKey, artifactFocusedGroupFiles, artifactFocusedFile,
    artifactActiveSection, artifactViewMode, artifactWorkspaceRoot, artifactWorkspaceContext,
    workspaceRecoveryAction, onArtifactFocusFile, onOpenGeneratedArtifactFile, onOpenArtifactGroup,
    onArtifactSectionChange, onArtifactViewModeChange, onArtifactRevealInFileManager,
  } = useChatArtifactContext();
  const { t } = useTranslation('chat');
  const supportsInlineDiff = useFilePreviewSupport('diff');
  const artifactFiles = useMemo(() => artifactFocusedGroupFiles ?? [], [artifactFocusedGroupFiles]);
  const workspaceOwnerKey = artifactWorkspaceContext?.agentScope
    ? buildCapabilityScopeKey(artifactWorkspaceContext.agentScope) : '';
  const artifactFocusedGeneratedIndex = useMemo(() => (
    artifactFocusedFile
      ? artifactFiles.findIndex((file) => file.filePath === artifactFocusedFile.filePath)
      : -1
  ), [artifactFiles, artifactFocusedFile]);
  const artifactFocusedGeneratedFile = artifactFocusedGeneratedIndex >= 0
    ? artifactFiles[artifactFocusedGeneratedIndex]
    : null;
  const sectionTabsAvailableWidth = Math.max(0, width - 32 - 8);
  const sectionTabsPerItemWidth = sectionTabsAvailableWidth / 3;
  const compactArtifactSections = sectionTabsPerItemWidth < SIDE_PANEL_SECTION_MIN_ITEM_WIDTH;
  const artifactCanShowChanges = !!artifactFocusedFile && supportsInlineDiff(artifactFocusedFile);
  const artifactHasPreviousFile = artifactFocusedGeneratedIndex > 0;
  const artifactHasNextFile = artifactFocusedGeneratedIndex >= 0 && artifactFocusedGeneratedIndex < artifactFiles.length - 1;
  const artifactShowRevealShortcut = artifactFocusedFile?.contentType === 'pdf' || artifactFocusedFile?.contentType === 'sheet';
  const artifactWorkbenchLayout = useMemo(() => {
    if (artifactActiveSection === 'workspace') {
      return {
        mode: 'workspace' as const,
        railWidth: null,
      };
    }
    if (width < ARTIFACT_WORKBENCH_SPLIT_MIN_WIDTH) {
      return {
        mode: 'stacked' as const,
        railWidth: null,
      };
    }
    return {
      mode: 'split' as const,
      railWidth: Math.min(
        ARTIFACT_GROUP_RAIL_DEFAULT_WIDTH,
        Math.max(ARTIFACT_GROUP_RAIL_MIN_WIDTH, Math.floor(width * 0.4)),
      ),
    };
  }, [artifactActiveSection, width]);

  const handleCopyGroupPaths = async (group: ChatArtifactContextValue['artifactGroups'][number]) => {
    try {
      await navigator.clipboard.writeText(group.files.map((file) => file.filePath).join('\n'));
      toast.success(t('artifacts.copyPathCopied'));
    } catch (error) {
      toast.error(t('artifacts.copyPathFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const handleOpenRelativeArtifactFile = (offset: -1 | 1) => {
    if (artifactFocusedGeneratedIndex < 0) {
      return;
    }
    const nextFile = artifactFiles[artifactFocusedGeneratedIndex + offset];
    if (!nextFile) {
      return;
    }
    onOpenGeneratedArtifactFile(nextFile, { preserveSection: 'current' });
  };

  const handleRevealFocusedArtifact = () => {
    if (!artifactFocusedFile) {
      return;
    }
    void invokeIpc('shell:showItemInFolder', artifactFocusedFile.filePath).then((result) => {
      if (result && typeof result === 'object' && 'success' in result && (result as { success?: boolean }).success === false) {
        toast.error(t('artifacts.revealFailed'));
      }
    }).catch(() => {
      toast.error(t('artifacts.revealFailed'));
    });
  };
  const artifactGroupRail = (
    <div className={cn('min-h-0 overflow-y-auto bg-muted/[0.16]', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
      {artifactGroups.length === 0 ? (
        <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-8 text-center text-sm text-muted-foreground">
          {t('artifacts.empty')}
        </p>
      ) : (
        <div className="space-y-4">
          {artifactGroups.map((group) => (
            <div key={group.graphItemKey} className="rounded-xl border border-border/60 bg-background px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('artifacts.groupLabel', { count: group.files.length })}
                </p>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid={`artifact-group-open-${group.graphItemKey}`}
                    onClick={() => {
                      onOpenArtifactGroup(group.graphItemKey, { preserveSection: 'current' });
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    title={t('artifacts.openLatest')}
                    aria-label={t('artifacts.openLatest')}
                  >
                    <FileCode2 className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    data-testid={`artifact-group-copy-${group.graphItemKey}`}
                    onClick={() => {
                      void handleCopyGroupPaths(group);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    title={t('artifacts.copyPath')}
                    aria-label={t('artifacts.copyPath')}
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const latestFile = group.files[group.files.length - 1];
                      if (!latestFile) {
                        return;
                      }
                      onArtifactRevealInFileManager(latestFile.filePath);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    title={t('artifacts.revealGroup')}
                    aria-label={t('artifacts.revealGroup')}
                  >
                    <FolderOpen className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {group.files.map((file) => {
                  const selected = artifactFocusedFile?.filePath === file.filePath;
                  const groupSelected = artifactFocusedGroupKey === group.graphItemKey;
                  return (
                    <button
                      key={`${group.graphItemKey}:${file.filePath}`}
                      type="button"
                      onClick={() => onOpenGeneratedArtifactFile(file, { preserveSection: 'current' })}
                      className={cn(
                        'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                        selected
                          ? 'border-border bg-secondary text-foreground'
                          : groupSelected
                            ? 'border-border/55 bg-secondary/70 hover:bg-secondary'
                            : 'border-border/45 bg-muted/20 hover:bg-secondary',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[11px] text-muted-foreground">
                            +{file.lineStats.added} / -{file.lineStats.removed}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/75">
                            {file.action === 'created' ? t('artifacts.created') : file.action === 'deleted' ? t('artifacts.deleted') : t('artifacts.modified')}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  const artifactDetailPane = (
    <div className="min-h-0 overflow-hidden">
      {artifactFocusedFile ? (
        <FilePreviewBody
          key={`${workspaceOwnerKey}:${artifactFocusedFile.filePath}`}
          file={artifactFocusedFile}
          mode={artifactViewMode}
          workspaceContext={artifactWorkspaceContext}
          className="h-full"
          headerAccessory={(
            <>
              {artifactFocusedGeneratedFile ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md"
                    onClick={() => handleOpenRelativeArtifactFile(-1)}
                    disabled={!artifactHasPreviousFile}
                    data-testid="artifact-preview-prev-file"
                    title={t('common:actions.previous', { defaultValue: 'Previous' })}
                    aria-label={t('common:actions.previous', { defaultValue: 'Previous' })}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </Button>
                  <div className="px-1 text-xs text-muted-foreground">
                    {artifactFocusedGeneratedIndex + 1} / {artifactFiles.length}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md"
                    onClick={() => handleOpenRelativeArtifactFile(1)}
                    disabled={!artifactHasNextFile}
                    data-testid="artifact-preview-next-file"
                    title={t('common:actions.next', { defaultValue: 'Next' })}
                    aria-label={t('common:actions.next', { defaultValue: 'Next' })}
                  >
                    <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
                  </Button>
                </>
              ) : null}
              {artifactShowRevealShortcut ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-md"
                  onClick={handleRevealFocusedArtifact}
                  title={t('artifacts.reveal')}
                  aria-label={t('artifacts.reveal')}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              {artifactCanShowChanges ? (
                <Button
                  type="button"
                  variant={artifactActiveSection === 'changes' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 rounded-md"
                  onClick={() => onArtifactSectionChange('changes')}
                  title={t('artifacts.changesTab')}
                  aria-label={t('artifacts.changesTab')}
                >
                  <GitCompare className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </>
          )}
          headerTrailingAccessory={(
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="chat-side-panel-artifact-fullscreen-toggle"
              aria-label={artifactWorkbenchFullscreen ? t('artifacts.exitFullscreen') : t('artifacts.enterFullscreen')}
              className="h-7 w-7 rounded-md"
              onClick={onToggleArtifactWorkbenchFullscreen}
              title={artifactWorkbenchFullscreen ? t('artifacts.exitFullscreen') : t('artifacts.enterFullscreen')}
            >
              {artifactWorkbenchFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('artifacts.selectFile')}
        </div>
      )}
    </div>
  );

  return <>
          <div className="border-b border-border/40 px-3 py-2">
            <div className="grid grid-cols-3 gap-1 bg-transparent p-0">
              <button
                type="button"
                data-testid="chat-artifact-section-changes"
                data-state={artifactActiveSection === 'changes' ? 'active' : 'inactive'}
                disabled={!artifactCanShowChanges}
                onClick={() => onArtifactSectionChange('changes')}
                className={cn(
                  `inline-flex ${SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME} items-center py-1.5`,
                  compactArtifactSections ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2',
                  !artifactCanShowChanges && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground',
                )}
                title={t('artifacts.changesTab')}
                aria-label={t('artifacts.changesTab')}
              >
                <GitCompare className="h-3.5 w-3.5" />
                {!compactArtifactSections ? <span className="truncate">{t('artifacts.changesTab')}</span> : null}
              </button>
              <button
                type="button"
                data-testid="chat-artifact-section-preview"
                data-state={artifactActiveSection === 'preview' ? 'active' : 'inactive'}
                onClick={() => onArtifactSectionChange('preview')}
                className={cn(
                  `inline-flex ${SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME} items-center py-1.5`,
                  compactArtifactSections ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2',
                )}
                title={t('artifacts.previewTab')}
                aria-label={t('artifacts.previewTab')}
              >
                <Eye className="h-3.5 w-3.5" />
                {!compactArtifactSections ? <span className="truncate">{t('artifacts.previewTab')}</span> : null}
              </button>
              <button
                type="button"
                data-testid="chat-artifact-section-workspace"
                data-state={artifactActiveSection === 'workspace' ? 'active' : 'inactive'}
                onClick={() => onArtifactSectionChange('workspace')}
                className={cn(
                  `inline-flex ${SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME} items-center py-1.5`,
                  compactArtifactSections ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2',
                )}
                title={t('artifacts.workspaceTab')}
                aria-label={t('artifacts.workspaceTab')}
              >
                <FolderTree className="h-3.5 w-3.5" />
                {!compactArtifactSections ? <span className="truncate">{t('artifacts.workspaceTab')}</span> : null}
              </button>
            </div>
          </div>

          {artifactWorkbenchLayout.mode === 'workspace' ? (
            <div data-testid="chat-artifact-workbench" data-layout="workspace" className="min-h-0 flex-1 overflow-hidden">
              <WorkspaceBrowserBody
                key={workspaceOwnerKey}
                rootPath={artifactWorkspaceRoot}
                selectedFilePath={artifactFocusedFile?.filePath ?? null}
                selectedFile={artifactFocusedFile}
                workspaceContext={artifactWorkspaceContext}
                recoveryAction={workspaceRecoveryAction}
                availableWidth={width}
                previewMode={artifactViewMode}
                onSelectFile={(file) => onArtifactFocusFile(file, { preserveSection: 'workspace' })}
                onPreviewModeChange={onArtifactViewModeChange}
                previewHeaderTrailingAccessory={artifactFocusedFile ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid="chat-side-panel-artifact-fullscreen-toggle"
                    aria-label={artifactWorkbenchFullscreen ? t('artifacts.exitFullscreen') : t('artifacts.enterFullscreen')}
                    className="h-7 w-7 rounded-md"
                    onClick={onToggleArtifactWorkbenchFullscreen}
                    title={artifactWorkbenchFullscreen ? t('artifacts.exitFullscreen') : t('artifacts.enterFullscreen')}
                  >
                    {artifactWorkbenchFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                  </Button>
                ) : null}
              />
            </div>
          ) : artifactWorkbenchLayout.mode === 'split' ? (
            <div
              data-testid="chat-artifact-workbench"
              data-layout="split"
              className="grid min-h-0 flex-1 overflow-hidden"
              style={{ gridTemplateColumns: `minmax(${ARTIFACT_GROUP_RAIL_MIN_WIDTH}px, ${artifactWorkbenchLayout.railWidth}px) minmax(0,1fr)` }}
            >
              <div className="min-h-0 border-r border-border/40 overflow-hidden">
                {artifactGroupRail}
              </div>
              {artifactDetailPane}
            </div>
          ) : (
            <div data-testid="chat-artifact-workbench" data-layout="stacked" className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-[220px] max-h-[45%] overflow-hidden border-b border-border/40">
                {artifactGroupRail}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {artifactDetailPane}
              </div>
            </div>
          )}
  </>;
}

