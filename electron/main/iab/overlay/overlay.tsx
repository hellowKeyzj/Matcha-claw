import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Popover from '@radix-ui/react-popover';
import {
  Camera, Check, ChevronRight, Download, Eraser, ExternalLink,
  Globe, History, Minus, Plus, RotateCcw, Search, X, ZoomIn,
} from 'lucide-react';

import type { IabDownloadCommand, IabMenuAction, IabOverlayCommand, IabOverlayState, IabToolAnchor } from '../../../../src/types/desktop/iab';
import { DownloadIcon, DownloadRow } from './download-row';
import { labelsFor, type Labels } from './labels';

type State = NonNullable<IabOverlayState>;
type Command = IabOverlayCommand extends infer Value ? Value extends IabOverlayCommand ? Omit<Value, 'sessionId'> : never : never;
type Api = {
  getState(): Promise<IabOverlayState>;
  onState(callback: (state: IabOverlayState) => void): () => void;
  command(command: IabOverlayCommand): Promise<void>;
};
declare global { interface Window { iabOverlay: Api } }
const api = window.iabOverlay;

function useAction(sessionId: number) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const perform = useCallback((command: Command): void => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    void api.command({ ...command, sessionId }).catch(() => {
      if (mounted.current) setFailed(true);
    }).finally(() => {
      running.current = false;
      if (mounted.current) setBusy(false);
    });
  }, [sessionId]);
  return { busy, failed, perform };
}

const Menu = memo(function Menu({ state, labels, dismiss }: {
  state: Extract<State, { kind: 'menu' }>; labels: Labels; dismiss(): void;
}) {
  const [failed, setFailed] = useState(false);
  const anchor = state.anchor as IabToolAnchor;
  const action = (command: IabMenuAction): void => {
    void api.command({ sessionId: state.sessionId, action: 'menu', command }).catch(() => setFailed(true));
  };
  const row = (label: string, icon: ReactNode, command: IabMenuAction, disabled = false) =>
    <button type="button" className="menu-row" onClick={() => action(command)} disabled={disabled}>
      {icon}<span className="grow">{label}</span>
    </button>;
  return <Popover.Root open modal onOpenChange={(open) => { if (!open) dismiss(); }}>
    <ToolAnchor state={state} />
    <Popover.Portal>
      <Popover.Content className="panel menu" aria-label={labels.more} aria-describedby={undefined}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { if (!anchor.keyboard) event.preventDefault(); }}
        align="end" side="bottom" sideOffset={8} collisionPadding={12}>
        <button type="button" className="menu-row" onClick={() => action('find')}>
          <Search aria-hidden="true" /><span className="grow">{labels.find}</span><span className="shortcut">{state.findShortcut}</span>
        </button>
        <div className="zoom" role="group" aria-label={labels.zoom}>
          <ZoomIn aria-hidden="true" /><span className="grow">{labels.zoom}</span>
          <div className="zoom-controls">
            <button type="button" className="icon-button" aria-label={labels.zoomOut} title={labels.zoomOut}
              disabled={state.zoomFactor <= .25} onClick={() => action('zoom-out')}><Minus aria-hidden="true" /></button>
            <output aria-live="polite">{Math.round(state.zoomFactor * 100)}%</output>
            <button type="button" className="icon-button" aria-label={labels.zoomIn} title={labels.zoomIn}
              disabled={state.zoomFactor >= 5} onClick={() => action('zoom-in')}><Plus aria-hidden="true" /></button>
          </div>
          <button type="button" className="icon-button" aria-label={labels.resetZoom} title={labels.resetZoom}
            disabled={Math.abs(state.zoomFactor - 1) < .001} onClick={() => action('zoom-reset')}><RotateCcw aria-hidden="true" /></button>
        </div>
        {row(labels.screenshot, <Camera aria-hidden="true" />, 'screenshot', !state.canCapturePage)}
        <div className="separator" role="separator" />
        <Popover.Root>
          <Popover.Trigger asChild><button type="button" className="menu-row">
            <Eraser aria-hidden="true" /><span className="grow">{labels.clearData}</span><ChevronRight aria-hidden="true" />
          </button></Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="panel submenu" aria-label={labels.clearData} aria-describedby={undefined}
              side="right" align="start" sideOffset={8} collisionPadding={12}>
              <button type="button" className="menu-row" onClick={() => action('clear-cache')}>{labels.clearCache}</button>
              <button type="button" className="menu-row" onClick={() => action('clear-site-data')}>{labels.clearSiteData}</button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {row(labels.downloads, <Download aria-hidden="true" />, 'downloads')}
        {row(labels.history, <History aria-hidden="true" />, 'history')}
        <div className="separator" role="separator" />
        {row(labels.openExternal, <ExternalLink aria-hidden="true" />, 'open-external', !state.canOpenExternal)}
        {(failed || state.error) && <p className="error" role="alert">{labels.failed}</p>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
});

function ToolAnchor({ state }: { state: State }) {
  const { anchor } = state;
  return <Popover.Anchor asChild><span aria-hidden="true" style={{
    position: 'fixed', left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height, pointerEvents: 'none',
  }} /></Popover.Anchor>;
}

function Downloads({ state, labels, dismiss }: {
  state: Extract<State, { kind: 'downloads' }>; labels: Labels; dismiss(): void;
}) {
  const { busy, failed, perform } = useAction(state.sessionId);
  const onAction = useCallback((command: IabDownloadCommand) => {
    perform({ action: 'download', command });
  }, [perform]);
  const anchor = state.anchor as IabToolAnchor;
  return <Popover.Root open modal onOpenChange={(open) => { if (!open) dismiss(); }}>
    <ToolAnchor state={state} />
    <Popover.Portal>
      <Popover.Content className="panel downloads" aria-label={labels.downloads} aria-describedby={undefined}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { if (!anchor.keyboard) event.preventDefault(); }}
        align="end" side="bottom" sideOffset={8} collisionPadding={12}
        style={{ maxWidth: anchor.browserBounds ? Math.max(0, anchor.browserBounds.width - 24) : undefined }}>
        <header><h2 className="grow">{labels.downloads}</h2>
          <button type="button" className="icon-button" aria-label={labels.openDirectory} title={labels.openDirectory}
            disabled={busy} onClick={() => perform({ action: 'download', command: { action: 'open-directory' } })}>
            <DownloadIcon name="folder_open" size={19} />
          </button>
          <button type="button" className="icon-button" aria-label={labels.close} onClick={dismiss}><DownloadIcon name="close" size={16} /></button>
        </header>
        {(failed || state.error) && <p role="alert" className="error">{labels.failed}</p>}
        {state.entries.length ? <ul aria-busy={busy}>
          {state.entries.map((entry) => <DownloadRow key={entry.id} {...entry} locale={state.locale}
            labels={labels} busy={busy} onAction={onAction} />)}
        </ul> : <p role="status" className="empty">{labels.empty}</p>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

const Suggestions = memo(function Suggestions({ state, labels }: {
  state: Extract<State, { kind: 'suggestions' }>; labels: Labels;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { selected.current?.scrollIntoView({ block: 'nearest' }); }, [state.selectedIndex, state.entries]);
  const command = (action: 'select-suggestion' | 'remove-suggestion', id: string): void => {
    void api.command({ sessionId: state.sessionId, action, id }).catch(() => {});
  };
  return <section className="panel suggestions" aria-label={labels.history} role="listbox">
    {state.entries.map((entry, index) => <div key={entry.id} className={`suggestion${index === state.selectedIndex ? ' selected' : ''}`}
      role="option" aria-selected={index === state.selectedIndex}>
      <button type="button" className="choose" tabIndex={-1} ref={index === state.selectedIndex ? selected : undefined}
        onClick={(event) => { if (event.detail === 0) command('select-suggestion', entry.id); }}
        onPointerDown={(event) => { event.preventDefault(); command('select-suggestion', entry.id); }}>
        {entry.faviconUrl ? <img src={entry.faviconUrl} alt="" /> : <Globe aria-hidden="true" />}
        <span className="grow truncate">{entry.title || new URL(entry.url).hostname}
          <span className="muted"> — {new URL(entry.url).host}</span>
        </span>
      </button>
      <button type="button" className="icon-button remove" aria-label={labels.removeSuggestion} title={labels.removeSuggestion}
        onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onClick={(event) => { event.stopPropagation(); command('remove-suggestion', entry.id); }}>
        <X aria-hidden="true" />
      </button>
    </div>)}
  </section>;
});

function DownloadNotice({ state, labels, dismiss }: {
  state: Extract<State, { kind: 'download' }>; labels: Labels; dismiss(): void;
}) {
  const { busy, failed, perform } = useAction(state.sessionId);
  return <section className="panel notice" aria-label={labels.completed}
    onKeyDown={(event) => { if (event.key === 'Escape') dismiss(); }}>
    <div className="notice-main"><DownloadIcon name="check_circle" size={20} />
      <div className="grow" role="status" aria-live="polite"><h2>{labels.completed}</h2>
        <p className="filename truncate" title={state.download.filename}>{state.download.filename}</p>
      </div>
      <button type="button" className="icon-button" aria-label={labels.close} onClick={dismiss}><DownloadIcon name="close" size={16} /></button>
    </div>
    {(failed || state.error) && <p role="alert" className="error">{labels.failed}</p>}
    <div className="notice-actions" aria-busy={busy}>
      <button type="button" disabled={busy} onClick={() => perform({ action: 'download', command: { action: 'show-in-folder', id: state.download.id } })}>
        {labels.showInFolder}
      </button>
      <button type="button" className="primary" disabled={busy}
        onClick={() => perform({ action: 'download', command: { action: 'open', id: state.download.id } })}>{labels.open}</button>
    </div>
  </section>;
}

function Overlay() {
  const [state, setState] = useState<IabOverlayState>(null);
  useEffect(() => {
    let mounted = true;
    let received = false;
    const update = (value: IabOverlayState): void => {
      if (!mounted) return;
      document.documentElement.classList.toggle('dark', value?.theme === 'dark');
      document.documentElement.lang = value?.locale ?? 'en';
      setState(value);
    };
    const unsubscribe = api.onState((value) => { received = true; update(value); });
    void api.getState().then((value) => { if (!received) update(value); });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  const sessionId = state?.sessionId;
  const locale = state?.locale ?? 'en';
  const labels = useMemo(() => labelsFor(locale), [locale]);
  const dismiss = useCallback(() => {
    if (sessionId !== undefined) void api.command({ sessionId, action: 'dismiss' });
  }, [sessionId]);
  if (state?.kind === 'suggestions') return <Suggestions state={state} labels={labels} />;
  if (state?.kind === 'toast') return <div className="toast-position"><section className="panel toast" role="status" aria-live="polite" aria-atomic="true">
    <span className="toast-check" aria-hidden="true"><Check /></span><p>{state.message}</p>
  </section></div>;
  if (state?.kind === 'downloads') return <Downloads key={state.sessionId} state={state} labels={labels} dismiss={dismiss} />;
  if (state?.kind === 'download') return <DownloadNotice key={state.sessionId} state={state} labels={labels} dismiss={dismiss} />;
  if (state?.kind === 'menu') return <Menu key={state.sessionId} state={state} labels={labels} dismiss={dismiss} />;
  return null;
}

createRoot(document.getElementById('root')!).render(<Overlay />);
