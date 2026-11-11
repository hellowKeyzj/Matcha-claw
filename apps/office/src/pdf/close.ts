import { flushBrowserStorage } from '../platform/browser-storage';
import { ipcRenderer } from '../platform/electron-preload';
import { chooseUnsavedAction } from '../ui/document-actions';

export function installPdfClose() {
  let closing = false;
  async function canLeave(signal?: AbortSignal): Promise<boolean> {
    (document.activeElement as HTMLElement | null)?.blur?.();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (signal?.aborted) return false;
    if (!await ipcRenderer.invoke('office:dirty')) return true;
    const choice = await chooseUnsavedAction(signal);
    if (signal?.aborted || choice === 'cancel') return false;
    return choice === 'discard' || await ipcRenderer.invoke('office:flush') === true;
  }
  window.matchaApp?.onCloseRequested?.(async (signal) => {
    if (closing) return false;
    closing = true;
    try {
      if (!await canLeave(signal)) return false;
      await flushBrowserStorage();
      await ipcRenderer.invoke('office:close-editor');
      return true;
    } catch (error) { console.error(error); return false; }
    finally { closing = false; }
  });
  return canLeave;
}
