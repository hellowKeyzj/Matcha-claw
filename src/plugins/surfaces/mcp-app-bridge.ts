import { hostOpenClawMcpAppRequest } from '@/lib/host-api';
import {
  isOpenClawMcpAppRequest,
  type OpenClawMcpAppRequest,
  type OpenClawMcpAppSurfaceDescriptor,
  type OpenClawMcpAppViewResult,
} from '@/types/openclaw-runtime-surface';
import { surfaceFailure, type ContentActions, type ContentCallbacks } from '@/plugins/surfaces/content-security';
import { isRecord, type SandboxChannel } from '@/plugins/surfaces/sandbox-channel';
import { createMcpAppProtocol, onlyMcpAppParams as only } from './mcp-app-protocol';

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
  let alive = true;
  const active = () => alive && current() && (descriptor.expiresAtMs === undefined || Date.now() < descriptor.expiresAtMs);
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

  const protocol = createMcpAppProtocol({
    frame: channel.frame, post: (data) => channel.post(data), subscribe: (listener) => channel.subscribe(listener),
    current: active, revoke, onHeight: options.onHeight,
    methods: ['tools/call', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read',
      'ui/message', 'ui/open-link', 'ui/update-model-context'],
    capabilities: () => ({
      sandbox: { csp: payload.csp ?? {} },
      ...(!readOnly ? { serverTools: {}, serverResources: {} } : {}),
      ...(!readOnly && options.callbacks().onOpenLink ? { openLinks: {} } : {}),
      ...(!readOnly && payload.messageSupported && options.callbacks().onSendMessage ? { message: { text: {} } } : {}),
      ...(!readOnly && payload.updateModelContextSupported ? { updateModelContext: { text: {} } } : {}),
    }),
    onInitialized: async (notify) => {
      const view = await currentView();
      notify('ui/notifications/tool-input', { arguments: isRecord(view.toolInput) ? view.toolInput : {} });
      notify('ui/notifications/tool-result', view.toolResult);
    },
    execute: async (method, params, requestCurrent) => {
      if (readOnly) throw new Error('MCP App is read-only');
      if (method === 'ui/message') {
        if (!payload.messageSupported || !only(params, ['role', 'content']) || params.role !== undefined && params.role !== 'user' || !Array.isArray(params.content)
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
    },
    failure: (error) => {
      const failure = surfaceFailure(error);
      return { message: failure?.message ?? 'MCP App operation failed', revoke: !!failure
        && ['MCP_APP_VIEW_EXPIRED', 'SURFACE_REJECTED', 'SURFACE_UNAVAILABLE', 'SURFACE_OUTCOME_UNKNOWN'].includes(failure.code) };
    },
  });
  return { checkAuthority, dispose: () => { alive = false; protocol.dispose(); } };
}
