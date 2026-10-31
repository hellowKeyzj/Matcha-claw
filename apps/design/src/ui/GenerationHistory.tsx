import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, ImagePlus, Pencil, Play } from 'lucide-react';
import type { Asset, GenerationAction, GenerationRecord } from '../document';
import type { LoadedAsset } from './useAssets';
import { download, errorMessage } from './api';
import i18n, { useTranslation } from './i18n';
import { MediaPreview } from './MediaPreview';

interface Props {
  generations: GenerationRecord[];
  load(assetId: string): Promise<LoadedAsset>;
  onInsert(asset: Asset): Promise<void>;
  onCancel(recordId: string): Promise<void>;
  onEditStoryboard?(record: GenerationRecord): void;
}

const actionLabels: Record<GenerationAction, string> = {
  image: '生成图片', edit: '图片编辑', 'remove-background': '抠图', upscale: '高清', erase: '消除',
  'product-scene': '商品场景图', recolor: '商品换色', 'model-display': '模特展示图', logo: 'Logo效果图',
  video: '视频', storyboard: '多镜头生成与合成', white: '白底图', watermark: '水印擦除', resize: '改尺寸', translate: '翻译', 'edit-text': '编辑文字',
  angle: '换角度', 'erase-text': '擦除文字',
};
const stateLabels: Record<GenerationRecord['state'], string> = {
  running: '生成中', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消本地等待',
};

function HistoryAsset({ asset, load, onInsert, onPreview }: {
  asset: Asset;
  load: Props['load'];
  onInsert: Props['onInsert'];
  onPreview(assetId: string): void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ id: string; load: Props['load']; entry?: LoadedAsset; error?: string } | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inserting = useRef(false);
  const mounted = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const thumbnail = useRef<HTMLImageElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const clearMedia = useCallback(() => {
    thumbnail.current?.removeAttribute('src');
    const element = player.current;
    if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
  }, []);
  const [active, setActive] = useState(false);
  const [height, setHeight] = useState(0);
  const current = active && result?.id === asset.id && result.load === load ? result : null;
  const entry = current?.entry;
  const video = asset.mimeType.startsWith('video/');
  const media = video || asset.mimeType.startsWith('image/');

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), { rootMargin: '260px' });
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!active || !entry) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, [active, entry]);
  useLayoutEffect(() => {
    if (!active) { setResult(null); return; }
    let live = true;
    let held: LoadedAsset | undefined;
    setResult(null);
    void load(asset.id).then((entry) => {
      if (!live) { entry.release(); return; }
      held = entry;
      setResult({ id: asset.id, load, entry });
    }).catch((cause) => { if (live) setResult({ id: asset.id, load, error: errorMessage(cause) }); });
    return () => {
      live = false;
      clearMedia();
      held?.release();
    };
  }, [asset.id, load, attempt, active, clearMedia]);

  async function downloadOriginal() {
    try {
      const entry = await load(asset.id);
      if (!mounted.current) { entry.release(); return; }
      download(entry.url, asset.name, entry.release);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
  }

  async function insert() {
    if (inserting.current) return;
    inserting.current = true;
    setAdding(true);
    setError('');
    try { await onInsert(asset); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { inserting.current = false; if (mounted.current) setAdding(false); }
  }

  return <div ref={root} className="generation-asset" style={{ minHeight: height || 120 }}>
    {!entry && !current?.error && <div className="asset-placeholder" role="status">{t('读取预览…')}</div>}
    {current?.error && <div><p className="inline-error" role="alert">{current.error}</p><button type="button" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}>{t('重新读取')}</button></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {entry && <>
      {media ? <button type="button" className="ic-history-thumbnail" aria-label={t('预览 {name}', { name: asset.name })} title={t('预览 {name}', { name: asset.name })} onClick={() => onPreview(asset.id)}>
        {video ? entry.image ? <img ref={thumbnail} src={entry.image.src} alt="" /> : <video ref={player} src={entry.url} muted playsInline preload="metadata" aria-hidden="true" /> : <img ref={thumbnail} src={entry.url} alt="" />}
        {video && <span className="ic-history-play" aria-hidden="true"><Play size={20} /></span>}
      </button> : <p>{asset.name}</p>}
      <div className="asset-actions"><span title={asset.name}>{asset.name}</span><button type="button" className="icon small" title={t('下载结果')} aria-label={t('下载 {name}', { name: asset.name })} onClick={() => void downloadOriginal()}><Download size={14} aria-hidden="true" /></button>{media && <button type="button" disabled={adding} title={t('作为新图层插入')} onClick={() => void insert()}><ImagePlus size={14} aria-hidden="true" />{t(adding ? '插入中' : '插入')}</button>}</div>
    </>}
  </div>;
}

function HistoryRecord({ record, load, onInsert, onCancel, onPreview, onEditStoryboard }: {
  record: GenerationRecord;
  load: Props['load'];
  onInsert: Props['onInsert'];
  onCancel: Props['onCancel'];
  onEditStoryboard: Props['onEditStoryboard'];
  onPreview(assetId: string): void;
}) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const cancellingRequest = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function cancel() {
    if (cancellingRequest.current || record.state !== 'running') return;
    cancellingRequest.current = true;
    setCancelling(true);
    setError('');
    try { await onCancel(record.id); }
    catch (cause) {
      cancellingRequest.current = false;
      if (mounted.current) { setCancelling(false); setError(errorMessage(cause)); }
    }
  }

  return <article className="generation-record">
    <div className="record-heading"><strong>{t(actionLabels[record.action])}</strong><span className={`state state-${record.state}`}>{t(stateLabels[record.state])}</span></div>
    {record.prompt && <p className="record-prompt" title={record.prompt}>{record.prompt}</p>}
    <time className="quiet" dateTime={record.startedAt}>{new Date(record.startedAt).toLocaleString(i18n.resolvedLanguage)}</time>
    {record.action === 'storyboard' && !!record.editing?.scenes?.length && onEditStoryboard && <div><button type="button" onClick={() => onEditStoryboard(record)}><Pencil size={14} aria-hidden="true" />{t('编辑分镜脚本')}</button></div>}
    {record.state === 'running' && <div><button type="button" disabled={cancelling} onClick={() => void cancel()}>{t(cancelling ? '正在取消，等待任务结束…' : '取消本地等待')}</button><p className="quiet">{t('取消仅停止本地等待，不保证云端任务撤销或费用退回。')}</p></div>}
    {record.state === 'cancelled' && <p className="quiet">{t('取消仅停止本地等待，不保证云端任务撤销或费用退回。')}</p>}
    {record.error && <p className="inline-error">{record.error}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {record.assets.map((asset) => <HistoryAsset key={asset.id} asset={asset} load={load} onInsert={onInsert} onPreview={onPreview} />)}
  </article>;
}

export function GenerationHistory({ generations, load, onInsert, onCancel, onEditStoryboard }: Props) {
  const { t } = useTranslation();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const records = [...generations].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const assets = [...new Map(records.flatMap((record) => record.assets).filter((asset) => asset.mimeType.startsWith('image/') || asset.mimeType.startsWith('video/')).map((asset) => [asset.id, asset])).values()];
  return <div className="generation-history">
    {!generations.length && <p className="empty-hint">{t('对话中生成的图片和视频将在此显示。')}</p>}
    {records.map((record) => <HistoryRecord key={record.id} record={record} load={load} onInsert={onInsert} onCancel={onCancel} onEditStoryboard={onEditStoryboard} onPreview={setPreviewId} />)}
    {previewId && <MediaPreview assets={assets} initialAssetId={previewId} load={load} onClose={() => setPreviewId(null)} />}
  </div>;
}
