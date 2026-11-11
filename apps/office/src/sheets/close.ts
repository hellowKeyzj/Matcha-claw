import type { DesktopApi } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import { callTool } from '../documents/client';
import { editorId } from '../platform/electron-preload';
import { chooseUnsavedAction } from '../ui/document-actions';
import { flushBrowserStorage } from '../platform/browser-storage';

export function installSheetsClose(desktop: DesktopApi): (signal?: AbortSignal) => Promise<boolean> {
  const closeSaveListeners = new Set<() => void>();
  let pendingEdits = 0;
  let saveWaiter: ((ok: boolean) => void) | undefined;
  let closing = false;
  Object.assign(desktop, {
    notifyPendingEdits(count: number) { pendingEdits = count; },
    onCloseSaveRequest(callback: () => void) {
      closeSaveListeners.add(callback);
      return () => closeSaveListeners.delete(callback);
    },
    reportCloseSaveResult(ok: boolean) { saveWaiter?.(ok); }
  });

  async function canLeaveWorkbook(signal?: AbortSignal): Promise<boolean> {
    // The upstream close-save callback commits the active cell editor before
    // inspecting its journal, then reports the actual save outcome.
    (document.activeElement as HTMLElement | null)?.blur?.();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (signal?.aborted) return false;
    if (pendingEdits <= 0) return true;
    const action = await chooseUnsavedAction(signal);
    if (signal?.aborted || action === 'cancel') return false;
    if (action === 'discard') return true;
    if (closeSaveListeners.size === 0) return false;
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        saveWaiter = undefined;
        resolve(ok && !signal?.aborted);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), 120_000);
      saveWaiter = finish;
      signal?.addEventListener('abort', abort, { once: true });
      for (const listener of closeSaveListeners) listener();
    });
  }

  window.matchaApp?.onCloseRequested?.(async (signal) => {
    if (closing) return false;
    closing = true;
    try {
      if (!(await canLeaveWorkbook(signal))) return false;
      await flushBrowserStorage();
      if (signal.aborted) return false;
      await callTool('office_sheets_ipc', { channel: 'office:close-editor', editorId });
      return true;
    } catch {
      return false;
    } finally {
      closing = false;
    }
  });
  return canLeaveWorkbook;
}
