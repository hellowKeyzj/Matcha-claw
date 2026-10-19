// SPDX-License-Identifier: MIT
// Adapted from OpenClaw ui/src/pages/chat/components/browser-tab-card.ts.
// Attribution: ./tool-renderers/openclaw/LICENSE and ./tool-renderers/openclaw/NOTICE.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, ExternalLink, Globe, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { invokeIpc } from '@/lib/api-client';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionRenderToolStatusKind } from '@/types/session/tool-card';
import { loadBrowserScreenshot } from '@/components/runtime-surfaces/browser-screenshots';
import type { ToolActivityBrowserTabPreview } from './tool-activity-view-model';

function BrowserThumbnail({ preview, scopeKey, revision, onOpen, title }: {
  preview: ToolActivityBrowserTabPreview;
  scopeKey: string;
  revision: string;
  onOpen?: () => void;
  title: string;
}) {
  const { t } = useTranslation('chat');
  const { target, node, profile, targetId } = preview;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadBrowserScreenshot({ target, ...(node ? { node } : {}), query: { profile } }, scopeKey, targetId, revision, () => current).then((image) => {
      if (current && image) setSrc(image.dataUrl);
    });
    return () => { current = false; };
  }, [scopeKey, target, node, profile, targetId, revision]);
  return src ? (
    <button type="button" className="block w-full overflow-hidden border-b border-border/40" disabled={!onOpen} onClick={onOpen} aria-label={`${title}${preview.url ? ` — ${preview.url}` : ''}`} title={t('toolActivity.browser.openPanel')}>
      <img src={src} alt="" className="block max-h-[240px] w-full object-cover object-top" onError={() => setSrc(null)} />
    </button>
  ) : null;
}

export default function ToolBrowserCard({ preview, onOpen, sessionIdentity, latest = false, revision, status }: {
  preview: ToolActivityBrowserTabPreview;
  onOpen?: () => void;
  sessionIdentity?: SessionIdentity;
  latest?: boolean;
  revision?: string;
  status?: SessionRenderToolStatusKind;
}) {
  const { t } = useTranslation('chat');
  const scopeKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const thumbnailKey = latest && status === 'completed' && revision && scopeKey
    ? JSON.stringify([scopeKey, preview.target, preview.node, preview.profile, preview.targetId, revision]) : null;
  const url = preview.url;
  let host = url;
  let canOpenExternal = false;
  try {
    const parsed = new URL(url ?? '');
    host = parsed.host || url;
    canOpenExternal = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    // Internal browser pages can have no host; retain their supplied label.
  }
  const title = preview.title?.trim() || host || t('toolActivity.browserTab');

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('toolActivity.copied'));
    } catch {
      toast.error(t('toolActivity.browser.copyFailed'));
    }
  };
  const openExternal = async () => {
    if (!url || !canOpenExternal) return;
    try {
      await invokeIpc('shell:openExternal', url);
    } catch {
      toast.error(t('toolActivity.browser.openFailed'));
    }
  };

  return (
    <div className="w-full max-w-[320px] overflow-hidden rounded-[16px] border border-border/45 bg-card shadow-sm">
      {thumbnailKey && scopeKey && revision ? <BrowserThumbnail key={thumbnailKey} preview={preview} scopeKey={scopeKey} revision={revision} onOpen={onOpen} title={title} /> : null}
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-foreground" title={title}>{title}</div>
          {url ? <div className="truncate text-[11px] text-muted-foreground" title={url}>{url}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {onOpen ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-md px-2" onClick={onOpen} title={t('toolActivity.browser.openPanel')}>
              {t('toolActivity.browser.open')}
            </Button>
          ) : null}
          {url ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-md" aria-label={t('toolActivity.browser.moreActions')}>
                  <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => { void copyUrl(); }}>
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />{t('toolActivity.browser.copyUrl')}
                </DropdownMenuItem>
                {canOpenExternal ? (
                  <DropdownMenuItem onSelect={() => { void openExternal(); }}>
                    <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />{t('toolActivity.browser.openNewTab')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 border-t border-border/40 px-3 py-1.5 text-[10px] leading-4 text-muted-foreground">
        <span>{preview.target}</span>
        <span className="max-w-full truncate" title={preview.targetId}>target {preview.targetId}</span>
        <span className="max-w-full truncate" title={preview.profile}>profile {preview.profile}</span>
        {preview.node ? <span className="max-w-full truncate" title={preview.node}>node {preview.node}</span> : null}
      </div>
    </div>
  );
}
