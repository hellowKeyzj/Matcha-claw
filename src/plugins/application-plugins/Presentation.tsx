import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { hostAppPresentationBootstrap } from '@/lib/host-api';
import type { AppPresentationBootstrap } from '@/types/desktop/app-plugin-sdk';
import { AppFrame } from './AppFrame';
import '@/i18n';
import '@/styles/globals.css';

function htmlDocument(html: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
}

function Presentation() {
  const { t } = useTranslation('common');
  const [view, setView] = useState<AppPresentationBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let closed = false;
    void hostAppPresentationBootstrap().then((bootstrap) => {
      if (closed) return;
      document.title = bootstrap.title;
      setView(bootstrap);
    }).catch((failure: unknown) => {
      if (!closed) setError(failure instanceof Error ? failure.message : t('appFrame.loadFailed'));
    });
    return () => { closed = true; };
  }, [t]);

  if (error) return <div role="alert" className="flex h-screen items-center justify-center p-6 text-sm text-destructive">{error}</div>;
  if (!view) return <div role="status" className="flex h-screen items-center justify-center p-6 text-sm text-muted-foreground">{t('appFrame.loading')}</div>;
  return <main className="h-screen w-screen overflow-hidden">
    {view.content.kind === 'document'
      ? <iframe title={view.title} src={view.content.url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="h-full w-full border-0" />
      : view.content.kind === 'html'
      ? <iframe title={view.title} srcDoc={htmlDocument(view.content.html)} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-full w-full border-0" />
      : <AppFrame pluginId={view.pluginId} digest={view.digest} entry={view.entry} applicationId={view.applicationId} html={view.content.html} title={view.title} presentation={view} />}
  </main>;
}

export function mountPresentation(): void {
  const root = createRoot(document.getElementById('root')!);
  root.render(<Presentation />);
  if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
}
