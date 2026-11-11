import { forwardRef, useEffect, useEffectEvent, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import type { AppDocumentResourcesResult } from '@matcha/app-plugins-sdk';
import { isFromInspector, type FromInspector, type ToInspector } from '../../genoffice/apps/html/src/renderer/preview/inspector-protocol';
import { useI18n } from '../../genoffice/apps/html/src/renderer/i18n/locale';
import { appApi } from '../documents/client';
import { preview } from './preview';

export interface PreviewFrameHandle { post(message: ToInspector): void; }
interface Props {
  url: string | null; nonce: number; zoom: number;
  onMessage(message: FromInspector): void; onLoad?(): void; draft?: string | null;
}
const errors = {
  zh: '无法加载文档资源', en: 'Could not load document resources',
  ja: 'ドキュメントのリソースを読み込めませんでした', ru: 'Не удалось загрузить ресурсы документа',
  ko: '문서 리소스를 불러오지 못했습니다'
};
export const PreviewFrame = forwardRef<PreviewFrameHandle, Props>(function PreviewFrame({ nonce, zoom, onMessage, onLoad }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { t, lang } = useI18n();
  // In-place source commits stay in the frame; accepted resource changes need a new snapshot.
  const resourceVersion = useSyncExternalStore(preview.subscribe, preview.resourceVersion);
  const [view, setView] = useState<{ nonce: number; resourceVersion: number; lease?: AppDocumentResourcesResult; error?: string }>();
  const receiveMessage = useEffectEvent(onMessage);
  useEffect(() => {
    let closed = false;
    let lease: AppDocumentResourcesResult | undefined;
    const resources = appApi().documentResources;
    void resources.create(preview.snapshot()).then((result) => {
      lease = result;
      if (closed) { void resources.release({ id: result.id }).catch(console.error); return; }
      setView({ nonce, resourceVersion, lease: result });
    }).catch((error: unknown) => {
      if (!closed) setView({ nonce, resourceVersion, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { closed = true; if (lease) void resources.release({ id: lease.id }).catch(console.error); };
  }, [nonce, resourceVersion]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !isFromInspector(event.data)) return;
      receiveMessage(event.data);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  useImperativeHandle(ref, () => ({ post(message) { frame.current?.contentWindow?.postMessage(message, '*'); } }));
  const active = view?.nonce === nonce && view.resourceVersion === resourceVersion ? view : undefined;
  return <div className="preview-host" style={{ zoom: zoom / 100 }}>
    {active?.error && <div role="alert">{errors[lang as keyof typeof errors] ?? errors.en}: {active.error}</div>}
    {active?.lease && <iframe key={active.lease.id} ref={frame} className="preview-frame" title={t('viewPreview')} src={active.lease.url}
      onLoad={onLoad} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />}
  </div>;
});
