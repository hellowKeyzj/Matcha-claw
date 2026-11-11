interface DesktopMediaInput {
  frameName: string;
  operation: 'captureScreenSources' | 'captureScreenSource' | 'requestMicrophoneAccess' | 'prepareScreenStream';
  id?: string;
}
interface DesktopSource { id: string; name: string; thumbnail: string }

export function createAppDesktopMedia(frame: HTMLIFrameElement, port: MessagePort, options: {
  invoke(input: DesktopMediaInput): Promise<unknown>;
  isActive(): boolean;
  text: { chooseScreen: string; cancel: string };
}): { handleMessage(value: unknown): boolean; dispose(): void } {
  let closed = false;
  const sessions = new Map<number, { peer: RTCPeerConnection; stream?: MediaStream; timer: ReturnType<typeof setTimeout>; finishGathering?: () => void }>();
  let picker: { id: number; dialog: HTMLDialogElement; cancel: () => void } | undefined;
  const current = () => !closed && frame.isConnected && options.isActive() && !frame.closest('[inert]') && !frame.closest('[hidden]');
  const post = (value: unknown) => { if (!closed) port.postMessage(value); };
  const stop = (id: number) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    if (picker?.id === id) picker.cancel();
    clearTimeout(session.timer);
    session.finishGathering?.();
    for (const track of session.stream?.getTracks() ?? []) track.stop();
    session.peer.close();
    post({ type: 'desktop-stream-ended', id });
  };
  const chooseScreen = (sources: DesktopSource[], id: number): Promise<MediaStream> => new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', options.text.chooseScreen);
    dialog.style.cssText = 'max-width:min(900px,90vw);max-height:85vh;overflow:auto;padding:20px;border-radius:12px;background:var(--background,#fff);color:var(--foreground,#111)';
    const heading = document.createElement('h2');
    heading.textContent = options.text.chooseScreen;
    dialog.append(heading);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px';
    let settled = false;
    let capturedStream: MediaStream | undefined;
    const releaseCapture = () => { capturedStream?.getTracks().forEach((track) => track.stop()); capturedStream = undefined; };
    const finish = () => { settled = true; dialog.remove(); if (picker?.dialog === dialog) picker = undefined; };
    const cancel = () => { finish(); releaseCapture(); reject(new DOMException('Screen selection cancelled.', 'AbortError')); };
    picker = { id, dialog, cancel };
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); cancel(); });
    for (const source of sources) {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid currentColor;border-radius:6px;cursor:pointer';
      if (source.thumbnail) {
        const image = document.createElement('img');
        image.src = source.thumbnail;
        image.alt = '';
        image.style.cssText = 'width:100%;height:140px;object-fit:contain';
        button.append(image);
      }
      const name = document.createElement('span');
      name.textContent = source.name;
      button.append(name);
      button.addEventListener('click', () => {
        if (!current() || !navigator.userActivation.isActive || !sessions.has(id)) { cancel(); return; }
        for (const item of grid.querySelectorAll('button')) item.disabled = true;
        const prepared = options.invoke({ frameName: frame.name, operation: 'prepareScreenStream', id: source.id });
        const captured = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then((stream) => {
          capturedStream = stream;
          if (settled || !current() || !sessions.has(id)) releaseCapture();
          return stream;
        });
        void Promise.all([prepared, captured]).then(([, stream]) => {
          if (settled || !current() || !sessions.has(id)) { releaseCapture(); return; }
          capturedStream = undefined;
          finish(); resolve(stream);
        }, (error) => {
          finish(); releaseCapture(); reject(error);
        });
      });
      grid.append(button);
    }
    dialog.append(grid);
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = options.text.cancel;
    cancelButton.style.marginTop = '16px';
    cancelButton.onclick = cancel;
    dialog.append(cancelButton);
    document.body.append(dialog);
    dialog.showModal();
    cancelButton.focus();
  });
  const start = async (id: number, operation: string) => {
    const session = sessions.get(id)!;
    try {
      let stream: MediaStream;
      if (operation === 'getMicrophoneStream') {
        if (await options.invoke({ frameName: frame.name, operation: 'requestMicrophoneAccess' }) !== true) throw new DOMException('Microphone access denied.', 'NotAllowedError');
        if (!current() || !sessions.has(id)) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      } else {
        const result = await options.invoke({ frameName: frame.name, operation: 'captureScreenSources' }) as { status: string; sources: DesktopSource[] };
        if (!current() || !sessions.has(id)) return;
        if (result.status !== 'ok' || !Array.isArray(result.sources) || !result.sources.length) throw new DOMException('No screen source is available.', 'NotAllowedError');
        stream = await chooseScreen(result.sources, id);
      }
      if (!current() || sessions.get(id) !== session) { stream.getTracks().forEach((track) => track.stop()); return; }
      session.stream = stream;
      for (const track of stream.getTracks()) {
        session.peer.addTrack(track, stream);
        track.addEventListener('ended', () => stop(id), { once: true });
      }
      await session.peer.setLocalDescription(await session.peer.createOffer());
      if (session.peer.iceGatheringState !== 'complete') await new Promise<void>((resolve) => {
        const finish = () => {
          session.peer.removeEventListener('icegatheringstatechange', changed);
          session.finishGathering = undefined;
          resolve();
        };
        const changed = () => { if (session.peer.iceGatheringState === 'complete') finish(); };
        session.finishGathering = finish;
        session.peer.addEventListener('icegatheringstatechange', changed);
        if (!sessions.has(id)) finish();
      });
      if (current() && sessions.get(id) === session) post({ type: 'desktop-stream-offer', id, sdp: session.peer.localDescription?.sdp });
      else stop(id);
    } catch (error) {
      if (sessions.has(id)) post({ type: 'desktop-stream-error', id, error: error instanceof Error ? error.message : 'Media request failed.' });
      stop(id);
    }
  };
  return {
    handleMessage(value) {
      if (!value || typeof value !== 'object') return false;
      const message = value as Record<string, unknown>;
      if (!['desktop-stream', 'desktop-stream-answer', 'desktop-stream-stop'].includes(String(message.type))) return false;
      const id = Number(message.id);
      if (!Number.isSafeInteger(id) || id < 1) return true;
      if (message.type === 'desktop-stream-stop') { stop(id); return true; }
      if (message.type === 'desktop-stream-answer') {
        const session = sessions.get(id);
        if (session && typeof message.sdp === 'string' && message.sdp.length <= 128_000 && session.peer.signalingState === 'have-local-offer') {
          void session.peer.setRemoteDescription({ type: 'answer', sdp: message.sdp }).catch(() => stop(id));
        }
        return true;
      }
      if (!current() || !document.hasFocus() || document.activeElement !== frame || !navigator.userActivation.isActive
        || picker || sessions.has(id) || sessions.size >= 2 || !['getMicrophoneStream', 'getScreenStream'].includes(String(message.operation))) {
        post({ type: 'desktop-stream-error', id, error: 'Media requires a foreground user action.' }); return true;
      }
      const peer = new RTCPeerConnection({ iceServers: [] });
      const timer = setTimeout(() => { picker?.cancel(); stop(id); }, message.operation === 'getMicrophoneStream' ? 30_000 : 120_000);
      sessions.set(id, { peer, timer });
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') clearTimeout(timer);
        else if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) stop(id);
      };
      void start(id, String(message.operation));
      return true;
    },
    dispose() {
      picker?.cancel();
      for (const id of sessions.keys()) stop(id);
      closed = true;
    },
  };
}
