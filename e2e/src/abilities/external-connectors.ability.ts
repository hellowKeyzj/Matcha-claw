import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron, type PublicHostApiReply } from './use-electron.ability.js';

type Operation = 'upsert' | 'probe' | 'remove';
type Phase = 'reserved' | 'rejection-pending' | 'upsert-pending' | 'stored' | 'probe-pending' | 'probed' | 'remove-pending' | 'removed';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connector public response is not an object');
  return value as Record<string, unknown>;
}

function body(reply: PublicHostApiReply, status = 200): Record<string, unknown> {
  if (!reply.ok) throw new Error(`Connector public IPC failed: ${reply.error.code}`);
  if (reply.data.status !== status || reply.data.ok !== (status < 400)) {
    throw new Error(`Connector public API expected HTTP ${status}, received ${reply.data.status}`);
  }
  return object(reply.data.json);
}

export class ExternalConnectors extends Ability {
  readonly id = `e2e-connectors-${randomUUID()}`;
  readonly rejectedId = `${this.id}-rejected`;
  readonly name = `E2E HTTP ${this.id}`;
  private server?: Server;
  private phase: Phase = 'reserved';
  private revision = 0;
  private connections = 0;
  private baseUrl = '';
  private scope?: { kind: 'runtime-instance'; endpoint: { kind: 'native-runtime'; runtimeAdapterId: string; runtimeInstanceId: string } };

  constructor(private readonly electron: UseElectron) { super(); }

  async reserve() {
    // Opening this UI runs status(), which probes the entire catalog. Never open it over foreign entries.
    const catalog = body(await this.electron.fetchHostApi({ path: '/api/external-connectors', method: 'GET' }));
    if (!Array.isArray(catalog.connectors) || catalog.connectors.length !== 0) {
      throw new Error('Connector E2E requires an empty public catalog before opening the page; no existing connectors were probed or removed');
    }
    const server = createServer(socket => { this.connections += 1; socket.destroy(); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Connector E2E did not reserve its own loopback endpoint');
    this.baseUrl = `http://127.0.0.1:${address.port}/${this.id}`;
    return { id: this.id, rejectedId: this.rejectedId, name: this.name, baseUrl: this.baseUrl };
  }

  async rememberRuntime(displayName: string): Promise<void> {
    const directory = body(await this.electron.fetchHostApi({ path: '/api/runtime-endpoints/list', method: 'GET' }));
    if (!Array.isArray(directory.endpoints)) throw new Error('Connector runtime directory is invalid');
    const matches = directory.endpoints.map(object).filter(entry => entry.displayName === displayName);
    if (matches.length !== 1) throw new Error('Connector management selection must identify exactly one public endpoint');
    const selected = matches[0];
    const endpoint = object(selected.endpointRef);
    if (endpoint.kind !== 'native-runtime' || !['openclaw', 'matcha-agent'].includes(String(endpoint.runtimeAdapterId))
      || typeof endpoint.runtimeInstanceId !== 'string' || !endpoint.runtimeInstanceId
      || object(selected.lifecycle).ready !== true || object(object(selected.controlState).readiness).ready !== true) {
      throw new Error('Connectors requires a ready selected native management runtime; unavailability is not an empty catalog');
    }
    const scope = {
      kind: 'runtime-instance' as const,
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: String(endpoint.runtimeAdapterId), runtimeInstanceId: endpoint.runtimeInstanceId },
    };
    if (this.scope && JSON.stringify(this.scope) !== JSON.stringify(scope)) throw new Error('Connector management runtime changed during this case');
    if (!this.scope) this.scope = scope;
  }

  async runtimeToRestore(): Promise<string> {
    if (!this.scope) throw new Error('Connector management runtime was not recorded before reload');
    // Re-entering the page probes the catalog; validate ownership before mounting it again.
    if (!await this.needsCleanup()) throw new Error('Connector reload requires the confirmed owned connector');
    const directory = body(await this.electron.fetchHostApi({ path: '/api/runtime-endpoints/list', method: 'GET' }));
    if (!Array.isArray(directory.endpoints)) throw new Error('Connector runtime directory is invalid');
    const endpoints = directory.endpoints.map(object);
    const original = this.scope.endpoint;
    const matches = endpoints.filter(entry => {
      const endpoint = object(entry.endpointRef);
      return endpoint.kind === original.kind && endpoint.runtimeAdapterId === original.runtimeAdapterId
        && endpoint.runtimeInstanceId === original.runtimeInstanceId;
    });
    if (matches.length !== 1) throw new Error('Original connector management endpoint is no longer unique; no replacement runtime selected');
    const selected = matches[0];
    if (object(selected.lifecycle).ready !== true || object(object(selected.controlState).readiness).ready !== true) {
      throw new Error('Original connector management runtime is not ready; no replacement runtime selected');
    }
    if (typeof selected.displayName !== 'string' || !selected.displayName
      || endpoints.filter(entry => entry.displayName === selected.displayName).length !== 1) {
      throw new Error('Original connector management endpoint has no unique public UI name');
    }
    return selected.displayName;
  }

  arm(operation: Operation | 'rejection'): void {
    const expected = operation === 'probe' ? ['stored'] : operation === 'remove' ? ['stored', 'probed'] : ['reserved'];
    if (!expected.includes(this.phase)) throw new Error(`Connector ${this.id} cannot submit ${operation} from ${this.phase}`);
    this.phase = `${operation}-pending`;
  }

  async confirmRejectedAbsent(): Promise<boolean> {
    const missing = body(await this.electron.fetchHostApi({
      path: '/api/external-connectors/get', method: 'POST', body: { connectorId: this.rejectedId },
    }), 404);
    if (missing.success !== false || missing.error !== 'External connector is unknown') throw new Error('Rejected connector absence was not confirmed');
    this.phase = 'reserved';
    return true;
  }

  private async ownedFact(): Promise<Record<string, unknown>> {
    const fact = object(body(await this.electron.fetchHostApi({
      path: '/api/external-connectors/get', method: 'POST', body: { connectorId: this.id },
    })).connector);
    const allowed = ['id', 'kind', 'displayName', 'enabled', 'baseUrl'];
    if (fact.id !== this.id || fact.kind !== 'http' || fact.displayName !== this.name || fact.enabled !== true
      || fact.baseUrl !== this.baseUrl || !Object.keys(fact).every(key => allowed.includes(key))) {
      throw new Error(`Owned connector ${this.id} does not match the exact secret-free HTTP resource; no removal attempted`);
    }
    return fact;
  }

  private async terminal(operation: Operation): Promise<{ callId: string; detail: Record<string, unknown> }> {
    const deadline = Date.now() + 30_000;
    let callId: string | undefined;
    while (Date.now() < deadline) {
      if (!callId) {
        const catalog = body(await this.electron.fetchHostApi({
          path: '/api/calls/list', method: 'POST', body: { module: 'connectors', limit: 50 },
        }));
        if (!Array.isArray(catalog.items)) throw new Error('Connector call catalog is invalid');
        const matches = catalog.items.map(object).filter(call => call.command === `externalConnectors.${operation}`
          && object(call.detail).connectorId === this.id);
        if (matches.length > 1) throw new Error(`Connector ${this.id} has duplicate ${operation} calls; do not retry or clean up`);
        if (matches.length === 1) {
          const candidate = matches[0].callId;
          if (typeof candidate !== 'string' || !/^[a-f0-9]{32}$/.test(candidate)) throw new Error('Connector call ID is invalid');
          callId = candidate;
        }
      }
      if (callId) {
        const call = body(await this.electron.fetchHostApi({ path: '/api/calls/get', method: 'POST', body: { callId } }));
        const detail = object(call.detail);
        if (call.callId !== callId || call.module !== 'connectors' || call.command !== `externalConnectors.${operation}`
          || detail.connectorId !== this.id) throw new Error('Connector call identity is invalid');
        if (['succeeded', 'failed', 'rejected', 'unknown'].includes(String(call.status))) {
          if (call.status !== 'succeeded') throw new Error(`Connector ${this.id} ${operation} ended ${String(call.status)} (${callId}); no retry or automatic cleanup`);
          return { callId, detail };
        }
        if (!['received', 'accepted', 'running', 'waiting'].includes(String(call.status))) throw new Error('Connector call status is invalid');
      }
      await delay(200);
    }
    throw new Error(`Connector ${this.id} ${operation} outcome is unresolved${callId ? ` (${callId})` : ''}; do not retry or clean up`);
  }

  async confirmStored() {
    const { detail } = await this.terminal('upsert');
    if (detail.result !== 'stored' || detail.created !== true || detail.projection !== 'written'
      || typeof detail.revision !== 'number' || !Number.isSafeInteger(detail.revision) || detail.revision <= 0
      || detail.appliedRevision !== detail.revision || detail.tombstoned !== false) {
      throw new Error(`Connector ${this.id} store/projection is unconfirmed; no retry or automatic cleanup`);
    }
    await this.ownedFact();
    this.revision = detail.revision;
    this.phase = 'stored';
    return { result: 'stored', created: true, projection: 'written', revisionApplied: true, exactPublicFact: true };
  }

  async confirmProbed() {
    const { callId, detail } = await this.terminal('probe');
    if (!this.scope || detail.result !== 'available' || detail.summariesTruncated !== false
      || !Array.isArray(detail.observations) || detail.observations.length !== 1) {
      throw new Error(`Connector ${this.id} probe result is unconfirmed; no retry or automatic cleanup`);
    }
    const summary = object(detail.observations[0]);
    const result = body(await this.electron.fetchHostApi({
      path: '/api/external-connectors/observation-result', method: 'POST', body: { callId, scope: this.scope },
    }));
    const observation = object(result.status);
    if (Object.keys(result).sort().join(',') !== 'callId,kind,status' || result.callId !== callId || result.kind !== 'probe'
      || !Object.keys(observation).every(key => ['connectorId', 'resultType', 'latencyMs', 'reason', 'safeProbe'].includes(key))
      || summary.connectorId !== this.id || summary.resultType !== 'unsupported'
      || observation.connectorId !== this.id || observation.resultType !== 'unsupported' || observation.safeProbe !== false
      || (observation.reason !== undefined && (typeof observation.reason !== 'string' || !observation.reason.trim()))
      || (observation.latencyMs !== undefined && (typeof observation.latencyMs !== 'number' || !Number.isFinite(observation.latencyMs) || observation.latencyMs < 0))
      || this.connections !== 0) {
      throw new Error(`Connector ${this.id} same-call HTTP observation violated the source-backed no-network/unsupported contract`);
    }
    this.phase = 'probed';
    return { result: 'available', observation: 'unsupported', localConnections: this.connections, sameCallObservation: true };
  }

  async needsCleanup(): Promise<boolean> {
    if (this.phase === 'reserved' || this.phase === 'removed') return false;
    if (this.phase !== 'stored' && this.phase !== 'probed') {
      throw new Error(`Connector ${this.id} remains ${this.phase}; no retry or automatic cleanup, inspect the public call before recovery`);
    }
    await this.ownedFact();
    const catalog = body(await this.electron.fetchHostApi({ path: '/api/external-connectors', method: 'GET' }));
    if (!Array.isArray(catalog.connectors) || catalog.connectors.length !== 1 || object(catalog.connectors[0]).id !== this.id) {
      throw new Error('Connector catalog changed outside this scenario; no mutation or cleanup attempted');
    }
    return true;
  }

  async confirmRemoved() {
    const { detail } = await this.terminal('remove');
    if (detail.result !== 'removed' || detail.projection !== 'written' || detail.tombstoned !== true
      || typeof detail.revision !== 'number' || !Number.isSafeInteger(detail.revision) || detail.revision <= this.revision
      || detail.appliedRevision !== detail.revision) {
      throw new Error(`Connector ${this.id} removal is unconfirmed; do not retry cleanup`);
    }
    const missing = body(await this.electron.fetchHostApi({
      path: '/api/external-connectors/get', method: 'POST', body: { connectorId: this.id },
    }), 404);
    if (missing.success !== false || missing.error !== 'External connector is unknown') throw new Error('Removed connector absence was not confirmed');
    this.phase = 'removed';
    return { result: 'removed', projection: 'written', tombstoned: true, revisionAdvanced: true, absent: true };
  }

  async release(): Promise<void> {
    const server = this.server;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    this.server = undefined;
  }
}
