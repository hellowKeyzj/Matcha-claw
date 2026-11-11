// Serialized into the opaque application frame; keep all dependencies inside this function.
export function installAppDesktopMediaBridge(send: (value: unknown) => void): {
  getMicrophoneStream(): Promise<MediaStream>;
  getScreenStream(): Promise<MediaStream>;
  handleMessage(value: unknown): boolean;
  dispose(): void;
} {
  const PeerConnection = RTCPeerConnection;
  const Stream = MediaStream;
  let nextId = 0;
  let closed = false;
  const calls = new Map<number, { peer: RTCPeerConnection; stream: MediaStream; resolve: (stream: MediaStream) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; finishGathering?: () => void }>();
  const close = (id: number, error?: Error) => {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    clearTimeout(call.timer);
    call.finishGathering?.();
    call.peer.close();
    for (const track of call.stream.getTracks()) track.stop();
    call.reject(error ?? new DOMException('Media stream closed.', 'AbortError'));
    if (!closed) send({ type: 'desktop-stream-stop', id });
  };
  const open = (operation: 'getMicrophoneStream' | 'getScreenStream'): Promise<MediaStream> => {
    if (closed || !document.hasFocus() || !navigator.userActivation.isActive || calls.size >= 2) return Promise.reject(new DOMException('Media requires a foreground user action.', 'NotAllowedError'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const peer = new PeerConnection({ iceServers: [] });
      const stream = new Stream();
      const timer = setTimeout(() => close(id, new DOMException('Media request timed out.', 'AbortError')), 120_000);
      calls.set(id, { peer, stream, resolve, reject, timer });
      peer.ontrack = (event) => {
        if (!calls.has(id)) { event.track.stop(); return; }
        stream.addTrack(event.track);
        const stop = event.track.stop.bind(event.track);
        event.track.stop = () => { stop(); close(id); };
        event.track.addEventListener('ended', () => close(id), { once: true });
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') { clearTimeout(timer); resolve(stream); }
        else if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) close(id);
      };
      send({ type: 'desktop-stream', id, operation });
    });
  };
  return {
    getMicrophoneStream: () => open('getMicrophoneStream'),
    getScreenStream: () => open('getScreenStream'),
    handleMessage(value) {
      if (!value || typeof value !== 'object') return false;
      const message = value as Record<string, unknown>;
      if (!['desktop-stream-offer', 'desktop-stream-error', 'desktop-stream-ended'].includes(String(message.type))) return false;
      const id = Number(message.id);
      const call = calls.get(id);
      if (!call) return true;
      if (message.type !== 'desktop-stream-offer') { close(id, new DOMException(typeof message.error === 'string' ? message.error : 'Media stream ended.', 'AbortError')); return true; }
      if (typeof message.sdp !== 'string' || message.sdp.length > 128_000 || call.peer.signalingState !== 'stable') { close(id); return true; }
      void (async () => {
        await call.peer.setRemoteDescription({ type: 'offer', sdp: message.sdp as string });
        await call.peer.setLocalDescription(await call.peer.createAnswer());
        if (call.peer.iceGatheringState !== 'complete') await new Promise<void>((resolve) => {
          const finish = () => {
            call.peer.removeEventListener('icegatheringstatechange', changed);
            call.finishGathering = undefined;
            resolve();
          };
          const changed = () => { if (call.peer.iceGatheringState === 'complete') finish(); };
          call.finishGathering = finish;
          call.peer.addEventListener('icegatheringstatechange', changed);
          if (!calls.has(id)) finish();
        });
        if (calls.get(id) === call) send({ type: 'desktop-stream-answer', id, sdp: call.peer.localDescription?.sdp });
      })().catch(() => close(id));
      return true;
    },
    dispose() {
      for (const id of calls.keys()) close(id);
      closed = true;
    },
  };
}
