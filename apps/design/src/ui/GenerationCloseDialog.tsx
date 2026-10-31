import { useEffect, useId, useRef } from 'react';
import type { GenerationCloseState } from './useGenerationClose';
import { useTranslation } from './i18n';

export function GenerationCloseDialog({ state, onConfirm, onStay }: { state: GenerationCloseState; onConfirm(): void; onStay(): void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);

  return <dialog ref={dialog} className="ic-close-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); onStay(); }}>
    <h2 id={titleId}>{t('关闭设计工作台？')}</h2>
    <p id={descriptionId} role="status">{state.phase === 'checking' ? t('正在检查生成任务…') : state.phase === 'cancelling' ? t('正在取消本地等待并保存任务状态…') : t('仍有 {count} 个生成任务。关闭前将取消本地等待并保存任务状态。', { count: state.count })}</p>
    {state.phase !== 'checking' && <p className="quiet">{t('已保存的素材会保留；取消不保证远端停止或退款。')}</p>}
    <div className="button-row"><button type="button" autoFocus onClick={onStay}>{t('留在工作台')}</button>{state.phase === 'confirm' && <button type="button" className="primary" onClick={onConfirm}>{t('取消任务并关闭')}</button>}</div>
  </dialog>;
}
