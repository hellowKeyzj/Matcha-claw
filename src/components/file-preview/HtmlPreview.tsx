import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface HtmlPreviewProps {
  source: string;
  fileName?: string;
  className?: string;
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

export function HtmlPreview({ source, fileName, className }: HtmlPreviewProps) {
  const { t } = useTranslation('chat');

  return (
    <div className={cn('h-full min-h-0 bg-white', className)}>
      <iframe
        data-testid="html-preview-frame"
        title={fileName ?? t('filePreview.html.title', 'HTML preview')}
        srcDoc={buildHtmlPreviewDocument(source)}
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}
