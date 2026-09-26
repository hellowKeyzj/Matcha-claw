import type { JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, FileText, GitGraph, Home, RefreshCw, Search, Settings2, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { WikiFileItem, WikiProject, WikiSourceView, WikiWorkspaceTab } from '../wiki-model';
import { WikiTreePanel } from './WikiTreePanel';

export type LibraryWorkspaceProps = Readonly<{
  currentProject: WikiProject;
  files: readonly WikiFileItem[];
  expandedDirectories: ReadonlySet<string>;
  selectedPath: string;
  activeTab: WikiWorkspaceTab;
  sourceView: WikiSourceView;
  busy: string | null;
  children: ReactNode;
  activity: ReactNode;
  onTabChange(tab: WikiWorkspaceTab): void;
  onSourceViewChange(view: WikiSourceView): void;
  onBackHome(): void;
  onRefresh(): void;
  onSelectFile(path: string): void;
  onToggleDirectory(path: string): void;
}>;

const tabs: readonly { value: WikiWorkspaceTab; labelKey: string; icon: typeof BookOpen }[] = [
  { value: 'wiki', labelKey: 'workspace.tabs.wiki', icon: BookOpen },
  { value: 'sources', labelKey: 'workspace.tabs.sources', icon: FileText },
  { value: 'review', labelKey: 'workspace.tabs.review', icon: ShieldQuestion },
  { value: 'search', labelKey: 'workspace.tabs.search', icon: Search },
  { value: 'graph', labelKey: 'workspace.tabs.graph', icon: GitGraph },
];

export function LibraryWorkspace({
  currentProject,
  files,
  expandedDirectories,
  selectedPath,
  activeTab,
  sourceView,
  busy,
  children,
  activity,
  onTabChange,
  onSourceViewChange,
  onBackHome,
  onRefresh,
  onSelectFile,
  onToggleDirectory,
}: LibraryWorkspaceProps): JSX.Element {
  const { t } = useTranslation('wiki');

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as WikiWorkspaceTab)}
      className="flex h-[calc(100dvh-96px)] min-h-[620px] flex-col overflow-hidden rounded-[28px] border border-border/80 bg-card shadow-sm"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/95 px-3">
        <TabsList className="h-9 w-auto gap-0 rounded-2xl bg-secondary/60 p-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.value} value={tab.value} onClick={() => { if (tab.value === 'sources') onSourceViewChange('sources'); }} className="h-7 rounded-xl px-4 text-sm data-[state=active]:shadow-sm">
                <Icon className="mr-2 h-4 w-4" />
                {t(tab.labelKey)}
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

      <div className="grid min-h-0 flex-1 xl:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col overflow-hidden border-r border-border/70 bg-secondary/20">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold" title={currentProject.title}>{currentProject.title}</h2>
            <Button type="button" size="icon" variant="ghost" onClick={onBackHome} disabled={busy !== null} className="h-8 w-8 shrink-0 rounded-full" title={t('workspace.library')}>
              <Home className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <WikiTreePanel
              files={files}
              expandedDirectories={expandedDirectories}
              selectedPath={selectedPath}
              busy={busy}
              onSelectFile={onSelectFile}
              onToggleDirectory={onToggleDirectory}
            />
          </div>
        </aside>

        <section className="min-w-0 overflow-hidden bg-background/60">
          <TabsContent value={activeTab} className="m-0 h-full min-w-0 p-0">
            {children}
          </TabsContent>
        </section>
      </div>

      {activity}
    </Tabs>
  );
}
