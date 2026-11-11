import { desktopCapturer, ipcMain, screen, systemPreferences, type BrowserWindow, type WebFrameMain } from 'electron';

type Operation = 'captureScreenSources' | 'captureScreenSource' | 'requestMicrophoneAccess' | 'prepareScreenStream';
interface SourceList { frame: WebFrameMain; expires: number; ids: Set<string> }

export function registerAppDesktopMediaHandlers(getMainWindow: () => BrowserWindow | null, shutdownSignal: AbortSignal): void {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) throw new Error('Desktop media requires the application window.');
  const contents = window.webContents;
  const sourcesByFrame = new Map<string, SourceList>();
  let display: { frame: WebFrameMain; id: string; expires: number } | undefined;
  let waitingDisplay: { finish: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const foreground = () => !shutdownSignal.aborted && !window.isDestroyed() && !contents.isDestroyed() && window.isVisible() && window.isFocused();
  const live = (frame: WebFrameMain) => !frame.detached && frame.parent === contents.mainFrame && frame.url === 'about:srcdoc';
  const clear = () => {
    sourcesByFrame.clear();
    display = undefined;
    waitingDisplay?.finish();
  };
  const mediaSession = contents.session;
  // Microphone authorization stays at the foreground IPC boundary; do not replace the session's unrelated permission policy.
  mediaSession.setDisplayMediaRequestHandler((request, reply) => {
    if (!foreground() || !request.frame || request.frame.detached || request.frame.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId
      || request.frame.frameToken !== contents.mainFrame.frameToken || !request.userGesture || !request.videoRequested || request.audioRequested || waitingDisplay) {
      reply({}); return;
    }
    const finish = () => {
      if (waitingDisplay?.finish === finish) { clearTimeout(waitingDisplay.timer); waitingDisplay = undefined; }
      const selected = display;
      display = undefined;
      if (!selected || !foreground() || !live(selected.frame) || selected.expires <= Date.now()) { reply({}); return; }
      void desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
        const source = sources.find((item) => item.id === selected.id);
        reply(source && foreground() && live(selected.frame) ? { video: source } : {});
      }, () => reply({}));
    };
    // getDisplayMedia starts synchronously in the selection click; its private prepare IPC may arrive second.
    if (display) finish();
    else waitingDisplay = { finish, timer: setTimeout(finish, 5000) };
  });
  ipcMain.handle('app-plugins:desktop-media', async (event, value: unknown) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !foreground()
      || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Desktop media requires the foreground application.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['frameName', 'operation', 'id'].includes(key))
      || typeof input.frameName !== 'string' || !/^matcha-app-[a-f0-9-]{36}$/.test(input.frameName)
      || !['captureScreenSources', 'captureScreenSource', 'requestMicrophoneAccess', 'prepareScreenStream'].includes(String(input.operation))) throw new Error('Invalid desktop media request.');
    const operation = input.operation as Operation;
    const needsSource = operation === 'captureScreenSource' || operation === 'prepareScreenStream';
    if (needsSource ? typeof input.id !== 'string' || input.id.length > 256 : input.id !== undefined) throw new Error('Invalid desktop media source.');
    const matches = contents.mainFrame.frames.filter((frame) => frame.name === input.frameName && live(frame));
    if (matches.length !== 1) throw new Error('Desktop media frame is no longer available.');
    const frame = matches[0]!;
    const active = await frame.executeJavaScript(`({visible:document.visibilityState==='visible'&&!!document.documentElement.getClientRects().length,gesture:navigator.userActivation.isActive,focused:document.hasFocus()})`) as { visible: boolean; gesture: boolean; focused: boolean };
    // Preparing only names a previously listed source. The separate native display request must prove its own userGesture.
    if (!foreground() || !live(frame) || !active.visible || operation !== 'prepareScreenStream' && !(active.gesture && active.focused)) throw new Error('Desktop media requires a current user action in this frame.');
    if (operation === 'requestMicrophoneAccess') {
      const status = process.platform === 'darwin' || process.platform === 'win32' ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown';
      const allowed = status === 'granted' || process.platform === 'darwin' && status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone')
        || process.platform !== 'darwin' && status !== 'denied' && status !== 'restricted';
      return allowed && foreground() && live(frame);
    }
    if (operation === 'captureScreenSources') {
      sourcesByFrame.delete(input.frameName);
      for (const [key, list] of sourcesByFrame) if (list.expires <= Date.now() || !live(list.frame)) sourcesByFrame.delete(key);
      if (sourcesByFrame.size >= 32) throw new Error('Too many desktop media pickers.');
      if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) return { status: 'denied', sources: [] };
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
      if (!foreground() || !live(frame)) throw new Error('Desktop media frame is no longer active.');
      if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') return { status: 'denied', sources: [] };
      const listed = sources.filter((source) => source.id !== window.getMediaSourceId()).map((source) => ({
        id: source.id, name: source.name, kind: source.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      }));
      if (Buffer.byteLength(JSON.stringify(listed)) + 1024 > 8 * 1024 * 1024) throw new Error('Desktop source previews exceed the media limit.');
      sourcesByFrame.set(input.frameName, { frame, expires: Date.now() + 120_000, ids: new Set(listed.map((source) => source.id)) });
      return { status: 'ok', sources: listed };
    }
    const listed = sourcesByFrame.get(input.frameName);
    if (!listed || listed.frame !== frame || listed.expires <= Date.now() || !listed.ids.has(input.id as string)) throw new Error('Choose a source from the current desktop media picker.');
    sourcesByFrame.delete(input.frameName);
    if (operation === 'prepareScreenStream') {
      display = { frame, id: input.id as string, expires: Date.now() + 5000 };
      waitingDisplay?.finish();
      return undefined;
    }
    const displays = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: {
      width: Math.min(4096, Math.max(1920, ...displays.map((item) => Math.ceil(item.size.width * item.scaleFactor)))),
      height: Math.min(4096, Math.max(1080, ...displays.map((item) => Math.ceil(item.size.height * item.scaleFactor)))),
    } });
    if (!foreground() || !live(frame)) throw new Error('Desktop media frame is no longer active.');
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') return null;
    const source = sources.find((item) => item.id === input.id);
    if (!source || source.thumbnail.isEmpty()) return null;
    let image = source.thumbnail;
    let png = image.toPNG();
    while (png.length * 4 / 3 + 1024 > 8 * 1024 * 1024 && image.getSize().width > 1) {
      image = image.resize({ width: Math.max(1, Math.floor(image.getSize().width / 2)) });
      png = image.toPNG();
    }
    if (png.length * 4 / 3 + 1024 > 8 * 1024 * 1024) throw new Error('Desktop image exceeds the media limit.');
    return { mediaType: 'image/png', base64: png.toString('base64'), ...image.getSize() };
  });
  window.on('hide', clear);
  contents.on('did-start-navigation', clear);
  contents.on('render-process-gone', clear);
  shutdownSignal.addEventListener('abort', () => {
    clear();
    ipcMain.removeHandler('app-plugins:desktop-media');
    window.removeListener('hide', clear);
    contents.removeListener('did-start-navigation', clear);
    contents.removeListener('render-process-gone', clear);
    mediaSession.setDisplayMediaRequestHandler(null);
  }, { once: true });
}
