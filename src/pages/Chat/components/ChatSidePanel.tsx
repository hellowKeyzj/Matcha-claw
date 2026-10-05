import { memo, useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowLeft, Copy, Eye, FileCode2, FolderOpen, FolderTree, GitCompare, Maximize2, Minimize2, PanelRight, SquareActivity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatSidePanelMode } from '@/components/layout/chat-workspace-layout';
import {
  getChatRuntimeSurfaceSnapshot,
  subscribeChatRuntimeSurface,
  type ChatSidePanelTab,
  type ChatRuntimeSurfaceDescriptor,
} from '../useChatSidePanelController';
import { ChatRuntimeSurfacePanel } from './ChatRuntimeSurfacePanel';
import { supportsInlineDiff, type GeneratedFile } from '@/lib/generated-files';
import { invokeIpc } from '@/lib/api-client';
import { FilePreviewBody, type FilePreviewMode } from '@/components/file-preview/FilePreviewBody';
import { WorkspaceBrowserBody } from '@/components/file-preview/WorkspaceBrowserBody';
import type { ArtifactPreviewTarget } from '@/components/file-preview/types';
import type { WorkspaceFileContext } from '@/lib/host-api';
import type {
  SessionIdentity,
} from '../../../types/desktop/runtime-address';

interface ChatSidePanelProps {
  mode: ChatSidePanelMode;
  width: number;
  activeTab: ChatSidePanelTab;
  artifactWorkbenchFullscreen: boolean;
  onTabChange: (tab: ChatSidePanelTab) => void;
  onClose: () => void;
  onToggleArtifactWorkbenchFullscreen: () => void;
  artifactGroups: Array<{
    graphItemKey: string;
    anchorItemKey?: string;
    triggerItemKey?: string;
    replyItemKey?: string;
    files: GeneratedFile[];
  }>;
  artifactFocusedGroupKey?: string | null;
  artifactFocusedGroupFiles?: GeneratedFile[];
  artifactFocusedFile: ArtifactPreviewTarget | null;
  artifactActiveSection: 'changes' | 'preview' | 'workspace';
  artifactViewMode: FilePreviewMode;
  artifactWorkspaceRoot: string | null;
  artifactWorkspaceContext?: WorkspaceFileContext;
  onArtifactFocusFile: (file: ArtifactPreviewTarget, options?: { preserveSection?: 'workspace' }) => void;
  onOpenGeneratedArtifactFile: (file: GeneratedFile, options?: { preserveSection?: boolean | 'current' }) => void;
  onOpenArtifactGroup: (groupKey: string, options?: { preserveSection?: boolean | 'current' }) => void;
  onArtifactSectionChange: (section: 'changes' | 'preview' | 'workspace') => void;
  onArtifactViewModeChange: (mode: FilePreviewMode) => void;
  onArtifactRevealInFileManager: (filePath: string) => void;
  sessionIdentity?: SessionIdentity;
  teamGraphSurface?: Extract<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }> | null;
}

const ARTIFACT_GROUP_RAIL_MIN_WIDTH = 240;
const ARTIFACT_GROUP_RAIL_DEFAULT_WIDTH = 320;
const ARTIFACT_WORKBENCH_SPLIT_MIN_WIDTH = 620;
const SIDE_PANEL_TOP_TAB_MIN_ITEM_WIDTH = 78;
const SIDE_PANEL_SECTION_MIN_ITEM_WIDTH = 76;
const SIDE_PANEL_CONTENT_PAD_X = 'px-3';
const SIDE_PANEL_CONTENT_PAD_Y = 'py-3';
const SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME = 'min-w-0 rounded-full border-0 bg-transparent text-xs font-medium text-muted-foreground !shadow-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:!ring-0 focus-visible:!ring-offset-0 data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:!shadow-none';

export const ChatSidePanel = memo(function ChatSidePanel({
  mode,
  width,
  activeTab,
  artifactWorkbenchFullscreen,
  onTabChange,
  onClose,
  onToggleArtifactWorkbenchFullscreen,
  artifactGroups,
  artifactFocusedGroupKey,
  artifactFocusedGroupFiles,
  artifactFocusedFile,
  artifactActiveSection,
  artifactViewMode,
  artifactWorkspaceRoot,
  artifactWorkspaceContext,
  onArtifactFocusFile,
  onOpenGeneratedArtifactFile,
  onOpenArtifactGroup,
  onArtifactSectionChange,
  onArtifactViewModeChange,
  onArtifactRevealInFileManager,
  sessionIdentity,
  teamGraphSurface = null,
}: ChatSidePanelProps) {
  const { t } = useTranslation(['chat', 'teams']);
  const runtimeSurface = useSyncExternalStore(
    subscribeChatRuntimeSurface,
    getChatRuntimeSurfaceSnapshot,
    getChatRuntimeSurfaceSnapshot,
  );
  const panelStyle = {
    ['--chat-side-panel-width' as string]: `${width}px`,
  } as CSSProperties;
  const artifactFiles = useMemo(() => artifactFocusedGroupFiles ?? [], [artifactFocusedGroupFiles]);
  const artifactFocusedGeneratedIndex = useMemo(() => (
    artifactFocusedFile
      ? artifactFiles.findIndex((file) => file.filePath === artifactFocusedFile.filePath)
      : -1
  ), [artifactFiles, artifactFocusedFile]);
  const artifactFocusedGeneratedFile = artifactFocusedGeneratedIndex >= 0
    ? artifactFiles[artifactFocusedGeneratedIndex]
    : null;
  const topTabsAvailableWidth = Math.max(0, width - 24 - 8 - 32);
  const topTabsPerItemWidth = topTabsAvailableWidth / 2;
  const sectionTabsAvailableWidth = Math.max(0, width - 32 - 8);
  const sectionTabsPerItemWidth = sectionTabsAvailableWidth / 3;
  const compactTopTabs = topTabsPerItemWidth < SIDE_PANEL_TOP_TAB_MIN_ITEM_WIDTH;
  const compactArtifactSections = sectionTabsPerItemWidth < SIDE_PANEL_SECTION_MIN_ITEM_WIDTH;
  const artifactCanShowChanges = !!artifactFocusedFile && supportsInlineDiff(artifactFocusedFile);
  const artifactHasPreviousFile = artifactFocusedGeneratedIndex > 0;
  const artifactHasNextFile = artifactFocusedGeneratedIndex >= 0 && artifactFocusedGeneratedIndex < artifactFiles.length - 1;
  const artifactShouldRevealInsteadOfDiff = artifactFocusedFile?.contentType === 'pdf' || artifactFocusedFile?.contentType === 'sheet';
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

  const handleCopyGroupPaths = async (group: ChatSidePanelProps['artifactGroups'][number]) => {
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
          file={artifactFocusedFile}
          mode={artifactViewMode}
          sessionIdentity={sessionIdentity}
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
              {artifactShouldRevealInsteadOfDiff ? (
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
              {!artifactShouldRevealInsteadOfDiff && artifactCanShowChanges ? (
                <Button
                  type="button"
                  variant={artifactActiveSection === 'changes' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 rounded-md"
                  onClick={() => {
                    onArtifactSectionChange('changes');
                    onArtifactViewModeChange('diff');
                  }}
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

  return (
    <aside
      data-testid="chat-side-panel"
      data-mode={mode}
      data-active-tab={activeTab}
      data-artifact-fullscreen={artifactWorkbenchFullscreen ? 'true' : 'false'}
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden bg-card',
        artifactWorkbenchFullscreen
          ? 'border-0'
          : mode === 'docked'
          ? 'border-l [border-left-color:var(--divider-line)]'
          : 'rounded-[18px] border border-border/60 shadow-[0_24px_60px_rgba(15,23,42,0.18)]',
      )}
      style={panelStyle}
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as ChatSidePanelTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="border-b border-border/40 bg-card px-3 py-2">
          <div className="flex items-center gap-2">
            <TabsList
              data-compact={compactTopTabs ? 'true' : 'false'}
              className={cn(
                'grid h-8 min-h-0 flex-1 grid-cols-2 gap-1 overflow-visible rounded-none border-0 bg-transparent p-0 text-foreground shadow-none',
              )}
            >
              <TabsTrigger
                value="artifacts"
                data-testid="chat-side-panel-tab-artifacts"
                title={t('artifacts.title')}
                aria-label={t('artifacts.title')}
                className={cn(
                  `h-8 ${SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME}`,
                  compactTopTabs ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2.5',
                )}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                {!compactTopTabs ? <span className="truncate">{t('artifacts.sectionLabel')}</span> : null}
              </TabsTrigger>
              <TabsTrigger
                value="runtime"
                data-testid="chat-side-panel-tab-runtime"
                title="运行面"
                aria-label="运行面"
                className={cn(
                  `h-8 ${SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME}`,
                  compactTopTabs ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2.5',
                )}
              >
                <SquareActivity className="h-3.5 w-3.5" />
                {!compactTopTabs ? <span className="truncate">运行面</span> : null}
              </TabsTrigger>
            </TabsList>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('toolbar.closeSidePanel')}
              className="h-8 w-8 rounded-md border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-secondary hover:text-foreground"
              onClick={onClose}
              title={t('toolbar.closeSidePanel')}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <TabsContent value="artifacts" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
          <div className="border-b border-border/40 px-3 py-2">
            <div className="grid grid-cols-3 gap-1 bg-transparent p-0">
              <button
                type="button"
                data-testid="chat-artifact-section-changes"
                data-state={artifactActiveSection === 'changes' ? 'active' : 'inactive'}
                disabled={!artifactCanShowChanges}
                onClick={() => {
                  if (!artifactCanShowChanges) {
                    return;
                  }
                  onArtifactSectionChange('changes');
                  onArtifactViewModeChange('diff');
                }}
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
                onClick={() => {
                  onArtifactSectionChange('preview');
                  onArtifactViewModeChange('preview');
                }}
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
                rootPath={artifactWorkspaceRoot}
                selectedFilePath={artifactFocusedFile?.filePath ?? null}
                selectedFile={artifactFocusedFile}
                sessionIdentity={sessionIdentity}
                workspaceContext={artifactWorkspaceContext}
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
        </TabsContent>

        <TabsContent value="runtime" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
          <div className={cn('border-b border-border/40', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
            <p className="text-sm font-medium text-foreground">运行面</p>
            <p className="mt-1 text-xs text-muted-foreground">{teamGraphSurface ? t('teams:run.graph') : 'Browser Tab / MCP App 预览'}</p>
          </div>
          <ChatRuntimeSurfacePanel surface={teamGraphSurface ?? runtimeSurface} sessionIdentity={sessionIdentity} />
        </TabsContent>
      </Tabs>
    </aside>
  );
});
