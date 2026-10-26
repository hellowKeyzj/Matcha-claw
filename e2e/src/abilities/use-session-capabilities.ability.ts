import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron } from './use-electron.ability.js';

const fixedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
type Identity = { endpoint: typeof endpoint; agentId: 'main'; sessionKey: string };
type Attachment = { stagedAttachmentId: string; fileName: string; mimeType: string; fileSize: number };
type CapabilityRequest =
  | { id: 'session.management'; operationId: 'sessions.list'; scope: { kind: 'runtime-instance'; endpoint: typeof endpoint }; target: { kind: 'runtime-endpoint' }; input: { endpoint: typeof endpoint } }
  | { id: 'session.prompt'; operationId: 'sessions.create'; scope: { kind: 'agent'; endpoint: typeof endpoint; agentId: 'main' }; target: { kind: 'agent'; agentId: 'main' }; input: { endpoint: typeof endpoint; agentId: 'main'; endpointSessionId: string } }
  | { id: 'session.prompt'; operationId: 'sessions.prompt' | 'sessions.sendWithMedia'; scope: { kind: 'session'; identity: Identity }; target: { kind: 'session'; identity: Identity }; input: { sessionKey: string; sessionIdentity: Identity; message: string; runId: string; attachments: Attachment[] } };
type FetchRequest = { requestId: string; path: '/api/capabilities/execute'; method: 'POST'; body: CapabilityRequest; timeoutMs: number };
type FetchReply = { ok: false; error: { code: 'TIMEOUT' | 'ABORTED' | 'UNAVAILABLE' | 'INVALID_RESPONSE' } } | { ok: true; data: { status: number; ok: boolean; json: unknown } };
type PublicIpc = {
  invoke(channel: 'hostapi:fetch', request: FetchRequest | { requestId: string; path: '/api/gateway/status'; method: 'GET'; timeoutMs: number }): Promise<FetchReply>;
  invoke(channel: 'dialog:stageRendererBufferAttachment', input: { base64: string; fileName: string; mimeType: string }): Promise<unknown>;
  invoke(channel: 'dialog:releaseStagedAttachments', ids: string[]): Promise<void>;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function failureContext(reply: FetchReply): string {
  if (!reply.ok) return `IPC ${reply.error.code}`;
  const body = record(reply.data.json);
  const outcome = !Object.hasOwn(body, 'outcome') ? 'absent'
    : ['queued', 'succeeded', 'target_rejected', 'unavailable', 'unknown'].includes(String(body.outcome)) ? body.outcome : 'unrecognized';
  const error = ['Capability request failed', 'Session catalog is unavailable', 'Session create is unavailable', 'Session send is unavailable', 'Session send request is invalid'].includes(String(body.error)) ? body.error : 'none';
  return `HTTP ${reply.data.status}; outcome=${outcome}; publicError=${error}`;
}

export class UseSessionCapabilities extends Ability {
  private identity?: Identity;
  private attachment?: Attachment;
  private pendingRun?: string;
  private deletionSubmitted = false;

  constructor(private readonly electron: UseElectron) { super(); }

  async waitForSessionCatalog(timeoutMs = 45_000): Promise<boolean> {
    const body: CapabilityRequest = {
      id: 'session.management', operationId: 'sessions.list',
      scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint },
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.electron.page.evaluate(async (body) => {
        const bridge = (window as unknown as { electron: { ipcRenderer: PublicIpc } }).electron.ipcRenderer;
        const gateway = await bridge.invoke('hostapi:fetch', {
          requestId: crypto.randomUUID(), path: '/api/gateway/status', method: 'GET', timeoutMs: 3_000,
        });
        if (!gateway.ok || gateway.data.status !== 200 || !gateway.data.ok) return false;
        const status = gateway.data.json as { processState?: string; gatewayReady?: boolean; transportState?: string } | null;
        if (status?.processState !== 'running' || status.gatewayReady !== true || status.transportState !== 'connected') return false;
        const reply = await bridge.invoke('hostapi:fetch', {
          requestId: crypto.randomUUID(), path: '/api/capabilities/execute', method: 'POST', body, timeoutMs: 3_000,
        });
        if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) return false;
        const json = reply.data.json as { sessions?: unknown } | null;
        return Array.isArray(json?.sessions);
      }, body);
      if (ready) return true;
      await delay(250);
    }
    throw new Error('OpenClaw gateway and public session catalog did not become ready');
  }

  async createSession() {
    const endpointSessionId = `e2e-attachment-${randomUUID()}`;
    const sessionKey = `agent:main:${endpointSessionId}`;
    if (this.identity || this.pendingRun) throw new Error('Public attachment session creation must not be replayed');
    if ((await this.catalog()).some(entry => {
      const identity = record(entry.sessionIdentity);
      const ref = record(identity.endpoint);
      return identity.sessionKey === sessionKey && identity.agentId === 'main' && ref.kind === endpoint.kind
        && ref.runtimeAdapterId === endpoint.runtimeAdapterId && ref.runtimeInstanceId === endpoint.runtimeInstanceId;
    })) {
      throw new Error('Reserved attachment session already exists; it must not be touched');
    }
    const reply = await this.execute({
      id: 'session.prompt', operationId: 'sessions.create',
      scope: { kind: 'agent', endpoint, agentId: 'main' }, target: { kind: 'agent', agentId: 'main' },
      input: { endpoint, agentId: 'main', endpointSessionId },
    });
    const body = record(reply.ok ? reply.data.json : undefined);
    const identity = record(body.identity);
    const actualEndpoint = record(identity.endpoint);
    const created = reply.ok && reply.data.status === 200 && reply.data.ok && body.sessionKey === sessionKey
      && typeof body.endpointSessionId === 'string' && body.endpointSessionId.length > 0
      && identity.sessionKey === sessionKey && identity.agentId === 'main'
      && actualEndpoint.kind === endpoint.kind && actualEndpoint.runtimeAdapterId === endpoint.runtimeAdapterId
      && actualEndpoint.runtimeInstanceId === endpoint.runtimeInstanceId;
    if (!created) throw new Error(`Public session create did not confirm ${sessionKey}: ${failureContext(reply)}`);
    this.identity = { endpoint, agentId: 'main', sessionKey };
    return { created, sessionKey };
  }

  async stageFixedPng(): Promise<boolean> {
    const staged = record(await this.electron.page.evaluate(async (base64) => {
      const bridge = (window as unknown as { electron: { ipcRenderer: PublicIpc } }).electron.ipcRenderer;
      return bridge.invoke('dialog:stageRendererBufferAttachment', { base64, fileName: 'fixed-profile.png', mimeType: 'image/png' });
    }, fixedPng));
    const valid = typeof staged.stagedAttachmentId === 'string' && staged.fileName === 'fixed-profile.png'
      && staged.mimeType === 'image/png' && typeof staged.fileSize === 'number';
    this.attachment = valid ? {
      stagedAttachmentId: staged.stagedAttachmentId as string, fileName: staged.fileName as string,
      mimeType: staged.mimeType as string, fileSize: staged.fileSize as number,
    } : undefined;
    return valid;
  }

  async sendTextBaseline() {
    const marker = `PUBLIC_TEXT_${randomUUID()}`;
    const message = `Do not use tools. Reply with only ${marker}.`;
    const reply = await this.send(message, 'baseline', false);
    return this.confirmCompleted(reply, message, marker, true);
  }

  async sendFixedPng() {
    const marker = `PUBLIC_PNG_${randomUUID()}`;
    const message = `Read the fixed PNG attachment. Do not use tools. Reply with only ${marker}.`;
    const reply = await this.send(message, 'run', true);
    const projected = JSON.stringify(reply);
    return {
      receipt: await this.confirmCompleted(reply, message, marker),
      custody: {
        stagingPath: projected.includes('attachment-staging'), mediaReference: projected.includes('media://'),
        fullPng: projected.includes(fixedPng), pngPrefix: projected.includes('iVBORw0KGgo'),
      },
    };
  }

  async replayFixedPng() {
    const reply = await this.send('This must not replay the attachment.', 'replay', true);
    const body = record(reply.ok ? reply.data.json : undefined);
    if (reply.ok && reply.data.status === 500 && reply.data.ok === false
      && Object.keys(body).length === 2 && body.success === false && body.error === 'Capability request failed') this.pendingRun = undefined;
    return {
      ok: reply.ok, status: reply.ok ? reply.data.status : null, httpOk: reply.ok ? reply.data.ok : false,
      successIsFalse: body.success === false, fixedPublicError: body.error === 'Capability request failed',
    };
  }

  private sameIdentity(value: unknown): boolean {
    const identity = record(value);
    const ref = record(identity.endpoint);
    return this.identity !== undefined && identity.sessionKey === this.identity.sessionKey && identity.agentId === this.identity.agentId
      && ref.kind === endpoint.kind && ref.runtimeAdapterId === endpoint.runtimeAdapterId && ref.runtimeInstanceId === endpoint.runtimeInstanceId;
  }

  private async readPublic(body: unknown, timeoutMs = 8_000): Promise<Record<string, unknown>> {
    const reply = await this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', body, timeoutMs });
    if (!reply.ok || !reply.data.ok || reply.data.status !== 200) throw new Error('Public attachment session reconciliation is unavailable; no mutation was retried');
    const projected = JSON.stringify(reply.data.json);
    if (/attachment-staging|iVBORw0KGgo|privateToken|rawPayload|nativeError|sessionStorage/.test(projected)) {
      throw new Error('Public attachment session reconciliation exposed private custody details');
    }
    return record(reply.data.json);
  }

  private async catalog(): Promise<Record<string, unknown>[]> {
    const body = await this.readPublic({ id: 'session.management', operationId: 'sessions.list',
      scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint } });
    if (!Array.isArray(body.sessions)) throw new Error('Public attachment session catalog is malformed');
    return body.sessions.map(record);
  }

  private async confirmCompleted(reply: FetchReply, message: string, marker: string, observeTextTimeout = false) {
    const receipt = record(reply.ok ? reply.data.json : undefined);
    const admitted = reply.ok && reply.data.ok && (reply.data.status === 202 && receipt.outcome === 'queued'
      || reply.data.status === 200 && receipt.outcome === 'succeeded' && ['started', 'in_flight', 'ok'].includes(String(receipt.status)));
    if (!admitted || typeof receipt.runId !== 'string' || !receipt.runId) {
      throw new Error(`Public session send did not confirm admission: ${failureContext(reply)}; no resend is allowed`);
    }
    const runId = receipt.runId;
    this.pendingRun = runId;
    const identity = this.identity!;
    const startedAt = Date.now();
    const deadline = startedAt + 30_000;
    // Temporary text-only diagnosis: observe at most 150s total; late completion never passes or releases custody. Remove after attribution.
    const observationDeadline = observeTextTimeout ? startedAt + 150_000 : deadline;
    let phase = 'unknown';
    let originalUserCount = 0;
    let sameRunAssistantFinalCount = 0;
    do {
      const remainingMs = observationDeadline - Date.now();
      if (remainingMs <= 0) break;
      const view = await this.readPublic({ id: 'session.management', operationId: 'sessions.load',
        scope: { kind: 'session', identity }, target: { kind: 'session', identity },
        input: { sessionKey: identity.sessionKey, sessionIdentity: identity, limit: 100 } }, Math.min(8_000, remainingMs));
      if (!this.sameIdentity(view.identity) || view.sessionKey !== identity.sessionKey) throw new Error('Public attachment readback crossed session identity');
      const items = record(view.items).complete ?? record(record(view.items).incomplete).facts;
      const runtime = record(record(view.runtime).complete ?? record(record(view.runtime).incomplete).facts);
      if (!Array.isArray(items)) throw new Error('Public attachment readback did not deliver real history facts');
      const facts = items.map(record);
      const turn = facts.find(item => item.kind === 'assistantTurn' && item.runId === runId);
      phase = typeof runtime.phase === 'string' && ['queued', 'started', 'waiting_for_approval', 'cancellation_requested', 'cancelled', 'completed', 'failed', 'interrupted'].includes(runtime.phase)
        ? runtime.phase : 'unknown';
      originalUserCount = facts.filter(item => item.kind === 'userMessage' && item.text === message).length;
      sameRunAssistantFinalCount = facts.filter(item => item.kind === 'assistantTurn' && item.runId === runId && item.status === 'final').length;
      if (turn && ['error', 'aborted'].includes(String(turn.status)) || runtime.phase === 'failed' || runtime.phase === 'cancelled') {
        this.pendingRun = undefined;
        throw new Error('The public attachment run failed or was cancelled; a send receipt is not successful execution');
      }
      if (runtime.phase === 'completed' && runtime.activeRunId === null && turn?.status === 'final'
        && typeof turn.text === 'string' && turn.text.trim() === marker && originalUserCount > 0) {
        if (Date.now() >= deadline) break;
        this.pendingRun = undefined;
        return { admitted: true, hasRunId: true, completed: true, persisted: true };
      }
      await delay(Math.min(250, Math.max(0, observationDeadline - Date.now())));
    } while (Date.now() < observationDeadline);
    if (observeTextTimeout) throw new Error(`Public text send missed the 30000ms exact persisted final and completed run deadline; elapsedMs=${Date.now() - startedAt}; phase=${phase}; originalUserCount=${originalUserCount}; sameRunAssistantFinalCount=${sameRunAssistantFinalCount}; no resend is allowed`);
    throw new Error('Public attachment send did not produce the exact persisted final answer and completed run; no resend is allowed');
  }

  async cleanup(): Promise<void> {
    if (this.pendingRun) throw new Error('Retain the owned attachment session and staged attachment while its native outcome is unresolved');
    if (this.attachment) {
      await this.electron.page.evaluate(async id => {
        const bridge = (window as unknown as { electron: { ipcRenderer: PublicIpc } }).electron.ipcRenderer;
        await bridge.invoke('dialog:releaseStagedAttachments', [id]);
      }, this.attachment.stagedAttachmentId);
      this.attachment = undefined;
    }
    if (!this.identity) return;
    if (this.deletionSubmitted) throw new Error('Owned attachment session deletion must not be replayed');
    this.deletionSubmitted = true;
    const identity = this.identity;
    const deleted = await this.readPublic({ id: 'session.management', operationId: 'sessions.delete',
      scope: { kind: 'session', identity }, target: { kind: 'session', identity }, input: { sessionIdentity: identity } });
    if (Object.keys(deleted).length !== 1 || deleted.outcome !== 'succeeded') throw new Error('Owned attachment session deletion was not confirmed');
    if ((await this.catalog()).some(entry => this.sameIdentity(entry.sessionIdentity))) throw new Error('Deleted attachment identity remains in the native public catalog');
    this.identity = undefined;
  }

  private send(message: string, run: 'baseline' | 'run' | 'replay', withAttachment: boolean): Promise<FetchReply> {
    if (!this.identity) throw new Error('Public session creation was not confirmed');
    if (this.pendingRun) throw new Error('A public attachment run is unsettled; no resend or concurrent send is allowed');
    if (withAttachment && !this.attachment) throw new Error('Fixed PNG staging was not confirmed');
    const runId = `e2e-attachment-${run}-${randomUUID()}`;
    this.pendingRun = runId;
    return this.execute({
      id: 'session.prompt', operationId: withAttachment ? 'sessions.sendWithMedia' : 'sessions.prompt',
      scope: { kind: 'session', identity: this.identity }, target: { kind: 'session', identity: this.identity },
      input: {
        sessionKey: this.identity.sessionKey, sessionIdentity: this.identity, message,
        runId, attachments: withAttachment ? [this.attachment!] : [],
      },
    });
  }

  private execute(body: CapabilityRequest): Promise<FetchReply> {
    return this.electron.page.evaluate(async (body) => {
      const bridge = (window as unknown as { electron: { ipcRenderer: PublicIpc } }).electron.ipcRenderer;
      return bridge.invoke('hostapi:fetch', {
        requestId: crypto.randomUUID(), path: '/api/capabilities/execute', method: 'POST', body, timeoutMs: 30_000,
      });
    }, body);
  }
}
