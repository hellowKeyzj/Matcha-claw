import { useRef, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, FileText, FolderOpen, GitGraph, Home, ListChecks, MessageSquare, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings2, ShieldQuestion, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { WikiFileItem, WikiProject, WikiSourceView, WikiWorkspaceTab } from '../wiki-model';
import type { WikiNavigationPage } from '@/types/wiki-navigation';
import { cn } from '@/lib/utils';
import { KnowledgeTreePanel } from './KnowledgeTreePanel';
import { WikiTreePanel } from './WikiTreePanel';

export type LibraryWorkspaceProps = Readonly<{
  currentProject: WikiProject;
  files: readonly WikiFileItem[];
  expandedDirectories: ReadonlySet<string>;
  loadedDirectories: ReadonlySet<string>;
  loadingDirectories: ReadonlySet<string>;
  directoryErrors: Readonly<Record<string, string>>;
  pages: readonly WikiNavigationPage[];
  sourceFiles: readonly WikiFileItem[];
  navigationLoading: boolean;
  navigationError: string | null;
  selectedPath: string;
  activeTab: WikiWorkspaceTab;
  sourceView: WikiSourceView;
  busy: string | null;
  children: ReactNode;
  questionPanel?: ReactNode;
  activity: ReactNode;
  onTabChange(tab: WikiWorkspaceTab): void;
  onSourceViewChange(view: WikiSourceView): void;
  onBackHome(): void;
  onRefresh(): void;
  onSelectFile(path: string): void;
  onToggleDirectory(path: string): void;
  onRetryDirectory(path: string): void;
  onRetryNavigation(): void;
  onDeletePage(path: string): Promise<void>;
  onOpenFolder(): void;
}>;

const SIDEBAR_COLLAPSED_KEY = 'matcha:wiki-sidebar-collapsed';

const tabs: readonly { value: WikiWorkspaceTab; labelKey: string; defaultValue?: string; icon: typeof BookOpen }[] = [
  { value: 'wiki', labelKey: 'workspace.tabs.wiki', icon: BookOpen },
  { value: 'sources', labelKey: 'workspace.tabs.sources', icon: FileText },
  { value: 'review', labelKey: 'workspace.tabs.review', icon: ShieldQuestion },
  { value: 'qa', labelKey: 'workspace.tabs.qa', defaultValue: '问答', icon: MessageSquare },
  { value: 'lint', labelKey: 'workspace.tabs.lint', defaultValue: '检查', icon: ListChecks },
  { value: 'search', labelKey: 'workspace.tabs.search', icon: Search },
  { value: 'graph', labelKey: 'workspace.tabs.graph', icon: GitGraph },
  { value: 'maintenance', labelKey: 'workspace.tabs.maintenance', defaultValue: '维护', icon: Wrench },
];

export function LibraryWorkspace({
  currentProject,
  files,
  expandedDirectories,
  loadedDirectories,
  loadingDirectories,
  directoryErrors,
  pages,
  sourceFiles,
  navigationLoading,
  navigationError,
  selectedPath,
  activeTab,
  sourceView,
  busy,
  children,
  questionPanel,
  activity,
  onTabChange,
  onSourceViewChange,
  onBackHome,
  onRefresh,
  onSelectFile,
  onToggleDirectory,
  onRetryDirectory,
  onRetryNavigation,
  onDeletePage,
  onOpenFolder,
}: LibraryWorkspaceProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [sidebarMode, setSidebarMode] = useState<'knowledge' | 'files'>('knowledge');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const layoutRef = useRef<HTMLDivElement>(null);

  function toggleSidebar(): void {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    setSidebarMode('knowledge');
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as WikiWorkspaceTab)}
      className="flex h-full min-h-[620px] flex-col overflow-hidden"
    >
      <div ref={layoutRef} className="flex min-h-0 flex-1">
        {sidebarCollapsed ? (
          <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r bg-[hsl(var(--shell-surface-muted))] pt-2 [border-color:hsl(var(--shell-border))]">
            <Button type="button" size="icon" variant="ghost" onClick={toggleSidebar} className="h-7 w-7" title={t('sidebar.expand')} aria-label={t('sidebar.expand')}><PanelLeftOpen className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" onClick={onBackHome} disabled={busy !== null} className="h-7 w-7" title={t('workspace.library')} aria-label={t('workspace.library')}><Home className="h-4 w-4" /></Button>
          </div>
        ) : (
          <>
            <aside style={{ width: sidebarWidth }} className="flex min-w-0 shrink-0 flex-col overflow-hidden border-r bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
                <h2 className="min-w-0 flex-1 truncate text-base font-semibold" title={currentProject.title}>{currentProject.title}</h2>
                <Button type="button" size="icon" variant="ghost" onClick={onBackHome} disabled={busy !== null} className="h-8 w-8 shrink-0 rounded-full" title={t('workspace.library')} aria-label={t('workspace.library')}><Home className="h-4 w-4" /></Button>
              </div>
              <div className="flex shrink-0 border-b border-border/70">
                {(['knowledge', 'files'] as const).map((mode) => (
                  <button key={mode} type="button" aria-pressed={sidebarMode === mode} onClick={() => setSidebarMode(mode)} className={cn('flex-1 border-b-2 border-transparent px-2 py-2 text-xs font-medium text-muted-foreground hover:text-foreground', sidebarMode === mode && 'border-primary text-foreground')}>{t(`sidebar.${mode}`)}</button>
                ))}
                <Button type="button" size="icon" variant="ghost" onClick={toggleSidebar} className="h-9 w-9 shrink-0 rounded-none border-l" title={t('sidebar.collapse')} aria-label={t('sidebar.collapse')}><PanelLeftClose className="h-4 w-4" /></Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {sidebarMode === 'knowledge' ? (
                  <KnowledgeTreePanel pages={pages} sourceFiles={sourceFiles} selectedPath={selectedPath} busy={busy} loading={navigationLoading} error={navigationError} onSelectFile={onSelectFile} onDeletePage={onDeletePage} onRetry={onRetryNavigation} />
                ) : (
                  <WikiTreePanel files={files} expandedDirectories={expandedDirectories} loadedDirectories={loadedDirectories} loadingDirectories={loadingDirectories} directoryErrors={directoryErrors} selectedPath={selectedPath} busy={busy} onSelectFile={onSelectFile} onToggleDirectory={onToggleDirectory} onRetryDirectory={onRetryDirectory} />
                )}
              </div>
              {sidebarMode === 'files' ? <div className="shrink-0 border-t p-2"><Button type="button" size="sm" variant="ghost" onClick={onOpenFolder} className="h-8 w-full gap-1.5 text-xs" title={currentProject.rootPath}><FolderOpen className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{t('sidebar.openFolder')}</span></Button></div> : null}
            </aside>
            <div
              role="separator"
              tabIndex={0}
              aria-label={t('sidebar.resize')}
              aria-orientation="vertical"
              aria-valuemin={150}
              aria-valuemax={400}
              aria-valuenow={sidebarWidth}
              className="w-1.5 shrink-0 touch-none cursor-col-resize bg-border/30 transition-colors hover:bg-primary/30 focus-visible:bg-primary/30 focus-visible:outline-none"
              onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
              onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId) && layoutRef.current) setSidebarWidth(Math.max(150, Math.min(400, event.clientX - layoutRef.current.getBoundingClientRect().left))); }}
              onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); }}
              onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSidebarWidth((width) => Math.max(150, Math.min(400, width + (event.key === 'ArrowRight' ? 10 : -10)))); } }}
            />
          </>
        )}

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(var(--shell-surface))]">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b px-5 [border-color:hsl(var(--shell-border))]">
            <TabsList className="h-12 min-h-0 flex-1 gap-1 overflow-x-auto rounded-none border-0 bg-transparent p-0 shadow-none">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.value} value={tab.value} onClick={() => { if (tab.value === 'sources') onSourceViewChange('sources'); }} className="h-8 rounded-full px-3 text-sm data-[state=active]:bg-[hsl(var(--shell-surface-muted))]">
                    <Icon className="mr-2 h-4 w-4" />
                    {t(tab.labelKey, { defaultValue: tab.defaultValue })}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                size="icon"
                variant={activeTab === 'sources' && sourceView === 'settings' ? 'secondary' : 'ghost'}
                onClick={() => {
                  if (activeTab === 'sources' && sourceView === 'settings') {
                    onSourceViewChange('sources');
                    return;
                  }
                  onTabChange('sources');
                  onSourceViewChange('settings');
                }}
                disabled={busy !== null}
                className="h-8 w-8 rounded-full"
                title={t('common.settings')}
              >
                <Settings2 className="h-4 w-4" />
              </Button>
              <Button type="button" size="icon" variant="ghost" onClick={onRefresh} disabled={busy !== null} className="h-8 w-8 rounded-full" title={t('common.refresh')}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {activeTab !== 'qa' ? <TabsContent value={activeTab} className="m-0 min-h-0 flex-1 p-0">{children}</TabsContent> : null}
          {questionPanel ? <TabsContent value="qa" forceMount hidden={activeTab !== 'qa'} className="m-0 min-h-0 flex-1 p-0">{questionPanel}</TabsContent> : null}
        </section>
      </div>

      {activity}
    </Tabs>
  );
}
