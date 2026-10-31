import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { Button } from '@/components/ui/button';
import { hostAppPluginBundle } from '@/lib/host-api';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { AppComposeRequest, AppComposeSource, AppWebviewApi } from '@/types/desktop/app-plugin-sdk';
import { AppFrame } from './AppFrame';

export interface InstalledApplicationProps {
  pluginId: string;
  digest: string;
  entry: string;
  title: string;
  sessionIdentity?: SessionIdentity;
  onCompose?: (request: AppComposeRequest, source: AppComposeSource, signal: AbortSignal) => Promise<void>;
  registerCloseHandler?: AppWebviewApi['onCloseRequested'];
}

type BundleState = { key: string } & (
  | { status: 'ready'; html: string }
  | { status: 'error'; message: string }
);

const bundles = new Map<string, { digest: string; promise: Promise<{ html: string }> }>();

export function InstalledApplication({ pluginId, digest, entry, title, sessionIdentity, onCompose, registerCloseHandler }: InstalledApplicationProps) {
  const { t } = useTranslation('common');
  const key = JSON.stringify([pluginId, digest, entry]);
  const [state, setState] = useState<BundleState | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let closed = false;
    const bundleKey = JSON.stringify([pluginId, entry]);
    let bundle = bundles.get(bundleKey);
    if (bundle?.digest !== digest) {
      const promise = hostAppPluginBundle(pluginId, digest, entry);
      bundle = { digest, promise };
      bundles.set(bundleKey, bundle);
      void promise.catch(() => { if (bundles.get(bundleKey)?.promise === promise) bundles.delete(bundleKey); });
    }
    void bundle.promise.then(({ html }) => {
      if (!closed) setState({ key, status: 'ready', html });
    }).catch((error: unknown) => {
      if (!closed) setState({ key, status: 'error', message: error instanceof Error ? error.message : i18n.t('common:appFrame.bundleFailed') });
    });
    return () => { closed = true; };
  }, [pluginId, digest, entry, key, attempt]);

  if (!state || state.key !== key) return <div role="status" className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{t('appFrame.reading')}</div>;
  if (state.status === 'error') return <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-sm">
    <p className="max-w-prose text-destructive [overflow-wrap:anywhere]">{state.message}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => { setState(null); setAttempt((value) => value + 1); }}>{t('appFrame.retry')}</Button>
  </div>;
  return <AppFrame pluginId={pluginId} digest={digest} html={state.html} title={title} sessionIdentity={sessionIdentity} onCompose={onCompose} registerCloseHandler={registerCloseHandler} />;
}
