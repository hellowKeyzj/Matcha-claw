import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { hostApiFetch } from '@/lib/host-api';
import type { AppJson, AppToolResult } from '@/types/desktop/app-plugin-sdk';
import type { WorkspacePageProps } from '@/plugins/workspace/extensions';
import { AppFrame } from './AppFrame';
import type { AppFrameHandle } from './development-protocol';
import { applicationPath } from './plugin';
import { useDevelopmentStatus, type DevelopmentBundle, type DevelopmentStatus } from './development-status';

function DevelopmentFrame({ developmentId, bundle, status, active, visible, registerCloseHandler, handled, isCurrent, onError }: {
  developmentId: string;
  bundle: DevelopmentBundle;
  status: DevelopmentStatus;
  active: boolean;
  visible: boolean;
  registerCloseHandler?: WorkspacePageProps['registerCloseHandler'];
  handled: Set<string>;
  isCurrent: () => boolean;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation('applicationPlugins');
  const frame = useRef<AppFrameHandle>(null);
  const lifetime = useRef(new AbortController());
  const listeners = useMemo(() => new Set<(event: { topic: string; data: AppJson }) => void>(), []);
  const eventSequence = useRef(0);
  const pending = useRef(false);
  useLayoutEffect(() => {
    if (!active) lifetime.current.abort();
    else if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
  }, [active]);
  const development = useMemo(() => ({
    developmentId, revision: bundle.revision, entry: bundle.entry, manifest: bundle.manifest,
    call: async (name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error(t('preview.revisionChanged'));
      const requestSignal = AbortSignal.any([signal, lifetime.current.signal]);
      const result = await hostApiFetch<AppToolResult>('/api/app-plugins/development-call', {
        method: 'POST', body: JSON.stringify({ developmentId, revision: bundle.revision, name, arguments: args }), signal: requestSignal, timeoutMs: 20 * 60_000,
      });
      requestSignal.throwIfAborted();
      if (!isCurrent()) throw new Error(t('preview.revisionChanged'));
      return result;
    },
    subscribe: (listener: (event: { topic: string; data: AppJson }) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    report: (event: { level: 'info' | 'error'; message: string }) => {
      if (!isCurrent() || lifetime.current.signal.aborted) return;
      void hostApiFetch('/api/app-plugins/development-log', {
        method: 'POST', body: JSON.stringify({ developmentId, revision: bundle.revision, ...event }), signal: lifetime.current.signal,
      }).catch(() => {
        if (!lifetime.current.signal.aborted) onError(t('preview.logFailed'));
      });
    },
  }), [developmentId, bundle, listeners, lifetime, isCurrent, onError, t]);

  useLayoutEffect(() => {
    lifetime.current = new AbortController();
    return () => { lifetime.current.abort(); listeners.clear(); };
  }, [listeners]);

  useEffect(() => {
    if (status.revision !== bundle.revision || !isCurrent()) return;
    for (const event of status.events) {
      if (event.revision !== bundle.revision || event.seq <= eventSequence.current) continue;
      eventSequence.current = event.seq;
      for (const listener of listeners) listener({ topic: event.topic, data: event.data });
    }
  }, [status, bundle.revision, listeners, isCurrent]);

  useEffect(() => {
    if (!visible || pending.current || !isCurrent() || !frame.current?.getBounds()) return;
    const command = status.commands.find((candidate) => candidate.revision === bundle.revision && candidate.entry === bundle.entry && !handled.has(candidate.id));
    if (!command) return;
    const target = frame.current;
    const signal = lifetime.current.signal;
    handled.add(command.id);
    if (handled.size > 256) handled.delete(handled.values().next().value!);
    pending.current = true;
    void (async () => {
      try {
        const result = command.kind === 'inspect'
          ? await target.inspect(signal)
          : await target.act(command.action, signal);
        if (!signal.aborted && isCurrent()) {
          await hostApiFetch('/api/app-plugins/development-observe', {
            method: 'POST', body: JSON.stringify({ developmentId, revision: bundle.revision, commandId: command.id, result }), signal,
          });
        }
      } catch (cause) {
        if (signal.aborted || !isCurrent()) return;
        const error = cause instanceof Error ? cause.message : t('preview.commandFailed');
        try {
          await hostApiFetch('/api/app-plugins/development-observe', {
            method: 'POST', body: JSON.stringify({ developmentId, revision: bundle.revision, commandId: command.id, error }), signal,
          });
        } catch { if (!signal.aborted) onError(t('preview.observeFailed')); }
      } finally { pending.current = false; }
    })();
  }, [status, developmentId, bundle, visible, handled, lifetime, isCurrent, onError, t]);

  return <AppFrame ref={frame} pluginId={bundle.manifest.id} digest={bundle.digest} entry={bundle.entry} html={bundle.html}
    title={bundle.manifest.contributes.applications?.find((application) => application.entry === bundle.entry)?.name ?? bundle.manifest.name}
    development={development} registerCloseHandler={registerCloseHandler} />;
}

export default function DevelopmentPreview() {
  const { developmentId = '' } = useParams<{ developmentId: string }>();
  return <DevelopmentPreviewContent key={developmentId} developmentId={developmentId} />;
}

export interface DevelopmentPreviewContentProps {
  developmentId: string;
  entry?: string;
  embedded?: boolean;
  visible?: boolean;
  registerCloseHandler?: WorkspacePageProps['registerCloseHandler'];
}

export function DevelopmentPreviewContent({ developmentId, entry: fixedEntry, embedded = false, visible = true, registerCloseHandler }: DevelopmentPreviewContentProps) {
  const { t } = useTranslation('applicationPlugins');
  const { status, error: statusError } = useDevelopmentStatus(developmentId);
  const [entry, setEntry] = useState('');
  const [bundle, setBundle] = useState<DevelopmentBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<DevelopmentStatus | null>(null);
  useLayoutEffect(() => { latest.current = status; }, [status]);
  const currentEntry = useRef('');
  const isCurrentRevision = useCallback(() => latest.current?.state === 'active' && latest.current.revision === bundle?.revision
    && currentEntry.current === bundle?.entry, [bundle?.revision, bundle?.entry]);
  const handled = useMemo(() => new Set<string>(), []);
  const applications = status?.manifest?.contributes.applications ?? [];
  const command = status?.commands.find((candidate) => candidate.revision === status.revision && (fixedEntry === undefined || candidate.entry === fixedEntry) && !handled.has(candidate.id));
  const selectedEntry = fixedEntry ?? command?.entry ?? (applications.some((application) => application.entry === entry) ? entry : applications[0]?.entry);
  const revision = status?.revision;
  const manifest = status?.manifest;
  const digest = status?.digest;
  const state = status?.state;
  useLayoutEffect(() => { currentEntry.current = selectedEntry ?? ''; }, [selectedEntry]);
  const readFailure = useEffectEvent((cause: unknown, fallback: string) => cause instanceof Error ? cause.message : t(fallback));

  useEffect(() => {
    const currentManifest = latest.current?.manifest;
    if (state !== 'active' || revision === undefined || !currentManifest || !digest || !selectedEntry) return;
    const controller = new AbortController();
    void hostApiFetch<{ html: string }>('/api/app-plugins/development-bundle', {
      method: 'POST', body: JSON.stringify({ developmentId, revision, entry: selectedEntry }), signal: controller.signal,
    }).then(({ html }) => {
      if (!controller.signal.aborted) {
        setBundle({ revision, entry: selectedEntry, html, manifest: currentManifest, digest });
        setError(null);
      }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(readFailure(cause, 'preview.bundleFailed')); });
    return () => controller.abort();
  }, [developmentId, revision, selectedEntry, digest, state]);

  return <div className="flex h-full min-h-0 flex-1 flex-col text-foreground">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-5 py-3">
      {!embedded && <Button type="button" variant="ghost" size="sm" asChild><Link to="/"><ArrowLeft className="size-4" aria-hidden="true" />{t('preview.backChat')}</Link></Button>}
      <h1 className="min-w-0 flex-1 text-sm font-semibold [overflow-wrap:anywhere]">{manifest?.name ?? t('preview.title')}</h1>
      {fixedEntry === undefined && applications.length > 1 && <Select aria-label={t('preview.entry')} value={selectedEntry ?? ''} disabled={!!command} onChange={(event) => setEntry(event.target.value)} className="max-w-64">
        {applications.map((application) => <option key={application.id} value={application.entry}>{application.name}</option>)}
      </Select>}
      {status && <span className="text-xs text-muted-foreground">{t(`preview.state.${status.state}`)}</span>}
    </header>
    {(statusError || error || status?.error) && <p role="alert" className="shrink-0 bg-destructive/10 px-5 py-3 text-sm text-destructive [overflow-wrap:anywhere]">{statusError ?? error ?? status?.error}</p>}
    {status?.state === 'installed' ? <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-sm">{t('preview.installed')}</p>
      <div className="flex flex-wrap justify-center gap-3">
        {status.installed?.manifest.contributes.applications?.filter((application) => application.placement !== 'chat-panel').map((application) => <Button key={application.id} asChild variant="outline" size="sm"><Link to={applicationPath(status.installed!.manifest.id, application.id)}>{application.name}</Link></Button>)}
        <Button asChild variant="outline" size="sm"><Link to="/applications">{t('preview.manage')}</Link></Button>
      </div>
    </div> : status && status.state !== 'active' ? <div role="status" className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{t(`preview.state.${status.state}`)}</div>
      : bundle && status ? <div className="min-h-0 flex-1"><DevelopmentFrame key={`${bundle.revision}:${bundle.entry}`} developmentId={developmentId} bundle={bundle} status={status}
        active={status.state === 'active' && status.revision === bundle.revision && selectedEntry === bundle.entry}
        visible={visible} registerCloseHandler={registerCloseHandler} handled={handled} onError={setError}
        isCurrent={isCurrentRevision} /></div>
        : <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <p>{status?.manifest && !applications.length ? t('preview.noPage') : t('preview.waiting')}</p>
        </div>}
    {!!status?.logs.length && <details className="shrink-0 border-t border-border/60 px-5 py-3">
      <summary className="cursor-pointer text-xs text-muted-foreground">{t('preview.logs')}</summary>
      <ol className="mt-3 max-h-40 space-y-1 overflow-auto font-mono text-xs leading-5">
        {status.logs.map((log) => <li key={log.seq} className={log.level === 'error' ? 'text-destructive [overflow-wrap:anywhere]' : 'text-muted-foreground [overflow-wrap:anywhere]'}>{log.at} [{log.level}] {log.message}</li>)}
      </ol>
    </details>}
  </div>;
}
