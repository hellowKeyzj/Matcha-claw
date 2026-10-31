import { useEffect, useRef, useState } from 'react';
import { Eye, Trash2, Upload } from 'lucide-react';
import type { Asset } from '../document';
import { templatePromptLimits, type DesignTemplate, type TemplateCategory, type TemplateInput, type TemplatesResult } from '../templates';
import { call, errorMessage, fileData } from './api';
import { useTranslation } from './i18n';
import { MediaPreview } from './MediaPreview';
import { useAssets, type LoadedAsset } from './useAssets';
import './template-picker.css';

interface Props {
  category: TemplateCategory;
  selectedId?: string;
  disabled: boolean;
  load?(assetId: string): Promise<LoadedAsset>;
  onSelect(template: DesignTemplate | null): void | Promise<void>;
  onBusyChange?(busy: boolean): void;
}

const categoryTitles: Record<TemplateCategory, string> = {
  'product-scene': '本地场景模板', model: '本地模特描述模板', 'logo-technique': '本地 Logo 工艺模板',
};

function TemplateImage({ template, load }: { template: DesignTemplate; load: NonNullable<Props['load']> }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ assetId: string; load: Props['load']; entry?: LoadedAsset; error?: string } | null>(null);
  const current = result?.assetId === template.assetId && result.load === load ? result : null;
  useEffect(() => {
    let live = true;
    let entry: LoadedAsset | undefined;
    void load(template.assetId).then((loaded) => {
      if (!live) { loaded.release(); return; }
      entry = loaded;
      setResult({ assetId: template.assetId, load, entry });
    }).catch((cause) => { if (live) setResult({ assetId: template.assetId, load, error: errorMessage(cause) }); });
    return () => { live = false; entry?.release(); };
  }, [template.assetId, load]);
  return current?.entry ? <img src={current.entry.url} alt={template.title} loading="lazy" />
    : <span className={current?.error ? 'inline-error' : 'quiet'} title={current?.error}>{t(current?.error ? '读取失败' : '读取预览…')}</span>;
}

export function TemplatePicker(props: Props) {
  return <TemplateCatalog key={props.category} {...props} />;
}

function TemplateCatalog({ category, selectedId, disabled, load: providedLoad, onSelect, onBusyChange }: Props) {
  const { t } = useTranslation();
  const localAssets = useAssets();
  const load = providedLoad ?? localAssets.load;
  const promptLimit = templatePromptLimits[category];
  const [catalog, setCatalog] = useState<TemplatesResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', prompt: '' });
  const [file, setFile] = useState<File | null>(null);
  const [imported, setImported] = useState<{ file: File; asset: Asset } | null>(null);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [removingId, setRemovingId] = useState('');
  const [page, setPage] = useState(0);
  const mounted = useRef(false);
  const operation = useRef(false);
  const latest = useRef({ onSelect, onBusyChange });
  latest.current = { onSelect, onBusyChange };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (operation.current) latest.current.onBusyChange?.(false);
    };
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void call<TemplatesResult>('templates', { action: 'list', category }).then((result) => {
      if (live) setCatalog(result);
    }).catch((cause) => { if (live) setError(errorMessage(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [category, attempt]);

  async function perform(action: () => Promise<void>) {
    if (disabled || operation.current) return;
    operation.current = true;
    setBusy(true);
    latest.current.onBusyChange?.(true);
    setError('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally {
      operation.current = false;
      if (mounted.current) { setBusy(false); latest.current.onBusyChange?.(false); }
    }
  }

  async function save() {
    if (!file || !draft.title.trim() || !draft.prompt.trim()) {
      setError(t('请选择模板图片并填写标题和生成要求。'));
      return;
    }
    if (draft.prompt.trim().length > promptLimit) {
      setError(t('模板生成要求不能超过 {count} 字，请缩短后保存。', { count: promptLimit }));
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.type) || !file.size || file.size > 64 * 1024 * 1024) {
      setError(t('请选择不超过 64 MiB 的 PNG、JPEG、WebP、GIF 或 SVG 图片。'));
      return;
    }
    const selectedFile = file;
    await perform(async () => {
      let asset = imported?.file === selectedFile ? imported.asset : undefined;
      if (!asset) {
        const data = await fileData(selectedFile);
        if (!mounted.current) return;
        const result = await call<{ asset: Asset }>('asset_import', { name: selectedFile.name, mimeType: selectedFile.type, data });
        if (!mounted.current) return;
        asset = result.asset;
        setImported({ file: selectedFile, asset });
      }
      const template: TemplateInput = { category, title: draft.title.trim(), description: draft.description.trim(), prompt: draft.prompt.trim(), assetId: asset.id };
      const result = await call<TemplatesResult>('templates', { action: 'save', template });
      if (!mounted.current) return;
      setCatalog(result);
      setImporting(false);
      setDraft({ title: '', description: '', prompt: '' });
      setFile(null);
      setImported(null);
    });
  }

  async function remove(template: DesignTemplate) {
    await perform(async () => {
      const result = await call<TemplatesResult>('templates', { action: 'remove', templateId: template.id });
      if (!mounted.current) return;
      setCatalog(result);
      setRemovingId('');
      if (selectedId === template.id) await latest.current.onSelect(null);
    });
  }

  const templates = catalog?.templates.filter((template) => template.category === category) ?? [];
  const lastPage = Math.max(0, Math.ceil(templates.length / 16) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleTemplates = templates.slice(currentPage * 16, (currentPage + 1) * 16);
  const blocked = disabled || busy;
  return <section className="ic-template-picker" aria-label={t(categoryTitles[category])} aria-busy={busy || loading}>
    <div className="section-heading"><h3>{t(categoryTitles[category])}</h3><div className="button-row">
      <button type="button" disabled={blocked || loading || importing} onClick={() => setAttempt((value) => value + 1)}>{t('刷新目录')}</button>
      <button type="button" disabled={blocked || loading || importing || (catalog?.templates.length ?? 0) >= 256} onClick={() => setImporting(true)}><Upload size={14} aria-hidden="true" />{t('从本地导入')}</button>
    </div></div>
    {importing && <div className="ic-template-import">
      <label className="field"><span>{t('模板分类')}</span><input value={t(categoryTitles[category])} readOnly /></label>
      <label className="field"><span>{t('模板图片')}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" disabled={blocked} onChange={(event) => {
        setFile(event.currentTarget.files?.[0] ?? null); setImported(null);
      }} /></label>
      <label className="field"><span>{t('模板标题')}</span><input value={draft.title} maxLength={200} disabled={blocked} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label className="field"><span>{t('模板描述（可选）')}</span><textarea value={draft.description} rows={2} maxLength={2000} disabled={blocked} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      <label className="field"><span>{t('生成要求')}</span><textarea value={draft.prompt} rows={3} maxLength={promptLimit} disabled={blocked} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
      <div className="button-row"><button type="button" className="primary" disabled={blocked} onClick={() => void save()}>{t(busy ? '保存中…' : '保存模板')}</button><button type="button" disabled={blocked} onClick={() => setImporting(false)}>{t('取消')}</button></div>
    </div>}
    {loading && <p className="empty-hint" role="status">{t('正在读取本地模板…')}</p>}
    {!loading && !templates.length && !error && <p className="empty-hint" role="status">{t('此分类还没有本地模板。导入图片并保存生成要求后，即可在这里选择。')}</p>}
    {!loading && <div className="ic-template-grid">{visibleTemplates.map((template) => <article className="ic-template-card" data-selected={selectedId === template.id} key={template.id}>
      <button type="button" className="ic-template-thumbnail" disabled={blocked} aria-label={t('预览模板 {title}', { title: template.title })} onClick={() => void perform(async () => {
        const entry = await load(template.assetId);
        try { if (mounted.current) setPreview(entry.asset); }
        finally { entry.release(); }
      })}><TemplateImage template={template} load={load} /><Eye size={14} aria-hidden="true" /></button>
      <strong title={template.title}>{template.title}</strong><p className="quiet" title={template.description}>{template.description}</p>
      <div className="button-row"><button type="button" aria-pressed={selectedId === template.id} aria-label={t('选择模板 {title}', { title: template.title })} disabled={blocked} onClick={() => void perform(async () => {
          if (template.prompt.length > promptLimit) {
            setError(t('此模板的生成要求超过 {count} 字，无法使用。请重新导入符合长度限制的模板；原模板仍可预览或移除。', { count: promptLimit }));
            return;
          }
          await latest.current.onSelect(template);
        })}>{t(selectedId === template.id ? '已选择' : '选择模板')}</button>
        <button type="button" className="icon small" aria-label={t('移除模板 {title}', { title: template.title })} disabled={blocked} onClick={() => setRemovingId(template.id)}><Trash2 size={14} aria-hidden="true" /></button></div>
      {removingId === template.id && <div className="ic-template-remove"><p>{t('仅从模板目录移除，不删除图片。')}</p><div className="button-row"><button type="button" disabled={blocked} onClick={() => void remove(template)}>{t('确认移除模板')}</button><button type="button" disabled={blocked} onClick={() => setRemovingId('')}>{t('取消')}</button></div></div>}
    </article>)}</div>}
    {!loading && lastPage > 0 && <div className="button-row"><button type="button" disabled={blocked || currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('上一页')}</button><span className="quiet">{t('第 {page} / {total} 页', { page: currentPage + 1, total: lastPage + 1 })}</span><button type="button" disabled={blocked || currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{t('下一页')}</button></div>}
    {busy && <p className="quiet" role="status">{t('正在处理模板…')}</p>}
    {error && <p className="inline-error" role="alert">{t('模板操作失败：{error}', { error })}</p>}
    {!loading && error && <button type="button" disabled={blocked} onClick={() => setAttempt((value) => value + 1)}>{t('重新读取')}</button>}
    {preview && <MediaPreview assets={[preview]} initialAssetId={preview.id} load={load} onClose={() => setPreview(null)} />}
  </section>;
}
