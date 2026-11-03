import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { ExtractTextResult } from '../analysis';
import type { GenerationRequest, ImageLayer } from '../document';
import type { LoadedAsset } from './useAssets';
import { call, errorMessage } from './api';
import i18n, { useTranslation } from './i18n';

interface Props {
  documentId: string;
  documentRevision: number;
  layer: ImageLayer;
  load(assetId: string): Promise<LoadedAsset>;
  onSubmit(request: GenerationRequest): Promise<void>;
  onClose(): void;
}

type ScanState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: ExtractTextResult; preview: LoadedAsset; edited: string[] };

export function TextEditor(props: Props) {
  useTranslation();
  return <TextEditorSession key={JSON.stringify([props.documentId, props.documentRevision, props.layer.id, props.layer.assetId, i18n.resolvedLanguage ?? i18n.language])} {...props} />;
}

function TextEditorSession({ documentId, layer, load, onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const section = useRef<HTMLElement>(null);
  const previewImage = useRef<HTMLImageElement>(null);
  const previewLease = useRef<LoadedAsset | null>(null);
  const requestEpoch = useRef(0);
  const submitLock = useRef(false);
  const closed = useRef(false);
  const [scan, setScan] = useState<ScanState>({ status: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const releasePreview = useCallback(() => {
    previewImage.current?.removeAttribute('src');
    previewLease.current?.release();
    previewLease.current = null;
  }, []);

  const extract = useCallback(async () => {
    if (closed.current) return;
    const epoch = ++requestEpoch.current;
    releasePreview();
    setScan({ status: 'loading' });
    setError('');
    try {
      const result = await call<ExtractTextResult>('text_extract', { documentId, layerId: layer.id });
      if (epoch !== requestEpoch.current) return;
      const crop = layer.crop ?? null;
      if (result.sourceLayerId !== layer.id || result.sourceAssetId !== layer.assetId
        || (crop === null ? result.sourceCrop !== null : !result.sourceCrop || (['x', 'y', 'width', 'height'] as const).some((key) => crop[key] !== result.sourceCrop![key]))) throw new Error(t('文字识别结果与源图片不一致，请重新识别。'));
      const preview = await load(result.markedAsset.id);
      if (epoch !== requestEpoch.current) { preview.release(); return; }
      previewLease.current = preview;
      setScan({ status: 'ready', result, preview, edited: result.texts.map(({ original }) => original) });
    } catch (cause) {
      if (epoch === requestEpoch.current) setScan({ status: 'error', message: t('文字编辑准备失败：{error}', { error: errorMessage(cause) }) });
    }
  }, [documentId, layer.id, layer.assetId, layer.crop, load, t, releasePreview]);

  useLayoutEffect(() => {
    closed.current = false;
    void extract();
    return () => { requestEpoch.current += 1; releasePreview(); };
  }, [extract, releasePreview]);
  useLayoutEffect(() => {
    closed.current = false;
    const previous = document.activeElement as HTMLElement | null;
    section.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { closed.current = true; requestEpoch.current += 1; previous?.focus(); };
  }, []);

  function close() {
    if (closed.current) return;
    closed.current = true;
    requestEpoch.current += 1;
    releasePreview();
    onClose();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (closed.current || submitLock.current || scan.status !== 'ready' || !scan.result.texts.length) return;
    submitLock.current = true;
    setSubmitting(true);
    setError('');
    const epoch = requestEpoch.current;
    const textEdits = scan.result.texts.map(({ marker, original }, index) => ({ marker, original, edited: scan.edited[index] }));
    const changed = textEdits.filter(({ original, edited }) => edited !== original);
    try {
      await onSubmit({
        documentId,
        action: 'edit-text',
        prompt: '',
        sourceLayerIds: [scan.result.sourceLayerId],
        expectedSourceAssetId: scan.result.sourceAssetId,
        expectedSourceCrop: scan.result.sourceCrop,
        markedAssetId: scan.result.markedAsset.id,
        textEdits: changed.length ? changed : textEdits,
      });
      if (epoch === requestEpoch.current) close();
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(t('图片改字失败：{error}', { error: errorMessage(cause) }));
    } finally {
      submitLock.current = false;
      if (epoch === requestEpoch.current) setSubmitting(false);
    }
  }

  return <div className="ic-tool-popover-wrap">
    <section ref={section} className="ic-creative-dialog ic-dialog-text ic-creative-popover" role="dialog" aria-labelledby={titleId} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <header><h2 id={titleId}>{t('编辑文字')}</h2><button type="button" className="icon small" aria-label={t('关闭')} onClick={close}><X size={18} /></button></header>
      <form onSubmit={(event) => void submit(event)}>
        <div className="ic-creative-body" aria-busy={scan.status === 'loading'}>
          {scan.status === 'loading' && <div className="asset-placeholder" role="status">{t('正在识别图片文字…')}</div>}
          {scan.status === 'error' && <><p className="inline-error" role="alert">{scan.message}</p><button type="button" onClick={() => void extract()}><RefreshCw size={14} />{t('重新识别')}</button></>}
          {scan.status === 'ready' && <>
            <div className="generation-asset"><img ref={previewImage} src={scan.preview.url} alt={t('文字定位标记图')} /></div>
            {scan.result.texts.length ? <>
              <div className="ic-edit-text-list">{scan.result.texts.map(({ marker, original }, index) => <div className="field" key={marker}>
                <label htmlFor={`${titleId}-edit-${index}`}>{t('标记 {marker}', { marker })}</label>
                <p id={`${titleId}-original-${index}`} className="quiet">{t('原文：{text}', { text: original })}</p>
                <textarea id={`${titleId}-edit-${index}`} aria-label={t('修改标记 {marker} 的文字', { marker })} aria-describedby={`${titleId}-original-${index}`} value={scan.edited[index]} rows={2} disabled={submitting} onChange={(event) => {
                  const edited = event.target.value;
                  setScan((previous) => previous.status === 'ready' ? { ...previous, edited: previous.edited.map((value, entry) => entry === index ? edited : value) } : previous);
                }} />
              </div>)}</div>
              <p className="quiet">{t('留空以删除这段文字')}</p>
            </> : <><p className="empty-hint" role="status">{t('未识别到文字，请确认图片中文字清晰后重试。')}</p><button type="button" onClick={() => void extract()}><RefreshCw size={14} />{t('重新识别')}</button></>}
          </>}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {(scan.status === 'loading' || submitting) && <p className="quiet">{t('关闭面板不会撤销已提交的请求。')}</p>}
        <footer><button type="button" onClick={close}>{t('关闭')}</button><button className="primary" disabled={scan.status !== 'ready' || !scan.result.texts.length || submitting}>{t(submitting ? '正在改字…' : '确认改字')}</button></footer>
      </form>
    </section>
  </div>;
}
