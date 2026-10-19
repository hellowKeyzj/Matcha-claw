import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { hostOpenClawCanvasRequest, hostOpenClawMcpAppRequest } from '@/lib/host-api';
import { boardExecute } from '@/lib/board-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { cn } from '@/lib/utils';
import { buildSessionIdentityKey } from '@/types/desktop/runtime-address';
import { decodeBoardChangedEvent, type BoardIdentity, type BoardWidget } from '@/types/board';
import {
  decodeOpenClawRuntimeSurfaceDescriptor,
  type OpenClawCanvasSurfaceDescriptor,
  type OpenClawMcpAppSurfaceDescriptor,
} from '@/types/openclaw-runtime-surface';
import { SandboxChannel, isRecord } from './sandbox-channel';
import { createContentActions, surfaceFailure, type ContentCallbacks } from './content-security';
import { requestContentSnapshot, WidgetImageError, type RuntimeContentHandle } from './content-snapshot';
import { createMcpAppBridge } from './mcp-app-bridge';
import { boardDocument, createBoardBridge, fetchBoardDocument } from './board-content';
import { BoardReportContent } from './BoardReportContent';
import { BoardProgressContent } from './BoardProgressContent';
import { bindWidgetHostState } from './widget-host-state';

export type { RuntimeContentHandle } from './content-snapshot';
export type RuntimeContentSource =
  | { kind: 'mcp-app'; descriptor: OpenClawMcpAppSurfaceDescriptor }
  | { kind: 'canvas'; descriptor: OpenClawCanvasSurfaceDescriptor }
  | { kind: 'board'; identity: BoardIdentity; widget: BoardWidget };

interface Props extends ContentCallbacks {
  source: RuntimeContentSource;
  onHeightChange?: (height: number) => void;
  onRefresh?: () => void | Promise<void>;
  className?: string;
}

function sourceKey(source: RuntimeContentSource): string {
  if (source.kind === 'board') return JSON.stringify([
    'board', buildSessionIdentityKey(source.identity), source.widget.name, source.widget.revision,
    source.widget.instanceId, source.widget.grantState, source.widget.viewGeneration,
    source.widget.viewTicket, source.widget.sandboxUrl,
  ]);
  const descriptor = source.descriptor;
  return JSON.stringify([descriptor.kind, buildSessionIdentityKey(descriptor.sessionIdentity),
    descriptor.kind === 'mcp-app' ? [descriptor.viewId, descriptor.readOnly, descriptor.expiresAtMs]
      : [descriptor.documentId, descriptor.sandbox]]);
}

const ContentFrame = forwardRef<RuntimeContentHandle, Props>(function ContentFrame(props, ref) {
  const { t } = useTranslation('chat');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<SandboxChannel | null>(null);
  const snapshotReady = useRef(false);
  const retired = useRef(false);
  const observedWidget = useRef(props.source.kind === 'board' ? props.source.widget : null);
  const [incarnation, setIncarnation] = useState(0);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
    const widget = props.source.kind === 'board' ? props.source.widget : null;
    const changed = widget !== observedWidget.current;
    observedWidget.current = widget;
    if (retired.current && changed && widget) {
      retired.current = false;
      queueMicrotask(() => setIncarnation((value) => value + 1));
    }
  }, [props]);
  const [view, setView] = useState<{ incarnation: number; status: 'ready' | 'error'; error?: string } | null>(null);
  const status = view?.incarnation === incarnation ? view.status : 'loading';
  const error = view?.incarnation === incarnation ? view.error : undefined;
  useImperativeHandle(ref, () => ({
    snapshot: (signal) => channelRef.current && snapshotReady.current
      ? requestContentSnapshot(channelRef.current, signal)
      : Promise.reject(new WidgetImageError('snapshotUnavailable')),
  }), []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const source = latest.current.source;
    retired.current = false;
    const message = (key: string, fallback: string) => t(`runtimeContent.${key}`, { defaultValue: fallback });
    const abort = new AbortController();
    const cleanups: (() => void)[] = [];
    let alive = true;
    let channel: SandboxChannel | null = null;
    let expiresAt = source.kind === 'mcp-app' ? source.descriptor.expiresAtMs : undefined;
    const current = () => alive && !abort.signal.aborted && (expiresAt === undefined || Date.now() < expiresAt);
    const refresh = () => { void Promise.resolve(latest.current.onRefresh?.()).catch(() => {}); };
    const close = () => {
      alive = false;
      abort.abort();
      snapshotReady.current = false;
      channelRef.current = null;
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      channel?.close();
    };
    const revoke = (message: string, requestRefresh = true) => {
      if (!alive) return;
      retired.current = true;
      close();
      setView({ incarnation, status: 'error', error: message });
      if (requestRefresh) refresh();
    };
    const height = (value: number) => { if (current()) latest.current.onHeightChange?.(value); };
    const lease = (expiry: number, renew: boolean) => {
      expiresAt = expiry;
      const remaining = expiry - Date.now();
      if (remaining <= 0) throw new Error(message('leaseExpired', 'Native content lease expired.'));
      const expiryTimer = setTimeout(() => revoke(message('leaseExpired', 'Native content lease expired.')), Math.min(remaining, 2_147_483_647));
      cleanups.push(() => clearTimeout(expiryTimer));
      if (renew && remaining > 15_000) {
        const renewalTimer = setTimeout(refresh, remaining - 15_000);
        cleanups.push(() => clearTimeout(renewalTimer));
      }
    };
    let authorize = async () => { if (!current()) throw new Error('Content authority expired'); };
    const actions = createContentActions(frame, () => latest.current, current, () => authorize(), (text) =>
      window.confirm(`${t('toolActivity.widget.confirmAction', { defaultValue: 'Confirm this action?' })}\n\n${text}`));
    cleanups.push(subscribeHostEvent('runtime-host:restart', () => revoke(message('runtimeRestarted', 'Native runtime restarted.'))));
    cleanups.push(subscribeHostEvent('board:resync', () => revoke(message('authorityChanged', 'Native content authority changed.'), source.kind !== 'board')));
    if (source.kind === 'board') cleanups.push(subscribeHostEvent<unknown>('board:changed', (payload) => {
      let event;
      try { event = decodeBoardChangedEvent(payload); } catch { return; }
      if (buildSessionIdentityKey(event.identity) === buildSessionIdentityKey(source.identity)
        && (!event.widget || event.widget === source.widget.name)) revoke(message('boardChanged', 'Board content changed.'), false);
    }));
    const setup = async () => {
      let html: string;
      let sandboxUrl: string;
      let strict = false;
      let mcpPayload: Awaited<ReturnType<typeof hostOpenClawMcpAppRequest<'mcp.app.view'>>> | null = null;
      let mcpDescriptor: OpenClawMcpAppSurfaceDescriptor | null = null;
      let boardTicket: string | null = null;
      if (source.kind === 'board') {
        const { identity, widget } = source;
        if (widget.contentKind === 'mcp-app') {
          if (!widget.instanceId || ['pending', 'rejected'].includes(widget.grantState)) throw new Error('Board MCP App has no active grant');
          const view = await boardExecute(identity, { method: 'board.widget.appView', name: widget.name,
            revision: widget.revision, instanceId: widget.instanceId });
          if (!current()) return;
          lease(view.expiresAtMs, true);
          mcpDescriptor = { kind: 'mcp-app', sessionIdentity: identity, viewId: view.viewId, expiresAtMs: view.expiresAtMs };
          mcpPayload = await hostOpenClawMcpAppRequest({ operationId: 'mcp.app.view', sessionIdentity: identity, viewId: view.viewId });
          html = mcpPayload.html;
          sandboxUrl = mcpPayload.sandboxUrl;
        } else {
          const document = boardDocument(identity, widget);
          lease(document.expiresAtMs, true);
          boardTicket = document.ticket;
          html = await fetchBoardDocument(document.url, abort.signal);
          sandboxUrl = document.sandboxUrl;
          authorize = async () => {
            if (!current()) throw new Error('Board view expired');
            await boardExecute(identity, { method: 'board.prompt.authorize', ticket: document.ticket });
            if (!current()) throw new Error('Board view expired');
          };
        }
      } else {
        const descriptor = decodeOpenClawRuntimeSurfaceDescriptor(source.descriptor);
        if (!descriptor || descriptor.kind !== source.kind) throw new Error('Invalid native content identity');
        if (descriptor.kind === 'mcp-app') {
          if (descriptor.expiresAtMs !== undefined) lease(descriptor.expiresAtMs, true);
          mcpDescriptor = descriptor;
          mcpPayload = await hostOpenClawMcpAppRequest({ operationId: 'mcp.app.view', sessionIdentity: descriptor.sessionIdentity, viewId: descriptor.viewId });
          html = mcpPayload.html;
          sandboxUrl = mcpPayload.sandboxUrl;
        } else {
          const view = await hostOpenClawCanvasRequest({ operationId: 'canvas.document.view', sessionIdentity: descriptor.sessionIdentity, docId: descriptor.documentId });
          html = view.html;
          sandboxUrl = view.sandboxUrl;
          strict = descriptor.sandbox === 'strict';
          authorize = async () => {
            if (!current() || strict) throw new Error('Canvas prompt is unavailable');
            await hostOpenClawCanvasRequest({ operationId: 'canvas.document.view', sessionIdentity: descriptor.sessionIdentity, docId: descriptor.documentId });
            if (!current()) throw new Error('Canvas view is no longer active');
          };
        }
      }
      if (!current()) return;
      channel = new SandboxChannel(frame, sandboxUrl);
      channelRef.current = channel;
      const connectedChannel = channel;
      cleanups.push(connectedChannel.onClose(() => revoke(message('sandboxDisconnected', 'Native sandbox disconnected.'))));
      await connectedChannel.start();
      if (!current()) return;
      if (mcpPayload && mcpDescriptor) {
        const bridge = createMcpAppBridge({ channel: connectedChannel, descriptor: mcpDescriptor, payload: mcpPayload,
          actions, callbacks: () => latest.current, current, revoke: () => revoke(message('authorityChanged', 'Native content authority changed.')), onHeight: height });
        authorize = bridge.checkAuthority;
        cleanups.push(bridge.dispose);
      } else {
        let promptPort: MessagePort | null = null;
        cleanups.push(() => promptPort?.close());
        if (source.kind === 'board' && boardTicket) cleanups.push(createBoardBridge({ channel: connectedChannel,
          identity: source.identity, ticket: boardTicket, actions, current,
          revoke: () => revoke(message('authorityChanged', 'Native content authority changed.')) }));
        cleanups.push(connectedChannel.subscribe((data, ports) => {
          if (!isRecord(data)) return;
          if (data.type === 'openclaw:widget-prompt-offer') {
            if (source.kind === 'board' || strict || promptPort || ports.length !== 1 || !latest.current.onSendMessage || !current()) {
              ports.forEach((port) => port.close()); return;
            }
            promptPort = ports[0];
            promptPort.onmessage = (event: MessageEvent<unknown>) => {
              event.ports.forEach((port) => port.close());
              if (current() && isRecord(event.data) && event.data.type === 'openclaw:widget-prompt') {
                void actions.message(event.data.prompt).catch(() => {});
              }
            };
            promptPort.start();
            promptPort.postMessage({ type: 'openclaw:widget-prompt-host-ready' });
          } else if (data.type === 'openclaw:widget-bridge-port-offer' && source.kind !== 'board') ports.forEach((port) => port.close());
          else if (data.type === 'openclaw:widget-size' && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0) {
            height(Math.max(48, Math.min(8000, Math.ceil(data.height))));
          }
        }));
      }
      await connectedChannel.load(html, { strict, csp: mcpPayload?.csp });
      if (!current()) return;
      snapshotReady.current = !strict && !mcpPayload;
      if (!mcpPayload && !strict) {
        const state = bindWidgetHostState(connectedChannel, source.kind === 'board', current);
        cleanups.push(state.dispose);
        cleanups.push(connectedChannel.subscribe((data) => { if (isRecord(data)) state.scroll(data); }));
      }
      setView({ incarnation, status: 'ready' });
    };
    void setup().catch((caught: unknown) => {
      if (!alive) return;
      const failure = surfaceFailure(caught);
      revoke(failure?.message ?? message('unavailable', 'Native content is unavailable.'), false);
    });
    return close;
  }, [incarnation, t]);

  return <div className={cn('relative h-full min-h-0 w-full', props.className)}>
    <iframe ref={frameRef} title={props.source.kind === 'board' ? props.source.widget.title ?? props.source.widget.name : props.source.descriptor.title ?? props.source.kind}
      className={cn('block h-full w-full border-0 bg-transparent', status === 'error' && 'hidden')} />
    {status === 'loading' ? <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div> : null}
    {status === 'error' ? <p role="alert" className="p-3 text-xs text-muted-foreground">{error}</p> : null}
  </div>;
});

function ReportContent(props: Props & { source: Extract<RuntimeContentSource, { kind: 'board' }> }) {
  const { t } = useTranslation('chat');
  const container = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const latest = useRef(props);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (latest.current.source.widget !== props.source.widget) {
      generation.current += 1;
      active.current = true;
    }
    latest.current = props;
  }, [props]);
  useEffect(() => {
    active.current = true;
    const stop = () => { active.current = false; generation.current += 1; };
    const changed = subscribeHostEvent<unknown>('board:changed', (payload) => {
      let event;
      try { event = decodeBoardChangedEvent(payload); } catch { return; }
      if (buildSessionIdentityKey(event.identity) === buildSessionIdentityKey(props.source.identity)
        && (!event.widget || event.widget === props.source.widget.name)) stop();
    });
    const resync = subscribeHostEvent('board:resync', stop);
    const restart = subscribeHostEvent('runtime-host:restart', stop);
    return () => { stop(); changed(); resync(); restart(); };
  }, [props.source.identity, props.source.widget.name]);
  const openLink = async (url: string) => {
    const element = container.current;
    if (!element) return;
    const { identity, widget } = latest.current.source;
    const captured = generation.current;
    const currentGeneration = () => active.current && captured === generation.current;
    const authorize = async () => {
      const snapshot = await boardExecute(identity, { method: 'board.get' });
      if (!currentGeneration()) throw new Error('Report view is no longer active');
      const current = snapshot.widgets.find((item) => item.name === widget.name);
      if (!current || current.revision !== widget.revision || current.instanceId !== widget.instanceId
        || current.pluginKind !== 'session:report' || ['pending', 'rejected'].includes(current.grantState)) {
        active.current = false;
        throw new Error(t('runtimeContent.authorityChanged', { defaultValue: 'Native content authority changed.' }));
      }
    };
    const actions = createContentActions(element, () => latest.current, currentGeneration, authorize,
      (text) => window.confirm(`${t('toolActivity.widget.confirmAction', { defaultValue: 'Confirm this action?' })}\n\n${text}`));
    try { await actions.openLink(url); } catch {
      if (captured === generation.current) setError(t('runtimeContent.unavailable', { defaultValue: 'Native content is unavailable.' }));
    }
  };
  return <div ref={container} className={props.className}>
    <BoardReportContent widget={props.source.widget} onOpenLink={props.onOpenLink ? openLink : undefined} />
    {error ? <p role="alert" className="p-3 text-xs text-muted-foreground">{error}</p> : null}
  </div>;
}

function PluginUnavailable({ className }: { className?: string }) {
  const { t } = useTranslation('chat');
  return <p role="status" className={cn('p-3 text-xs text-muted-foreground', className)}>{t('runtimeContent.pluginUnavailable', { defaultValue: 'Native plugin view is unavailable.' })}</p>;
}

export const RuntimeContentHost = forwardRef<RuntimeContentHandle, Props>(function RuntimeContentHost(props, ref) {
  const key = sourceKey(props.source);
  if (props.source.kind === 'board' && props.source.widget.contentKind === 'plugin' && !props.source.widget.frameUrl) {
    if (['pending', 'rejected'].includes(props.source.widget.grantState)) return <PluginUnavailable className={props.className} />;
    return props.source.widget.pluginKind === 'session:report'
      ? <ReportContent key={key} {...props} source={props.source} />
      : props.source.widget.pluginKind === 'session:progress'
        ? <BoardProgressContent key={key} identity={props.source.identity} widget={props.source.widget} />
        : <PluginUnavailable className={props.className} />;
  }
  return <ContentFrame key={key} ref={ref} {...props} />;
});
