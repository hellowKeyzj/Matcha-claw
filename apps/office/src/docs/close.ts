import type { DesktopApi } from './types';
import { chooseUnsavedAction } from '../ui/document-actions';

type CloseState = Parameters<DesktopApi['reportCloseCheck']>[0];

export function createDocsCloseGuard(onDiscard: (path: string) => Promise<void> = async () => {}) {
  let checkHandler: (() => void) | undefined;
  let saveHandler: (() => void) | undefined;
  let state: CloseState | undefined;
  let saveResult: ((ok: boolean) => void) | undefined;
  let saving: Promise<boolean> | undefined;
  let deciding: Promise<boolean> | undefined;
  let disposed = false;

  function requestSave(): Promise<boolean> {
    if (saving) return saving;
    if (!saveHandler || disposed) return Promise.resolve(false);
    const result = new Promise<boolean>((resolve) => {
      saveResult = resolve;
    });
    saving = result.finally(() => {
      saving = undefined;
      saveResult = undefined;
    });
    try {
      saveHandler();
    } catch {
      saveResult?.(false);
    }
    return saving;
  }

  async function decide(signal?: AbortSignal): Promise<boolean> {
    if (disposed || signal?.aborted || !checkHandler) return false;
    state = undefined;
    checkHandler();
    // The real App reports its composite dirty state synchronously.
    const current = state as CloseState | undefined;
    if (!current) return false;
    if (!current.dirty) return true;
    if (current.autoSave) {
      const saved = await requestSave();
      if (disposed || signal?.aborted) return false;
      if (saved) return true;
    }
    const action = await chooseUnsavedAction(signal);
    if (disposed || signal?.aborted) return false;
    if (action === 'discard') {
      if (current.filePath) await onDiscard(current.filePath);
      return !disposed && !signal?.aborted;
    }
    if (action !== 'save') return false;
    return await requestSave() && !disposed && !signal?.aborted;
  }

  return {
    onCloseCheck(handler: () => void) {
      checkHandler = handler;
      return () => { if (checkHandler === handler) checkHandler = undefined; };
    },
    reportCloseCheck(value: CloseState) {
      state = value;
    },
    onCloseSaveRequest(handler: () => void) {
      saveHandler = handler;
      return () => { if (saveHandler === handler) saveHandler = undefined; };
    },
    reportCloseSaveResult(ok: boolean) {
      saveResult?.(ok === true);
    },
    confirm(signal?: AbortSignal): Promise<boolean> {
      deciding ??= decide(signal).finally(() => { deciding = undefined; });
      return deciding.then((allowed) => allowed && !disposed && !signal?.aborted);
    },
    dispose() {
      disposed = true;
      checkHandler = undefined;
      saveHandler = undefined;
      saveResult?.(false);
    }
  };
}
