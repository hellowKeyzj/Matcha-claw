import { useLayoutEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { Asset, DesignDocument, ExportResult, ImageLayer } from '../document';
import { call, download, errorMessage, ToolError } from './api';
import { t, useTranslation } from './i18n';

export interface ExportProps {
  document: DesignDocument;
  selected: string[];
  onClose(): void;
  onNotice(message: string): void;
}

type Format = 'png' | 'jpeg';
type ExportState =
  | { kind: 'idle' }
  | { kind: 'working'; completed: number; total: number }
  | { kind: 'completed'; message: string }
  | { kind: 'failed'; message: string };

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, (cause) => {
      signal.removeEventListener('abort', abort);
      reject(cause);
    });
  });
}

async function renderImage(design: DesignDocument, layerId: string, format: Format, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  // The tool transport cannot cancel accepted calls; closing only discards their results.
  const rendered = await waitFor(call<ExportResult>('document_export', {
    documentId: design.id, expectedRevision: design.revision, format, scale: 1, layerIds: [layerId],
  }), signal);
  if (rendered.renderedRevision !== design.revision) throw new Error(t('画板版本已变更，请重新打开导出面板后重试。'));
  signal.throwIfAborted();
  const { asset, data } = await waitFor(call<{ asset: Asset; data: string }>('asset_read', { assetId: rendered.asset.id }), signal);
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  const hasFormat = format === 'jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (asset.id !== rendered.asset.id || asset.mimeType !== `image/${format}` || !hasFormat) throw new Error(t('导出结果无效，请重新导出。'));
  signal.throwIfAborted();
  return bytes;
}

async function archive(files: Record<string, Uint8Array>, signal: AbortSignal): Promise<Blob> {
  const { zip } = await waitFor(import('fflate'), signal);
  signal.throwIfAborted();
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const abort = () => { terminate(); reject(signal.reason); };
    const terminate = zip(files, { level: 0 }, (cause, result) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (cause) reject(new Error(t('无法生成 ZIP 文件，请减少图片数量后重试。'), { cause }));
      else resolve(result);
    });
    signal.addEventListener('abort', abort, { once: true });
  });
  signal.throwIfAborted();
  return new Blob([bytes as BlobPart], { type: 'application/zip' });
}

function fileStem(name: string): string {
  const stem = Array.from(name, (character) => character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? '_' : character)
    .slice(0, 60).join('').replace(/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i, '').trim().replace(/[. ]+$/, '');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `_${stem}` : stem;
}

export function Export({ document: design, selected, onClose, onNotice }: ExportProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<Format>('png');
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const active = useRef<AbortController | null>(null);
  const ownedUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const images = design.layers.filter((layer): layer is ImageLayer => layer.type === 'image' && selected.includes(layer.id));
  const working = state.kind === 'working';

  function releaseDownloads() {
    for (const [url, timer] of ownedUrls.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    ownedUrls.current.clear();
  }
  useLayoutEffect(() => {
    const urls = ownedUrls.current;
    return () => {
      active.current?.abort();
      for (const [url, timer] of urls) { clearTimeout(timer); URL.revokeObjectURL(url); }
      urls.clear();
    };
  }, []);

  function close() {
    active.current?.abort();
    releaseDownloads();
    onClose();
  }

  async function exportImages(event: React.FormEvent) {
    event.preventDefault();
    if (active.current) return;
    if (!images.length) { setState({ kind: 'failed', message: t('请先选择需要导出的图片。') }); return; }
    const controller = new AbortController();
    const { signal } = controller;
    active.current = controller;
    setState({ kind: 'working', completed: 0, total: images.length });
    const batch = images.length > 1;
    const files: Record<string, Uint8Array> = {};
    let single: { blob: Blob; name: string } | undefined;
    let succeeded = 0;
    let failed = 0;
    let firstError = '';
    try {
      for (const [index, layer] of images.entries()) {
        signal.throwIfAborted();
        try {
          // Each layer renders independently, even when it shares an original asset.
          const bytes = await renderImage(design, layer.id, format, signal);
          signal.throwIfAborted();
          const stem = fileStem(layer.name);
          const name = `${index + 1}${stem ? `-${stem}` : ''}.${format === 'jpeg' ? 'jpg' : 'png'}`;
          if (batch) files[name] = bytes;
          else single = { blob: new Blob([bytes as BlobPart], { type: `image/${format}` }), name };
          succeeded++;
        } catch (cause) {
          signal.throwIfAborted();
          failed++;
          firstError ||= cause instanceof ToolError && cause.code === 'revision_conflict'
            ? t('画板版本已变更，请重新打开导出面板后重试。')
            : cause instanceof ToolError && cause.code === 'export_empty'
              ? t('所选图层已隐藏，请显示后再导出。') : errorMessage(cause);
        }
        setState({ kind: 'working', completed: index + 1, total: images.length });
      }
      signal.throwIfAborted();
      if (!succeeded) {
        setState({ kind: 'failed', message: t('导出失败：成功 0 张，失败 {failed} 张。{error}', { failed, error: firstError }) });
        return;
      }
      const blob = batch ? await archive(files, signal) : single!.blob;
      const name = batch ? `${fileStem(design.name) || design.id}.zip` : single!.name;
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const timer = setTimeout(() => { URL.revokeObjectURL(url); ownedUrls.current.delete(url); }, 60_000);
      ownedUrls.current.set(url, timer);
      try { download(url, name); }
      catch (cause) { clearTimeout(timer); ownedUrls.current.delete(url); URL.revokeObjectURL(url); throw cause; }
      const summary = t(batch ? '已导出 {succeeded} 张图片，失败 {failed} 张，已打包 ZIP' : '已导出 {succeeded} 张图片，失败 {failed} 张', { succeeded, failed });
      const message = failed ? `${summary}\n${firstError}` : summary;
      setState({ kind: 'completed', message });
      onNotice(message);
    } catch (cause) {
      if (!signal.aborted) setState({ kind: 'failed', message: t('导出失败：成功 0 张，失败 {failed} 张。{error}', { failed: images.length, error: errorMessage(cause) }) });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  return <form className="ic-export-form" aria-busy={working} onSubmit={(event) => void exportImages(event)} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div className="ic-segmented" role="group" aria-label={t('导出格式')}>
      <button type="button" aria-pressed={format === 'png'} disabled={working} onClick={() => setFormat('png')}>{t('PNG')}</button>
      <button type="button" aria-pressed={format === 'jpeg'} disabled={working} onClick={() => setFormat('jpeg')}>{t('JPG')}</button>
    </div>
    <p className="quiet">{images.length > 1 ? t('分别导出 {count} 张图片，并打包为 ZIP', { count: images.length }) : t('导出选中的图片')}</p>
    <p className="quiet">{t('按当前已保存版本导出完整图层效果，不受画布缩放影响。')}</p>
    {state.kind === 'working' && <p className="quiet" role="status">{t('正在导出 {completed}/{total} 张图片…', { completed: state.completed, total: state.total })}</p>}
    {state.kind === 'completed' && <p className="quiet" role="status">{state.message}</p>}
    {state.kind === 'failed' && <p className="inline-error" role="alert">{state.message}</p>}
    <div className="button-row">
      <button type="button" onClick={close}>{t('取消')}</button>
      <button className="primary" disabled={working || !images.length}><Download size={14} aria-hidden="true" />{t(working ? '正在导出…' : '下载')}</button>
    </div>
  </form>;
}
