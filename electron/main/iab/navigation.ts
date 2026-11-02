import type { DownloadItem, Event, Session, WebContents, WebPreferences } from 'electron';

export const IAB_WEB_PREFERENCES: Readonly<WebPreferences> = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  webSecurity: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  disableDialogs: true,
  backgroundThrottling: false,
  focusOnNavigation: false,
});

export function isIabUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

export function normalizeIabUrl(value: string): string {
  const input = value.trim();
  if (!input || input === 'about:blank') return 'about:blank';
  const hostWithPort = /^[^/?#\s:]+:\d+(?:[/?#]|$)/.test(input);
  const url = /^[a-z][a-z0-9+.-]*:/i.test(input) && !hostWithPort ? input : `https://${input}`;
  try {
    const parsed = new URL(url).toString();
    return isIabUrl(parsed) ? parsed : 'about:blank';
  } catch { return 'about:blank'; }
}

export function bindIabNavigation(contents: WebContents): () => void {
  const guard = (event: Electron.Event & Electron.WebContentsWillNavigateEventParams) => {
    if (event.url === 'about:blank' || !isIabUrl(event.url)) event.preventDefault();
  };
  const frameGuard = (event: Electron.Event & Electron.WebContentsWillFrameNavigateEventParams) => {
    if (!event.isMainFrame) guard(event);
  };
  contents.on('will-navigate', guard);
  contents.on('will-frame-navigate', frameGuard);
  contents.on('will-redirect', guard);
  return () => {
    contents.removeListener('will-navigate', guard);
    contents.removeListener('will-frame-navigate', frameGuard);
    contents.removeListener('will-redirect', guard);
  };
}

/** A popup that becomes a download closes only after completion, not while a save dialog is open. */
export function watchDownloadPopup(contents: WebContents, initialUrl: string, onCompleted: () => void): () => void {
  const session: Session = contents.session;
  let download: DownloadItem | undefined;
  let firstNavigation = false;
  let blank = initialUrl === 'about:blank';
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    session.removeListener('will-download', onDownload);
    contents.removeListener('did-start-navigation', onStart);
    contents.removeListener('did-navigate', onNavigate);
    contents.removeListener('did-navigate-in-page', onNavigate);
    contents.removeListener('destroyed', dispose);
    contents.removeListener('before-mouse-event', onMouse);
    contents.removeListener('before-input-event', onInput);
    download?.removeListener('done', onDone);
  };
  const onStart = (_event: Event, url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!mainFrame || inPlace || (blank && url === 'about:blank' && !download)) return;
    blank = false;
    if (firstNavigation) dispose();
    firstNavigation = true;
  };
  const onNavigate = (_event: Event, url: string) => {
    if (!(blank && url === 'about:blank' && !download)) dispose();
  };
  const onMouse = (_event: Event, input: Electron.MouseInputEvent) => { if (input.type === 'mouseDown') dispose(); };
  const onInput = (_event: Event, input: Electron.Input) => { if (input.type === 'keyDown') dispose(); };
  const onDone = (_event: Event, state: string) => {
    if (state !== 'completed') return dispose();
    queueMicrotask(() => {
      if (disposed || contents.isDestroyed()) return;
      dispose();
      onCompleted();
    });
  };
  const onDownload = (event: Event, item: DownloadItem, source: WebContents) => {
    if (source !== contents) return;
    if (event.defaultPrevented) return dispose();
    clearTimeout(timer);
    session.removeListener('will-download', onDownload);
    download = item;
    item.once('done', onDone);
    if (item.getState() !== 'progressing') onDone(event, item.getState());
  };
  contents.on('did-start-navigation', onStart);
  contents.on('did-navigate', onNavigate);
  contents.on('did-navigate-in-page', onNavigate);
  contents.once('destroyed', dispose);
  contents.on('before-mouse-event', onMouse);
  contents.on('before-input-event', onInput);
  session.on('will-download', onDownload);
  const timer = setTimeout(dispose, 300_000);
  timer.unref();
  return dispose;
}
