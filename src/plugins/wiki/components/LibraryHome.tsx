import { useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, FolderPlus, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatDateTime, type WikiProject, type WikiProjectTemplate, type WikiStatus } from '@/plugins/wiki/wiki-model';
import './LibraryHome.css';

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
      .filter((project) => !keyword || project.title.toLowerCase().includes(keyword) || project.rootPath.toLowerCase().includes(keyword));
  }, [projects, query]);

  return (
    <>
      <main className="library-home">
        <header className="library-home-header">
          <h1>{t('home.title')}</h1>
          <div className="library-home-actions">
            <Button type="button" variant="ghost" size="icon" onClick={onRefresh} disabled={isBusy} aria-label={t('common.refresh')}>
              {busy === 'load' ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
            </Button>
            <Button type="button" size="sm" onClick={() => setCreateDialogOpen(true)} disabled={isBusy} className="library-home-create">
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t('home.newLibrary')}
            </Button>
          </div>
        </header>

        <div className="library-home-body" aria-busy={isBusy}>
          <div className="library-home-toolbar">
            <label className="library-home-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('home.search')}
                aria-label={t('home.search')}
              />
            </label>
          </div>
          <div className="library-home-table-scroll">
            <table className="library-home-table" aria-label={t('home.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('home.table.name')}</th>
                  <th scope="col">{t('home.table.location')}</th>
                  <th scope="col">{t('home.table.lastOpened')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleProjects.map((project) => (
                  <tr key={project.projectId} aria-disabled={isBusy} onClick={() => { if (!isBusy) onSelectProject(project); }}>
                    <td>
                      <button
                        type="button"
                        className="library-home-project"
                        title={project.title}
                        disabled={isBusy}
                        onClick={(event) => { event.stopPropagation(); onSelectProject(project); }}
                      >
                        <span className="library-home-icon"><FolderOpen aria-hidden="true" /></span>
                        <strong>{project.title}</strong>
                        {project.projectId === currentProject?.projectId ? <span className="library-home-current">{t('common.current')}</span> : null}
                      </button>
                    </td>
                    <td><span className="library-home-path" title={project.rootPath}>{project.rootPath}</span></td>
                    <td>{formatDateTime(project.openedAtMs, t('time.unrecorded'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleProjects.length === 0 ? <div className="library-home-empty" role="status">{t(projects.length > 0 && query.trim() ? 'home.noResults' : 'common.empty')}</div> : null}
          </div>
        </div>
      </main>

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
