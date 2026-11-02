import { useId, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowLeft, ArrowUpRight, ChevronDown, Loader2, MoreHorizontal, Plus, Power, Puzzle, RefreshCw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { hostAppPluginInspect } from '@/lib/host-api';
import { stagePluginDevelopmentPrompt } from './development';
import { PluginIdentity } from './PluginIdentity';
import { applicationPath } from './plugin';
import {
  importAppPlugin,
  refreshInstalledAppPlugins,
  rollbackAppPlugin,
  setAppPluginEnabled,
  uninstallAppPlugin,
  useInstalledAppPlugins,
} from './installed';
import {
  appPluginHasKind,
  type AppPluginInspection,
  type AppPluginKind,
  type AppPluginManifest,
  type InstalledAppPlugin,
} from '@/types/desktop/app-plugin';

type Confirmation =
  | { kind: 'import'; packageBase64: string; inspection: AppPluginInspection }
  | { kind: 'disable' | 'uninstall' | 'rollback'; record: InstalledAppPlugin };
type PluginLocation = { kind: 'list' } | { kind: 'detail'; pluginId: string };
type ManagerView = PluginLocation | { kind: 'confirmation'; action: Confirmation; from: PluginLocation };
type PluginAction = 'detail' | 'enable' | 'disable' | 'uninstall' | 'rollback';

function hasOtherKinds(manifest: AppPluginManifest, category: AppPluginKind): boolean {
  return (['reader', 'connector', 'application'] as const).some((kind) => kind !== category && appPluginHasKind(manifest, kind));
}

function PluginCapabilities({ manifest }: { manifest: AppPluginManifest }) {
  const { t } = useTranslation('applicationPlugins');
  return (
    <ul className="space-y-2.5 text-sm leading-6 text-muted-foreground">
      {manifest.contributes.readers?.map((reader) => (
        <li key={`reader:${reader.id}`} className="[overflow-wrap:anywhere]">
          {t('capability.reader', { name: reader.name, formats: [...reader.extensions, ...(reader.mimeTypes ?? [])].join(', ') })}
        </li>
      ))}
      {manifest.contributes.connectors?.map((connector) => (
        <li key={`connector:${connector.id}`} className="[overflow-wrap:anywhere]">
          {t('capability.connector', { name: connector.displayName })}{connector.description && <> · {connector.description}</>}
        </li>
      ))}
      {manifest.contributes.applications?.map((application) => (
        <li key={`application:${application.id}`} className="[overflow-wrap:anywhere]">
          {t('capability.application', { name: application.name, placement: t(application.placement === 'both' ? 'placement.both' : application.placement === 'chat-panel' ? 'placement.chat' : 'placement.page') })}
        </li>
      ))}
      {manifest.contributes.tools?.map((tool) => (
        <li key={`tool:${tool.name}`} className="[overflow-wrap:anywhere]">{t('capability.tool', { description: tool.description })}</li>
      ))}
      {(manifest.main || manifest.backend) && <li>{t('capability.background')}</li>}
    </ul>
  );
}

function PluginMenu({ record, disabled, showDetails = false, onAction }: {
  record: InstalledAppPlugin;
  disabled: boolean;
  showDetails?: boolean;
  onAction: (action: PluginAction) => void;
}) {
  const { t } = useTranslation('applicationPlugins');
  const changingView = useRef(false);
  function select(action: PluginAction) {
    changingView.current = action !== 'enable';
    onAction(action);
  }
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) changingView.current = false; }}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-lg text-muted-foreground" aria-label={t('more', { name: record.manifest.name })} disabled={disabled}>
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[120] min-w-44 max-w-[calc(100vw-2rem)]" onCloseAutoFocus={(event) => { if (changingView.current) event.preventDefault(); }}>
        {showDetails && <DropdownMenuItem onSelect={() => select('detail')}><Puzzle className="size-4" aria-hidden="true" />{t('detail')}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => select(record.enabled ? 'disable' : 'enable')}><Power className="size-4" aria-hidden="true" />{t(record.enabled ? 'disable' : 'enable')}</DropdownMenuItem>
        {record.previous && <DropdownMenuItem onSelect={() => select('rollback')}><RefreshCw className="size-4 shrink-0" aria-hidden="true" /><span className="[overflow-wrap:anywhere]">{t('restoreVersion', { version: record.previous.manifest.version })}</span></DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive data-[highlighted]:text-destructive" onSelect={() => select('uninstall')}><Trash2 className="size-4" aria-hidden="true" />{t('uninstall')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ApplicationLinks({ record }: { record: InstalledAppPlugin }) {
  const { t } = useTranslation('applicationPlugins');
  if (!record.enabled) return null;
  const applications = record.manifest.contributes.applications ?? [];
  return <div className="flex flex-wrap gap-x-4 gap-y-2">
    {applications.map((application) => (
      <Link key={application.id} to={application.placement === 'chat-panel' ? '/' : applicationPath(record.manifest.id, application.id)}
        state={application.placement === 'chat-panel' ? { applicationWorkspace: { pluginId: record.manifest.id, applicationId: application.id } } : undefined}
        title={application.placement === 'chat-panel' ? `${application.name} · ${t('chatPlacement')}` : undefined}
        className="inline-flex max-w-full items-center gap-1 rounded-sm text-xs font-medium leading-5 text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="[overflow-wrap:anywhere]">{applications.length === 1 ? t('open') : t('openNamed', { name: application.name })}</span>
        <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
      </Link>
    ))}
  </div>;
}

function readPackage(file: File, t: TFunction<'applicationPlugins'>): Promise<string> {
  if (file.size > 64 * 1024 * 1024) return Promise.reject(new Error(t('errors.packageTooLarge')));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error(t('errors.packageRead')));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(t('errors.packageUnavailable')));
    reader.onabort = () => reject(new Error(t('errors.packageAborted')));
    reader.readAsDataURL(file);
  });
}

export function AppPluginManager({ category, compact = false }: { category: AppPluginKind; compact?: boolean }) {
  const { t } = useTranslation('applicationPlugins');
  const [open, setOpen] = useState(false);
  const label = t('managerTitle', { category: t(`category.${category}`) });
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" variant={compact ? 'ghost' : 'outline'} size="icon" className={compact ? 'size-7 rounded-md' : 'size-9 rounded-full'} aria-label={label} title={label}>
          <Puzzle className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </Dialog.Trigger>
      {open && <AppPluginManagerContent category={category} onClose={() => setOpen(false)} />}
    </Dialog.Root>
  );
}

export function AppPluginManagerPage() {
  return <AppPluginManagerContent category="application" page />;
}

function AppPluginManagerContent({ category, page = false, onClose }: { category: AppPluginKind; page?: boolean; onClose?: () => void }) {
  const { t } = useTranslation('applicationPlugins');
  const navigate = useNavigate();
  const id = useId();
  const { catalog, error: catalogError, loading } = useInstalledAppPlugins();
  const [view, setView] = useState<ManagerView>({ kind: 'list' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const running = useRef(false);
  const packageInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const listFocusId = useRef<string | null>(null);
  const addingDevelopment = useRef(false);
  const previousView = useRef(view.kind);
  const label = t(`category.${category}`);
  const plugins = catalog.plugins.filter(({ manifest }) => appPluginHasKind(manifest, category));
  const search = query.trim().toLowerCase();
  const filtered = plugins.filter(({ manifest }) => !search || [manifest.name, manifest.description, manifest.id].some((value) => value?.toLowerCase().includes(search)));
  const selected = view.kind === 'detail' ? plugins.find(({ manifest }) => manifest.id === view.pluginId) : undefined;
  const pending = busy !== null || loading;
  const confirmation = view.kind === 'confirmation' ? view.action : null;
  const confirmationManifest = confirmation?.kind === 'import' ? confirmation.inspection.manifest : confirmation?.record.manifest;
  const replacement = confirmation?.kind === 'import' ? catalog.plugins.find(({ manifest }) => manifest.id === confirmation.inspection.manifest.id) : undefined;
  const actionLabel = t(confirmation?.kind === 'import' ? replacement ? 'update' : 'import' : confirmation?.kind === 'disable' ? 'disable' : confirmation?.kind === 'rollback' ? 'rollback' : 'uninstall');
  const backTo = view.kind === 'list' ? null : view.kind === 'detail' ? { kind: 'list' } as const : view.from;

  useLayoutEffect(() => {
    const initialPage = page && previousView.current === 'list' && view.kind === 'list';
    previousView.current = view.kind;
    if (initialPage) return;
    if (body.current) body.current.scrollTop = 0;
    const previousButton = view.kind === 'list' && listFocusId.current ? document.getElementById(`${id}-plugin-${listFocusId.current}`) : null;
    (previousButton ?? (view.kind === 'list' ? searchInput.current : null) ?? title.current)?.focus();
  }, [view.kind, id, page]);

  function show(next: ManagerView) {
    setError(null);
    if (next.kind === 'detail') listFocusId.current = next.pluginId;
    setView(next);
  }

  async function run(action: string, execute: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(action);
    setError(null);
    try {
      await execute();
    } catch (cause) {
      const message = t('errors.actionFailed', { action, reason: cause instanceof Error ? cause.message : t('errors.retry') });
      setError(message);
      toast.error(message);
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  function inspect(file: File) {
    const from: PluginLocation = view.kind === 'detail' ? view : { kind: 'list' };
    void run(t('inspect'), async () => {
      const packageBase64 = await readPackage(file, t);
      const inspection = await hostAppPluginInspect(packageBase64);
      if (!appPluginHasKind(inspection.manifest, category)) {
        throw new Error(t('errors.wrongCategory', { category: label }));
      }
      show({ kind: 'confirmation', action: { kind: 'import', packageBase64, inspection }, from });
    });
  }

  function act(record: InstalledAppPlugin, action: PluginAction) {
    if (pending) return;
    if (action === 'detail') {
      show({ kind: 'detail', pluginId: record.manifest.id });
    } else if (action === 'enable') {
      void run(t('enable'), async () => {
        await setAppPluginEnabled(record, true);
        toast.success(t('enableSuccess'));
      });
    } else {
      show({ kind: 'confirmation', action: { kind: action, record }, from: view.kind === 'detail' ? view : { kind: 'list' } });
    }
  }

  function confirm() {
    if (view.kind !== 'confirmation') return;
    const { action, from } = view;
    void run(actionLabel, async () => {
      if (action.kind === 'import') {
        await importAppPlugin(action.packageBase64, action.inspection.digest);
      } else if (action.kind === 'disable') {
        await setAppPluginEnabled(action.record, false);
      } else if (action.kind === 'rollback') {
        await rollbackAppPlugin(action.record);
      } else {
        await uninstallAppPlugin(action.record);
      }
      show(action.kind === 'import' ? { kind: 'detail', pluginId: action.inspection.manifest.id } : action.kind === 'uninstall' ? { kind: 'list' } : from);
      toast.success(t('importSuccess', { action: actionLabel }));
    });
  }

  function openDevelopment() {
    if (!stagePluginDevelopmentPrompt(category)) {
      setError(t('errors.developmentChatUnavailable'));
      return;
    }
    onClose?.();
    navigate('/');
  }

  const Title = page ? 'h1' : Dialog.Title;
  const content = <>
    <header className={page ? 'flex min-h-11 flex-wrap items-center justify-between gap-4' : 'flex shrink-0 items-center gap-2 border-b border-border/60 p-4 sm:px-6 sm:py-5'}>
      {backTo && <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t(backTo.kind === 'detail' ? 'backDetail' : 'backList')} disabled={busy !== null} onClick={() => show(backTo)}><ArrowLeft className="size-4" aria-hidden="true" /></Button>}
      <div className="min-w-0 flex-1">
        <Title ref={title} tabIndex={-1} className={page ? 'text-2xl font-semibold tracking-[-0.035em] text-foreground outline-none [overflow-wrap:anywhere]' : 'text-base font-semibold tracking-tight outline-none [overflow-wrap:anywhere] sm:text-lg'}>
          {view.kind === 'list' ? page ? t('title') : t('managerTitle', { category: label }) : view.kind === 'detail' ? t('detailTitle') : actionLabel}
        </Title>
        {page && view.kind === 'list' && <p className="mt-1 max-w-2xl text-sm text-[hsl(var(--shell-text-muted))]">{t('subtitle')}</p>}
      </div>
      {(view.kind === 'list' || view.kind === 'detail') && (
        <DropdownMenu onOpenChange={(open) => { if (open) addingDevelopment.current = false; }}>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" className="h-9 shrink-0 gap-2 px-4" disabled={pending}><Plus className="size-4" aria-hidden="true" />{t('add')}<ChevronDown className="size-3.5 opacity-70" aria-hidden="true" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[120] min-w-48 max-w-[calc(100vw-2rem)]" onCloseAutoFocus={(event) => { if (addingDevelopment.current) event.preventDefault(); }}>
            <DropdownMenuItem onSelect={() => packageInput.current?.click()}><Upload className="size-4" aria-hidden="true" />{t('import')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { addingDevelopment.current = true; openDevelopment(); }}><Sparkles className="size-4" aria-hidden="true" />{t('make')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!page && <Dialog.Close asChild><Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t('close')} disabled={busy !== null}><X className="size-4" aria-hidden="true" /></Button></Dialog.Close>}
    </header>

    <input ref={packageInput} type="file" hidden accept=".zip,application/zip,application/x-zip-compressed" disabled={pending} aria-label={t('choosePackage')} onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) inspect(file);
    }} />

    <div ref={body} className={page ? 'space-y-6' : 'min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-6'}>
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('busy', { action: busy })}</p>}
      {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
      {catalogError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><p className="min-w-0 [overflow-wrap:anywhere]">{t('errors.catalog', { reason: catalogError })}</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void run(t('refresh'), refreshInstalledAppPlugins)}>{t('refresh')}</Button></div>}

      {view.kind === 'list' && <>
        <div className={page ? 'relative w-full sm:w-[300px]' : 'relative'}>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input ref={searchInput} type="search" value={query} disabled={busy !== null} onChange={(event) => setQuery(event.target.value)} className={`${page ? 'h-10' : 'h-11'} rounded-xl border-border/70 bg-[hsl(var(--shell-surface-muted))] pl-10 pr-4 text-sm shadow-none`} placeholder={t('search')} aria-label={t('search')} />
        </div>
        <section aria-label={t('installedLabel', { category: label })}>
          <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-3">
            <h2 className="flex items-center gap-2.5 text-sm font-medium">{t('installed')}<span className="text-xs tabular-nums text-muted-foreground">{loading ? '…' : plugins.length}</span></h2>
            <Button type="button" variant="ghost" size="icon" className="size-7 rounded-lg text-muted-foreground" aria-label={t('refresh')} title={t('refresh')} disabled={pending} onClick={() => void run(t('refresh'), refreshInstalledAppPlugins)}><RefreshCw className="size-3.5" aria-hidden="true" /></Button>
          </div>
          {loading ? (
            <div role="status" aria-label={t('loading')}>
              <span className="sr-only">{t('loading')}</span>
              <div aria-hidden="true" className="grid gap-x-8 pt-3 md:grid-cols-2">
                {[0, 1, 2, 3].map((item) => <div key={item} className="flex animate-pulse gap-4 px-3 py-6 motion-reduce:animate-none"><div className="size-12 shrink-0 rounded-2xl bg-muted" /><div className="flex-1 space-y-3 py-1"><div className="h-3 w-2/3 rounded bg-muted" /><div className="h-3 w-full rounded bg-muted" /><div className="h-2 w-1/3 rounded bg-muted" /></div></div>)}
              </div>
            </div>
          ) : plugins.length === 0 && !catalogError ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-4 py-12 text-center">
              <span className="mb-5 flex size-14 items-center justify-center rounded-2xl border border-border/70 bg-[hsl(var(--shell-surface-muted))]"><Puzzle className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" /></span>
              <h3 className="text-base font-medium">{t('emptyTitle', { category: label })}</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{t('emptyHint')}</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2"><Button type="button" size="sm" disabled={pending} onClick={() => packageInput.current?.click()}><Upload className="size-3.5" aria-hidden="true" />{t('import')}</Button><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => openDevelopment()}><Sparkles className="size-3.5" aria-hidden="true" />{t('make')}</Button></div>
            </div>
          ) : filtered.length === 0 && plugins.length > 0 ? (
            <div className="flex min-h-60 flex-col items-center justify-center gap-2 text-center"><Search className="mb-2 size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" /><h3 className="text-sm font-medium">{t('noMatches')}</h3><p className="text-sm text-muted-foreground">{t('noMatchesHint')}</p><Button type="button" variant="ghost" size="sm" className="mt-2" disabled={pending} onClick={() => { setQuery(''); searchInput.current?.focus(); }}>{t('clearSearch')}</Button></div>
          ) : (
            <ul className="grid gap-x-8 pt-2 md:grid-cols-2">
              {filtered.map((record) => {
                const applications = record.manifest.contributes.applications ?? [];
                const description = record.manifest.description || [...(record.manifest.contributes.readers?.map((reader) => reader.name) ?? []), ...(record.manifest.contributes.connectors?.map((connector) => connector.displayName) ?? []), ...applications.map((application) => application.name)].join(' · ');
                return <li key={record.manifest.id} className="group relative flex min-w-0 items-start gap-4 rounded-2xl px-3 py-5 transition-colors duration-150 hover:bg-[hsl(var(--shell-surface-muted))] focus-within:bg-[hsl(var(--shell-surface-muted))] motion-reduce:transition-none">
                  <PluginIdentity manifest={record.manifest} className="mt-1" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-h-8 items-center gap-2">
                      <button id={`${id}-plugin-${record.manifest.id}`} type="button" disabled={pending} onClick={() => show({ kind: 'detail', pluginId: record.manifest.id })} className="min-w-0 rounded-sm text-left text-[15px] font-semibold leading-6 outline-none [overflow-wrap:anywhere] hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{record.manifest.name}</button>
                      <div className="ml-auto shrink-0"><PluginMenu record={record} disabled={pending} showDetails onAction={(action) => act(record, action)} /></div>
                    </div>
                    {description && <p className="mt-1 line-clamp-2 text-[13px] leading-[1.65] text-muted-foreground [overflow-wrap:anywhere]">{description}</p>}
                    <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs leading-5 text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`size-1.5 rounded-full ${record.enabled ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-[hsl(var(--shell-icon))]'}`} />{t(record.enabled ? 'enabled' : 'disabled')}</span>
                      <span aria-hidden="true">·</span><span className="[overflow-wrap:anywhere]">v{record.manifest.version}</span>
                      {category === 'application' && <><span aria-hidden="true">·</span><span>{t(applications.length === 0 ? 'background' : applications.every((application) => application.placement === 'chat-panel') ? 'chatPlacement' : 'pagePlacement')}</span></>}
                    </div>
                    {category === 'application' && record.enabled && applications.length > 0 && <div className="mt-3"><ApplicationLinks record={record} /></div>}
                  </div>
                </li>;
              })}
            </ul>
          )}
        </section>
      </>}

      {view.kind === 'detail' && (selected ? (
        <div className="mx-auto max-w-2xl space-y-7 py-2 sm:py-4">
          <div className="flex items-start gap-4">
            <PluginIdentity manifest={selected.manifest} className="size-16 rounded-2xl text-2xl" />
            <div className="min-w-0 flex-1"><h2 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{selected.manifest.name}</h2>{selected.manifest.description && <p className="mt-2 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{selected.manifest.description}</p>}{category === 'application' && <div className="mt-3"><ApplicationLinks record={selected} /></div>}</div>
            <PluginMenu record={selected} disabled={pending} onAction={(action) => act(selected, action)} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-y border-border/70 py-5">
            <label className="flex items-center gap-2.5 text-sm text-muted-foreground"><Switch type="button" checked={selected.enabled} aria-label={t('enableName', { name: selected.manifest.name })} disabled={pending} onCheckedChange={(enabled) => act(selected, enabled ? 'enable' : 'disable')} />{t(selected.enabled ? 'enabled' : 'disabled')}</label>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => packageInput.current?.click()}><Upload className="size-3.5" aria-hidden="true" />{t('update')}</Button>
          </div>
          {hasOtherKinds(selected.manifest, category) && <p className="text-xs leading-5 text-muted-foreground">{t('mixed')}</p>}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 text-sm">
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('version')}</dt><dd className="mt-1.5 [overflow-wrap:anywhere]">v{selected.manifest.version}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('origin')}</dt><dd className="mt-1.5">{t(selected.origin === 'manual' ? 'manual' : 'agent')}</dd></div>
            <div className="col-span-2 min-w-0"><dt className="text-xs text-muted-foreground">{t('pluginId')}</dt><dd className="mt-1.5 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{selected.manifest.id}</dd></div>
          </dl>
          <section className="space-y-3 border-t border-border/70 pt-6"><h3 className="text-sm font-medium">{t('capabilities')}</h3><PluginCapabilities manifest={selected.manifest} /></section>
        </div>
      ) : <div className="flex min-h-64 flex-col items-center justify-center gap-3"><p className="text-sm text-muted-foreground">{t('unavailable')}</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => show({ kind: 'list' })}>{t('backList')}</Button></div>)}

      {view.kind === 'confirmation' && confirmation && confirmationManifest && (
        <div className="mx-auto max-w-2xl space-y-6 py-2 sm:py-4">
          <section className="space-y-4" aria-label={t('confirmPackage')}>
            <div className="flex items-start gap-4"><PluginIdentity manifest={confirmationManifest} /><div className="min-w-0"><h2 className="text-xl font-semibold [overflow-wrap:anywhere]">{confirmationManifest.name}</h2><p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">v{confirmationManifest.version}</p><p className="mt-2 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{confirmationManifest.id}</p></div></div>
            {confirmationManifest.description && <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{confirmationManifest.description}</p>}
            <PluginCapabilities manifest={confirmationManifest} />
            {confirmation.kind === 'rollback' && confirmation.record.previous && <div className="space-y-3 border-t border-border/60 pt-4"><h3 className="text-sm font-medium [overflow-wrap:anywhere]">{t('trust.restore', { version: confirmation.record.previous.manifest.version })}</h3><PluginCapabilities manifest={confirmation.record.previous.manifest} /></div>}
          </section>
          <div className="space-y-2 rounded-xl bg-[hsl(var(--shell-surface-muted))] p-4 text-sm leading-6 text-muted-foreground">
            {confirmation.kind === 'import' ? <>
              {!!confirmationManifest.contributes.readers?.length && <p>{t('trust.reader')}</p>}
              {!!confirmationManifest.contributes.connectors?.length && <p>{t('trust.connector')}</p>}
              {appPluginHasKind(confirmationManifest, 'application') && <p>{t('trust.application')}</p>}
              {replacement && <p className="[overflow-wrap:anywhere]">{t('trust.replacement', { previous: replacement.manifest.version, next: confirmationManifest.version })}</p>}
              <p>{t('trust.install')}</p>
            </> : <><p>{t(`trust.${confirmation.kind}`)}</p><p>{t('trust.preserve')}</p></>}
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border/70 pt-5"><Button type="button" variant="outline" disabled={pending} onClick={() => show(view.from)}>{t('cancel')}</Button><Button type="button" variant={confirmation.kind === 'disable' || confirmation.kind === 'uninstall' ? 'destructive' : 'default'} disabled={pending} onClick={confirm}>{actionLabel}</Button></div>
        </div>
      )}
    </div>
  </>;

  if (page) return <div aria-busy={pending} className="min-w-0 space-y-6 text-foreground">{content}</div>;
  return <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[120] bg-[hsl(var(--shell-scrim))]" />
    <Dialog.Content aria-busy={pending}
      onOpenAutoFocus={(event) => { event.preventDefault(); (searchInput.current ?? title.current)?.focus(); }}
      onEscapeKeyDown={(event) => { if (running.current) event.preventDefault(); }}
      onInteractOutside={(event) => { if (running.current) event.preventDefault(); }}
      className="fixed left-1/2 top-1/2 z-[120] flex h-[min(600px,calc(100dvh-2rem))] w-[calc(100vw-1.5rem)] max-w-[56rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-[hsl(var(--shell-surface))] shadow-elevated outline-none">
      {content}
    </Dialog.Content>
  </Dialog.Portal>;
}
