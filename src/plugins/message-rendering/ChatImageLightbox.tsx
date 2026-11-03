import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, FolderOpen, Loader2, Maximize, Minus, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { invokeIpc } from '@/lib/api-client';
import { hostWorkspaceMediaResolve } from '@/lib/host-api';
import { useContributions } from '@/plugin-host/react';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import { imagePreviewActions } from './extensions';

interface ChatImageLightboxProps {
  src: string;
  fileName: string;
  filePath?: string;
  mediaReference?: string;
  mimeType?: string;
  sessionIdentity?: SessionIdentity;
  onClose: () => void;
}

export function ChatImageLightbox(props: ChatImageLightboxProps) {
  return <Fragment key={props.src}><ImageLightbox key={JSON.stringify([props.fileName, props.sessionIdentity, props.mediaReference])} {...props} /></Fragment>;
}

function ImageLightbox({ src, fileName, filePath, mediaReference, mimeType, sessionIdentity, onClose }: ChatImageLightboxProps) {
  const { t } = useTranslation('common');
  const actions = useContributions(imagePreviewActions);
  const viewport = useRef<HTMLDivElement>(null);
  const [restoreFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const download = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(true);
  const [image, setImage] = useState<{ src: string; width: number; height: number } | null>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalSrc, setOriginalSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!mediaReference || !sessionIdentity) return;
    let active = true;
    let url: string | undefined;
    void hostWorkspaceMediaResolve({ reference: mediaReference, sessionIdentity }).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(new Blob([blob], { type: mimeType || 'application/octet-stream' }));
      setOriginalSrc(url);
    }).catch(() => { if (active) setError(t('imagePreview.loadFailed')); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [mediaReference, mimeType, sessionIdentity, t]);
  const fit = image && available.width && available.height ? Math.min(1, available.width / image.width, available.height / image.height) : 1;
  const scale = zoom ?? fit;
  const close = useCallback(() => {
    download.current?.abort();
    download.current = null;
    setOpen(false);
    onClose();
  }, [onClose]);

  useLayoutEffect(() => {
    return () => {
      download.current?.abort();
      download.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setAvailable({ width: Math.max(1, node.clientWidth - 48), height: Math.max(1, node.clientHeight - 48) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [image]);

  const downloadImage = async () => {
    const downloadSrc = mediaReference ? originalSrc : image?.src;
    if (!downloadSrc || download.current) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(true);
    setError(null);
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(downloadSrc, { signal: controller.signal });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      try {
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
      }
    } catch {
      if (download.current === controller) setError(t('imagePreview.downloadFailed'));
    } finally {
      window.clearTimeout(timeout);
      if (download.current === controller) {
        download.current = null;
        setDownloading(false);
      }
    }
  };

  const iconButton = 'h-9 w-9 shrink-0 rounded-full text-white/85 hover:bg-white/12 hover:text-white motion-reduce:transition-none';
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value) close(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md" />
      <Dialog.Content aria-describedby={undefined} className="fixed inset-0 z-50 flex flex-col text-white outline-none" onEscapeKeyDown={(event) => event.stopPropagation()} onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
      }}>
        <Dialog.Title className="pointer-events-none absolute left-6 right-6 top-5 z-10 truncate text-sm font-medium text-white/75">{fileName}</Dialog.Title>
        <div ref={viewport} className="mt-10 min-h-0 flex-1 overflow-auto overscroll-contain" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div className="flex min-h-full min-w-full w-max items-center justify-center p-6" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
            <img src={originalSrc ?? src} alt={fileName} draggable={false} onLoad={(event) => {
              const current = event.currentTarget;
              setImage({ src: current.src, width: current.naturalWidth, height: current.naturalHeight });
            }} onError={() => { setImage(null); setError(t('imagePreview.loadFailed')); }} className="block shrink-0 rounded-xl object-contain shadow-2xl" style={image ? { width: image.width * scale, height: image.height * scale, maxWidth: 'none' } : { maxWidth: '85vw', maxHeight: '75vh' }} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-3 px-4 pb-6 pt-3">
          {error && <p role="alert" className="max-w-xl text-center text-sm text-white/90">{error}</p>}
          <div className="flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/12 bg-black/45 p-2 shadow-lg backdrop-blur-xl">
            {image && (!mediaReference || originalSrc) && actions.map(({ id, component: Action }) => <Action key={id} src={originalSrc ?? image.src} fileName={fileName} sessionIdentity={sessionIdentity} onClose={close} />)}
            <Button type="button" variant="ghost" size="sm" className="h-9 rounded-full text-white/85 hover:bg-white/12 hover:text-white motion-reduce:transition-none" disabled={!image || downloading || !!mediaReference && !originalSrc} onClick={() => { void downloadImage(); }} aria-busy={downloading}>
              {downloading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Download aria-hidden="true" className="h-4 w-4" />}
              {t('imagePreview.downloadOriginal')}
            </Button>
            {filePath && <Button type="button" variant="ghost" size="icon" className={iconButton} onClick={() => { void invokeIpc<{ success: boolean }>('shell:showItemInFolder', filePath).then((result) => { if (!result.success) throw new Error(); }).catch(() => { if (viewport.current?.isConnected) setError(t('imagePreview.showInFolderFailed')); }); }} title={t('imagePreview.showInFolder')} aria-label={t('imagePreview.showInFolder')}>
              <FolderOpen aria-hidden="true" className="h-4 w-4" />
            </Button>}
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/15" />
            <Button type="button" variant="ghost" size="icon" className={iconButton} disabled={!image || scale <= 0.05} onClick={() => setZoom(Math.max(0.05, scale / 1.25))} title={t('imagePreview.zoomOut')} aria-label={t('imagePreview.zoomOut')}><Minus aria-hidden="true" className="h-4 w-4" /></Button>
            <output aria-label={t('imagePreview.zoomLevel')} aria-live="polite" className="w-12 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</output>
            <Button type="button" variant="ghost" size="icon" className={iconButton} disabled={!image || scale >= 4} onClick={() => setZoom(Math.min(4, scale * 1.25))} title={t('imagePreview.zoomIn')} aria-label={t('imagePreview.zoomIn')}><Plus aria-hidden="true" className="h-4 w-4" /></Button>
            <Button type="button" variant="ghost" size="icon" className={iconButton} disabled={!image} onClick={() => setZoom(null)} title={t('imagePreview.fitToScreen')} aria-label={t('imagePreview.fitToScreen')} aria-pressed={zoom === null}><Maximize aria-hidden="true" className="h-4 w-4" /></Button>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/15" />
            <Button type="button" variant="ghost" size="icon" className={iconButton} onClick={close} title={t('imagePreview.close')} aria-label={t('imagePreview.close')}><X aria-hidden="true" className="h-4 w-4" /></Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
