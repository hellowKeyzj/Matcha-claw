import { useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, FolderOpen, FolderPlus, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatDateTime, type WikiProject, type WikiProjectTemplate, type WikiStatus } from '../wiki-model';

export type LibraryHomeProps = Readonly<{
  status: WikiStatus;
  projects: readonly WikiProject[];
  templates: readonly WikiProjectTemplate[];
  selectedTemplateId: string;
  openPath: string;
  projectName: string;
  busy: string | null;
  onOpenPathChange(value: string): void;
  onProjectNameChange(value: string): void;
  onTemplateChange(value: string): void;
  onPickDirectory(): void;
  onCreateProject(): void | Promise<void>;
  onSelectProject(project: WikiProject): void;
  onRefresh(): void;
}>;

function LibraryDialog(props: Readonly<{
  open: boolean;
  openPath: string;
  projectName: string;
  templates: readonly WikiProjectTemplate[];
  selectedTemplateId: string;
  busy: string | null;
  onOpenPathChange(value: string): void;
  onProjectNameChange(value: string): void;
  onTemplateChange(value: string): void;
  onPickDirectory(): void;
  onCreateProject(): void | Promise<void>;
  onClose(): void;
}>): JSX.Element | null {
  const { t } = useTranslation('wiki');
  const { open, openPath, projectName, templates, selectedTemplateId, busy, onOpenPathChange, onProjectNameChange, onTemplateChange, onPickDirectory, onCreateProject, onClose } = props;
  if (!open) return null;

  const isBusy = busy !== null;
  const templateOptions = templates.some((template) => template.id === 'general')
    ? templates
    : [{ id: 'general', name: 'General', description: '', icon: '📚' }, ...templates];
  const canSubmit = openPath.trim().length > 0 && !isBusy;

  const submit = () => {
    if (!canSubmit) return;
    void Promise.resolve(onCreateProject()).then(onClose);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-6" role="dialog" aria-modal="true" aria-labelledby="wiki-library-dialog-title">
      <div className="w-full max-w-[520px] overflow-hidden rounded-[28px] border border-border bg-card shadow-2xl">
        <div className="flex items-start gap-4 border-b border-border/70 px-6 py-5">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-secondary text-muted-foreground">
            <FolderPlus className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="wiki-library-dialog-title" className="text-lg font-semibold tracking-tight">{t('home.newLibrary')}</h2>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} disabled={isBusy} className="h-8 w-8 rounded-full">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('common.folder')}</label>
            <div className="flex gap-2">
              <Input value={openPath} onChange={(event) => onOpenPathChange(event.target.value)} placeholder={t('home.folderPlaceholder')} disabled={isBusy} className="h-10 rounded-2xl" />
              <Button type="button" variant="outline" onClick={onPickDirectory} disabled={isBusy} className="h-10 rounded-2xl bg-card px-4">{t('common.choose')}</Button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('common.name')}</label>
            <Input value={projectName} onChange={(event) => onProjectNameChange(event.target.value)} placeholder={t('common.optional')} disabled={isBusy} className="h-10 rounded-2xl" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('common.template')}</label>
            <div className="grid gap-2">
              {templateOptions.map((template) => {
                const name = t(`templates.${template.id}.name`, { defaultValue: template.name });
                const description = t(`templates.${template.id}.description`, { defaultValue: template.description });
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => onTemplateChange(template.id)}
                    disabled={isBusy}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-2xl border px-3 py-2.5 text-left transition hover:bg-secondary/40',
                      selectedTemplateId === template.id ? 'border-foreground bg-secondary/45' : 'border-border/80 bg-background',
                    )}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-secondary text-lg">{template.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{name}</span>
                      {description ? <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/70 bg-secondary/20 px-6 py-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isBusy} className="rounded-full">{t('common.cancel')}</Button>
          <Button type="button" onClick={submit} disabled={!canSubmit} className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90">
            {t('home.newLibrary')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function LibraryHome(props: LibraryHomeProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const {
    status,
    projects,
    templates,
    selectedTemplateId,
    openPath,
    projectName,
    busy,
    onOpenPathChange,
    onProjectNameChange,
    onTemplateChange,
    onPickDirectory,
    onCreateProject,
    onSelectProject,
    onRefresh,
  } = props;
  const [query, setQuery] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const currentProject = status.currentProject ?? projects.find((project) => project.isCurrent) ?? null;
  const isBusy = busy !== null;
  const visibleProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return [...projects]
      .sort((left, right) => right.openedAtMs - left.openedAtMs)
      .filter((project) => !keyword || project.title.toLowerCase().includes(keyword) || project.rootPath.toLowerCase().includes(keyword))
      .slice(0, 10);
  }, [projects, query]);

  return (
    <>
      <div className="grid h-[calc(100dvh-96px)] min-h-0 overflow-hidden rounded-[28px] border border-border bg-card xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 min-w-0 flex-col border-r border-border/70 bg-secondary/25">
          <div className="px-5 py-5">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{t('home.title')}</h1>
              <Button variant="ghost" size="icon" onClick={onRefresh} disabled={isBusy} className="h-8 w-8 rounded-full">
                {busy === 'load' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>

            <div className="mt-5 flex h-10 items-center gap-2 rounded-2xl bg-background px-3 ring-1 ring-border/70">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('home.search')}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="mt-1 min-h-0 flex-1 overflow-auto px-5">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('home.myLibraries')}</span>
              <span>{visibleProjects.length}</span>
            </div>

            <div className="space-y-1.5">
              {visibleProjects.map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  onClick={() => onSelectProject(project)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-background/70',
                    project.projectId === currentProject?.projectId && 'bg-background shadow-sm',
                  )}
                >
                  <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  {project.projectId === currentProject?.projectId ? <Badge variant="secondary">{t('common.current')}</Badge> : null}
                </button>
              ))}
              {visibleProjects.length === 0 ? <div className="rounded-xl border border-dashed border-border/80 py-8 text-center text-sm text-muted-foreground">{t('common.empty')}</div> : null}
            </div>
          </div>
        </aside>

        <main className="min-h-0 min-w-0 overflow-y-auto px-12 py-10">
          <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">{t('home.recent')}</h2>
              <Button type="button" onClick={() => setCreateDialogOpen(true)} disabled={isBusy} className="h-9 rounded-full bg-foreground px-4 text-background hover:bg-foreground/90">
                <Plus className="h-4 w-4" />
                {t('home.newLibrary')}
              </Button>
            </div>

            <div className="mt-6 overflow-hidden rounded-2xl border border-border/80">
              <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_160px] border-b border-border/70 bg-secondary/30 px-4 py-2 text-xs text-muted-foreground">
                <span>{t('home.table.name')}</span>
                <span>{t('home.table.location')}</span>
                <span>{t('home.table.lastOpened')}</span>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {visibleProjects.length > 0 ? visibleProjects.map((project) => (
                  <button
                    key={project.projectId}
                    type="button"
                    onClick={() => onSelectProject(project)}
                    className="grid w-full grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_160px] items-center border-b border-border/60 px-4 py-3 text-left text-sm last:border-b-0 hover:bg-secondary/35"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{project.title}</span>
                      {project.projectId === currentProject?.projectId ? <Badge variant="secondary">{t('common.current')}</Badge> : null}
                    </span>
                    <span className="truncate text-muted-foreground">{project.rootPath}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(project.openedAtMs, t('time.unrecorded'))}</span>
                  </button>
                )) : (
                  <div className="py-16 text-center text-sm text-muted-foreground">{t('common.empty')}</div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      <LibraryDialog
        open={createDialogOpen}
        openPath={openPath}
        projectName={projectName}
        templates={templates}
        selectedTemplateId={selectedTemplateId}
        busy={busy}
        onOpenPathChange={onOpenPathChange}
        onProjectNameChange={onProjectNameChange}
        onTemplateChange={onTemplateChange}
        onPickDirectory={onPickDirectory}
        onCreateProject={onCreateProject}
        onClose={() => setCreateDialogOpen(false)}
      />
    </>
  );
}
