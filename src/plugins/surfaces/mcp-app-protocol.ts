// Wire contract: @modelcontextprotocol/ext-apps 2026-01-26. Runtime authority stays in each adapter.
import { isRecord, type SandboxMessage } from './sandbox-channel';

type RequestId = string | number;
export type McpAppNotify = (method: string, params: unknown) => void;

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    || typeof value === 'number' && Number.isSafeInteger(value);
}

export function onlyMcpAppParams(params: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(params).every((name) => names.includes(name) || name === '_meta');
}

export function mcpAppHostContext(frame: HTMLIFrameElement) {
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    displayMode: 'inline', availableDisplayModes: ['inline'],
    containerDimensions: { width: Math.max(1, frame.clientWidth), height: Math.max(1, frame.clientHeight) },
    locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: 'desktop',
  };
}

export function createMcpAppProtocol(options: {
  frame: HTMLIFrameElement;
  post: (data: unknown) => void;
  subscribe: (listener: SandboxMessage) => () => void;
  current: () => boolean;
  revoke: (message: string) => void;
  capabilities: () => Record<string, unknown>;
  hostContext?: () => Record<string, unknown>;
  methods: readonly string[];
  execute: (method: string, params: Record<string, unknown>, current: () => boolean) => Promise<unknown>;
  onInitialized?: (notify: McpAppNotify) => void | Promise<void>;
  optional?: boolean;
  onHeight: (height: number) => void;
  failure?: (error: unknown) => { message: string; revoke?: boolean };
}) {
  const pending = new Map<RequestId, object>();
  const seen = new Set<RequestId>();
  let alive = true;
  let initialization: 'waiting' | 'accepted' | 'initialized' = 'waiting';
  const active = () => alive && options.current();
  const hostContext = () => options.hostContext?.() ?? mcpAppHostContext(options.frame);
  const notify: McpAppNotify = (method, params) => { if (active()) options.post({ jsonrpc: '2.0', method, params }); };
  const reject = (id: RequestId, code: number, message: string) => options.post({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id: RequestId, value: unknown) => options.post({ jsonrpc: '2.0', id, result: value });
  const reportFailure = (error: unknown, id?: RequestId) => {
    if (!active()) return;
    const failure = options.failure?.(error) ?? { message: error instanceof Error ? error.message : 'MCP App operation failed' };
    if (id !== undefined) reject(id, -32000, failure.message);
    if (failure.revoke || id === undefined) options.revoke(failure.message);
  };
  const offMessage = options.subscribe((message, ports) => {
    if (ports.length) { ports.forEach((port) => port.close()); return; }
    if (!active() || !isRecord(message) || message.jsonrpc !== '2.0') return;
    const { method, params } = message;
    if (method === 'notifications/cancelled') {
      if (message.id === undefined && isRecord(params) && isRequestId(params.requestId)) pending.delete(params.requestId);
      return;
    }
    if (message.id === undefined) {
      if (method === 'ui/notifications/initialized' && initialization === 'accepted') {
        initialization = 'initialized';
        clearTimeout(initializationTimer);
        // The App installs its input/result handlers after sending initialized.
        setTimeout(() => {
          if (active()) void Promise.resolve().then(() => options.onInitialized?.(notify)).catch((error: unknown) => reportFailure(error));
        }, 0);
      } else if (method === 'ui/notifications/size-changed' && initialization === 'initialized' && isRecord(params)
        && typeof params.height === 'number' && Number.isFinite(params.height) && params.height > 0) {
        options.onHeight(Math.max(160, Math.min(1200, Math.round(params.height))));
      } else if (method === 'ui/notifications/request-teardown' && initialization === 'initialized') options.revoke('MCP App closed');
      return;
    }
    const id = message.id;
    // Responses (including the teardown ACK) are not new requests.
    if (!isRequestId(id) || typeof method !== 'string' || seen.has(id)) return;
    if (seen.size >= 4096) { options.revoke('MCP App request capacity exhausted'); return; }
    seen.add(id);
    if (method === 'ping') { result(id, {}); return; }
    if (method === 'ui/initialize') {
      if (initialization !== 'waiting' || !isRecord(params) || !isRecord(params.appInfo)
        || typeof params.appInfo.name !== 'string' || typeof params.appInfo.version !== 'string'
        || !isRecord(params.appCapabilities) || typeof params.protocolVersion !== 'string') {
        reject(id, -32602, 'Invalid MCP App initialization'); return;
      }
      initialization = 'accepted';
      clearTimeout(initializationTimer);
      initializationTimer = setTimeout(() => { if (active()) options.revoke('MCP App initialization timed out'); }, 15_000);
      result(id, { protocolVersion: '2026-01-26', hostInfo: { name: 'Matcha', version: '1.0.0' },
        hostCapabilities: options.capabilities(), hostContext: hostContext() });
      return;
    }
    if (!options.methods.includes(method)) {
      reject(id, -32601, 'Method not found'); return;
    }
    if (initialization !== 'initialized') { reject(id, -32002, 'MCP App initialization is incomplete'); return; }
    if (params !== undefined && !isRecord(params)) { reject(id, -32602, 'Invalid MCP App parameters'); return; }
    if (pending.size >= 32) { reject(id, -32000, 'MCP App request capacity exhausted'); return; }
    const token = {};
    pending.set(id, token);
    void Promise.resolve().then(() => {
      if (!active() || pending.get(id) !== token) return;
      return options.execute(method, params ?? {}, () => active() && pending.get(id) === token);
    }).then((value) => {
      if (active() && pending.get(id) === token) result(id, value);
    }).catch((error: unknown) => {
      if (active() && pending.get(id) === token) reportFailure(error, id);
    }).finally(() => { if (pending.get(id) === token) pending.delete(id); });
  });
  let initializationTimer = setTimeout(() => {
    if (active() && (!options.optional || initialization === 'accepted')) options.revoke('MCP App initialization timed out');
  }, 15_000);
  const updateHostContext = () => {
    if (initialization === 'initialized') notify('ui/notifications/host-context-changed', hostContext());
  };
  const themeObserver = new MutationObserver(updateHostContext);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  const resize = new ResizeObserver(updateHostContext);
  resize.observe(options.frame);

  return {
    updateHostContext,
    dispose: () => {
      if (!alive) return;
      alive = false;
      pending.clear();
      offMessage();
      clearTimeout(initializationTimer);
      themeObserver.disconnect();
      resize.disconnect();
      try { options.post({ jsonrpc: '2.0', id: `host-teardown-${crypto.randomUUID()}`, method: 'ui/resource-teardown', params: {} }); } catch { /* Already retired. */ }
    },
  };
}
