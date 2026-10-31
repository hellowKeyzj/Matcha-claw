import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import type { Asset } from '../document';
import type { DesignTemplate } from '../templates';
import { TemplatePicker } from './TemplatePicker';
import type { LoadedAsset } from './useAssets';
import { call, errorMessage, fileData } from './api';
import { useTranslation } from './i18n';

export interface ProductReferencesProps {
  kind: 'model' | 'logo';
  asset: Asset | null;
  onChange(asset: Asset | null): void;
  load(assetId: string): Promise<LoadedAsset>;
  disabled: boolean;
  onBusyChange?(busy: boolean): void;
  onTemplateSelect?(template: DesignTemplate): void;
}

export function ProductReferences({ kind, asset, onChange, load, disabled, onBusyChange, onTemplateSelect }: ProductReferencesProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const clearImage = useCallback(() => { image.current?.removeAttribute('src'); }, []);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const importing = useRef(false);
  const latest = useRef({ kind, assetId: asset?.id, onChange, onBusyChange, onTemplateSelect });
  latest.current = { kind, assetId: asset?.id, onChange, onBusyChange, onTemplateSelect };
  const [busy, setBusy] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<DesignTemplate | null>(null);
  const [preview, setPreview] = useState<LoadedAsset | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const assetId = asset?.id;
  const entry = preview?.asset.id === assetId ? preview : null;
  const blocked = disabled || busy || directoryBusy;
  const label = t(kind === 'model' ? '人物照片' : 'Logo 图片');

  const reportBusy = useCallback((value: boolean) => {
    if (importing.current === value) return;
    importing.current = value;
    setBusy(value);
    latest.current.onBusyChange?.(value);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (importing.current) latest.current.onBusyChange?.(false);
      importing.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const request = ++epoch.current;
    setError('');
    setPreview(null);
    reportBusy(false);
    if (!assetId) return;
    let live = true;
    let held: LoadedAsset | undefined;
    void load(assetId).then((value) => {
      if (!live || epoch.current !== request) { value.release(); return; }
      held = value;
      setPreview(value);
    }).catch((cause) => {
      if (live && epoch.current === request) setError(t('预览读取失败：{error}', { error: errorMessage(cause) }));
    });
    return () => { live = false; clearImage(); held?.release(); };
  }, [assetId, kind, load, attempt, reportBusy, t, clearImage]);

  async function importFile(file: File) {
    if (disabled || importing.current || directoryBusy) return;
    setError('');
    if (!file.type.startsWith('image/')) { setError(t('请选择图片文件。')); return; }
    const request = ++epoch.current;
    const isCurrent = () => mounted.current && epoch.current === request
      && latest.current.kind === kind && latest.current.assetId === assetId;
    reportBusy(true);
    try {
      const data = await fileData(file);
      if (!isCurrent()) return;
      const { asset: imported } = await call<{ asset: Asset }>('asset_import', { name: file.name, mimeType: file.type, data });
      // Invalidating this request only drops its UI result; asset_import may already have saved the image.
      if (!isCurrent()) return;
      setSelectedTemplate(null);
      latest.current.onChange(imported);
    } catch (cause) {
      if (isCurrent()) setError(t('图片上传失败：{error}', { error: errorMessage(cause) }));
    } finally {
      if (mounted.current && epoch.current === request) reportBusy(false);
    }
  }

  function selectTemplate(template: DesignTemplate | null) {
    if (!template) { setSelectedTemplate(null); return; }
    if (template.category !== (kind === 'model' ? 'model' : 'logo-technique')) return;
    epoch.current++;
    setSelectedTemplate(template);
    if (kind === 'model') latest.current.onChange(null);
    latest.current.onTemplateSelect?.(template);
  }

  function remove() {
    if (disabled || directoryBusy) return;
    epoch.current++;
    reportBusy(false);
    setPreview(null);
    setSelectedTemplate(null);
    setError('');
    onChange(null);
  }

  return <div className="ic-reference-section" role="group" aria-label={label} aria-busy={busy || directoryBusy}>
    <span className="ic-field-label">{label}</span>
    <div className="ic-logo-layout">
      <button type="button" className="ic-logo-upload" aria-label={t(asset ? '重新上传' : kind === 'model' ? '上传人物照片' : '上传 Logo')} disabled={blocked} onClick={() => input.current?.click()}>
        {entry ? <img ref={image} src={entry.url} alt={t(kind === 'model' ? '人物照片预览：{name}' : 'Logo 预览：{name}', { name: asset?.name ?? entry.asset.name })} />
          : <><Upload size={23} aria-hidden="true" />{asset && <span>{t(error ? '读取失败' : '读取中…')}</span>}</>}
      </button>
      <div className="field">
        {asset && <p>{asset.name}</p>}
        <div className="button-row">
          <button type="button" disabled={blocked} onClick={() => input.current?.click()}>{t(asset ? '重新上传' : kind === 'model' ? '上传人物照片' : '上传 Logo')}</button>
          {(kind === 'model' || onTemplateSelect) && <button type="button" aria-expanded={directoryOpen} disabled={blocked} onClick={() => setDirectoryOpen((value) => !value)}>{t(directoryOpen ? '收起本地模板' : kind === 'model' ? '从本地模板填入描述' : '从本地模板填入工艺')}</button>}
          {(asset || busy) && <button type="button" disabled={disabled || directoryBusy} onClick={remove}><Trash2 size={14} aria-hidden="true" />{t(kind === 'model' ? '移除人物照片' : '移除 Logo')}</button>}
          {asset && error && !entry && <button type="button" disabled={blocked} onClick={() => { setPreview(null); setAttempt((value) => value + 1); }}>{t('重新读取')}</button>}
        </div>
        {(asset || busy) && <p className="quiet">{t('移除仅清除此处选择，不删除已保存的图片。')}</p>}
        {busy && <span className="quiet" role="status">{t('上传中…')}</span>}
      </div>
    </div>
    {directoryOpen && <TemplatePicker category={kind === 'model' ? 'model' : 'logo-technique'} selectedId={selectedTemplate?.id} disabled={disabled} load={load} onSelect={selectTemplate} onBusyChange={(value) => { setDirectoryBusy(value); latest.current.onBusyChange?.(value || importing.current); }} />}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <input ref={input} hidden type="file" accept="image/*" aria-label={t(kind === 'model' ? '选择人物照片文件' : '选择 Logo 图片文件')} disabled={blocked} onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) void importFile(file);
    }} />
  </div>;
}
