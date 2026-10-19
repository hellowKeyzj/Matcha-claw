import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Clock3, Loader2 } from 'lucide-react';
import { hostOpenClawProgressCardRequest } from '@/lib/host-api';
import { subscribeBrowserRecovery, subscribeHostEvent } from '@/lib/host-events';
import { getOrBuildMarkdownBody } from '@/pages/Chat/md-pipeline';
import { useChatStore } from '@/stores/chat';
import { findSessionRecordKey } from '@/stores/chat/session-identity';
import { isRunActive } from '@/types/session/runtime-state';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { BoardIdentity, BoardWidget } from '@/types/board';
import { isOpenClawProgressCardRequest, type OpenClawProgressCard } from '@/types/openclaw-runtime-surface';
import { surfaceFailure } from './content-security';
import { isRecord } from './sandbox-channel';

type LoadError = 'accessDenied' | 'unavailable';

function ProgressCardContent({ sessionIdentity, title }: { sessionIdentity: SessionIdentity; title?: string }) {
  const { t, i18n } = useTranslation('chat');
  const [card, setCard] = useState<OpenClawProgressCard | null>();
  const [error, setError] = useState<LoadError | null>(null);
  const retry = useRef(() => {});
  const runtime = useChatStore((state) => {
    const key = findSessionRecordKey(state, sessionIdentity);
    return key ? state.loadedSessions[key]?.runtime : undefined;
  });
  const markdown = card?.markdown;
  const html = useMemo(() => {
    if (!markdown) return '';
    const template = document.createElement('template');
    template.innerHTML = getOrBuildMarkdownBody(
      `board-progress:${buildSessionIdentityKey(sessionIdentity)}:${markdown}`, { markdown },
    ).fullHtml;
    // This read-only surface has no link or remote-resource capability.
    template.content.querySelectorAll('a').forEach((link) => link.replaceWith(...link.childNodes));
    template.content.querySelectorAll('img').forEach((image) => image.replaceWith(image.alt));
    return template.innerHTML;
  }, [markdown, sessionIdentity]);

  useEffect(() => {
    let alive = true;
    let generation = 0;
    let inFlight = false;
    let dirty = false;
    const read = async () => {
      if (!alive) return;
      dirty = true;
      setError(null);
      if (inFlight) return;
      inFlight = true;
      try {
        do {
          dirty = false;
          const captured = generation;
          try {
            const result = await hostOpenClawProgressCardRequest({ operationId: 'progressCard.get', sessionIdentity });
            if (!alive || captured !== generation) continue;
            setCard(result.card);
            setError(null);
          } catch (caught) {
            if (!alive || captured !== generation) continue;
            const denied = surfaceFailure(caught)?.code === 'SURFACE_REJECTED';
            if (denied) setCard(undefined);
            setError(denied ? 'accessDenied' : 'unavailable');
          }
        } while (alive && dirty);
      } finally {
        inFlight = false;
      }
    };
    const hint = () => {
      if (!alive) return;
      generation += 1;
      void read();
    };
    const invalidate = () => {
      if (!alive) return;
      setCard(undefined);
      hint();
    };
    const emptyHint = (payload: unknown) => isRecord(payload) && Object.keys(payload).length === 0;
    const cleanup = [
      subscribeHostEvent<unknown>('openclaw:progress-changed', (payload) => { if (emptyHint(payload)) hint(); }),
      subscribeHostEvent<unknown>('board:resync', (payload) => { if (emptyHint(payload)) invalidate(); }),
      subscribeHostEvent('runtime-host:restart', invalidate),
      subscribeBrowserRecovery(hint),
    ];
    retry.current = () => { void read(); };
    void read();
    return () => {
      alive = false;
      generation += 1;
      retry.current = () => {};
      cleanup.forEach((stop) => stop());
    };
  }, [sessionIdentity]);

  const notice = error ? <div role="alert" className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
    <p>{error === 'accessDenied'
      ? t('board.progress.accessDenied', { defaultValue: 'You do not have access to this session’s progress.' })
      : t('board.progress.unavailable', { defaultValue: 'Progress is unavailable.' })}</p>
    {error === 'unavailable' && <button type="button" className="shrink-0 rounded-md border border-border px-2 py-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => retry.current()}>{t('board.progress.retry', { defaultValue: 'Retry' })}</button>}
  </div> : null;
  if (!card) return <div className="p-4 text-xs text-muted-foreground">
    {notice ?? <p role="status" className="flex items-center gap-2">{card === undefined
      ? <><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t('board.progress.loading', { defaultValue: 'Loading progress…' })}</>
      : t('board.progress.empty', { defaultValue: 'No progress yet.' })}</p>}
  </div>;

  const steps = card.steps ?? [];
  const completed = steps.filter((step) => step.status === 'completed').length;
  const count = steps.length ? t('board.progress.count', { defaultValue: '{{completed}}/{{total}} completed', completed, total: steps.length })
    : t('board.progress.note', { defaultValue: 'Progress note' });
  const updatedAt = new Date(card.updatedAt);
  const active = runtime && runtime.updatedAt !== null ? isRunActive(runtime) : undefined;
  return <section aria-label={title ?? t('board.progress.title', { defaultValue: 'Progress' })} className="grid min-w-0 gap-3 p-4 text-[13px] leading-normal text-foreground">
    {notice}
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-semibold">{title ?? t('board.progress.title', { defaultValue: 'Progress' })}</h3>
      <span className="text-xs text-muted-foreground">{count}</span>
    </header>
    {Number.isFinite(updatedAt.getTime()) && <time dateTime={updatedAt.toISOString()} className="text-xs text-muted-foreground">{t('board.progress.updatedAt', { defaultValue: 'Updated {{time}}', time: updatedAt.toLocaleString(i18n.language) })}</time>}
    {steps.length > 0 && <progress aria-label={count} max={steps.length} value={completed} className="h-1.5 w-full accent-primary" />}
    {html && <div className="chat-markdown chat-markdown-sm min-w-0 max-w-none break-words" dangerouslySetInnerHTML={{ __html: html }} />}
    {steps.length > 0 && <ol className="grid list-none gap-2 p-0">{steps.map((step, index) => {
      const running = step.status === 'in_progress' && active === true;
      const label = step.status === 'completed' ? t('board.progress.completed', { defaultValue: 'Completed' })
        : step.status === 'pending' ? t('board.progress.pending', { defaultValue: 'Pending' })
          : active === false ? t('board.progress.paused', { defaultValue: 'Paused' })
            : t('board.progress.inProgress', { defaultValue: 'In progress' });
      const Marker = step.status === 'completed' ? Check : running ? Loader2 : Clock3;
      return <li key={index} aria-label={`${label}: ${step.step}`} className="flex items-start gap-2 [overflow-wrap:anywhere]">
        <Marker aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground${running ? ' animate-spin motion-reduce:animate-none' : ''}`} />
        <span>{step.step}</span><span className="sr-only">{label}</span>
      </li>;
    })}</ol>}
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{t('board.progress.originalSource', { defaultValue: 'Original source' })}</summary>
      <pre className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(card, null, 2)}</pre>
    </details>
  </section>;
}

export function BoardProgressContent({ identity, widget }: { identity: BoardIdentity; widget: BoardWidget }) {
  const { t } = useTranslation('chat');
  const override = widget.props?.sessionKey;
  const key = typeof override === 'string' && override.trim() ? override.trim() : identity.sessionKey;
  const qualified = /^agent:([^:]+):(.+)$/.exec(key);
  const agentId = qualified?.[1] ?? identity.agentId;
  const sessionKey = qualified || key === 'global' || key === 'unknown' ? key : `agent:${agentId}:${key}`;
  const { runtimeAdapterId, runtimeInstanceId } = identity.endpoint;
  const sessionIdentity = useMemo<SessionIdentity>(() => ({
    endpoint: { kind: 'native-runtime', runtimeAdapterId, runtimeInstanceId }, agentId, sessionKey,
  }), [runtimeAdapterId, runtimeInstanceId, agentId, sessionKey]);
  const denied = widget.grantState === 'pending' || widget.grantState === 'rejected';
  if (denied || !isOpenClawProgressCardRequest({ operationId: 'progressCard.get', sessionIdentity })) {
    return <p role="alert" className="p-4 text-xs text-muted-foreground">{denied
      ? t('board.progress.accessDenied', { defaultValue: 'You do not have access to this session’s progress.' })
      : t('board.progress.unavailable', { defaultValue: 'Progress is unavailable.' })}</p>;
  }
  const owner = JSON.stringify([buildSessionIdentityKey(identity), buildSessionIdentityKey(sessionIdentity),
    widget.name, widget.revision, widget.instanceId, widget.grantState]);
  return <ProgressCardContent key={owner} sessionIdentity={sessionIdentity} title={widget.title} />;
}
