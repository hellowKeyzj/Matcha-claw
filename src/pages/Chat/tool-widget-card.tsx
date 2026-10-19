// Adapted from OpenClaw ui/src/pages/chat/components/widget-card.ts.
// Copyright (c) 2026 OpenClaw Foundation. SPDX-License-Identifier: MIT.
// See tool-renderers/openclaw/LICENSE and tool-renderers/openclaw/NOTICE.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, Loader2, PanelTopOpen, SquareActivity } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { RuntimeContentHost, type RuntimeContentHandle } from '@/components/runtime-surfaces/RuntimeContentHost';
import { buildSessionIdentityKey, sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { ToolActivityViewModel } from './tool-activity-view-model';
import { exportWidgetImage, WidgetImageError } from './tool-widget-card-image';

type WidgetPreview = NonNullable<ToolActivityViewModel['canvasPreview']>;
type Props = {
  preview: WidgetPreview;
  onOpen?: () => void;
  sessionIdentity?: SessionIdentity;
  onSendMessage?: (text: string) => void | Promise<void>;
  onOpenLink?: (url: string) => void | Promise<void>;
};

function WidgetCard({ preview, onOpen, sessionIdentity, onSendMessage, onOpenLink }: Props) {
  const { t } = useTranslation('chat');
  const contentRef = useRef<RuntimeContentHandle>(null);
  const exportRef = useRef<AbortController | null>(null);
  const [height, setHeight] = useState(() => Math.max(160, Math.min(1200, preview.preferredHeight ?? 320)));
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptor = preview.runtimeSurface && sessionIdentity
    && sessionIdentitiesEqual(preview.runtimeSurface.sessionIdentity, sessionIdentity) ? preview.runtimeSurface : null;
  const canExport = descriptor?.kind === 'canvas' && descriptor.sandbox !== 'strict';
  const nativeApp = descriptor?.kind === 'mcp-app';

  useEffect(() => () => {
    exportRef.current?.abort();
    exportRef.current = null;
  }, []);

  const exportImage = async (action: 'copy' | 'download') => {
    const content = contentRef.current;
    if (!content || !canExport || exportRef.current) return;
    const operation = new AbortController();
    exportRef.current = operation;
    setExporting(true);
    setError(null);
    try {
      await exportWidgetImage(action, content, preview.title, operation.signal);
      if (exportRef.current === operation && action === 'copy') toast.success(t('toolActivity.widget.imageCopied'));
    } catch (caught) {
      if (exportRef.current === operation) {
        const reason = caught instanceof WidgetImageError
          ? t(`toolActivity.widget.${caught.code}`)
          : caught instanceof Error ? caught.message : String(caught);
        setError(t('toolActivity.widget.exportFailed', { error: reason }));
      }
    } finally {
      operation.abort();
      if (exportRef.current === operation) {
        exportRef.current = null;
        setExporting(false);
      }
    }
  };

  return (
    <section aria-label={preview.title} className="overflow-hidden rounded-2xl border border-border/60 bg-background">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <SquareActivity aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={preview.title}>{preview.title}</span>
        {onOpen ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onOpen}>
            <PanelTopOpen aria-hidden="true" className="h-3.5 w-3.5" />
            {t(nativeApp ? 'toolActivity.widget.openApp' : 'toolActivity.openSurface')}
          </Button>
        ) : null}
        {canExport ? <>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={exporting}
            aria-label={t('toolActivity.widget.copyImage')} title={t('toolActivity.widget.copyImage')}
            onClick={() => { void exportImage('copy'); }}>
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={exporting}
            aria-label={t('toolActivity.widget.downloadImage')} title={t('toolActivity.widget.downloadImage')}
            onClick={() => { void exportImage('download'); }}>
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </> : null}
      </div>
      {descriptor ? <div style={{ height }}>
        <RuntimeContentHost ref={contentRef} source={descriptor.kind === 'mcp-app'
          ? { kind: 'mcp-app', descriptor } : { kind: 'canvas', descriptor }}
          onSendMessage={onSendMessage} onOpenLink={onOpenLink} onHeightChange={setHeight} />
      </div> : <p role="status" className="px-3 pb-3 text-xs text-muted-foreground">{t('toolActivity.widget.unavailable')}</p>}
      {exporting ? <p role="status" className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />{t('toolActivity.widget.exporting')}
      </p> : null}
      {error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {preview.rawText ? <details className="border-t border-border/50 px-3 py-2 text-xs">
        <summary data-chat-local-geometry-anchor="true" className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('toolActivity.details')}</summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono">{preview.rawText}</pre>
      </details> : null}
    </section>
  );
}

export function ToolWidgetCard(props: Props) {
  const descriptor = props.preview.runtimeSurface;
  const key = JSON.stringify([
    props.sessionIdentity ? buildSessionIdentityKey(props.sessionIdentity) : null,
    descriptor?.kind, descriptor ? buildSessionIdentityKey(descriptor.sessionIdentity) : null,
    descriptor?.kind === 'mcp-app' ? descriptor.viewId : descriptor?.documentId,
    descriptor?.kind === 'canvas' ? descriptor.sandbox : undefined,
  ]);
  return <WidgetCard key={key} {...props} />;
}
