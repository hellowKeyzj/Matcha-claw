import { forwardRef, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hostAppPluginBundle, hostAppPluginCall, hostFileWriteBinary, hostWriteClipboardImage } from '@/lib/host-api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { subscribeHostEvent } from '@/lib/host-events';
import { appPluginResources, appResourceUri, appToolName, validateAppComposeRequest, validateAppWorkspaceFileRequest, type AppComposeRequest, type AppComposeSource, type AppJson, type AppRuntimeEvent, type AppToolResult, type AppWebviewApi, type AppWebviewContext } from '@/types/desktop/app-plugin-sdk';
import type { AppPluginManifest } from '@/types/desktop/app-plugin';
import { createMcpAppProtocol, mcpAppHostContext, onlyMcpAppParams as only } from '@/plugins/surfaces/mcp-app-protocol';
import { isRecord, type SandboxMessage } from '@/plugins/surfaces/sandbox-channel';
import { useInstalledAppPlugins } from './installed';
import { isAppDevelopmentSnapshot, type AppDevelopmentAction, type AppDevelopmentActionResult, type AppFrameHandle } from './development-protocol';
export type { AppFrameHandle } from './development-protocol';
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
  development?: {
    developmentId: string;
    revision: number;
    entry: string;
    manifest: AppPluginManifest;
    call: (name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<AppToolResult>;
    subscribe: (listener: (event: { topic: string; data: AppJson }) => void) => () => void;
    report: (event: { level: 'info' | 'error'; message: string }) => void;
  };
}

export const AppFrame = forwardRef<AppFrameHandle, AppFrameProps>(function AppFrame({ pluginId, digest, html, title, sessionIdentity, onCompose, registerCloseHandler, development }, ref) {
  const { t, i18n } = useTranslation('common');
  const theme = useResolvedTheme(useSettingsStore((state) => state.theme));
  const framePort = useRef<MessagePort | null>(null);
  const developmentHandle = useRef<AppFrameHandle | null>(null);
  const mcpContextChanged = useRef<(() => void) | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const { catalog } = useInstalledAppPlugins();
  const readManifest = useEffectEvent(() => {
    if (development) return development.manifest.id === pluginId ? development.manifest : undefined;
    return catalog.plugins.find((record) => record.manifest.id === pluginId && record.digest === digest && record.enabled)?.manifest;
  });
  const backendCall = useEffectEvent((name: string, args: Record<string, unknown>, signal: AbortSignal) => development
    ? development.call(name, args, signal)
    : hostAppPluginCall({ id: pluginId, digest, name, arguments: args }));
  const report = useEffectEvent((event: { level: 'info' | 'error'; message: string }) => development?.report(event));
  useImperativeHandle(ref, () => ({
    inspect: (signal) => developmentHandle.current?.inspect(signal) ?? Promise.reject(new Error(t('appFrame.closed'))),
    act: (action, signal) => developmentHandle.current?.act(action, signal) ?? Promise.reject(new Error(t('appFrame.closed'))),
    getBounds: () => developmentHandle.current?.getBounds() ?? null,
  }), [t]);
  const sessionIdentityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : undefined;
  const identity = useMemo(() => ({ pluginId, digest, html, title, sessionIdentityKey, development }), [pluginId, digest, html, title, sessionIdentityKey, development]);
  const readContext = useEffectEvent((): AppWebviewContext => ({ ...(sessionIdentity ? { sessionIdentity } : {}), language: i18n.resolvedLanguage ?? i18n.language, theme }));
  const isCurrentSession = useEffectEvent((sourceIdentityKey: string | undefined) => sourceIdentityKey === sessionIdentityKey);
  const canCompose = useEffectEvent(() => !!onCompose);
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
    mcpContextChanged.current?.();
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
    let mcp: ReturnType<typeof createMcpAppProtocol> | null = null;
    const standardListeners = new Set<SandboxMessage>();
    const commandPending = new Map<number, { finish: (error: Error | null, result?: unknown) => void }>();
    let commandId = 0;
    const command = (method: 'inspect' | 'act', signal: AbortSignal, action?: AppDevelopmentAction): Promise<unknown> => {
      if (closed || !ready || !loaded || !identity.development || signal.aborted || commandPending.size >= 8) return Promise.reject(new Error(text('requestFailed')));
      const id = ++commandId;
      return new Promise((resolve, reject) => {
        const finish = (error: Error | null, result?: unknown) => {
          if (!commandPending.delete(id)) return;
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(new Error(text('closed')));
        const timeout = setTimeout(() => finish(new Error(text('connectionTimeout'))), 5000);
        commandPending.set(id, { finish });
        signal.addEventListener('abort', abort, { once: true });
        try { channel.port1.postMessage({ type: 'development-request', id, method, ...(action ? { action } : {}) }); }
        catch { finish(new Error(text('requestFailed'))); }
      });
    };
    const handle: AppFrameHandle | null = identity.development ? {
      inspect: async (signal) => {
        const snapshot = await command('inspect', signal);
        if (!isAppDevelopmentSnapshot(snapshot)) throw new Error(text('invalidResult'));
        return snapshot;
      },
      act: async (action, signal) => {
        if (!action || !['click', 'fill'].includes(action.type) || typeof action.id !== 'string' || !/^\d+-\d+$/.test(action.id)
          || action.id.length > 80 || action.value !== undefined && (typeof action.value !== 'string' || action.value.length > 10_000)) throw new Error(text('invalidRequest'));
        const result = await command('act', signal, action);
        if (!isRecord(result) || Object.keys(result).some((key) => key !== 'outcome') || !['applied', 'stale', 'unsupported'].includes(String(result.outcome))) throw new Error(text('invalidResult'));
        return result as unknown as AppDevelopmentActionResult;
      },
      getBounds: () => {
        if (closed || !ready || !loaded || !frame.isConnected) return null;
        const { x, y, width, height } = frame.getBoundingClientRect();
        return { x, y, width, height };
      },
    } : null;
    developmentHandle.current = handle;
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
      mcp?.updateHostContext();
    };
    const dispose = () => {
      if (closed) return;
      closed = true;
      mcp?.dispose();
      mcp = null;
      mcpContextChanged.current = null;
      standardListeners.clear();
      for (const request of commandPending.values()) request.finish(new Error(text('closed')));
      if (developmentHandle.current === handle) developmentHandle.current = null;
      window.removeEventListener('message', standardMessage);
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
      report({ level: 'error', message: message.slice(0, 500) });
      dispose();
      setResult({ identity, error: message.slice(0, 500) });
    };
    const showConnectedFrame = () => {
      if (!closed && loaded && ready) { clearTimeout(timer); setResult({ identity }); }
    };
    const load = () => {
      if (closed) return;
      if (loaded) { fail(text('navigation')); return; }
      loaded = true;
      showConnectedFrame();
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
    const manifest = () => {
      const value = readManifest();
      if (!value) throw new Error(text('sessionChanged'));
      return value;
    };
    const callDeclaredTool = (name: string, args: Record<string, unknown>, standard = false) => {
      const tools = manifest().contributes.tools ?? [];
      const matches = tools.filter((tool) => tool.name === name || standard && appToolName(identity.pluginId, tool.name) === name);
      if (matches.length !== 1) throw new Error(text('invalidTool'));
      return backendCall(matches[0].name, args, staging.signal);
    };
    const resources = () => (manifest().contributes.applications ?? []).filter((application) => !identity.development || application.entry === identity.development.entry);
    const standardMessage = (event: MessageEvent<unknown>) => {
      if (closed || event.source !== frame.contentWindow || !isRecord(event.data) || event.data.jsonrpc !== '2.0') return;
      for (const listener of standardListeners) listener(event.data, event.ports);
    };
    mcp = createMcpAppProtocol({
      frame, optional: true, post: (data) => frame.contentWindow?.postMessage(data, '*'),
      subscribe: (listener) => { standardListeners.add(listener); return () => { standardListeners.delete(listener); }; },
      current: () => !closed && isCurrentSession(identity.sessionIdentityKey),
      revoke: (message) => fail(text(message === 'MCP App closed' ? 'closed'
        : message === 'MCP App initialization timed out' ? 'connectionTimeout' : 'requestFailed')),
      methods: ['tools/call', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read', 'ui/message'],
      capabilities: () => ({ serverTools: {}, serverResources: {}, ...(canCompose() ? { message: { text: {}, image: {}, resource: {} } } : {}) }),
      hostContext: () => ({ ...mcpAppHostContext(frame), locale: readContext().language, theme: readContext().theme }),
      onHeight: (height) => { frame.style.minHeight = `${height}px`; },
      onInitialized: () => { report({ level: 'info', message: 'MCP Apps protocol initialized (rendering not verified)' }); },
      execute: async (method, params, requestCurrent) => {
        staging.signal.throwIfAborted();
        if (!requestCurrent()) throw new Error(text('sessionChanged'));
        if (method === 'ui/message') {
          if (!only(params, ['role', 'content']) || params.role !== 'user' || !Array.isArray(params.content)
            || params.content.length < 1 || params.content.length > 32) throw new Error(text('invalidCompose'));
          const texts: string[] = [];
          const attachments: NonNullable<AppComposeRequest['attachments']>[number][] = [];
          for (const [index, part] of params.content.entries()) {
            if (!isRecord(part)) throw new Error(text('invalidCompose'));
            if (part.type === 'text' && only(part, ['type', 'text', 'annotations']) && typeof part.text === 'string') texts.push(part.text);
            else if (part.type === 'image' && only(part, ['type', 'data', 'mimeType', 'annotations']) && typeof part.data === 'string'
              && typeof part.mimeType === 'string' && part.mimeType.startsWith('image/')) {
              attachments.push({ name: `image-${index + 1}`, mimeType: part.mimeType, data: part.data });
            } else if (part.type === 'resource' && only(part, ['type', 'resource', 'annotations']) && isRecord(part.resource)) {
              const resource = part.resource;
              if (!only(resource, ['uri', 'mimeType', 'text', 'blob']) || typeof resource.uri !== 'string' || resource.uri.length > 4096
                || resource.mimeType !== undefined && typeof resource.mimeType !== 'string') throw new Error(text('invalidCompose'));
              if (typeof resource.text === 'string' && resource.blob === undefined) texts.push(`${resource.uri}\n${resource.text}`);
              else if (typeof resource.blob === 'string' && resource.text === undefined && typeof resource.mimeType === 'string') {
                attachments.push({ name: `resource-${index + 1}`, mimeType: resource.mimeType, data: resource.blob });
              } else throw new Error(text('invalidCompose'));
            } else throw new Error(text('invalidCompose'));
          }
          const request: AppComposeRequest = { text: texts.join('\n') || attachments.map((attachment) => attachment.name).join('\n'),
            ...(attachments.length ? { attachments } : {}) };
          const error = validateAppComposeRequest(request);
          if (error) throw new Error(i18n.t(error));
          // This product stages the user's draft; it never submits a chat turn on an App's behalf.
          if (!requestCurrent()) throw new Error(text('sessionChanged'));
          await compose(request, { pluginId: identity.pluginId, digest: identity.digest }, identity.sessionIdentityKey, staging.signal);
          return {};
        }
        if (method === 'tools/call') {
          if (!only(params, ['name', 'arguments']) || typeof params.name !== 'string' || !params.name
            || params.arguments !== undefined && !isRecord(params.arguments)) throw new Error(text('invalidTool'));
          return callDeclaredTool(params.name, params.arguments as Record<string, unknown> | undefined ?? {}, true);
        }
        if (method === 'resources/read') {
          if (!only(params, ['uri']) || typeof params.uri !== 'string') throw new Error(text('invalidRequest'));
          const application = resources().find((item) => appResourceUri(identity.pluginId, item.id) === params.uri);
          if (!application) throw new Error(text('invalidRequest'));
          const bundle = identity.development ? { html: identity.html } : await hostAppPluginBundle(identity.pluginId, identity.digest, application.entry);
          return { contents: [{ uri: params.uri, mimeType: 'text/html;profile=mcp-app', text: bundle.html }] };
        }
        if (!only(params, ['cursor']) || params.cursor !== undefined) throw new Error(text('invalidRequest'));
        if (method === 'tools/list') return { tools: (manifest().contributes.tools ?? []).map((tool) => ({ ...tool, name: appToolName(identity.pluginId, tool.name) })) };
        if (method === 'resources/list') return { resources: appPluginResources({ ...manifest(), contributes: { applications: resources() } }) };
        return { resourceTemplates: [] };
      },
    });
    mcpContextChanged.current = mcp.updateHostContext;
    window.addEventListener('message', standardMessage);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      event.ports.forEach((port) => port.close());
      if (closed) return;
      if (event.ports.length || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
        fail(text('invalidMessage'));
        return;
      }
      const value = event.data as Record<string, unknown>;
      if (value.type === 'development-result' && identity.development && Number.isSafeInteger(value.id)) {
        const request = commandPending.get(Number(value.id));
        if (!request) return;
        if (typeof value.error === 'string') request.finish(new Error(value.error.slice(0, 500)));
        else request.finish(null, value.result);
        return;
      }
      if (value.type === 'ready' && !ready) {
        ready = true;
        localeChanged();
        channel.port1.postMessage({ type: 'theme', theme: readContext().theme });
        showConnectedFrame();
        report({ level: 'info', message: 'Application bridge connected (rendering not verified)' });
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
          : Promise.resolve().then(() => callDeclaredTool(value.name as string, value.arguments as Record<string, unknown>));
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
    const runtimeEvent = (event: { topic: string; data: AppJson }) => {
      if (!closed && ready) {
        try { channel.port1.postMessage({ type: 'event', topic: event.topic, data: event.data }); }
        catch { fail(text('eventFailed')); }
      }
    };
    unsubscribe = identity.development ? identity.development.subscribe(runtimeEvent)
      : subscribeHostEvent<AppRuntimeEvent>('app-plugins:runtime', (event) => {
        if (event.pluginId === identity.pluginId && event.digest === identity.digest) runtimeEvent(event);
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
    frame.srcdoc = buildAppDocument(identity.pluginId, identity.html, context, !!identity.development);
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
});
