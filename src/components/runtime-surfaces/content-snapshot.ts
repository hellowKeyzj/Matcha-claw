import { isRecord, type SandboxChannel } from './sandbox-channel';

export interface RuntimeContentHandle {
  snapshot(signal: AbortSignal): Promise<Blob>;
}

export class WidgetImageError extends Error {
  constructor(readonly code: 'snapshotUnavailable' | 'invalidSnapshot' | 'clipboardUnavailable') {
    super(code);
  }
}

function snapshotBlob(value: unknown): Blob {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 32 * 1024 * 1024) {
    throw new WidgetImageError('invalidSnapshot');
  }
  let binary: string;
  try { binary = atob(value.slice(prefix.length)); } catch { throw new WidgetImageError('invalidSnapshot'); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((byte, index) => bytes[index] !== byte)) throw new WidgetImageError('invalidSnapshot');
  const header = new DataView(bytes.buffer);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) throw new WidgetImageError('invalidSnapshot');
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 16777216) throw new WidgetImageError('invalidSnapshot');
  return new Blob([bytes], { type: 'image/png' });
}

export function requestContentSnapshot(channel: SandboxChannel, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { offMessage(); offClose(); clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const onAbort = () => fail(signal.reason);
    const offClose = channel.onClose(() => fail(new WidgetImageError('snapshotUnavailable')));
    const offMessage = channel.subscribe((data) => {
      if (!isRecord(data) || data.type !== 'openclaw:widget-snapshot' || data.id !== id) return;
      try {
        if ('error' in data) throw new WidgetImageError('snapshotUnavailable');
        const blob = snapshotBlob(data.dataUrl);
        cleanup();
        resolve(blob);
      } catch (error) { fail(error); }
    });
    const timer = setTimeout(() => fail(new WidgetImageError('snapshotUnavailable')), 5000);
    signal.addEventListener('abort', onAbort, { once: true });
    try { channel.post({ type: 'openclaw:widget-snapshot-request', id }); } catch (error) { fail(error); }
  });
}
