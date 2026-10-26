import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

export type WorldPrivateAdmissionDependencies = Readonly<{
  getMainWindow: () => BrowserWindow | null;
  authorizeInitialImport: () => Promise<boolean>;
}>;
export class WorldPrivateAdmissionError extends Error {
  constructor(readonly reason: 'authorization-denied' | 'authorization-unavailable') { super(reason); }
}
export function trustedWorldWindow(event: IpcMainInvokeEvent, getMainWindow: () => BrowserWindow | null): BrowserWindow | null {
  const window = getMainWindow();
  return window && !window.isDestroyed() && !window.webContents.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame ? window : null;
}
/** A local IPC caller gate only; it neither creates nor replaces World authority. */
export function worldPrivateAdmission(
  event: IpcMainInvokeEvent, signal: AbortSignal, deps: WorldPrivateAdmissionDependencies,
): () => Promise<void> {
  return async () => {
    if (signal.aborted || !trustedWorldWindow(event, deps.getMainWindow)) throw new WorldPrivateAdmissionError('authorization-denied');
    let allowed: boolean;
    try { allowed = await deps.authorizeInitialImport(); }
    catch { throw new WorldPrivateAdmissionError('authorization-unavailable'); }
    if (!allowed || signal.aborted || !trustedWorldWindow(event, deps.getMainWindow)) throw new WorldPrivateAdmissionError('authorization-denied');
  };
}
