import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hostAppPluginCall, hostFileWriteBinary, hostWriteClipboardImage } from '@/lib/host-api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { subscribeHostEvent } from '@/lib/host-events';
import { validateAppComposeRequest, validateAppWorkspaceFileRequest, type AppComposeRequest, type AppComposeSource, type AppRuntimeEvent, type AppWebviewApi, type AppWebviewContext } from '@/types/desktop/app-plugin-sdk';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import { buildAppDocument, getAppBridgeMessages } from './browser-sdk';
import { useSettingsStore } from '@/plugins/settings/store';
import { useResolvedTheme } from '@/lib/use-resolved-theme';
import { createAppSessionMedia } from './session-media';

export interface AppFrameProps {
  pluginId: string;
  digest: string;
  html: string;
  title: string;
  sessionIdentity?: SessionIdentity;
  onCompose?: (request: AppComposeRequest, source: AppComposeSource, signal: AbortSignal) => Promise<void>;
  registerCloseHandler?: AppWebviewApi['onCloseRequested'];
}

export function AppFrame({ pluginId, digest, html, title, sessionIdentity, onCompose, registerCloseHandler }: AppFrameProps) {
  const { t, i18n } = useTranslation('common');
  const theme = useResolvedTheme(useSettingsStore((state) => state.theme));
  const framePort = useRef<MessagePort | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const sessionIdentityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : undefined;
  const identity = useMemo(() => ({ pluginId, digest, html, title, sessionIdentityKey }), [pluginId, digest, html, title, sessionIdentityKey]);
  const readContext = useEffectEvent((): AppWebviewContext => ({ ...(sessionIdentity ? { sessionIdentity } : {}), language: i18n.resolvedLanguage ?? i18n.language, theme }));
  const isCurrentSession = useEffectEvent((sourceIdentityKey: string | undefined) => sourceIdentityKey === sessionIdentityKey);
  const compose = useEffectEvent((request: AppComposeRequest, source: AppComposeSource, sourceIdentityKey: string | undefined, signal: AbortSignal) => {
    if (sourceIdentityKey !== sessionIdentityKey || source.pluginId !== pluginId || source.digest !== digest) throw new Error(t('appFrame.sessionChanged'));
    if (!onCompose) throw new Error(t('appFrame.noComposer'));
    return onCompose(request, source, signal);
  });
  const registerClose = useEffectEvent((handler: Parameters<NonNullable<AppWebviewApi['onCloseRequested']>>[0]) => registerCloseHandler?.(handler));
  const [workspaceSave, setWorkspaceSave] = useState<{
    identity: typeof identity;
    path: string;
    finish: (allowed: boolean) => void;
  } | null>(null);
  const [result, setResult] = useState<{ identity: typeof identity; error?: string } | null>(null);
  const current = result?.identity === identity ? result : null;

  useEffect(() => {
    framePort.current?.postMessage({ type: 'theme', theme });
  }, [theme]);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const frame = document.createElement('iframe');
    frame.title = identity.title;
    // Opaque web origin separates the page from preload and the main Renderer, not from its trusted backend.
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-downloads');
    frame.referrerPolicy = 'no-referrer';
    frame.className = 'h-full w-full border-0';
    const channel = new MessageChannel();
    framePort.current = channel.port1;
    const pending = new Set<number>();
    const staging = new AbortController();
    const context = readContext();
    const media = context.sessionIdentity ? createAppSessionMedia(context.sessionIdentity) : null;
    let mediaRequest = new AbortController();
    let mediaDirty = false;
    let mediaReadPending = false;
    let mediaListPending = false;
    let workspaceSavePending = false;
    let finishWorkspaceSave: ((allowed: boolean) => void) | null = null;
    let unsubscribeMedia = () => {};
    let loaded = false;
    let ready = false;
    let closed = false;
    let closeOwner: number | null = null;
    let lastCloseOwner = 0;
    let closeId = 0;
    let closePending: { id: number; finish: (allowed: boolean) => void; abort: () => void } | null = null;
    let unregisterClose = () => {};
    const clearCloseOwner = () => {
      closePending?.abort();
      unregisterClose();
      unregisterClose = () => {};
      closeOwner = null;
    };
    let timer: ReturnType<typeof setTimeout>;
    let unsubscribe = () => {};
    const text = (key: string) => i18n.t(`common:appFrame.${key}`);
    const isMediaActive = () => !closed && ready && !frame.closest('[inert]') && isCurrentSession(identity.sessionIdentityKey);
    const notifyMediaChanged = () => {
      mediaDirty = true;
      if (!isMediaActive()) return;
      channel.port1.postMessage({ type: 'event', topic: 'media.changed', data: {} });
      mediaDirty = false;
    };
    const visibility = new MutationObserver(() => {
      finishWorkspaceSave?.(false);
      mediaRequest.abort(new Error(text('sessionChanged')));
      mediaRequest = new AbortController();
      if (mediaDirty && isMediaActive()) notifyMediaChanged();
    });
    for (let ancestor: Element | null = root; ancestor; ancestor = ancestor.parentElement) visibility.observe(ancestor, { attributes: true, attributeFilter: ['inert'] });
    const localeChanged = () => {
      if (!closed && ready) channel.port1.postMessage({ type: 'locale', language: i18n.resolvedLanguage ?? i18n.language, messages: getAppBridgeMessages() });
    };
    const dispose = () => {
      if (closed) return;
      closed = true;
      clearCloseOwner();
      staging.abort();
      finishWorkspaceSave?.(false);
      mediaRequest.abort();
      visibility.disconnect();
      unsubscribeMedia();
      clearTimeout(timer);
      unsubscribe();
      i18n.off('languageChanged', localeChanged);
      window.removeEventListener('message', connect);
      frame.removeEventListener('load', load);
      frame.removeEventListener('error', loadError);
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      if (framePort.current === channel.port1) framePort.current = null;
      channel.port2.close();
      pending.clear();
      frame.remove();
    };
    const fail = (message: string) => {
      if (closed) return;
      dispose();
      setResult({ identity, error: message.slice(0, 500) });
    };
    const load = () => {
      if (closed) return;
      if (loaded) { fail(text('navigation')); return; }
      loaded = true;
    };
    const connect = (event: MessageEvent<unknown>) => {
      if (closed || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object'
        || (event.data as { type?: unknown }).type !== 'matcha:app-ready') return;
      event.ports.forEach((port) => port.close());
      if (event.ports.length) { fail(text('invalidConnection')); return; }
      window.removeEventListener('message', connect);
      try { frame.contentWindow?.postMessage({ type: 'matcha:app-connect' }, '*', [channel.port2]); }
      catch { fail(text('connectionFailed')); }
    };
    const loadError = () => fail(text('loadFailed'));
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      event.ports.forEach((port) => port.close());
      if (closed) return;
      if (event.ports.length || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
        fail(text('invalidMessage'));
        return;
      }
      const value = event.data as Record<string, unknown>;
      if (value.type === 'ready' && !ready) {
        ready = true;
        clearTimeout(timer);
        localeChanged();
        channel.port1.postMessage({ type: 'theme', theme: readContext().theme });
        setResult({ identity });
        if (mediaDirty) notifyMediaChanged();
        return;
      }
      if (value.type === 'error' && typeof value.message === 'string') { fail(value.message || text('executionFailed')); return; }
      if (value.type === 'close-owner') {
        if (!ready || Object.keys(value).some((key) => key !== 'type' && key !== 'owner')
          || (value.owner !== null && (!Number.isSafeInteger(value.owner) || Number(value.owner) <= lastCloseOwner || closeOwner !== null))) {
          fail(text('invalidRequest'));
          return;
        }
        clearCloseOwner();
        if (value.owner !== null) {
          const owner = Number(value.owner);
          closeOwner = lastCloseOwner = owner;
          try {
            unregisterClose = registerClose((signal) => {
              if (closed || !ready || signal.aborted || closeOwner !== owner || !isCurrentSession(identity.sessionIdentityKey)) return false;
              closePending?.abort();
              const id = ++closeId;
              return new Promise<boolean>((resolve) => {
                let settled = false;
                const finish = (allowed: boolean) => {
                  if (closePending?.id !== id) return;
                  const accepted = allowed && !closed && !signal.aborted && closeOwner === owner && isCurrentSession(identity.sessionIdentityKey);
                  if (!accepted) {
                    closePending = null;
                    signal.removeEventListener('abort', abort);
                  }
                  if (!settled) { settled = true; resolve(accepted); }
                };
                const abort = () => {
                  if (!closed) channel.port1.postMessage({ type: 'close-abort', id, owner });
                  finish(false);
                };
                closePending = { id, finish, abort };
                signal.addEventListener('abort', abort, { once: true });
                channel.port1.postMessage({ type: 'close-request', id, owner });
              });
            }) ?? (() => {});
          } catch (error) { fail(error instanceof Error ? error.message : text('closeFailed')); }
        }
        return;
      }
      if (value.type === 'close-result') {
        if (Object.keys(value).some((key) => !['type', 'id', 'owner', 'allowed', 'error'].includes(key))
          || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || !Number.isSafeInteger(value.owner) || Number(value.owner) < 1
          || typeof value.allowed !== 'boolean' || (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 500))) {
          fail(text('invalidRequest'));
          return;
        }
        const active = closePending;
        if (value.owner !== closeOwner || !active || active.id !== value.id) return;
        if (typeof value.error === 'string') console.warn('[app-frame] close request failed', { pluginId: identity.pluginId, message: value.error });
        active.finish(value.allowed);
        return;
      }
      if ((value.type !== 'call' && value.type !== 'compose' && value.type !== 'clipboard' && value.type !== 'workspace-save' && value.type !== 'media-list' && value.type !== 'media-read') || !Number.isSafeInteger(value.id) || Number(value.id) < 1
        || pending.has(Number(value.id)) || pending.size >= 64) {
        fail(text('invalidRequest'));
        return;
      }
      const mediaOperation = value.type === 'media-list' || value.type === 'media-read';
      if (mediaOperation) {
        if (!media || !isMediaActive()) {
          channel.port1.postMessage({ type: 'result', id: value.id, error: text('sessionChanged') });
          return;
        }
        const request = value.request;
        if ((value.type === 'media-list' && (Object.keys(value).some((key) => !['type', 'id', 'request'].includes(key))
          || (request !== undefined && (!request || typeof request !== 'object' || Array.isArray(request)
            || Object.keys(request).some((key) => key !== 'cursor')
            || ((request as Record<string, unknown>).cursor !== undefined && (typeof (request as Record<string, unknown>).cursor !== 'string'
              || !/^media_cursor_[a-f0-9]{64}$/.test(String((request as Record<string, unknown>).cursor))))))))
          || (value.type === 'media-read' && (Object.keys(value).some((key) => !['type', 'id', 'request'].includes(key))
            || !request || typeof request !== 'object' || Array.isArray(request)
            || Object.keys(request).some((key) => key !== 'id') || typeof (request as Record<string, unknown>).id !== 'string'
            || !/^media_[a-f0-9]{64}$/.test((request as { id: string }).id)))) {
          channel.port1.postMessage({ type: 'result', id: value.id, error: text('invalidRequest') });
          return;
        }
      } else if (value.type === 'workspace-save') {
        if (!context.sessionIdentity || !isMediaActive() || !document.hasFocus() || document.activeElement !== frame
          || !navigator.userActivation?.isActive || workspaceSavePending) {
          channel.port1.postMessage({ type: 'result', id: value.id, error: text('requestFailed') });
          return;
        }
        const error = validateAppWorkspaceFileRequest(value.request);
        if (Object.keys(value).some((key) => !['type', 'id', 'request'].includes(key)) || error) {
          channel.port1.postMessage({ type: 'result', id: value.id, error: text('invalidWorkspaceFile') });
          return;
        }
      } else if (value.type === 'clipboard') {
        if (!ready || !document.hasFocus() || document.activeElement !== frame || frame.closest('[inert]') || !navigator.userActivation?.isActive) {
          channel.port1.postMessage({ type: 'result', id: value.id, error: text('requestFailed') });
          return;
        }
        const request = value.request as Record<string, unknown> | null;
        if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => key !== 'data' && key !== 'mimeType')
          || request.mimeType !== 'image/png' || typeof request.data !== 'string' || !request.data.length
          || request.data.length > 4 * Math.ceil(20 * 1024 * 1024 / 3)) {
          channel.port1.postMessage({ type: 'result', id: value.id, error: text('invalidRequest') });
          return;
        }
      } else if (value.type === 'compose') {
        const error = validateAppComposeRequest(value.request);
        if (error) { channel.port1.postMessage({ type: 'result', id: value.id, error: i18n.t(error) }); return; }
      } else if (typeof value.name !== 'string' || !value.name || value.name.length > 128
        || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) {
        fail(text('invalidTool'));
        return;
      }
      if ((value.type === 'media-read' && mediaReadPending) || (value.type === 'media-list' && mediaListPending)) {
        channel.port1.postMessage({ type: 'result', id: value.id, error: text('tooManyRequests') });
        return;
      }
      const id = Number(value.id);
      if (value.type === 'media-read') mediaReadPending = true;
      if (value.type === 'media-list') mediaListPending = true;
      if (value.type === 'workspace-save') workspaceSavePending = true;
      pending.add(id);
      // Closing drops backend replies and any not-yet-dispatched local UI side effects.
      const mediaSignal = mediaRequest.signal;
      const operation = mediaOperation
        ? Promise.resolve().then(async () => {
          mediaSignal.throwIfAborted();
          if (!media || !isMediaActive()) throw new Error(text('sessionChanged'));
          const content = value.type === 'media-list' ? await media.list(mediaSignal, value.request as Parameters<AppWebviewApi['listSessionMedia']>[0]) : await media.read((value.request as { id: string }).id, mediaSignal);
          mediaSignal.throwIfAborted();
          if (!isMediaActive()) throw new Error(text('sessionChanged'));
          return { content: [], structuredContent: { ...content } };
        })
        : value.type === 'workspace-save'
        ? Promise.resolve().then(async () => {
          staging.signal.throwIfAborted();
          const session = context.sessionIdentity;
          const input = value.request as Parameters<NonNullable<AppWebviewApi['saveWorkspaceFile']>>[0];
          if (!session || !isMediaActive()) throw new Error(text('sessionChanged'));
          const allowed = await new Promise<boolean>((resolve) => {
            const finish = (accepted: boolean) => {
              if (finishWorkspaceSave !== finish) return;
              finishWorkspaceSave = null;
              setWorkspaceSave((current) => current?.finish === finish ? null : current);
              resolve(accepted);
            };
            finishWorkspaceSave = finish;
            setWorkspaceSave({ identity, path: input.relativePath, finish });
          });
          if (!allowed) throw new Error(text('workspaceSaveCancelled'));
          staging.signal.throwIfAborted();
          if (!isMediaActive()) throw new Error(text('sessionChanged'));
          const saved = await hostFileWriteBinary({ endpoint: session.endpoint, agentId: session.agentId, relativePath: input.relativePath, data: input.data });
          if (!saved.ok) throw new Error(text(saved.error === 'outcomeUnknown' ? 'workspaceSaveUnknown' : 'workspaceSaveFailed'));
          return { content: [], structuredContent: { name: saved.name, size: saved.size } };
        })
        : value.type === 'clipboard'
        ? Promise.resolve().then(async () => {
          staging.signal.throwIfAborted();
          try { await hostWriteClipboardImage(value.request as Parameters<AppWebviewApi['writeClipboardImage']>[0]); }
          catch { throw new Error(text('requestFailed')); }
          return { content: [] };
        })
        : value.type === 'compose'
          ? Promise.resolve().then(async () => {
            staging.signal.throwIfAborted();
            await compose(value.request as AppComposeRequest, { pluginId: identity.pluginId, digest: identity.digest }, identity.sessionIdentityKey, staging.signal);
            return { content: [] };
          })
          : hostAppPluginCall({ id: identity.pluginId, digest: identity.digest, name: value.name as string, arguments: value.arguments as Record<string, unknown> });
      void operation.then(
        (toolResult) => {
          if (closed) return;
          if (mediaOperation && (mediaSignal.aborted || !isMediaActive())) channel.port1.postMessage({ type: 'result', id, error: text('sessionChanged') });
          else channel.port1.postMessage({ type: 'result', id, result: toolResult });
        },
        (error: unknown) => {
          if (closed) return;
          const code = mediaOperation && error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            && ['unsupported', 'cursorInvalid', 'invalidReference', 'tooLarge', 'unavailable'].includes(error.code) ? error.code : undefined;
          channel.port1.postMessage({ type: 'result', id, error: mediaOperation ? text('mediaReadFailed') : error instanceof Error ? error.message : text('requestFailed'), ...(code ? { code } : {}) });
        },
      ).catch(() => fail(text('resultFailed'))).finally(() => {
        pending.delete(id);
        if (value.type === 'media-read') mediaReadPending = false;
        if (value.type === 'media-list') mediaListPending = false;
        if (value.type === 'workspace-save') workspaceSavePending = false;
      });
    };
    channel.port1.onmessageerror = () => fail(text('decodeFailed'));
    channel.port1.start();
    unsubscribe = subscribeHostEvent<AppRuntimeEvent>('app-plugins:runtime', (event) => {
      if (!closed && ready && event.pluginId === identity.pluginId && event.digest === identity.digest) {
        try { channel.port1.postMessage({ type: 'event', topic: event.topic, data: event.data }); }
        catch { fail(text('eventFailed')); }
      }
    });
    unsubscribeMedia = media?.subscribe(() => {
      mediaRequest.abort(new Error(text('mediaChanged')));
      mediaRequest = new AbortController();
      try { notifyMediaChanged(); }
      catch { fail(text('eventFailed')); }
    }) ?? (() => {});
    i18n.on('languageChanged', localeChanged);
    timer = setTimeout(() => fail(text('connectionTimeout')), 10_000);
    window.addEventListener('message', connect);
    frame.addEventListener('load', load);
    frame.addEventListener('error', loadError);
    frame.srcdoc = buildAppDocument(identity.pluginId, identity.html, context);
    root.appendChild(frame);
    return dispose;
  }, [identity, i18n]);

  return <div className="relative h-full min-h-0 w-full" aria-busy={!current}>
    <div ref={container} className="h-full w-full" style={{ visibility: current && !current.error ? 'visible' : 'hidden' }} />
    {!current && <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{t('appFrame.loading')}</div>}
    {current?.error && <div role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-destructive [overflow-wrap:anywhere]">{current.error}</div>}
    <ConfirmDialog open={workspaceSave?.identity === identity} title={t('appFrame.workspaceSaveTitle')}
      message={t('appFrame.workspaceSaveMessage', { name: title, path: workspaceSave?.path ?? '' })}
      confirmLabel={t('appFrame.workspaceSaveConfirm')} cancelLabel={t('appFrame.workspaceSaveCancel')}
      onConfirm={() => workspaceSave?.finish(true)} onCancel={() => workspaceSave?.finish(false)} />
  </div>;
}
