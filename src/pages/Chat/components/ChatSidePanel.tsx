import { memo, useMemo, type CSSProperties } from 'react';
import { AlertCircle, ArrowLeft, Copy, Eye, FileCode2, FolderOpen, FolderTree, GitCompare, ListTodo, Loader2, Maximize2, Minimize2, RefreshCw, Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useChatStore } from '@/stores/chat';
import { isGatewayOperational, isGatewayPreparing } from '@/lib/gateway-status';
import type { ChatSidePanelMode } from '../chat-workspace-layout';
import type { ChatSidePanelTab } from '../useChatSidePanelController';
import { AgentSkillConfigPanel, type AgentSkillOption } from './AgentSkillConfigPanel';
import { getOrBuildMarkdownBody } from '../md-pipeline';
import { supportsInlineDiff, type GeneratedFile } from '@/lib/generated-files';
import { invokeIpc } from '@/lib/api-client';
import { FilePreviewBody, type FilePreviewMode } from '@/components/file-preview/FilePreviewBody';
import { WorkspaceBrowserBody } from '@/components/file-preview/WorkspaceBrowserBody';
import type { ArtifactPreviewTarget } from '@/components/file-preview/types';
import type { DerivedPlanStatus } from '@/stores/chat/task-snapshot-store';
import type { TaskInboxTask } from '../useChatSidePanelController';

interface ChatSidePanelProps {
  mode: Exclude<ChatSidePanelMode, 'hidden'>;
  width: number;
  activeTab: ChatSidePanelTab;
  artifactWorkbenchFullscreen: boolean;
  onTabChange: (tab: ChatSidePanelTab) => void;
  onClose: () => void;
  onToggleArtifactWorkbenchFullscreen: () => void;
  unfinishedTaskCount: number;
  taskInboxTasks: TaskInboxTask[];
  taskInboxLoading: boolean;
  taskInboxError: string | null;
  onRefreshTaskInbox: () => Promise<void>;
  onClearTaskInboxError: () => void;
  derivedPlanStatus: DerivedPlanStatus;
  skillConfigLabel: string;
  skillConfigTitle: string;
  skillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  selectedSkillIds: string[];
  onToggleSkill: (skillId: string, checked: boolean) => void;
  skillPreview: {
    skillId: string;
    skillName: string;
    markdown: string | null;
    loading: boolean;
    error: string | null;
    filePath?: string;
  } | null;
  onClearSkillPreview: () => void;
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
  onArtifactFocusFile: (file: ArtifactPreviewTarget, options?: { preserveSection?: 'workspace' }) => void;
  onOpenGeneratedArtifactFile: (file: GeneratedFile, options?: { preserveSection?: boolean | 'current' }) => void;
  onOpenArtifactGroup: (groupKey: string, options?: { preserveSection?: boolean | 'current' }) => void;
  onArtifactSectionChange: (section: 'changes' | 'preview' | 'workspace') => void;
  onArtifactViewModeChange: (mode: FilePreviewMode) => void;
  onArtifactRevealInFileManager: (filePath: string) => void;
}

const ARTIFACT_GROUP_RAIL_MIN_WIDTH = 240;
const ARTIFACT_GROUP_RAIL_DEFAULT_WIDTH = 320;
const ARTIFACT_WORKBENCH_SPLIT_MIN_WIDTH = 620;
const SIDE_PANEL_TOP_TAB_MIN_ITEM_WIDTH = 78;
const SIDE_PANEL_SECTION_MIN_ITEM_WIDTH = 76;
const SIDE_PANEL_CONTENT_PAD_X = 'px-3';
const SIDE_PANEL_CONTENT_PAD_Y = 'py-3';
const SIDE_PANEL_ROW_HOVER_CLASSNAME = 'transition-colors hover:bg-secondary hover:text-foreground';
const SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME = 'min-w-0 rounded-full border-0 bg-transparent text-xs font-medium text-muted-foreground !shadow-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:!ring-0 focus-visible:!ring-offset-0 data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:!shadow-none';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' {
  if (status === 'in_progress') {
    return 'default';
  }
  if (status === 'pending') {
    return 'secondary';
  }
  if (status === 'completed') {
    return 'success';
  }
  return 'destructive';
}

function statusToPercent(status: string): number {
  if (status === 'completed') {
    return 100;
  }
  if (status === 'in_progress') {
    return 50;
  }
  return 0;
}

export const ChatSidePanel = memo(function ChatSidePanel({
  mode,
  width,
  activeTab,
  artifactWorkbenchFullscreen,
  onTabChange,
  onClose,
  onToggleArtifactWorkbenchFullscreen,
  unfinishedTaskCount,
  taskInboxTasks,
  taskInboxLoading,
  taskInboxError,
  onRefreshTaskInbox,
  onClearTaskInboxError,
  derivedPlanStatus,
  skillConfigLabel,
  skillConfigTitle,
  skillOptions,
  skillsLoading,
  selectedSkillIds,
  onToggleSkill,
  skillPreview,
  onClearSkillPreview,
  artifactGroups,
  artifactFocusedGroupKey,
  artifactFocusedGroupFiles,
  artifactFocusedFile,
  artifactActiveSection,
  artifactViewMode,
  artifactWorkspaceRoot,
  onArtifactFocusFile,
  onOpenGeneratedArtifactFile,
  onOpenArtifactGroup,
  onArtifactSectionChange,
  onArtifactViewModeChange,
  onArtifactRevealInFileManager,
}: ChatSidePanelProps) {
  const { t } = useTranslation('chat');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const gatewayPreparing = isGatewayPreparing(gatewayStatus, gatewayInitialized);
  const openTaskSession = useChatStore((state) => state.openTaskSession);
  const loading = taskInboxLoading;
  const panelStyle = {
    ['--chat-side-panel-width' as string]: `${width}px`,
  } as CSSProperties;
  const previewHtml = useMemo(() => {
    if (!skillPreview?.markdown) {
      return null;
    }
    return getOrBuildMarkdownBody(
      `chat-skill-preview:${skillPreview.skillId}:${skillPreview.filePath ?? ''}:${skillPreview.markdown}`,
      { markdown: skillPreview.markdown },
    ).fullHtml;
  }, [skillPreview]);
  const artifactFiles = useMemo(() => artifactFocusedGroupFiles ?? [], [artifactFocusedGroupFiles]);
  const artifactFocusedGeneratedIndex = useMemo(() => (
    artifactFocusedFile
      ? artifactFiles.findIndex((file) => file.filePath === artifactFocusedFile.filePath)
      : -1
  ), [artifactFiles, artifactFocusedFile]);
  const artifactFocusedGeneratedFile = artifactFocusedGeneratedIndex >= 0
    ? artifactFiles[artifactFocusedGeneratedIndex]
    : null;
  const topActionClusterWidth = activeTab === 'tasks' ? 72 : 32;
  const topTabsAvailableWidth = Math.max(0, width - 24 - 8 - topActionClusterWidth);
  const topTabsPerItemWidth = topTabsAvailableWidth / 3;
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

  const handleOpenSession = (task: TaskInboxTask) => {
    openTaskSession(task.sourceSessionKey);
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
                            {file.action === 'created' ? t('artifacts.created') : t('artifacts.modified')}
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
                'grid h-8 min-h-0 flex-1 grid-cols-3 gap-1 overflow-visible rounded-none border-0 bg-transparent p-0 text-foreground shadow-none',
              )}
            >
              <TabsTrigger
                value="tasks"
                data-testid="chat-side-panel-tab-tasks"
                title={t('taskInbox.title')}
                aria-label={t('taskInbox.title')}
                className={cn(
                  `h-8 ${SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME}`,
                  compactTopTabs ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2.5',
                )}
              >
                <ListTodo className="h-3.5 w-3.5" />
                {!compactTopTabs ? <span className="truncate">{t('taskInbox.shortTitle')}</span> : null}
              </TabsTrigger>
              <TabsTrigger
                value="skills"
                data-testid="chat-side-panel-tab-skills"
                title={skillConfigLabel}
                aria-label={skillConfigLabel}
                className={cn(
                  `h-8 ${SIDE_PANEL_SEGMENT_TRIGGER_CLASSNAME}`,
                  compactTopTabs ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2.5',
                )}
              >
                <Settings2 className="h-3.5 w-3.5" />
                {!compactTopTabs ? <span className="truncate">{t('toolbar.skillShortLabel')}</span> : null}
              </TabsTrigger>
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
            </TabsList>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('taskInbox.collapse')}
              className="h-8 w-8 rounded-md border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-secondary hover:text-foreground"
              onClick={onClose}
              title={t('taskInbox.collapse')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <TabsContent value="tasks" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
          <div className={cn('flex items-start justify-between gap-3 border-b border-border/40', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('taskInbox.title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('taskInbox.unfinishedCount', { count: unfinishedTaskCount })}
              </p>
            </div>
            {derivedPlanStatus && unfinishedTaskCount > 0 ? (
              <Badge variant={derivedPlanStatus === 'finished' ? 'success' : 'secondary'}>
                {t(`taskInbox.planStatus.${derivedPlanStatus}`)}
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-md border border-border/40 bg-muted/30 text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => void onRefreshTaskInbox()}
              disabled={!isGatewayRunning || loading}
              title={t('taskInbox.refresh')}
              aria-label={t('taskInbox.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>

          <div className={cn('flex-1 space-y-3 overflow-y-auto', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
            {!isGatewayRunning ? (
              <div className={cn(
                'rounded-lg border px-3 py-2 text-xs',
                gatewayPreparing
                  ? 'border-border bg-muted/30 text-muted-foreground'
                  : 'border-yellow-400/45 bg-yellow-50/72 text-yellow-800 dark:border-yellow-700/60 dark:bg-yellow-950/20 dark:text-yellow-200',
              )}>
                <span className="inline-flex items-center gap-2">
                  {gatewayPreparing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {gatewayPreparing ? t('taskInbox.gatewayPreparing') : t('taskInbox.gatewayStopped')}
                </span>
              </div>
            ) : null}

            {taskInboxError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{taskInboxError}</p>
                    <button
                      type="button"
                      onClick={onClearTaskInboxError}
                      className="mt-1 text-[11px] underline underline-offset-2 hover:opacity-80"
                    >
                      {t('common:actions.dismiss')}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {!loading && taskInboxTasks.length === 0 ? (
              <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-8 text-center text-sm text-muted-foreground">
                {t('taskInbox.empty')}
              </p>
            ) : null}

            {taskInboxTasks.length > 0 ? (
              <div className="divide-y divide-border/35">
                {taskInboxTasks.map((task) => {
                  return (
                      <div key={`${task.sourceSessionKey}:${task.id}`} className="py-2">
                      <button
                        type="button"
                        onClick={() => handleOpenSession(task)}
                        className={cn('w-full rounded-lg px-2 py-2 text-left', SIDE_PANEL_ROW_HOVER_CLASSNAME)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm font-medium">{task.subject || t('taskInbox.untitledTask')}</p>
                            <p className="mt-1 truncate text-[11px] text-muted-foreground">{task.id}</p>
                          </div>
                          <Badge variant={statusVariant(task.status)}>
                            {t(`taskInbox.status.${task.status}`, { defaultValue: task.status })}
                          </Badge>
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-3">
                          <p className="text-xs text-muted-foreground">{statusToPercent(task.status)}%</p>
                          <span className="text-xs text-muted-foreground">{t('taskInbox.openSession')}</span>
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="skills" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
          {skillPreview ? (
            <div data-testid="chat-skill-preview-panel" className="flex min-h-0 flex-1 flex-col">
              <div className={cn('border-b border-border/40', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-md"
                    onClick={onClearSkillPreview}
                    aria-label={t('common:actions.back')}
                    title={t('common:actions.back')}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{skillPreview.skillName}</p>
                    <p className="text-xs text-muted-foreground">{t('skillPreviewTitle')}</p>
                  </div>
                </div>
              </div>
              <div className={cn('min-h-0 flex-1 overflow-y-auto', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
                {skillPreview.loading ? (
                  <p className="text-sm text-muted-foreground">{t('skillPreviewLoading')}</p>
                ) : null}
                {!skillPreview.loading && skillPreview.error ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive">
                    {skillPreview.error}
                  </div>
                ) : null}
                {!skillPreview.loading && !skillPreview.error && previewHtml ? (
                  <div
                    className="prose prose-zinc max-w-none break-words dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:tracking-[-0.02em] prose-p:my-0 prose-p:leading-7 prose-pre:my-3 prose-pre:rounded-[18px] prose-pre:border prose-pre:border-border/45 prose-pre:bg-background/88 prose-pre:px-4 prose-pre:py-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-blockquote:border-l-border/60 prose-blockquote:text-muted-foreground prose-blockquote:italic prose-code:rounded prose-code:bg-background/75 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.92em]"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <AgentSkillConfigPanel
              title={skillConfigTitle}
              skillOptions={skillOptions}
              skillsLoading={skillsLoading}
              selectedSkillIds={selectedSkillIds}
              onToggleSkill={onToggleSkill}
            />
          )}
        </TabsContent>

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
      </Tabs>
    </aside>
  );
});
