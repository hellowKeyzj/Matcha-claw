// Wire contract: @modelcontextprotocol/ext-apps 2026-01-26, as used by native McpAppView.
import { hostOpenClawMcpAppRequest } from '@/lib/host-api';
import {
  isOpenClawMcpAppRequest,
  type OpenClawMcpAppRequest,
  type OpenClawMcpAppSurfaceDescriptor,
  type OpenClawMcpAppViewResult,
} from '@/types/openclaw-runtime-surface';
import { contentHostContext, surfaceFailure, type ContentActions, type ContentCallbacks } from './content-security';
import { isRecord, type SandboxChannel } from './sandbox-channel';

type RequestId = string | number;
function requestId(value: unknown): value is RequestId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    || typeof value === 'number' && Number.isSafeInteger(value);
}
function only(params: Record<string, unknown>, names: string[]) {
  return Object.keys(params).every((name) => names.includes(name) || name === '_meta');
}

export function createMcpAppBridge(options: {
  channel: SandboxChannel;
  descriptor: OpenClawMcpAppSurfaceDescriptor;
  payload: OpenClawMcpAppViewResult;
  actions: ContentActions;
  callbacks: () => ContentCallbacks;
  current: () => boolean;
  revoke: (message: string) => void;
  onHeight: (height: number) => void;
}) {
  const { channel, descriptor, payload, actions, current, revoke } = options;
  const binding = { sessionIdentity: descriptor.sessionIdentity, viewId: descriptor.viewId };
  const readOnly = descriptor.readOnly === true || payload.readOnly;
  const pending = new Map<RequestId, object>();
  const seen = new Set<RequestId>();
  let alive = true;
  let initializeAccepted = false;
  let initialized = false;
  let initializationTimer: ReturnType<typeof setTimeout>;
  const active = () => alive && current() && (descriptor.expiresAtMs === undefined || Date.now() < descriptor.expiresAtMs);
  const notify = (method: string, params: unknown) => channel.post({ jsonrpc: '2.0', method, params });
  const reject = (id: RequestId, code: number, message: string) => channel.post({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id: RequestId, value: unknown) => channel.post({ jsonrpc: '2.0', id, result: value });

  const currentView = async () => {
    if (!active()) throw new Error('MCP App is no longer active');
    const view = await hostOpenClawMcpAppRequest({ ...binding, operationId: 'mcp.app.view' }, { timeoutMs: 20_000 });
    if (!active()) throw new Error('MCP App is no longer active');
    if (view.readOnly !== payload.readOnly || view.messageSupported !== payload.messageSupported
      || payload.updateModelContextSupported && !view.updateModelContextSupported) {
      revoke('MCP App authority is no longer active');
      throw new Error('MCP App authority is no longer active');
    }
    return view;
  };
  const checkAuthority = async () => {
    if (readOnly) throw new Error('MCP App is read-only');
    await currentView();
  };

  const execute = async (method: string, params: unknown, requestCurrent: () => boolean): Promise<unknown> => {
    if (readOnly) throw new Error('MCP App is read-only');
    if (!isRecord(params)) throw new Error('Invalid MCP App parameters');
    if (method === 'ui/message') {
      if (!payload.messageSupported || !only(params, ['content']) || !Array.isArray(params.content)
        || params.content.length !== 1 || !isRecord(params.content[0]) || params.content[0].type !== 'text'
        || typeof params.content[0].text !== 'string' || !only(params.content[0], ['type', 'text'])) throw new Error('Invalid MCP App message');
      return await actions.message(params.content[0].text, requestCurrent) ? {} : { isError: true };
    }
    if (method === 'ui/open-link') {
      if (!only(params, ['url'])) throw new Error('Invalid MCP App link');
      return await actions.openLink(params.url, requestCurrent) ? {} : { isError: true };
    }
    let request: unknown;
    switch (method) {
      case 'tools/call':
        if (!only(params, ['name', 'arguments'])) break;
        request = { ...binding, operationId: 'mcp.app.callTool', toolName: params.name,
          ...(params.arguments === undefined ? {} : { arguments: params.arguments }) };
        break;
      case 'tools/list': case 'resources/list': case 'resources/templates/list': {
        if (!only(params, ['cursor'])) break;
        const operationId = method === 'tools/list' ? 'mcp.app.listTools'
          : method === 'resources/list' ? 'mcp.app.listResources' : 'mcp.app.listResourceTemplates';
        request = { ...binding, operationId, ...(params.cursor === undefined ? {} : { cursor: params.cursor }) };
        break;
      }
      case 'resources/read':
        if (only(params, ['uri'])) request = { ...binding, operationId: 'mcp.app.readResource', uri: params.uri };
        break;
      case 'ui/update-model-context':
        if (payload.updateModelContextSupported && only(params, ['content'])) request = {
          ...binding, operationId: 'mcp.app.updateModelContext', ...(params.content === undefined ? {} : { content: params.content }),
        };
        break;
    }
    if (!isOpenClawMcpAppRequest(request)) throw new Error('Invalid or unsupported MCP App parameters');
    const value = await hostOpenClawMcpAppRequest(request as OpenClawMcpAppRequest, { timeoutMs: 60_000 });
    // The grant may have been revoked while a tool/resource operation was in flight.
    await checkAuthority();
    return value;
  };

  const offMessage = channel.subscribe((message, ports) => {
    if (ports.length) { ports.forEach((port) => port.close()); return; }
    if (!active() || !isRecord(message) || message.jsonrpc !== '2.0') return;
    const { method, params } = message;
    if (method === 'notifications/cancelled') {
      if (message.id === undefined && isRecord(params) && requestId(params.requestId)) pending.delete(params.requestId);
      return;
    }
    if (message.id === undefined) {
      if (method === 'ui/notifications/initialized' && initializeAccepted && !initialized) {
        initialized = true;
        clearTimeout(initializationTimer);
        // Give the App's initialized notification handler time to install input/result callbacks.
        setTimeout(() => {
          if (!active()) return;
          void currentView().then((view) => {
            if (!active()) return;
            notify('ui/notifications/tool-input', { arguments: isRecord(view.toolInput) ? view.toolInput : {} });
            notify('ui/notifications/tool-result', view.toolResult);
          }).catch(() => { if (active()) revoke('MCP App authority could not be verified'); });
        }, 0);
      } else if (method === 'ui/notifications/size-changed' && initialized && isRecord(params)
        && typeof params.height === 'number' && Number.isFinite(params.height)) {
        options.onHeight(Math.max(160, Math.min(1200, Math.round(params.height))));
      } else if (method === 'ui/notifications/request-teardown') revoke('MCP App closed');
      return;
    }
    const id = message.id;
    if (!requestId(id) || typeof method !== 'string' || seen.has(id)) return;
    if (seen.size >= 4096) { revoke('MCP App request capacity exhausted'); return; }
    seen.add(id);
    if (method === 'ping') { result(id, {}); return; }
    if (method === 'ui/initialize') {
      if (initializeAccepted || !isRecord(params) || !isRecord(params.appInfo)
        || typeof params.appInfo.name !== 'string' || typeof params.appInfo.version !== 'string'
        || !isRecord(params.appCapabilities) || typeof params.protocolVersion !== 'string') {
        reject(id, -32602, 'Invalid MCP App initialization'); return;
      }
      initializeAccepted = true;
      const callbacks = options.callbacks();
      result(id, {
        protocolVersion: '2026-01-26', hostInfo: { name: 'Matcha', version: '1.0.0' },
        hostCapabilities: {
          sandbox: { csp: payload.csp ?? {} },
          ...(!readOnly ? { serverTools: {}, serverResources: {} } : {}),
          ...(!readOnly && callbacks.onOpenLink ? { openLinks: {} } : {}),
          ...(!readOnly && payload.messageSupported && callbacks.onSendMessage ? { message: { text: {} } } : {}),
          ...(!readOnly && payload.updateModelContextSupported ? { updateModelContext: { text: {} } } : {}),
        },
        hostContext: contentHostContext(channel.frame),
      });
      return;
    }
    if (!['tools/call', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read',
      'ui/message', 'ui/open-link', 'ui/update-model-context'].includes(method)) {
      reject(id, -32601, 'Method not found'); return;
    }
    if (!initialized) { reject(id, -32002, 'MCP App initialization is incomplete'); return; }
    if (pending.size >= 32) { reject(id, -32000, 'MCP App request capacity exhausted'); return; }
    const token = {};
    pending.set(id, token);
    void execute(method, params ?? {}, () => active() && pending.get(id) === token).then((value) => {
      if (active() && pending.get(id) === token) result(id, value);
    }).catch((error: unknown) => {
      if (!active() || pending.get(id) !== token) return;
      const failure = surfaceFailure(error);
      reject(id, -32000, failure?.message ?? 'MCP App operation failed');
      if (failure && ['MCP_APP_VIEW_EXPIRED', 'SURFACE_REJECTED', 'SURFACE_UNAVAILABLE', 'SURFACE_OUTCOME_UNKNOWN'].includes(failure.code)) {
        revoke(failure.message);
      }
    }).finally(() => { if (pending.get(id) === token) pending.delete(id); });
  });
  initializationTimer = setTimeout(() => { if (active()) revoke('MCP App initialization timed out'); }, 15_000);
  const themeObserver = new MutationObserver(() => {
    if (active() && initialized) notify('ui/notifications/host-context-changed', contentHostContext(channel.frame));
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  const resize = new ResizeObserver(() => {
    if (active() && initialized) notify('ui/notifications/host-context-changed', contentHostContext(channel.frame));
  });
  resize.observe(channel.frame);

  return {
    checkAuthority,
    dispose: () => {
      if (!alive) return;
      alive = false;
      pending.clear();
      offMessage();
      clearTimeout(initializationTimer);
      themeObserver.disconnect();
      resize.disconnect();
      try { channel.post({ jsonrpc: '2.0', id: `host-teardown-${crypto.randomUUID()}`, method: 'ui/resource-teardown', params: {} }); } catch { /* Already retired. */ }
    },
  };
}
