import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { hostAppPluginBundle, hostAppPluginRuntimeStatus } from '@/lib/host-api';
import { SandboxFrame } from '@/plugin-host/SandboxFrame';

export type InstalledReaderInput = {
  fileName: string;
  extension: string;
  mimeType: string;
} & ({ source: 'text'; text: string } | { source: 'binary'; data: ArrayBuffer });

type BundleState = { key: string } & (
  | { status: 'loading' }
  | { status: 'ready'; html: string }
  | { status: 'error'; message: string }
);

export interface InstalledReaderProps {
  pluginId: string;
  digest: string;
  entry: string;
  title: string;
  input: InstalledReaderInput;
}

export function InstalledReader({ pluginId, digest, entry, title, input }: InstalledReaderProps) {
  const { t } = useTranslation('chat');
  const resourceKey = JSON.stringify([pluginId, digest, entry]);
  const [state, setState] = useState<BundleState>({ key: resourceKey, status: 'loading' });
  const [instanceId] = useState(() => crypto.randomUUID());
  const report = useCallback((state: 'mounted' | 'ready' | 'error' | 'disposed', message?: string) => {
    void hostAppPluginRuntimeStatus({ pluginId, digest, entry, instanceId, state, ...(message ? { message } : {}) }).catch(() => {});
  }, [pluginId, digest, entry, instanceId]);
  const onReady = useCallback(() => report('ready'), [report]);
  const onError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setState({ key: resourceKey, status: 'error', message });
    report('error', 'Installed reader failed');
  }, [report, resourceKey]);

  useEffect(() => {
    let cancelled = false;
    report('mounted');
    void hostAppPluginBundle(pluginId, digest, entry).then(({ html }) => {
      if (!cancelled) setState({ key: resourceKey, status: 'ready', html });
    }).catch((error: unknown) => {
      if (!cancelled) onError(error);
    });
    return () => { cancelled = true; report('disposed'); };
  }, [pluginId, digest, entry, onError, report, resourceKey]);

  if (state.key !== resourceKey || state.status === 'loading') {
    return <div className="flex h-full items-center justify-center"><LoadingSpinner /></div>;
  }
  if (state.status === 'error') {
    return <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{t('artifacts.previewLoadFailed', { error: state.message })}</div>;
  }
  return <SandboxFrame html={state.html} title={title} input={input} onReady={onReady} onError={onError} />;
}
