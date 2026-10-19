import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_BROWSER_VIEWPORT_DIMENSION } from '@/types/openclaw-browser';
import { AlertCircle, ArrowLeft, ArrowRight, Keyboard, Loader2, MousePointerClick, PanelTopOpen, RefreshCw, SquareActivity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import { BrowserRuntimeController, browserKeyChord, browserRemotePoint, type BrowserSurfaceTarget } from './browser-runtime-controller';

function RuntimeMetadataRow({ label, value }: { label: string; value?: string | number }) {
  return value === undefined || value === '' ? null : (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs leading-5">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{String(value)}</span>
    </div>
  );
}

export function BrowserRuntimeSurface({ surface, sessionIdentity }: {
  surface: BrowserSurfaceTarget;
  sessionIdentity?: SessionIdentity;
}) {
  const scopeKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : 'browser-surface';
  const surfaceKey = JSON.stringify([scopeKey, surface.target, surface.node, surface.profile, surface.tabId, surface.targetId, surface.toolCallId]);
  return <BrowserSurfaceView key={surfaceKey} surface={surface} scopeKey={scopeKey} />;
}

function BrowserSurfaceView({ surface, scopeKey }: { surface: BrowserSurfaceTarget; scopeKey: string }) {
  const { t } = useTranslation('chat');
  const [controller] = useState(() => new BrowserRuntimeController(surface, scopeKey));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { tabs, targetId, screenshot, busy, error, notice, status } = state;
  const [draft, setDraft] = useState<{ value: string; source: string } | null>(null);
  const [urlEditing, setUrlEditing] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingClick = useRef<(() => void) | null>(null);
  const flushClick = useCallback(() => {
    clearTimeout(clickTimer.current);
    const click = pendingClick.current;
    pendingClick.current = null;
    click?.();
  }, []);
  const title = surface.title || t('browserRuntime.title');
  const selectedTab = useMemo(() => tabs.find((tab) => (tab.tabId || tab.targetId) === targetId), [tabs, targetId]);
  const currentUrl = screenshot?.url || selectedTab?.url || surface.url || '';
  const urlDraft = draft && (urlEditing || draft.source === currentUrl) ? draft.value : currentUrl;

  useLayoutEffect(() => {
    controller.connect();
    return () => { clearTimeout(clickTimer.current); pendingClick.current = null; controller.close(); };
  }, [controller]);
  const hasScreenshot = screenshot !== null;
  useLayoutEffect(() => {
    clearTimeout(clickTimer.current);
    pendingClick.current = null;
    composing.current = false;
    if (inputRef.current) inputRef.current.value = '';
  }, [targetId, hasScreenshot]);
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !screenshot || !targetId) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const bounds = imageRef.current?.getBoundingClientRect();
      const point = bounds ? browserRemotePoint(bounds, event, screenshot.viewport) : null;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? screenshot.viewport?.height || 600 : 1;
      flushClick();
      controller.scroll(event.deltaX * scale, event.deltaY * scale, point ?? undefined);
    };
    preview.addEventListener('wheel', wheel, { passive: false });
    return () => preview.removeEventListener('wheel', wheel);
  }, [controller, flushClick, screenshot, targetId]);

  const draftUrl = urlDraft.trim();
  const destination = draftUrl ? /^[a-z][a-z\d+.-]*:/iu.test(draftUrl) ? draftUrl : `https://${draftUrl}` : '';
  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (!destination) return;
    controller.navigate(destination);
    setUrlEditing(false);
  };
  const press = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    const key = browserKeyChord(native);
    if (!key || !targetId) return;
    event.preventDefault();
    flushClick();
    controller.act({ kind: 'press', targetId, key });
  };
  const clickScreenshot = (event: MouseEvent<HTMLImageElement>) => {
    const point = browserRemotePoint(event.currentTarget.getBoundingClientRect(), event, screenshot?.viewport);
    if (!point || !targetId) return;
    inputRef.current?.focus({ preventScroll: true });
    // Delay the first click so a double-click sends one native dblclick, not three clicks.
    clearTimeout(clickTimer.current);
    const action = { kind: 'clickCoords' as const, targetId, ...point };
    pendingClick.current = null;
    if (event.detail >= 2) controller.act({ ...action, doubleClick: true });
    else {
      pendingClick.current = () => controller.act(action);
      clickTimer.current = setTimeout(flushClick, 250);
    }
  };
  const resize = () => {
    const bounds = previewRef.current?.getBoundingClientRect();
    if (bounds && targetId) controller.act({ kind: 'resize', targetId, width: Math.max(320, Math.min(MAX_BROWSER_VIEWPORT_DIMENSION, Math.round(bounds.width))), height: Math.max(240, Math.min(MAX_BROWSER_VIEWPORT_DIMENSION, Math.round(bounds.height))) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3 py-3">
      <div className="rounded-xl border border-border/60 bg-background px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={title}>{title}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={currentUrl}>{currentUrl || t('browserRuntime.surface')}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-md" onClick={() => controller.refresh()} disabled={busy} aria-label={t('browserRuntime.refresh')} title={t('browserRuntime.refresh')}>
            <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
          </Button>
        </div>
        <form className="mt-3 flex gap-2" onSubmit={navigate}>
          <input
            value={urlDraft}
            onFocus={() => setUrlEditing(true)}
            onBlur={() => setUrlEditing(false)}
            onChange={(event) => setDraft({ value: event.currentTarget.value, source: currentUrl })}
            aria-label={t('browserRuntime.address')}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground outline-none focus:border-border"
            placeholder="https://example.com"
          />
          <Button type="submit" size="sm" className="h-8 px-3" disabled={busy || !targetId}>{t('browserRuntime.navigate')}</Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 px-3" onClick={() => controller.open(destination || 'about:blank')} disabled={busy}>{t('browserRuntime.open')}</Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={() => controller.start()} disabled={busy || status?.enabled === false}>
            <PanelTopOpen className="h-3.5 w-3.5" />{t('browserRuntime.start')}
          </Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={() => controller.act({ kind: 'history', targetId, delta: -1 })} disabled={busy || !targetId} aria-label={t('browserRuntime.back')}><ArrowLeft className="h-3.5 w-3.5" /></Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={() => controller.act({ kind: 'history', targetId, delta: 1 })} disabled={busy || !targetId} aria-label={t('browserRuntime.forward')}><ArrowRight className="h-3.5 w-3.5" /></Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={() => controller.act({ kind: 'reload', targetId })} disabled={busy || !targetId}><RefreshCw className="h-3.5 w-3.5" />{t('browserRuntime.reload')}</Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={resize} disabled={busy || !targetId}><SquareActivity className="h-3.5 w-3.5" />{t('browserRuntime.resize')}</Button>
        </div>
        <details className="mt-3 rounded-lg bg-muted/30 px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">{t(status ? status.running ? 'browserRuntime.running' : status.enabled ? 'browserRuntime.stopped' : 'browserRuntime.disabled' : 'browserRuntime.statusUnknown')}</summary>
          <div className="mt-2 space-y-1.5">
            <RuntimeMetadataRow label={t('browserRuntime.target')} value={surface.target} />
            <RuntimeMetadataRow label={t('browserRuntime.targetId')} value={targetId} />
            <RuntimeMetadataRow label={t('browserRuntime.profile')} value={surface.profile} />
            <RuntimeMetadataRow label={t('browserRuntime.node')} value={surface.node} />
            <RuntimeMetadataRow label={t('browserRuntime.tool')} value={surface.toolName} />
            <RuntimeMetadataRow label={t('browserRuntime.driver')} value={status?.driver} />
            <RuntimeMetadataRow label={t('browserRuntime.viewport')} value={screenshot?.viewport ? `${screenshot.viewport.width} × ${screenshot.viewport.height}` : undefined} />
          </div>
        </details>
      </div>
      {tabs.length ? (
        <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
          {tabs.map((tab) => {
            const id = tab.tabId || tab.targetId;
            return (
              <div key={id} className={cn('flex min-w-[180px] max-w-[240px] items-center gap-1 rounded-lg border px-2 py-1.5', id === targetId ? 'border-border bg-secondary' : 'border-border/50 bg-muted/20')}>
                <button type="button" disabled={busy} className="min-w-0 flex-1 text-left" onClick={() => controller.focus(id)}>
                  <p className="truncate text-xs font-medium text-foreground" title={tab.title}>{tab.title || t('browserRuntime.untitled')}</p>
                  <p className="truncate text-[11px] text-muted-foreground" title={tab.url}>{tab.url || id}</p>
                </button>
                <button type="button" disabled={busy} className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground" onClick={() => controller.closeTab(id)} aria-label={t('browserRuntime.closeTab')}>×</button>
              </div>
            );
          })}
        </div>
      ) : null}
      {error ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"><span className="inline-flex items-start gap-2"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t(`browserRuntime.${error}`)}</span></div> : null}
      {notice ? <div role="status" className="text-xs text-muted-foreground">{t(`browserRuntime.${notice}`)}</div> : null}
      <div
        ref={previewRef}
        className="relative flex min-h-[260px] flex-1 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/20 focus-within:border-border"
      >
        <textarea
          ref={inputRef}
          disabled={!screenshot || !targetId}
          aria-label={t('browserRuntime.inputLabel')}
          autoCapitalize="off" autoComplete="off" spellCheck={false}
          className="absolute left-1 top-1 h-px w-px resize-none opacity-0"
          onKeyDown={press}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(event) => {
            composing.current = false;
            flushClick();
            controller.text(event.currentTarget.value);
            event.currentTarget.value = '';
          }}
          onInput={(event) => {
            if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = '';
            flushClick();
            controller.text(text);
          }}
          onPaste={(event) => {
            event.preventDefault();
            flushClick();
            controller.text(event.clipboardData.getData('text/plain'));
          }}
        />
        {busy && !screenshot ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : null}
        {screenshot ? (
          <img ref={imageRef} data-testid="chat-runtime-browser-screenshot" src={screenshot.dataUrl} alt={title} className={cn('max-h-full max-w-full select-none object-contain', screenshot.viewport ? 'cursor-crosshair' : 'cursor-default')} draggable={false} onClick={clickScreenshot} />
        ) : !busy ? <div className="px-6 text-center text-sm text-muted-foreground">{t('browserRuntime.noScreenshot')}</div> : null}
        <div className="pointer-events-none absolute bottom-2 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full border border-border/50 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          <MousePointerClick className="h-3 w-3 shrink-0" />{t(screenshot && !screenshot.viewport ? 'browserRuntime.viewportUnavailable' : 'browserRuntime.clickHint')}
          <span className="mx-1 text-border">|</span><Keyboard className="h-3 w-3 shrink-0" />{t('browserRuntime.inputHint')}
        </div>
      </div>
    </div>
  );
}
