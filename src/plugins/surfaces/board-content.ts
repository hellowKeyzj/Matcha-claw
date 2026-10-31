import { boardExecute } from './board-api';
import { decodeBoardOperation, type BoardIdentity, type BoardOperation, type BoardWidget } from '@/types/board';
import { isRecord, type SandboxChannel } from '@/plugins/surfaces/sandbox-channel';
import type { ContentActions } from '@/plugins/surfaces/content-security';

export function boardDocument(identity: BoardIdentity, widget: BoardWidget) {
  if (!widget.frameUrl || !widget.viewTicket || !widget.sandboxUrl || !widget.sandboxOrigin
    || !widget.viewGeneration || !widget.instanceId || ['pending', 'rejected'].includes(widget.grantState)) {
    throw new Error('Board widget has no active native view');
  }
  const frame = new URL(widget.frameUrl);
  const sandbox = new URL(widget.sandboxUrl);
  const path = `/__openclaw__/board/${encodeURIComponent(identity.sessionKey)}/${encodeURIComponent(widget.name)}/index.html`;
  if (!['http:', 'https:'].includes(frame.protocol) || frame.username || frame.password || frame.hash
    || frame.pathname !== path || frame.searchParams.size !== 1 || frame.searchParams.get('bt') !== widget.viewTicket
    || sandbox.origin !== widget.sandboxOrigin || sandbox.origin === frame.origin) {
    throw new Error('Invalid Board native view binding');
  }
  const parts = widget.viewTicket.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/u.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[2])) {
    throw new Error('Invalid Board view ticket');
  }
  let claims: unknown;
  try {
    const binary = atob(parts[1].replace(/-/gu, '+').replace(/_/gu, '/'));
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  } catch { throw new Error('Invalid Board view ticket'); }
  // The native resource server verifies the signature; these checks bind the already sealed projection.
  if (!isRecord(claims) || claims.sessionKey !== identity.sessionKey || claims.agentId !== identity.agentId
    || claims.name !== widget.name || claims.revision !== widget.revision || claims.viewGeneration !== widget.viewGeneration
    || typeof claims.authorityGeneration !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(claims.authorityGeneration)
    || typeof claims.expiresAtMs !== 'number' || !Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs <= Date.now()) {
    throw new Error('Board view ticket is stale');
  }
  return { url: frame.href, sandboxUrl: sandbox.href, ticket: widget.viewTicket,
    authorityGeneration: claims.authorityGeneration, expiresAtMs: claims.expiresAtMs };
}

export async function fetchBoardDocument(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html') || !response.body) {
    throw new Error('Board document is unavailable; refresh its native view');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let html = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      signal.throwIfAborted();
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Board document exceeds the content limit');
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createBoardBridge(options: {
  channel: SandboxChannel;
  identity: BoardIdentity;
  document: ReturnType<typeof boardDocument>;
  actions: ContentActions;
  current: () => boolean;
  revoke: (message: string) => void;
  onAdopted: (document: ReturnType<typeof boardDocument>) => void;
}) {
  const { channel, identity, current, actions, revoke, onAdopted } = options;
  let document = options.document;
  let offered: typeof document | null = null;
  let adopted: typeof document | null = null;
  let port: MessagePort | null = null;
  let alive = true;
  const seen = new Set<string>();
  const pending = new Map<string, object>();
  const states = new Map<string, number>();
  const pendingStates = new Map<string, Promise<unknown>>();
  let stateAttempts: number[] = [];
  const active = () => alive && current();
  let adoptionTimer: ReturnType<typeof setTimeout> | undefined;
  const offerTicket = () => {
    if (!port || offered || document.ticket === adopted?.ticket) return;
    offered = document;
    adoptionTimer = setTimeout(() => revoke('Widget ticket adoption timed out'), 5000);
    port.postMessage({ type: 'openclaw:widget-host-init', ticket: offered.ticket });
  };
  const execute = async (method: string, params: Record<string, unknown>, ticket: string, requestCurrent: () => boolean) => {
    if (method === 'host.open') {
      if (!await actions.openLink(params.url, requestCurrent)) throw new Error('Widget link was not accepted');
      return { ok: true };
    }
    if (method === 'prompt.send') {
      if (!await actions.message(params.text, requestCurrent)) throw new Error('Widget prompt was not accepted');
      return { ok: true };
    }
    let operation: BoardOperation;
    switch (method) {
      case 'data.read': operation = decodeBoardOperation({ method: 'board.data.read', ticket, bindingId: params.bindingId,
        ...(params.params === undefined ? {} : { params: params.params }) }); break;
      case 'action.run': operation = decodeBoardOperation({ method: 'board.action', ticket, action: params.action, params: params.params ?? {} }); break;
      case 'cron.trigger': operation = decodeBoardOperation({ method: 'board.action', ticket, action: 'cron.trigger', jobId: params.jobId }); break;
      case 'state.emit': {
        operation = decodeBoardOperation({ method: 'board.event', ticket, payload: params.payload });
        const serialized = JSON.stringify(params.payload);
        if (new TextEncoder().encode(serialized).byteLength > 8192) throw new Error('Widget state exceeds the content limit');
        const now = Date.now();
        for (const [key, at] of states) if (now - at >= 5000) states.delete(key);
        if (states.has(serialized)) return { ok: true, appended: false, coalesced: true };
        const existing = pendingStates.get(serialized);
        if (existing) return await existing;
        stateAttempts = stateAttempts.filter((time) => now - time < 60_000);
        if (stateAttempts.length >= 12) throw new Error('Widget state rate limit exceeded');
        stateAttempts.push(now);
        const promise = boardExecute(identity, operation);
        pendingStates.set(serialized, promise);
        try {
          const result = await promise;
          if (requestCurrent()) states.set(serialized, Date.now());
          return result;
        } finally {
          if (pendingStates.get(serialized) === promise) pendingStates.delete(serialized);
        }
      }
      default: throw new Error('Unsupported widget host method');
    }
    return await boardExecute(identity, operation);
  };
  const offMessage = channel.subscribe((data, ports) => {
    if (!isRecord(data) || data.type !== 'openclaw:widget-bridge-port-offer') return;
    if (!active() || port || ports.length !== 1) { ports.forEach((item) => item.close()); return; }
    port = ports[0];
    const adoptedPort = port;
    adoptedPort.onmessage = (event: MessageEvent<unknown>) => {
      event.ports.forEach((item) => item.close());
      if (!active() || port !== adoptedPort || !isRecord(event.data)) return;
      const request = event.data;
      if (request.type === 'openclaw:widget-host-init-ack') {
        if (!offered || request.ticket !== offered.ticket) return;
        clearTimeout(adoptionTimer);
        for (const id of pending.keys()) adoptedPort.postMessage({ type: 'openclaw:widget-bridge-response', id, ok: false,
          error: 'Widget view ticket changed; an earlier operation may still complete' });
        pending.clear();
        pendingStates.clear();
        adopted = offered;
        offered = null;
        onAdopted(adopted);
        if (active()) offerTicket();
        return;
      }
      if (request.type !== 'openclaw:widget-bridge-request'
        || typeof request.id !== 'string' || !request.id || request.id.length > 128
        || typeof request.method !== 'string' || !isRecord(request.params) || seen.has(request.id)) return;
      if (!adopted || request.ticket !== adopted.ticket) {
        adoptedPort.postMessage({ type: 'openclaw:widget-bridge-response', id: request.id, ok: false, error: 'Widget view ticket changed' });
        return;
      }
      if (seen.size >= 4096) { revoke('Widget request capacity exhausted'); return; }
      seen.add(request.id);
      const id = request.id;
      if (pending.size >= 32) {
        adoptedPort.postMessage({ type: 'openclaw:widget-bridge-response', id, ok: false, error: 'Widget request capacity exhausted' });
        return;
      }
      const token = {};
      const requestTicket = adopted.ticket;
      pending.set(id, token);
      const requestCurrent = () => active() && adopted?.ticket === requestTicket && pending.get(id) === token;
      void execute(request.method, request.params, requestTicket, requestCurrent).then((result) => {
        if (requestCurrent()) adoptedPort.postMessage({ type: 'openclaw:widget-bridge-response', id, ok: true, result });
      }).catch((error: unknown) => {
        if (!requestCurrent()) return;
        const code = isRecord(error) ? error.code : undefined;
        adoptedPort.postMessage({ type: 'openclaw:widget-bridge-response', id, ok: false,
          error: code === 'unknown' ? 'Outcome unknown; refresh before trying again' : 'Widget host request failed' });
        if (['forbidden', 'stale', 'expired', 'unavailable', 'unknown'].includes(String(code))) revoke('Widget authority is no longer active; refresh its native view');
      }).finally(() => { if (pending.get(id) === token) pending.delete(id); });
    };
    adoptedPort.onmessageerror = () => revoke('Widget private channel failed');
    adoptedPort.start();
    offerTicket();
  });
  return {
    updateDocument(next: typeof document): boolean {
      if (next.authorityGeneration !== document.authorityGeneration) return false;
      if (active()) {
        document = next;
        offerTicket();
      }
      return true;
    },
    async checkAuthority() {
      const ticket = adopted?.ticket;
      if (!active() || !ticket) throw new Error('Board view expired');
      await boardExecute(identity, { method: 'board.prompt.authorize', ticket });
      if (!active() || ticket !== adopted?.ticket) throw new Error('Board view expired');
    },
    dispose() {
      alive = false;
      clearTimeout(adoptionTimer);
      pending.clear();
      pendingStates.clear();
      states.clear();
      offMessage();
      port?.close();
      port = null;
    },
  };
}
