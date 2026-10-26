import { useId, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Loader2, MoreHorizontal, Plus, Power, Puzzle, RefreshCw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { hostAppPluginInspect } from '@/lib/host-api';
import { requestPluginDevelopment } from '@/plugin-host/development';
import {
  importAppPlugin,
  refreshInstalledAppPlugins,
  rollbackAppPlugin,
  setAppPluginEnabled,
  uninstallAppPlugin,
  useInstalledAppPlugins,
} from '@/plugin-host/installed';
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
type ManagerView =
  | PluginLocation
  | { kind: 'develop'; pluginId: string; from: PluginLocation }
  | { kind: 'confirmation'; action: Confirmation; from: PluginLocation };
type PluginAction = 'detail' | 'enable' | 'disable' | 'uninstall' | 'rollback';

function PluginCapabilities({ manifest }: { manifest: AppPluginManifest }) {
  return (
    <ul className="space-y-2 text-sm text-muted-foreground">
      {manifest.contributes.readers?.map((reader) => (
        <li key={`reader:${reader.id}`} className="[overflow-wrap:anywhere]">
          文件阅读：{reader.name}（{reader.extensions.join('、')}{reader.mimeTypes?.length ? `；${reader.mimeTypes.join('、')}` : ''}）
        </li>
      ))}
      {manifest.contributes.connectors?.map((connector) => (
        <li key={`connector:${connector.id}`} className="[overflow-wrap:anywhere]">
          外部连接：{connector.displayName}（MCP HTTP）{connector.description ? ` — ${connector.description}` : ''}
        </li>
      ))}
    </ul>
  );
}

function PluginMenu({ record, disabled, showDetails = false, onAction }: {
  record: InstalledAppPlugin;
  disabled: boolean;
  showDetails?: boolean;
  onAction: (action: PluginAction) => void;
}) {
  const changingView = useRef(false);
  function select(action: PluginAction) {
    changingView.current = action !== 'enable';
    onAction(action);
  }
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) changingView.current = false; }}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`${record.manifest.name}的更多操作`} disabled={disabled}>
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[120] min-w-44 max-w-[calc(100vw-2rem)]" onCloseAutoFocus={(event) => { if (changingView.current) event.preventDefault(); }}>
        {showDetails && <DropdownMenuItem onSelect={() => select('detail')}><Puzzle className="size-4" aria-hidden="true" />查看详情</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => select(record.enabled ? 'disable' : 'enable')}><Power className="size-4" aria-hidden="true" />{record.enabled ? '停用插件' : '启用插件'}</DropdownMenuItem>
        {record.previous && <DropdownMenuItem onSelect={() => select('rollback')}><RefreshCw className="size-4 shrink-0" aria-hidden="true" /><span className="[overflow-wrap:anywhere]">恢复 v{record.previous.manifest.version}</span></DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive data-[highlighted]:text-destructive" onSelect={() => select('uninstall')}><Trash2 className="size-4" aria-hidden="true" />卸载插件</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function readPackage(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024) return Promise.reject(new Error('插件 ZIP 不能超过 8 MiB，请选择更小的包。'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error('读取插件包失败，请重新选择 ZIP 文件。'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('无法读取插件包，请重新选择文件。'));
    reader.onabort = () => reject(new Error('读取插件包已取消，请重新选择文件。'));
    reader.readAsDataURL(file);
  });
}

export function AppPluginManager({ category, compact = false }: { category: AppPluginKind; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = `${category === 'reader' ? '文件阅读器' : '外部连接器'}插件`;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" variant={compact ? 'ghost' : 'outline'} size="icon" className={compact ? 'size-7 rounded-md' : 'size-9 rounded-full'} aria-label={label} title={label}>
          <Puzzle className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </Dialog.Trigger>
      {open && <AppPluginManagerDialog category={category} onClose={() => setOpen(false)} />}
    </Dialog.Root>
  );
}

function AppPluginManagerDialog({ category, onClose }: { category: AppPluginKind; onClose: () => void }) {
  const navigate = useNavigate();
  const id = useId();
  const { catalog, error: catalogError, loading } = useInstalledAppPlugins();
  const [view, setView] = useState<ManagerView>({ kind: 'list' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [prompt, setPrompt] = useState('');
  const running = useRef(false);
  const packageInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const listFocusId = useRef<string | null>(null);
  const addingDevelopment = useRef(false);
  const label = category === 'reader' ? '文件阅读器' : '外部连接器';
  const plugins = catalog.plugins.filter(({ manifest }) => appPluginHasKind(manifest, category));
  const search = query.trim().toLowerCase();
  const filtered = plugins.filter(({ manifest }) => !search || [manifest.name, manifest.description, manifest.id].some((value) => value?.toLowerCase().includes(search)));
  const selected = view.kind === 'detail' ? plugins.find(({ manifest }) => manifest.id === view.pluginId) : undefined;
  const developmentTarget = view.kind === 'develop' && view.pluginId ? plugins.find(({ manifest }) => manifest.id === view.pluginId) : undefined;
  const targetMissing = view.kind === 'develop' && !!view.pluginId && !developmentTarget;
  const targetMixed = !!developmentTarget && appPluginHasKind(developmentTarget.manifest, category === 'reader' ? 'connector' : 'reader');
  const pending = busy !== null || loading;
  const confirmation = view.kind === 'confirmation' ? view.action : null;
  const confirmationManifest = confirmation?.kind === 'import' ? confirmation.inspection.manifest : confirmation?.record.manifest;
  const replacement = confirmation?.kind === 'import' ? catalog.plugins.find(({ manifest }) => manifest.id === confirmation.inspection.manifest.id) : undefined;
  const actionLabel = confirmation?.kind === 'import' ? replacement ? '更新插件' : '导入插件' : confirmation?.kind === 'disable' ? '停用插件' : confirmation?.kind === 'rollback' ? '恢复上一版' : '卸载插件';
  const backTo = view.kind === 'list' ? null : view.kind === 'detail' ? { kind: 'list' } as const : view.from;

  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    const previousButton = view.kind === 'list' && listFocusId.current ? document.getElementById(`${id}-plugin-${listFocusId.current}`) : null;
    (previousButton ?? (view.kind === 'list' ? searchInput.current : null) ?? title.current)?.focus();
  }, [view.kind, id]);

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
      const message = `${action}失败：${cause instanceof Error ? cause.message : '请重试。'}`;
      setError(message);
      toast.error(message);
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  function inspect(file: File) {
    const from: PluginLocation = view.kind === 'detail' ? view : { kind: 'list' };
    void run('检查插件包', async () => {
      const packageBase64 = await readPackage(file);
      const inspection = await hostAppPluginInspect(packageBase64);
      if (!appPluginHasKind(inspection.manifest, category)) {
        throw new Error(`这个包不提供${label}能力，请在对应业务入口导入。`);
      }
      show({ kind: 'confirmation', action: { kind: 'import', packageBase64, inspection }, from });
    });
  }

  function act(record: InstalledAppPlugin, action: PluginAction) {
    if (pending) return;
    if (action === 'detail') {
      show({ kind: 'detail', pluginId: record.manifest.id });
    } else if (action === 'enable') {
      void run('启用插件', async () => {
        await setAppPluginEnabled(record, true);
        toast.success('插件已启用');
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
      toast.success(`${actionLabel}成功`);
    });
  }

  function openDevelopment(pluginId = '') {
    setPrompt('');
    show({ kind: 'develop', pluginId, from: view.kind === 'detail' ? view : { kind: 'list' } });
  }

  function develop() {
    const requirement = prompt.trim();
    if (view.kind !== 'develop' || !requirement || targetMissing || targetMixed) return;
    void run('发送插件开发需求', async () => {
      await requestPluginDevelopment(category, view.pluginId || undefined, requirement);
      onClose();
      navigate('/');
    });
  }

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[120] bg-[hsl(var(--shell-scrim))]" />
      <Dialog.Content
        aria-busy={pending}
        onOpenAutoFocus={(event) => { event.preventDefault(); (searchInput.current ?? title.current)?.focus(); }}
        onEscapeKeyDown={(event) => { if (running.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (running.current) event.preventDefault(); }}
        className="fixed left-1/2 top-1/2 z-[120] flex h-[min(600px,calc(100dvh-2rem))] w-[calc(100vw-1.5rem)] max-w-[56rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-[hsl(var(--shell-surface))] shadow-elevated outline-none"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/60 p-4 sm:px-6 sm:py-5">
          {backTo && <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={backTo.kind === 'detail' ? '返回插件详情' : '返回插件列表'} disabled={busy !== null} onClick={() => show(backTo)}><ArrowLeft className="size-4" aria-hidden="true" /></Button>}
          <Dialog.Title ref={title} tabIndex={-1} className="min-w-0 flex-1 text-base font-semibold tracking-tight outline-none [overflow-wrap:anywhere] sm:text-lg">
            {view.kind === 'list' ? `${label}插件` : view.kind === 'detail' ? '插件详情' : view.kind === 'develop' ? '让 Agent 制作' : actionLabel}
          </Dialog.Title>
          <Dialog.Description className="sr-only">管理已安装的{label}插件，导入插件或让 Agent 制作。</Dialog.Description>
          {(view.kind === 'list' || view.kind === 'detail') && (
            <DropdownMenu onOpenChange={(open) => { if (open) addingDevelopment.current = false; }}>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" className="shrink-0 gap-1.5 px-3" disabled={pending}><Plus className="size-3.5" aria-hidden="true" />添加插件<ChevronDown className="size-3.5" aria-hidden="true" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[120] min-w-44 max-w-[calc(100vw-2rem)]" onCloseAutoFocus={(event) => { if (addingDevelopment.current) event.preventDefault(); }}>
                <DropdownMenuItem onSelect={() => packageInput.current?.click()}><Upload className="size-4" aria-hidden="true" />导入插件</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { addingDevelopment.current = true; openDevelopment(); }}><Sparkles className="size-4" aria-hidden="true" />让 Agent 制作</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Dialog.Close asChild>
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label="关闭插件管理" disabled={busy !== null}><X className="size-4" aria-hidden="true" /></Button>
          </Dialog.Close>
        </header>

        <input ref={packageInput} type="file" hidden accept=".zip,application/zip,application/x-zip-compressed" disabled={pending} aria-label="选择插件包" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) inspect(file);
        }} />

        <div ref={body} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在{busy}…</p>}
          {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
          {catalogError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><p className="min-w-0 [overflow-wrap:anywhere]">插件列表读取失败：{catalogError}</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void run('刷新插件列表', refreshInstalledAppPlugins)}>重试</Button></div>}

          {view.kind === 'list' && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input ref={searchInput} type="search" value={query} disabled={busy !== null} onChange={(event) => setQuery(event.target.value)} className="h-10 pl-10 pr-3 text-sm" placeholder="搜索已安装插件" aria-label="搜索已安装插件" />
              </div>
              <section aria-label={`已安装的${label}插件`}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-sm font-medium">已安装<span className="rounded-md bg-[hsl(var(--shell-surface-muted))] px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{loading ? '—' : plugins.length}</span></h3>
                  <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="刷新插件列表" title="刷新插件列表" disabled={pending} onClick={() => void run('刷新插件列表', refreshInstalledAppPlugins)}><RefreshCw className="size-3.5" aria-hidden="true" /></Button>
                </div>
                {loading ? (
                  <div role="status" aria-label="正在加载插件列表">
                    <span className="sr-only">正在加载插件列表…</span>
                    <div aria-hidden="true" className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                      {[0, 1, 2, 3].map((item) => <div key={item} className="flex animate-pulse gap-3 p-3 motion-reduce:animate-none"><div className="size-11 shrink-0 rounded-xl bg-muted" /><div className="flex-1 space-y-2 py-1"><div className="h-3 w-2/3 rounded bg-muted" /><div className="h-3 w-full rounded bg-muted" /><div className="h-2 w-1/3 rounded bg-muted" /></div></div>)}
                    </div>
                  </div>
                ) : plugins.length === 0 && !catalogError ? (
                  <div className="flex min-h-64 flex-col items-center justify-center gap-5 py-8 text-center">
                    <Puzzle className="size-10 text-muted-foreground/60" strokeWidth={1.25} aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">暂无{label}插件</p>
                    <div className="flex flex-wrap justify-center gap-2"><Button type="button" size="sm" disabled={pending} onClick={() => packageInput.current?.click()}><Upload className="size-3.5" aria-hidden="true" />导入插件</Button><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => openDevelopment()}><Sparkles className="size-3.5" aria-hidden="true" />让 Agent 制作</Button></div>
                  </div>
                ) : filtered.length === 0 && plugins.length > 0 ? (
                  <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center"><p className="text-sm text-muted-foreground">没有匹配的插件</p><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => { setQuery(''); searchInput.current?.focus(); }}>清除搜索</Button></div>
                ) : (
                  <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {filtered.map((record) => (
                      <li key={record.manifest.id} className="flex min-w-0 items-start rounded-xl transition-colors hover:bg-[hsl(var(--shell-surface-hover))] focus-within:bg-[hsl(var(--shell-surface-hover))] motion-reduce:transition-none">
                        <button id={`${id}-plugin-${record.manifest.id}`} type="button" disabled={pending} onClick={() => show({ kind: 'detail', pluginId: record.manifest.id })} className="flex min-w-0 flex-1 gap-3 rounded-xl p-3 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50">
                          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--shell-surface-muted))] text-[hsl(var(--shell-icon))]"><Puzzle className="size-5" strokeWidth={1.5} aria-hidden="true" /></span>
                          <span className="min-w-0 flex-1">
                            <span className="line-clamp-2 text-sm font-semibold [overflow-wrap:anywhere]">{record.manifest.name}</span>
                            <span className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{record.manifest.description || [...(record.manifest.contributes.readers?.map((reader) => reader.name) ?? []), ...(record.manifest.contributes.connectors?.map((connector) => connector.displayName) ?? [])].join(' · ')}</span>
                            <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"><span className="[overflow-wrap:anywhere]">v{record.manifest.version}</span><span aria-hidden="true">·</span><span>{record.enabled ? '已启用' : '已停用'}</span></span>
                          </span>
                        </button>
                        <div className="mr-1 mt-2 shrink-0"><PluginMenu record={record} disabled={pending} showDetails onAction={(action) => act(record, action)} /></div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {view.kind === 'detail' && (selected ? (
            <div className="mx-auto max-w-2xl space-y-7 py-2 sm:py-4">
              <div className="flex items-start gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-[hsl(var(--shell-surface-muted))] text-[hsl(var(--shell-icon))]"><Puzzle className="size-7" strokeWidth={1.5} aria-hidden="true" /></span>
                <div className="min-w-0 flex-1"><h3 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{selected.manifest.name}</h3>{selected.manifest.description && <p className="mt-2 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{selected.manifest.description}</p>}</div>
                <PluginMenu record={selected} disabled={pending} onAction={(action) => act(selected, action)} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <label className="flex items-center gap-2.5 text-sm text-muted-foreground"><Switch type="button" checked={selected.enabled} aria-label={`启用${selected.manifest.name}`} disabled={pending} onCheckedChange={(enabled) => act(selected, enabled ? 'enable' : 'disable')} />{selected.enabled ? '已启用' : '已停用'}</label>
                <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => packageInput.current?.click()}><Upload className="size-3.5" aria-hidden="true" />更新插件</Button><Button type="button" variant="outline" size="sm" disabled={pending || appPluginHasKind(selected.manifest, category === 'reader' ? 'connector' : 'reader')} onClick={() => openDevelopment(selected.manifest.id)}><Sparkles className="size-3.5" aria-hidden="true" />让 Agent 修改</Button></div>
              </div>
              {appPluginHasKind(selected.manifest, category === 'reader' ? 'connector' : 'reader') && <p className="text-xs text-muted-foreground">此插件包含两类能力，需导入完整插件包更新。</p>}
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl bg-[hsl(var(--shell-surface-muted))] p-4 text-sm">
                <div className="min-w-0"><dt className="text-xs text-muted-foreground">版本</dt><dd className="mt-1 [overflow-wrap:anywhere]">v{selected.manifest.version}</dd></div>
                <div className="min-w-0"><dt className="text-xs text-muted-foreground">来源</dt><dd className="mt-1">{selected.origin === 'manual' ? '手动导入' : 'Agent 制作'}</dd></div>
                <div className="col-span-2 min-w-0"><dt className="text-xs text-muted-foreground">插件 ID</dt><dd className="mt-1 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{selected.manifest.id}</dd></div>
              </dl>
              <section className="space-y-3"><h4 className="text-sm font-medium">提供的能力</h4><PluginCapabilities manifest={selected.manifest} /></section>
            </div>
          ) : <div className="flex min-h-64 flex-col items-center justify-center gap-3"><p className="text-sm text-muted-foreground">此插件已不可用</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => show({ kind: 'list' })}>返回插件列表</Button></div>)}

          {view.kind === 'confirmation' && confirmation && confirmationManifest && (
            <div className="mx-auto max-w-2xl space-y-6 py-2 sm:py-4">
              <section className="space-y-4" aria-label="待确认的插件包">
                <div><h3 className="text-xl font-semibold [overflow-wrap:anywhere]">{confirmationManifest.name}</h3><p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">v{confirmationManifest.version}</p><p className="mt-2 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{confirmationManifest.id}</p></div>
                {confirmationManifest.description && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{confirmationManifest.description}</p>}
                <PluginCapabilities manifest={confirmationManifest} />
                {confirmation.kind === 'rollback' && confirmation.record.previous && <div className="space-y-3 border-t border-border/60 pt-4"><h4 className="text-sm font-medium [overflow-wrap:anywhere]">将恢复至 v{confirmation.record.previous.manifest.version}</h4><PluginCapabilities manifest={confirmation.record.previous.manifest} /></div>}
              </section>
              <div className="space-y-2 rounded-xl bg-[hsl(var(--shell-surface-muted))] p-4 text-sm leading-relaxed text-muted-foreground">
                {confirmation.kind === 'import' ? (
                  <>
                    {!!confirmationManifest.contributes.readers?.length && <p>阅读器可读取交给它的文件内容并显示预览，请确认来源可信。</p>}
                    {!!confirmationManifest.contributes.connectors?.length && <p>连接器仅添加服务配置入口，不会自动连接；实际访问仍需连接配置与运行时授权。</p>}
                    {replacement && <p className="[overflow-wrap:anywhere]">替换同 ID 插件（v{replacement.manifest.version} → v{confirmationManifest.version}），失败保留旧版。</p>}
                    <p>上述能力将整包安装，已有连接、业务配置和文件保留。</p>
                  </>
                ) : (
                  <>
                    <p>{confirmation.kind === 'disable' ? '停用整个插件包，其全部能力将不可用，可重新启用。' : confirmation.kind === 'rollback' ? '整个插件包恢复至单一上一版；恢复后无法再切回当前版。' : '卸载整个插件包，移除其全部能力；需要时可重新导入。'}</p>
                    <p>已有连接、业务配置和文件保留，内置能力不受影响。</p>
                  </>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => show(view.from)}>取消</Button><Button type="button" variant={confirmation.kind === 'disable' || confirmation.kind === 'uninstall' ? 'destructive' : 'default'} disabled={pending} onClick={confirm}>{actionLabel}</Button></div>
            </div>
          )}

          {view.kind === 'develop' && (
            <form className="mx-auto max-w-2xl space-y-6 py-2 sm:py-4" onSubmit={(event) => { event.preventDefault(); develop(); }}>
              <div className="space-y-2.5">
                <Label htmlFor={`${id}-target`}>制作目标</Label>
                <Select id={`${id}-target`} value={view.pluginId} disabled={pending} onChange={(event) => setView({ ...view, pluginId: event.target.value })}>
                  <option value="">新建{label}插件</option>
                  {targetMissing && <option value={view.pluginId} disabled>所选插件已不可用</option>}
                  {plugins.map(({ manifest }) => <option key={manifest.id} value={manifest.id} disabled={appPluginHasKind(manifest, category === 'reader' ? 'connector' : 'reader')}>修改 {manifest.name}（{manifest.id}）</option>)}
                </Select>
                {targetMissing && <p role="alert" className="text-xs text-destructive">所选插件已不可用，请重新选择。</p>}
                {targetMixed && <p role="alert" className="text-xs text-muted-foreground">此插件包含两类能力，需导入完整插件包更新。</p>}
              </div>
              <div className="space-y-2.5"><Label htmlFor={`${id}-prompt`}>你想制作什么？</Label><Textarea id={`${id}-prompt`} value={prompt} disabled={pending} onChange={(event) => setPrompt(event.target.value)} aria-describedby={`${id}-scope`} className="min-h-40 resize-y text-sm" placeholder={category === 'reader' ? '例如：预览 CSV，支持排序和筛选。' : '例如：连接项目服务，查询任务。'} /></div>
              <div className="space-y-3"><p id={`${id}-scope`} className="text-xs text-muted-foreground">仅授权本次{view.pluginId ? '修改所选' : '制作'}{label}插件并安装。</p><div className="flex justify-end"><Button type="submit" disabled={pending || targetMissing || targetMixed || !prompt.trim()}><Sparkles className="size-4" aria-hidden="true" />{view.pluginId ? '让 Agent 修改' : '让 Agent 制作'}</Button></div></div>
            </form>
          )}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
