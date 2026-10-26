import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron, type PublicHostApiReply } from './use-electron.ability.js';

const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
type Identity = { endpoint: typeof endpoint; agentId: 'main'; sessionKey: string };
type RunTerminal = { runId: string; phase: string; epoch: number; seq: number; cursor: number };
type RunObservation = { owner: string; terminal?: RunTerminal; error?: string; dispose: () => void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseBody(reply: PublicHostApiReply, status = 200): Record<string, unknown> {
  if (!reply.ok) throw new Error(`Session lifecycle IPC failed (${reply.error.code}); no mutation will be replayed`);
  if (reply.data.status !== status || !reply.data.ok || !isRecord(reply.data.json)) {
    throw new Error(`Session lifecycle expected HTTP ${status}, received ${reply.data.status}; no mutation will be replayed`);
  }
  return reply.data.json;
}

function knownFacts(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, 'complete')) return value.complete;
  return isRecord(value.incomplete) ? value.incomplete.facts : undefined;
}

export class SessionLifecycle extends Ability {
  private readonly observationOwner = randomUUID();
  private observationActive = false;
  private readonly endpointSessionId = `e2e-session-lifecycle-${randomUUID()}`;
  private readonly identity: Identity = { endpoint, agentId: 'main', sessionKey: `agent:main:${this.endpointSessionId}` };
  private creationSubmitted = false;
  private creationConfirmed = false;
  private deletionSubmitted = false;
  private deleted = false;
  private pendingRun?: { message: string; previousRunIds: string[]; acceptedId?: string; abortSubmitted: boolean };
  private completedRunId?: string;
  readonly title = `OpenClaw ${randomUUID()}`;
  readonly cancellationPrompt = `Write a detailed, long-form analysis of cooperative cancellation in distributed systems. Reference ${randomUUID()} and continue for at least 5000 words.`;
  readonly marker = `OPENCLAW_LIFECYCLE_OK_${randomUUID()}`;
  readonly prompt = `Do not use tools. Reply with only the exact phrase ${this.marker}.`;

  constructor(private readonly electron: UseElectron) { super(); }

  async create() {
    if (this.creationSubmitted) throw new Error('Lifecycle session creation must be submitted only once');
    if (await this.isInCatalog()) throw new Error('Reserved lifecycle identity already exists; it must not be touched');
    this.creationSubmitted = true;
    const view = responseBody(await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST', timeoutMs: 8_000,
      body: {
        id: 'session.prompt', operationId: 'sessions.create',
        scope: { kind: 'agent', endpoint, agentId: 'main' }, target: { kind: 'agent', agentId: 'main' },
        input: { endpoint, agentId: 'main', endpointSessionId: this.endpointSessionId },
      },
    }));
    this.assertOwnView(view);
    this.creationConfirmed = true;
    const identityKey = JSON.stringify({
      type: 'session-identity', endpoint: { type: 'runtime-endpoint', ...endpoint },
      agentId: 'main', sessionKey: this.identity.sessionKey,
    });
    return {
      title: this.title, marker: this.marker, prompt: this.prompt, cancellationPrompt: this.cancellationPrompt,
      selector: `[data-testid=${JSON.stringify(`session-avatar-${identityKey}`)}]`,
    };
  }

  async confirmRename(): Promise<void> {
    this.requireCreated();
    await this.waitForRead('the UI rename to persist for the exact public identity', 8_000, async () => {
      const session = await this.catalogEntry();
      return session?.label === this.title;
    });
  }

  async prepareTurn(cancellation = false): Promise<void> {
    this.requireCreated();
    if (this.pendingRun) throw new Error('A lifecycle run is already pending; automatic resend is forbidden');
    const models = responseBody(await this.electron.fetchHostApi({
      path: '/api/provider-models/selectable?capability=chat', method: 'GET', timeoutMs: 5_000,
    }));
    if (!Array.isArray(models.models) || models.models.length === 0) {
      throw new Error('Real precondition missing: dedicated licensed Profile has no existing selectable chat model; no key, model or plugin will be changed');
    }
    const view = await this.load();
    const items = knownFacts(view.items);
    const runtime = knownFacts(view.runtime);
    if (!Array.isArray(items) || !isRecord(runtime) || runtime.activeRunId !== null) {
      throw new Error('The owned session must have readable history and no active run before a single UI send');
    }
    const previousRunIds = items.filter(isRecord).map(item => item.runId).filter((id): id is string => typeof id === 'string');
    await this.observeRun(view, previousRunIds);
    this.pendingRun = { message: cancellation ? this.cancellationPrompt : this.prompt, previousRunIds, abortSubmitted: false };
  }

  async completeTurn(): Promise<boolean> {
    const runId = await this.bindUiRun();
    await this.waitForCompletedTurn(runId, 30_000);
    await this.disposeObservation();
    this.completedRunId = runId;
    this.pendingRun = undefined;
    return true;
  }

  async confirmPersistedTurn(): Promise<boolean> {
    if (!this.completedRunId) throw new Error('A completed native turn must precede reload verification');
    await this.waitForCompletedTurn(this.completedRunId, 8_000);
    return true;
  }

  async prepareAbort(): Promise<void> {
    const runId = await this.bindUiRun();
    await this.waitForRead('the exact second run to become active before the UI Stop action', 8_000, async () => {
      const view = await this.load();
      const runtime = knownFacts(view.runtime);
      const items = knownFacts(view.items);
      if (!isRecord(runtime)) return false;
      if (Array.isArray(items) && items.some(item => isRecord(item) && item.kind === 'assistantTurn'
        && item.runId === runId && ['final', 'error', 'aborted'].includes(String(item.status)))) {
        throw new Error('The cancellation target became terminal before Stop; no second prompt will be submitted');
      }
      return runtime.activeRunId === runId && (runtime.phase === 'started' || runtime.phase === 'waiting_for_approval');
    });
    this.pendingRun!.abortSubmitted = true;
  }

  async abortTurn(): Promise<boolean> {
    const runId = this.pendingRun?.acceptedId;
    if (!runId || !this.pendingRun?.abortSubmitted) throw new Error('UI Stop requires the confirmed active owned run');
    await this.waitForRead('the exact public cancelled run event and a covering inactive view after UI Stop', 10_000,
      () => this.hasSettledRun(runId, true));
    await this.disposeObservation();
    this.pendingRun = undefined;
    return true;
  }

  prepareDeletion(): void {
    this.requireCreated();
    if (this.pendingRun || this.deletionSubmitted) throw new Error('UI deletion requires a settled owned session and must not be replayed');
    this.deletionSubmitted = true;
  }

  async confirmDeletion(): Promise<boolean> {
    if (!this.deletionSubmitted) throw new Error('The UI deletion must be submitted before reconciliation');
    await this.waitForRead('the exact UI-deleted identity to leave the public catalog', 8_000, async () => !await this.isInCatalog());
    this.deleted = true;
    return true;
  }

  async delete(): Promise<boolean> {
    this.requireCreated();
    if (this.pendingRun) throw new Error('An unsettled lifecycle run must be stopped before deletion');
    if (this.deletionSubmitted) throw new Error('Lifecycle deletion must not be replayed');
    this.deletionSubmitted = true;
    this.requireSucceeded(await this.execute('session.management', 'sessions.delete'));
    await this.waitForRead('the exact deleted identity to leave the public catalog', 8_000, async () => !await this.isInCatalog());
    this.deleted = true;
    return true;
  }

  async cleanup(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.cleanupSession(); } catch (error) { failures.push(error); }
    try { await this.disposeObservation(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Lifecycle session cleanup and observation release failed');
  }

  private async cleanupSession(): Promise<void> {
    if (!this.creationSubmitted || this.deleted) return;
    if (!await this.isInCatalog()) {
      if (!this.creationConfirmed && !this.deletionSubmitted) {
        throw new Error(`Create outcome is unresolved; only reserved identity ${this.identity.sessionKey} may be reconciled, never recreated`);
      }
      return;
    }
    if (this.deletionSubmitted) {
      throw new Error(`Deletion is unresolved for ${this.identity.sessionKey}; automatic mutation replay is forbidden`);
    }
    if (this.pendingRun) {
      const view = await this.load();
      const runId = this.pendingRun.acceptedId ?? this.runFromView(view);
      if (!runId) {
        throw new Error(`Run ownership is unresolved for ${this.identity.sessionKey}; retain the session without abort, deletion or resend`);
      }
      if (!await this.hasSettledRun(runId)) {
        const runtime = knownFacts(view.runtime);
        if (!isRecord(runtime) || runtime.activeRunId !== null && runtime.activeRunId !== runId) {
          throw new Error('Cleanup cannot confirm the owned active run; retain the session without cancellation or deletion');
        }
        if (runtime.activeRunId === runId && !this.pendingRun.abortSubmitted) {
          this.pendingRun.abortSubmitted = true;
          this.requireSucceeded(await this.execute('session.abort', 'sessions.abort', { runId }));
        }
        await this.waitForRead('the exact public owned run terminal and a covering inactive view during cleanup', 8_000,
          () => this.hasSettledRun(runId));
      }
      this.pendingRun = undefined;
    }
    // The exact UUID identity was absent before this test's single create request.
    this.creationConfirmed = true;
    await this.delete();
  }

  private async observeRun(view: Record<string, unknown>, previousRunIds: string[]): Promise<void> {
    if (this.observationActive) throw new Error('Lifecycle run observation is already owned');
    if (typeof view.epoch !== 'number' || !Number.isSafeInteger(view.epoch) || view.epoch < 0
      || typeof view.seq !== 'number' || !Number.isSafeInteger(view.seq) || view.seq < 0
      || typeof view.cursor !== 'number' || !Number.isSafeInteger(view.cursor) || view.cursor < 0) {
      throw new Error('Lifecycle run observation requires a complete public baseline watermark');
    }
    const baseline = { epoch: view.epoch, seq: view.seq, cursor: view.cursor };
    await this.electron.page.evaluate(({ identity, baseline, previousRunIds, owner }) => {
      const host = window as unknown as {
        __lifecycleRunObservation?: RunObservation;
        electron: { ipcRenderer: {
          on(channel: string, listener: (value: unknown) => void): (() => void) | void;
          off(channel: string, listener: (value: unknown) => void): void;
        } };
      };
      if (host.__lifecycleRunObservation) throw new Error('Lifecycle run observation is already installed');
      const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      const state: RunObservation = { owner, dispose: () => undefined };
      const listener = (value: unknown) => {
        if (!record(value) || !['session.delta', 'session.resync'].includes(String(value.eventName)) || !record(value.payload)) return;
        const event = value.payload;
        if (!record(event.identity) || !record(event.identity.endpoint)) return;
        const actual = event.identity;
        const actualEndpoint = actual.endpoint;
        if (!record(actualEndpoint) || actual.sessionKey !== identity.sessionKey || actual.agentId !== identity.agentId
          || actualEndpoint.kind !== identity.endpoint.kind || actualEndpoint.runtimeAdapterId !== identity.endpoint.runtimeAdapterId
          || actualEndpoint.runtimeInstanceId !== identity.endpoint.runtimeInstanceId) return;
        if (event.epoch !== baseline.epoch) {
          state.error = 'Lifecycle run observation changed epoch; retain the session';
          return;
        }
        if (value.eventName === 'session.resync') return;
        if (event.sessionKey !== identity.sessionKey || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq)
          || typeof event.cursor !== 'number' || !Number.isSafeInteger(event.cursor) || !Array.isArray(event.changes)) {
          state.error = 'Lifecycle run observation received a malformed public delta';
          return;
        }
        if (event.seq <= baseline.seq || event.cursor <= baseline.cursor) return;
        for (const change of event.changes) {
          if (!record(change)) continue;
          if (change.kind === 'recoveryRequired') state.error = 'Lifecycle run observation requires recovery; retain the session';
          if (change.kind !== 'runPhaseChanged' || typeof change.runId !== 'string' || previousRunIds.includes(change.runId)
            || !['completed', 'failed', 'cancelled', 'interrupted'].includes(String(change.phase))) continue;
          if (state.terminal && state.terminal.runId !== change.runId) {
            state.error = 'Lifecycle run observation found ambiguous new run terminals; retain the session';
            continue;
          }
          state.terminal = { runId: change.runId, phase: String(change.phase), epoch: baseline.epoch, seq: event.seq, cursor: event.cursor };
        }
      };
      const ipc = host.electron.ipcRenderer;
      const unsubscribe = ipc.on('host:event', listener);
      state.dispose = typeof unsubscribe === 'function' ? unsubscribe : () => ipc.off('host:event', listener);
      host.__lifecycleRunObservation = state;
    }, { identity: this.identity, baseline, previousRunIds, owner: this.observationOwner });
    this.observationActive = true;
  }

  private async hasSettledRun(runId: string, cancellation = false): Promise<boolean> {
    const view = await this.load();
    const observation = await this.electron.page.evaluate(owner => {
      const state = (window as unknown as { __lifecycleRunObservation?: RunObservation }).__lifecycleRunObservation;
      if (state?.owner !== owner) throw new Error('Lifecycle run observation ownership was lost; retain the session');
      return { terminal: state.terminal, error: state.error };
    }, this.observationOwner);
    if (observation.error) throw new Error(observation.error);
    const terminal = observation.terminal;
    if (!terminal || terminal.runId !== runId || !['completed', 'failed', 'cancelled'].includes(terminal.phase)) return false;
    if (cancellation && terminal.phase !== 'cancelled') throw new Error('The exact native run completed or failed instead of being cancelled by UI Stop');
    const runtime = knownFacts(view.runtime);
    const items = knownFacts(view.items);
    return view.epoch === terminal.epoch && typeof view.seq === 'number' && view.seq >= terminal.seq
      && typeof view.cursor === 'number' && view.cursor >= terminal.cursor
      && isRecord(runtime) && runtime.activeRunId === null && ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(runtime.phase))
      && (!cancellation || ['cancelled', 'interrupted'].includes(String(runtime.phase)) && runtime.issue === null && runtime.errorDetail === null)
      && Array.isArray(items) && items.some(item => isRecord(item) && item.kind === 'userMessage' && item.text === this.pendingRun?.message)
      && items.filter(item => isRecord(item) && item.kind === 'assistantTurn' && item.runId === runId)
        .every(item => isRecord(item) && (cancellation ? ['final', 'aborted'] : ['final', 'error', 'aborted']).includes(String(item.status)));
  }

  private async disposeObservation(): Promise<void> {
    if (!this.observationActive) return;
    await this.electron.page.evaluate(owner => {
      const host = window as unknown as { __lifecycleRunObservation?: RunObservation };
      if (host.__lifecycleRunObservation?.owner !== owner) throw new Error('Lifecycle cannot release another run observer');
      host.__lifecycleRunObservation.dispose();
      delete host.__lifecycleRunObservation;
    }, this.observationOwner);
    this.observationActive = false;
  }

  private runFromView(view: Record<string, unknown>): string | undefined {
    const pending = this.pendingRun;
    const items = knownFacts(view.items);
    const runtime = knownFacts(view.runtime);
    if (!pending || !Array.isArray(items) || !isRecord(runtime)
      || items.filter(item => isRecord(item) && item.kind === 'userMessage' && item.text === pending.message).length !== 1) return;
    const candidates = new Set(items.filter(isRecord).filter(item => item.kind === 'assistantTurn')
      .map(item => item.runId).filter((id): id is string => typeof id === 'string' && !pending.previousRunIds.includes(id)));
    if (typeof runtime.activeRunId === 'string' && !pending.previousRunIds.includes(runtime.activeRunId)) candidates.add(runtime.activeRunId);
    if (candidates.size > 1) throw new Error('UI send produced ambiguous native runs; no cancellation, deletion or resend is safe');
    return [...candidates][0];
  }

  private async bindUiRun(): Promise<string> {
    if (!this.pendingRun) throw new Error('The single UI send must be prepared before native reconciliation');
    await this.waitForRead('one new native run for the exact UI-sent prompt and complete session identity', 8_000, async () => {
      const runId = this.runFromView(await this.load());
      if (!runId) return false;
      this.pendingRun!.acceptedId = runId;
      return true;
    });
    return this.pendingRun.acceptedId!;
  }

  private async waitForCompletedTurn(runId: string, timeoutMs: number): Promise<void> {
    await this.waitForRead('a persisted final assistant answer and completed native run, not a delivery receipt', timeoutMs, async () => {
      const view = await this.load();
      const items = knownFacts(view.items);
      const runtime = knownFacts(view.runtime);
      if (!Array.isArray(items) || !isRecord(runtime)) return false;
      const turn = items.find(item => isRecord(item) && item.kind === 'assistantTurn' && item.runId === runId);
      if (runtime.phase === 'failed' || isRecord(turn) && (turn.status === 'error' || turn.status === 'aborted')) {
        throw new Error('The native lifecycle run failed or aborted; existing model authorization must be checked without reading keys or resending');
      }
      return runtime.phase === 'completed' && runtime.activeRunId === null
        && items.some(item => isRecord(item) && item.kind === 'userMessage' && item.text === this.prompt)
        && isRecord(turn) && turn.status === 'final' && typeof turn.text === 'string' && turn.text.trim() === this.marker;
    });
  }

  private async load(): Promise<Record<string, unknown>> {
    const view = await this.execute('session.management', 'sessions.load', { limit: 100 });
    this.assertOwnView(view);
    return view;
  }

  private async catalogEntry(): Promise<Record<string, unknown> | undefined> {
    const body = responseBody(await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST', timeoutMs: 5_000,
      body: { id: 'session.management', operationId: 'sessions.list',
        scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint } },
    }));
    if (!Array.isArray(body.sessions)) throw new Error('Public session catalog is unavailable or malformed');
    return body.sessions.find((session): session is Record<string, unknown> => isRecord(session) && this.isOwnIdentity(session.sessionIdentity));
  }

  private async isInCatalog(): Promise<boolean> { return await this.catalogEntry() !== undefined; }

  private isOwnIdentity(identity: unknown): boolean {
    return isRecord(identity) && identity.agentId === 'main' && identity.sessionKey === this.identity.sessionKey
      && isRecord(identity.endpoint) && identity.endpoint.kind === endpoint.kind
      && identity.endpoint.runtimeAdapterId === endpoint.runtimeAdapterId && identity.endpoint.runtimeInstanceId === endpoint.runtimeInstanceId;
  }

  private assertOwnView(view: Record<string, unknown>): void {
    if (view.sessionKey !== this.identity.sessionKey || !this.isOwnIdentity(view.identity)) {
      throw new Error('Public SessionView did not confirm the reserved lifecycle identity');
    }
  }

  private requireCreated(): void {
    if (!this.creationConfirmed || this.deleted) throw new Error('Only this test\'s confirmed live session may be mutated');
  }

  private requireSucceeded(body: Record<string, unknown>): void {
    if (body.outcome !== 'succeeded') throw new Error('Lifecycle mutation was rejected, unavailable or unknown; no mutation replay');
  }

  private sessionRequest(id: string, operationId: string, input: Record<string, unknown>) {
    return { id, operationId, scope: { kind: 'session', identity: this.identity }, target: { kind: 'session', identity: this.identity },
      input: { sessionKey: this.identity.sessionKey, sessionIdentity: this.identity, ...input } };
  }

  private async execute(id: string, operationId: string, input: Record<string, unknown> = {}) {
    return responseBody(await this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', timeoutMs: 8_000,
      body: this.sessionRequest(id, operationId, input) }));
  }

  private async waitForRead(description: string, timeoutMs: number, read: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await read()) return;
      await delay(250);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}; session=${this.identity.sessionKey}; no mutation was retried`);
  }
}
