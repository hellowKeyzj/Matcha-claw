import { ipcRenderer } from '../platform/electron-preload';
import { chooseUnsavedAction } from '../ui/document-actions';
import { flushBrowserStorage } from '../platform/browser-storage';
import { cancelPendingEdits, hasPendingEdits } from '../../genoffice/apps/slides/src/renderer/file-actions';

/** Keep unflushed input and the upstream App's actual save result in one close owner. */
export function createSlidesClose(bridge: Window['slidesApi'], cancelOpen: () => void) {
  let localEditRevision = 0;
  let savedLocalRevision = 0;
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('.notes-pane, .format-pane, .ribbon'))) localEditRevision++;
  }, true);

  async function save(operation: () => ReturnType<typeof bridge.save>): ReturnType<typeof bridge.save> {
    const revision = localEditRevision;
    const result = await operation();
    if (result.ok) savedLocalRevision = revision;
    return result;
  }
  const nativeSave = bridge.save;
  bridge.save = () => save(nativeSave);
  let autoSave = false;
  const setAutoSavePref = bridge.setAutoSavePref;
  bridge.setAutoSavePref = on => { autoSave = on; setAutoSavePref(on); };

  // App owns the real save flow: active edit + notes flush, save, render adoption.
  let saveHandler: (() => void) | undefined;
  let pendingSave: Promise<boolean> | undefined;
  let finishSave: ((ok: boolean) => void) | undefined;
  bridge.onCloseSaveRequest = (handler) => {
    saveHandler = handler;
    return () => { if (saveHandler === handler) saveHandler = undefined; };
  };
  bridge.reportCloseSaveResult = (ok) => finishSave?.(ok);
  function saveBeforeLeaving(): Promise<boolean> {
    if (pendingSave) return pendingSave;
    if (!saveHandler) return Promise.resolve(false);
    let timer: ReturnType<typeof setTimeout>;
    pendingSave = new Promise<boolean>((resolve) => {
      finishSave = resolve;
      timer = setTimeout(() => resolve(false), 120_000);
    });
    const result = pendingSave.finally(() => { clearTimeout(timer); pendingSave = undefined; finishSave = undefined; });
    try { saveHandler(); } catch { finishSave?.(false); }
    return result;
  }
  async function confirmLeaving(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const active = document.activeElement as HTMLElement | null;
    active?.blur();
    if (localEditRevision === savedLocalRevision && !hasPendingEdits() && !await bridge.isDirty()) return true;
    if (autoSave && await saveBeforeLeaving() && localEditRevision === savedLocalRevision && !await bridge.isDirty()) return !signal?.aborted;
    if (signal?.aborted) return false;
    const action = await chooseUnsavedAction(signal);
    if (action === 'cancel') return false;
    if (action === 'discard') {
      cancelPendingEdits();
      await ipcRenderer.invoke('office:discard');
      return true;
    }
    return await saveBeforeLeaving() && localEditRevision === savedLocalRevision && !await bridge.isDirty();
  }

  let opening: Promise<unknown> | undefined;
  let closed = false;
  async function openDeck<T>(operation: () => Promise<T>): Promise<T | null> {
    if (closed || opening) return null;
    const pending = operation();
    opening = pending;
    try {
      const result = await pending;
      if (result !== null) savedLocalRevision = localEditRevision;
      return result;
    } finally {
      if (opening === pending) opening = undefined;
      await ipcRenderer.invoke('office:cancel-discard');
    }
  }
  window.matchaApp?.onCloseRequested?.(async (signal) => {
    cancelOpen();
    await ipcRenderer.invoke('office:cancel-open');
    await opening?.catch(() => undefined);
    if (!await confirmLeaving(signal) || signal.aborted) {
      await ipcRenderer.invoke('office:cancel-discard');
      return false;
    }
    closed = true;
    try {
      await flushBrowserStorage();
      if (signal.aborted) { closed = false; return false; }
      await ipcRenderer.invoke('office:close-editor');
      return true;
    } catch (error) {
      closed = false;
      throw error;
    } finally {
      if (!closed) await ipcRenderer.invoke('office:cancel-discard');
    }
  });

  return {
    save,
    async open<T>(operation: () => Promise<T>): Promise<T | null> {
      return openDeck(async () => await confirmLeaving() ? operation() : null);
    }
  };
}
