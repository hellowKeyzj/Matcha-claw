import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import type { Asset, ImageLayer } from '../document';
import type { LoadedAsset } from './useAssets';
import { call, errorMessage, fileData } from './api';
import { useTranslation } from './i18n';

interface Props {
  assetIds: string[];
  sourceImages: readonly Pick<ImageLayer, 'assetId' | 'crop'>[];
  maxImages: number;
  forRecommendations: boolean;
  load(assetId: string): Promise<LoadedAsset>;
  disabled: boolean;
  onChange(assetIds: string[]): void;
  onBusyChange(busy: boolean): void;
}

export function AssetImage({ id, name, load }: { id: string; name: string; load: Props['load'] }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ id: string; load: Props['load']; entry?: LoadedAsset; error?: string } | null>(null);
  const current = result?.id === id && result.load === load ? result : null;
  const image = useRef<HTMLImageElement>(null);
  const clearImage = useCallback(() => { image.current?.removeAttribute('src'); }, []);
  useLayoutEffect(() => {
    let live = true;
    let held: LoadedAsset | undefined;
    void load(id).then((entry) => {
      if (!live) { entry.release(); return; }
      held = entry;
      setResult({ id, load, entry });
    }).catch((cause) => { if (live) setResult({ id, load, error: errorMessage(cause) }); });
    return () => { live = false; clearImage(); held?.release(); };
  }, [id, load, clearImage]);
  return current?.error ? <span className="inline-error" title={current.error}>{t('读取失败')}</span> : current?.entry ? <img ref={image} src={current.entry.url} alt={name} /> : <span className="quiet">{t('读取中…')}</span>;
}

export function ReferenceImages(props: Props) {
  const { t } = useTranslation();
  const { assetIds, sourceImages, maxImages, forRecommendations, load, disabled, onChange } = props;
  const input = useRef<HTMLInputElement>(null);
  const replacement = useRef<string | null>(null);
  const mounted = useRef(false);
  const importing = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const limit = Math.max(0, maxImages - sourceImages.length);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (importing.current) latest.current.onBusyChange(false);
    };
  }, []);

  function choose(assetId: string | null) {
    replacement.current = assetId;
    if (input.current) { input.current.multiple = assetId === null; input.current.click(); }
  }

  async function importFiles(files: File[]) {
    if (disabled || importing.current || !files.length) return;
    const replaceId = replacement.current;
    const next = [...assetIds];
    setError('');
    if (files.some((file) => !file.type.startsWith('image/'))) { setError(t('请选择图片文件。')); return; }
    if ((replaceId ? next.length : next.length + files.length) > limit || (replaceId && files.length !== 1)) {
      setError(t('此处最多使用 {count} 张参考图片（含画布图片）。', { count: maxImages })); return;
    }
    importing.current = true;
    setBusy(true);
    latest.current.onBusyChange(true);
    try {
      for (const file of files) {
        const data = await fileData(file);
        if (!mounted.current) return;
        const { asset } = await call<{ asset: Asset }>('asset_import', { name: file.name, mimeType: file.type, data });
        if (!mounted.current) return;
        if (latest.current.sourceImages.some((layer) => layer.assetId === asset.id && !layer.crop) || next.some((id) => id === asset.id && id !== replaceId)) {
          setError(t('此图片已在参考列表中。')); continue;
        }
        if (replaceId) next.splice(next.indexOf(replaceId), 1, asset.id);
        else next.push(asset.id);
        latest.current.onChange([...next]);
      }
    } catch (cause) { if (mounted.current) setError(t('图片上传失败：{error}', { error: errorMessage(cause) })); }
    finally {
      importing.current = false;
      if (mounted.current) { setBusy(false); latest.current.onBusyChange(false); }
    }
  }

  return <div className="ic-reference-section" role="group" aria-label={t('独立参考图片')} aria-busy={busy}>
    <span className="ic-field-label">{t('独立参考图片（{count}）', { count: assetIds.length })}</span>
    <div className="ic-independent-references">
      {assetIds.map((id, index) => <div className="ic-independent-reference" key={id}>
        <div className="ic-reference"><AssetImage id={id} name={t('参考图片 {number}', { number: index + 1 })} load={load} /></div>
        <div className="button-row">
          <button type="button" className="icon small" disabled={disabled || busy} aria-label={t('替换参考图片 {number}', { number: index + 1 })} title={t('替换参考图片 {number}', { number: index + 1 })} onClick={() => choose(id)}><RefreshCw size={13} /></button>
          <button type="button" className="icon small" disabled={disabled || busy} aria-label={t('移除参考图片 {number}', { number: index + 1 })} title={t('移除参考图片 {number}', { number: index + 1 })} onClick={() => { setError(''); onChange(assetIds.filter((entry) => entry !== id)); }}><X size={13} /></button>
        </div>
      </div>)}
      <button type="button" className="ic-reference-add" disabled={disabled || busy || assetIds.length >= limit} onClick={() => choose(null)}><Plus size={18} />{t('上传参考图片')}</button>
    </div>
    <p className="quiet">{forRecommendations ? t('按列表顺序用于推荐与生成，不添加到画布。推荐最多 {count} 张，实际生成另受所选模型能力限制。', { count: maxImages }) : t('按列表顺序用于生成，不添加到画布。')}</p>
    {busy && <span className="quiet" role="status">{t('上传中…')}</span>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <input ref={input} hidden type="file" accept="image/*" multiple disabled={disabled || busy} aria-label={t('选择独立参考图片文件')} onChange={(event) => {
      const files = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = '';
      void importFiles(files);
    }} />
  </div>;
}
