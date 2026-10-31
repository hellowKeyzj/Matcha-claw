import { useEffect, useId, useRef, useState } from 'react';
import type { LoadedAsset } from './useAssets';
import { app, errorMessage, fileData } from './api';
import { useTranslation } from './i18n';

type SaveState = { data?: string; preparing: boolean; saving: boolean; error: string; saved: string };

export function SaveWorkspaceFile({ entry, onClose }: { entry: LoadedAsset | null; onClose(): void }) {
  const { t } = useTranslation();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const [path, setPath] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SaveState>({ preparing: false, saving: false, error: '', saved: '' });
  const validPath = path.length > 0 && path.length <= 4096 && !path.includes('\0')
    && !path.startsWith('/') && !path.startsWith('\\') && !path.includes(':')
    && path.split(/[\\/]/).every((component) => component !== '' && component !== '.' && component !== '..');

  useEffect(() => {
    if (!entry) return;
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const name = Array.from(entry.asset.name, (character) => character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? '_' : character)
      .join('').trim().replace(/[. ]+$/, '') || entry.asset.id;
    setPath(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name);
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, [entry]);

  useEffect(() => {
    if (!entry) { setState({ preparing: false, saving: writing.current, error: '', saved: '' }); return; }
    const controller = new AbortController();
    active.current = controller;
    setState({ preparing: true, saving: writing.current, error: '', saved: '' });
    void (async () => {
      try {
        const response = await fetch(entry.url, { signal: controller.signal });
        if (!response.ok) throw new Error(t('无法读取原始文件，请重试。'));
        const original = await response.blob();
        controller.signal.throwIfAborted();
        if (original.size > 50 * 1024 * 1024) throw new Error(t('原始文件超过 50 MiB，无法保存到工作区。'));
        const data = await fileData(original);
        controller.signal.throwIfAborted();
        setState((previous) => ({ ...previous, data, preparing: false }));
      } catch (cause) {
        if (!controller.signal.aborted) setState((previous) => ({ ...previous, preparing: false, error: errorMessage(cause) }));
      }
    })();
    return () => { controller.abort(); active.current = null; };
  }, [entry, attempt, t]);

  function close() {
    active.current?.abort();
    onClose();
  }

  async function save() {
    const api = app();
    const controller = active.current;
    if (!entry || state.data === undefined || !validPath || state.saved || writing.current || !controller || controller.signal.aborted || !api.saveWorkspaceFile) return;
    writing.current = true;
    setState((previous) => ({ ...previous, saving: true, error: '', saved: '' }));
    try {
      // Original bytes are ready before this gesture; the trusted host owns final path/overwrite confirmation.
      await api.saveWorkspaceFile({ relativePath: path, data: state.data });
      if (!controller.signal.aborted) setState((previous) => ({ ...previous, saved: path }));
    } catch (cause) {
      if (!controller.signal.aborted) setState((previous) => ({ ...previous, error: errorMessage(cause) }));
    } finally {
      writing.current = false;
      if (dialog.current) setState((previous) => ({ ...previous, saving: false }));
    }
  }

  return <dialog ref={dialog} className="ic-workspace-save" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}>
    <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void save(); }}>
      <h2 id={`${id}-title`}>{t('保存到工作区')}</h2>
      <label className="field"><span>{t('工作区相对路径')}</span><input autoFocus value={path} maxLength={4096} disabled={state.saving} spellCheck={false} autoComplete="off" aria-invalid={!validPath} aria-describedby={`${id}-hint${validPath ? '' : ` ${id}-path-error`}`} onChange={(event) => { setPath(event.target.value); setState((previous) => ({ ...previous, saved: '' })); }} /></label>
      <p id={`${id}-hint`} className="quiet">{t('下一步将在宿主中确认相对路径；同名文件将被覆盖。')}</p>
      {!validPath && <p id={`${id}-path-error`} className="inline-error" role="alert">{t('请输入工作区内的相对路径，不能包含空目录、.、.. 或冒号。')}</p>}
      {state.preparing && <p className="quiet" role="status">{t('正在准备原始文件…')}</p>}
      {state.saving && <p className="quiet" role="status">{t('等待宿主确认或保存…')}</p>}
      {state.error && <div className="ic-media-feedback"><p className="inline-error" role="alert">{t('保存到工作区失败：{error}', { error: state.error })}</p>{state.data === undefined && !state.preparing && <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t('重试')}</button>}</div>}
      {state.saved && <p className="quiet" role="status">{t('已保存到工作区：{path}', { path: state.saved })}</p>}
      <p className="quiet">{t('关闭此窗口不会撤销已接单的保存。')}</p>
      <div className="button-row"><button type="button" onClick={close}>{t('关闭')}</button><button type="submit" className="primary" disabled={!validPath || state.preparing || state.saving || state.data === undefined || !!state.saved}>{t('继续保存')}</button></div>
    </form>
  </dialog>;
}
