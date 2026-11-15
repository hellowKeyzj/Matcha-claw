import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import type { TextFileReaderProps } from './extensions';

export interface HtmlPreviewProps {
  source: string;
  fileName?: string;
  className?: string;
  readResource?: TextFileReaderProps['readResource'];
}

const HTML_PREVIEW_SECURITY_HEAD = `
<base href="about:blank" target="_self">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; navigate-to 'none'; base-uri 'none'">
<style>
  :where(a[href], area[href]) {
    color: inherit !important;
    text-decoration: none !important;
    cursor: default !important;
    pointer-events: none !important;
  }

  :where(form, button, input, select, textarea, label, option) {
    pointer-events: none !important;
  }

  :where(button, input, select, textarea) {
    cursor: default !important;
  }
</style>`;

function buildHtmlPreviewDocument(source: string) {
  const headTag = source.match(/<head(?:\s[^>]*)?>/i);

  if (headTag?.index !== undefined) {
    const insertAt = headTag.index + headTag[0].length;
    return `${source.slice(0, insertAt)}${HTML_PREVIEW_SECURITY_HEAD}${source.slice(insertAt)}`;
  }

  const htmlTag = source.match(/<html(?:\s[^>]*)?>/i);

  if (htmlTag?.index !== undefined) {
    const insertAt = htmlTag.index + htmlTag[0].length;
    return `${source.slice(0, insertAt)}<head>${HTML_PREVIEW_SECURITY_HEAD}</head>${source.slice(insertAt)}`;
  }

  return `<!doctype html><html><head>${HTML_PREVIEW_SECURITY_HEAD}</head><body>${source}</body></html>`;
}

function useHtmlPreviewDocument(source: string, readResource: HtmlPreviewProps['readResource']) {
  const request = useMemo(() => ({ html: buildHtmlPreviewDocument(source), readResource }), [source, readResource]);
  const [resolved, setResolved] = useState<{ request: typeof request; html: string; failed: boolean }>();
  useEffect(() => {
    let active = true;
    void (async () => {
      let html = request.html;
      let failed = false;
      if (request.readResource) {
        const document = new DOMParser().parseFromString(request.html, 'text/html');
        const resources = new Map<string, { element: Element; attribute: string }[]>();
        for (const element of document.querySelectorAll('img[src], video[src], audio[src], source[src], video[poster]')) {
          for (const attribute of ['src', 'poster']) {
            const path = element.getAttribute(attribute);
            if (!path || /^(?:data:|blob:)/iu.test(path)) continue;
            const targets = resources.get(path) ?? [];
            targets.push({ element, attribute });
            resources.set(path, targets);
          }
        }
        let remainingBytes = 50 * 1024 * 1024;
        for (const [path, targets] of resources) {
          if (!active) return;
          try {
            const blob = await request.readResource(path, Math.max(1, remainingBytes));
            if (!active) return;
            if (!blob) continue;
            if (blob.size > remainingBytes || !/^(?:image|video|audio)\//.test(blob.type)) throw new Error('unavailable');
            remainingBytes -= blob.size;
            // An opaque sandbox cannot read the parent origin's Blob URLs.
            const url = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            if (!active) return;
            for (const { element, attribute } of targets) element.setAttribute(attribute, url);
          } catch {
            failed = true;
          }
        }
        if (resources.size > 0) html = `<!doctype html>${document.documentElement.outerHTML}`;
      }
      if (active) setResolved({ request, html, failed });
    })();
    return () => { active = false; };
  }, [request]);
  return resolved?.request === request ? resolved : null;
}

export function HtmlPreview({ source, fileName, className, readResource }: HtmlPreviewProps) {
  const { t } = useTranslation('chat');
  const preview = useHtmlPreviewDocument(source, readResource);

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-white', className)}>
      {preview ? <>
        {preview.failed ? <p role="status" className="shrink-0 px-4 py-2 text-sm text-destructive">{t('artifacts.previewLoadFailed', { error: t('media.previewUnavailable') })}</p> : null}
        <iframe
          data-testid="html-preview-frame"
          title={fileName ?? t('filePreview.html.title', 'HTML preview')}
          srcDoc={preview.html}
          sandbox=""
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </> : <div className="flex min-h-0 flex-1 items-center justify-center"><LoadingSpinner /></div>}
    </div>
  );
}
