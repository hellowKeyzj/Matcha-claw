import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, FolderDown, Minus, Plus, X } from 'lucide-react';
import type { Asset } from '../document';
import type { LoadedAsset } from './useAssets';
import { app, download, errorMessage, fileData, isExternalApp } from './api';
import { t, useTranslation } from './i18n';
import { SaveWorkspaceFile } from './SaveWorkspaceFile';
import './media-preview.css';

export interface MediaPreviewProps {
  assets: Asset[];
  initialAssetId: string;
  load(assetId: string): Promise<LoadedAsset>;
  onClose(): void;
}

type CopyState = { status: 'preparing' | 'ready' | 'writing' | 'failed' | 'unavailable'; error?: string };
const fitView = { zoom: 1, x: 0, y: 0 };
const clampZoom = (zoom: number) => Math.min(5, Math.max(0.1, zoom));

async function prepareClipboard(entry: LoadedAsset, signal: AbortSignal): Promise<string> {
  if (entry.asset.mimeType === 'image/gif') throw new Error(t('暂不支持复制 GIF 原图，请下载后使用。'));
  const image = entry.image;
  if (!image?.naturalWidth || !image.naturalHeight) throw new Error(t('图片解码失败'));
  if (image.naturalWidth > 16384 || image.naturalHeight > 16384 || image.naturalWidth * image.naturalHeight > 67_108_864) {
    throw new Error(t('图片尺寸超过剪贴板限制，请下载原图。'));
  }
  const response = await fetch(entry.url, { signal });
  if (!response.ok) throw new Error(t('无法读取原图，请重新选择后重试。'));
  let png = await response.blob();
  signal.throwIfAborted();
  if (!png.size || png.size > 20 * 1024 * 1024) throw new Error(t('图片文件超过 20 MiB 或为空，请压缩后重试。'));
  if (entry.asset.mimeType !== 'image/png') {
    const canvas = document.createElement('canvas');
    try {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error(t('图片解码失败'));
      drawing.drawImage(image, 0, 0);
      png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob?.size ? resolve(blob) : reject(new Error(t('图片解码失败'))), 'image/png');
      });
    } finally { canvas.width = canvas.height = 0; }
  }
  signal.throwIfAborted();
  if (png.size > 20 * 1024 * 1024) throw new Error(t('图片文件超过 20 MiB 或为空，请压缩后重试。'));
  const data = await fileData(png);
  signal.throwIfAborted();
  return data;
}

export function MediaPreview({ assets, initialAssetId, load, onClose }: MediaPreviewProps) {
  const { t } = useTranslation();
  const [assetId, setAssetId] = useState(initialAssetId);
  const [workspaceEntry, setWorkspaceEntry] = useState<LoadedAsset | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const index = assets.findIndex((asset) => asset.id === assetId);
  const asset = assets[index];

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);

  useEffect(() => () => {
    // Let SaveWorkspaceFile abort its original-byte read before releasing the URL.
    if (workspaceEntry) queueMicrotask(workspaceEntry.release);
  }, [workspaceEntry]);

  function navigate(direction: number) {
    const next = assets[index + direction];
    if (next) { setWorkspaceEntry(null); setAssetId(next.id); }
  }

  return <dialog ref={dialog} className="ic-media-preview" role="dialog" aria-label={t('媒体预览')} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {asset ? <PreviewContent key={asset.id} asset={asset} load={load} index={index} total={assets.length} onNavigate={navigate} onClose={onClose} onSaveWorkspace={setWorkspaceEntry} />
      : <div className="button-row"><p role="alert">{t('预览素材已不可用，请关闭后重新打开。')}</p><button type="button" autoFocus onClick={onClose}>{t('关闭')}</button></div>}
    <SaveWorkspaceFile entry={workspaceEntry?.asset.id === asset?.id ? workspaceEntry : null} onClose={() => setWorkspaceEntry(null)} />
  </dialog>;
}

function PreviewContent({ asset, load, index, total, onNavigate, onClose, onSaveWorkspace }: {
  asset: Asset;
  load: MediaPreviewProps['load'];
  index: number;
  total: number;
  onNavigate(direction: number): void;
  onClose(): void;
  onSaveWorkspace(entry: LoadedAsset): void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ load: MediaPreviewProps['load']; entry?: LoadedAsset; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState(fitView);
  const [panning, setPanning] = useState(false);
  const [copy, setCopy] = useState<CopyState>({ status: 'preparing' });
  const [notice, setNotice] = useState('');
  const [mediaError, setMediaError] = useState('');
  const current = result?.load === load ? result : null;
  const entry = current?.entry;
  const image = asset.mimeType.startsWith('image/');
  const video = asset.mimeType.startsWith('video/');
  const stage = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const previewImage = useRef<HTMLImageElement>(null);
  const clearMedia = useCallback(() => {
    previewImage.current?.removeAttribute('src');
    const element = player.current;
    if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
  }, []);
  const prepared = useRef<string | null>(null);
  const writing = useRef(false);
  const mounted = useRef(false);
  const drag = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    let held: LoadedAsset | undefined;
    mounted.current = true;
    prepared.current = null;
    setResult(null);
    setCopy({ status: 'preparing' });
    setMediaError('');
    void (async () => {
      let loaded: LoadedAsset;
      try { loaded = await load(asset.id); }
      catch (cause) { if (!controller.signal.aborted) setResult({ load, error: errorMessage(cause) }); return; }
      if (controller.signal.aborted) { loaded.release(); return; }
      held = loaded;
      setResult({ load, entry: loaded });
      if (!image) return;
      if (isExternalApp()) {
        setCopy({ status: 'unavailable', error: t('当前客户端不支持复制图片，请使用下载原图。') });
        return;
      }
      try {
        const data = await prepareClipboard(loaded, controller.signal);
        if (controller.signal.aborted) return;
        prepared.current = data;
        setCopy({ status: 'ready' });
      } catch (cause) { if (!controller.signal.aborted) setCopy({ status: 'failed', error: errorMessage(cause) }); }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      prepared.current = null;
      clearMedia();
      held?.release();
    };
  }, [asset.id, load, image, attempt, t, clearMedia]);

  useEffect(() => {
    const element = stage.current;
    if (!element || !image) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const x = event.clientX - bounds.left - bounds.width / 2;
      const y = event.clientY - bounds.top - bounds.height / 2;
      setView((previous) => {
        const zoom = clampZoom(previous.zoom * Math.exp(-event.deltaY * (event.ctrlKey || event.metaKey ? 0.01 : 0.0015)));
        const ratio = zoom / previous.zoom;
        return { zoom, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio };
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [image]);

  function zoomBy(amount: number) { setView((previous) => ({ ...previous, zoom: clampZoom(Number((previous.zoom + amount).toFixed(2))) })); }

  function closeMenu() {
    if (menu.current?.matches(':popover-open')) { menu.current.hidePopover(); stage.current?.focus(); }
  }

  function openMenu(event: React.MouseEvent) {
    event.preventDefault();
    if (!entry) return;
    const element = menu.current!;
    element.showPopover();
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  async function copyOriginal() {
    const data = prepared.current;
    if (!entry || !data || writing.current) return;
    closeMenu();
    writing.current = true;
    setCopy({ status: 'writing' });
    setNotice('');
    try {
      // Encoding finishes before the gesture; enter the existing native bridge without awaiting anything else.
      await app().writeClipboardImage({ data, mimeType: 'image/png' });
      if (mounted.current) { setCopy({ status: 'ready' }); setNotice(t('原图已复制到剪贴板')); }
    } catch (cause) { if (mounted.current) setCopy({ status: 'failed', error: errorMessage(cause) }); }
    finally { writing.current = false; }
  }

  async function downloadOriginal() {
    if (!entry) return;
    closeMenu();
    try {
      const loaded = await load(asset.id);
      if (!mounted.current) { loaded.release(); return; }
      download(loaded.url, loaded.asset.name, loaded.release);
    } catch (cause) { if (mounted.current) setNotice(errorMessage(cause)); }
  }

  async function saveToWorkspace() {
    if (!entry || !app().saveWorkspaceFile) return;
    closeMenu();
    try {
      const loaded = await load(asset.id);
      if (!mounted.current) { loaded.release(); return; }
      onSaveWorkspace(loaded);
    } catch (cause) { if (mounted.current) setNotice(errorMessage(cause)); }
  }

  const canCopy = !!entry && !!prepared.current && copy.status !== 'writing';
  const copyTitle = copy.status === 'preparing' ? t('正在准备原图…') : copy.status === 'writing' ? t('正在复制原图…') : copy.error || t('复制原图');
  const canSaveWorkspace = !!app().saveWorkspaceFile;
  const workspaceTitle = canSaveWorkspace ? t('保存到工作区') : t('当前客户端不支持保存到 Agent 工作区。');

  return <div className="ic-media-content" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); closeMenu(); onNavigate(event.key === 'ArrowLeft' ? -1 : 1); }
    else if (image && (event.key === '+' || event.key === '=' || event.key === '-')) { event.preventDefault(); zoomBy(event.key === '-' ? -0.2 : 0.2); }
  }}>
    <header><strong title={asset.name}>{asset.name}</strong><button type="button" className="icon" autoFocus title={t('关闭')} aria-label={t('关闭媒体预览')} onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <div ref={stage} className="ic-media-stage" tabIndex={-1}>
      {!entry && (current?.error ? <div className="ic-media-message"><p className="inline-error" role="alert">{current.error}</p><button type="button" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}>{t('重新读取')}</button></div> : <p className="quiet" role="status">{t('读取预览…')}</p>)}
      {entry && image && <img ref={previewImage} src={entry.url} alt={asset.name} draggable={false} className={`ic-media-image${panning ? ' is-panning' : ''}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }} onContextMenu={openMenu} onDoubleClick={() => setView(fitView)} onError={() => setMediaError(t('图片解码失败'))} onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        closeMenu();
        drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
        event.currentTarget.setPointerCapture(event.pointerId);
        setPanning(true);
      }} onPointerMove={(event) => {
        const origin = drag.current;
        if (!origin || origin.pointerId !== event.pointerId) return;
        setView((previous) => ({ ...previous, x: origin.x + event.clientX - origin.clientX, y: origin.y + event.clientY - origin.clientY }));
      }} onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { drag.current = null; setPanning(false); }} onLostPointerCapture={() => { drag.current = null; setPanning(false); }} />}
      {entry && video && <video ref={player} src={entry.url} controls playsInline preload="metadata" aria-label={t('视频预览：{name}', { name: asset.name })} onContextMenu={openMenu} onError={() => setMediaError(t('视频无法播放，请下载后使用其他播放器打开。'))} />}
      {entry && !image && !video && <p>{asset.name}</p>}
    </div>
    <footer>
      <div className="ic-media-controls">
        {image && <div className="ic-media-control-group"><button type="button" className="icon" disabled={!entry || view.zoom <= 0.1} title={t('缩小')} aria-label={t('缩小')} onClick={() => zoomBy(-0.2)}><Minus size={16} aria-hidden="true" /></button><button type="button" className="ic-media-zoom" disabled={!entry} title={t('适应内容')} aria-label={t('适应内容')} onClick={() => setView(fitView)}>{t('{value}%', { value: Math.round(view.zoom * 100) })}</button><button type="button" className="icon" disabled={!entry || view.zoom >= 5} title={t('放大')} aria-label={t('放大')} onClick={() => zoomBy(0.2)}><Plus size={16} aria-hidden="true" /></button></div>}
        <div className="ic-media-control-group">{image && <button type="button" className="icon" disabled={!canCopy} title={copyTitle} aria-label={t('复制原图')} onClick={() => void copyOriginal()}><Copy size={16} aria-hidden="true" /></button>}<button type="button" className="icon" disabled={!entry} title={t('下载原始文件')} aria-label={t('下载 {name}', { name: asset.name })} onClick={downloadOriginal}><Download size={16} aria-hidden="true" /></button><button type="button" className="icon" disabled={!entry || !canSaveWorkspace} title={workspaceTitle} aria-label={workspaceTitle} onClick={saveToWorkspace}><FolderDown size={16} aria-hidden="true" /></button></div>
        {total > 1 && <div className="ic-media-control-group"><button type="button" className="icon" disabled={index === 0} title={t('上一个素材')} aria-label={t('上一个素材')} onClick={() => onNavigate(-1)}><ChevronLeft size={18} aria-hidden="true" /></button><span className="ic-media-counter" aria-live="polite">{t('{current} / {total}', { current: index + 1, total })}</span><button type="button" className="icon" disabled={index + 1 === total} title={t('下一个素材')} aria-label={t('下一个素材')} onClick={() => onNavigate(1)}><ChevronRight size={18} aria-hidden="true" /></button></div>}
      </div>
      {mediaError && <p className="inline-error" role="alert">{mediaError}</p>}
      {image && copy.error && <div className="ic-media-feedback"><p className="inline-error" role={copy.status === 'failed' ? 'alert' : 'status'}>{copy.error}</p>{copy.status === 'failed' && !prepared.current && <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t('重试')}</button>}</div>}
      {notice && <p className="quiet" role="status">{notice}</p>}
    </footer>
    <div ref={menu} className="ic-media-menu" popover="auto" role="menu" aria-label={t('素材操作')} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      {image && <button type="button" role="menuitem" disabled={!canCopy} title={copyTitle} onClick={() => void copyOriginal()}><Copy size={15} aria-hidden="true" />{t(copy.status === 'preparing' ? '正在准备原图…' : copy.status === 'writing' ? '正在复制原图…' : '复制原图')}</button>}
      <button type="button" role="menuitem" onClick={downloadOriginal}><Download size={15} aria-hidden="true" />{t('下载原始文件')}</button>
      <button type="button" role="menuitem" disabled={!canSaveWorkspace} title={workspaceTitle} onClick={saveToWorkspace}><FolderDown size={15} aria-hidden="true" />{t('保存到工作区')}</button>
    </div>
  </div>;
}
