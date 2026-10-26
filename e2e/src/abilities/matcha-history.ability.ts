import { Ability } from '@serenity-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron } from './use-electron.ability.js';
import type { PublicHostApiReply } from './use-electron.ability.js';

const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'matcha-agent', runtimeInstanceId: 'local' } as const;
type Identity = { endpoint: typeof endpoint; agentId: string; sessionKey: string };
type Observation = {
  owner: string;
  terminals: { identity: Identity; runId: string; phase: string }[];
  overflow: boolean;
  dispose: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPublic(value: unknown): void {
  const privateKey = /^(?:sourcePath|sourceDir|configDir|workspaceDir|skillsDir|configPath|sessionDir|token|secret|credentials?|apiKey|accessToken|refreshToken|password|stderr|stdout)$/i;
  const privateText = /(?:[A-Za-z]:[\\/]|\.matcha-agent-app-server|\b(?:token|secret|credentials?|sourcePath|sourceDir|configDir|workspaceDir|skillsDir|configPath|sessionDir|stderr|stdout)\b)/i;
  if (typeof value === 'string' && privateText.test(value)) throw new Error('Matcha public history exposed private text');
  if (Array.isArray(value)) value.forEach(assertPublic);
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (privateKey.test(key)) throw new Error('Matcha public history exposed a private field');
      assertPublic(child);
    }
  }
}

function publicObject(reply: PublicHostApiReply, operation: string, expectedStatus = 200): Record<string, unknown> {
  if (!reply.ok) throw new Error(`${operation}: retained Host API IPC failed`);
  if (!reply.data.ok || reply.data.status !== expectedStatus) throw new Error(`${operation}: public HTTP ${reply.data.status}`);
  if (!isRecord(reply.data.json)) throw new Error(`${operation}: expected a public JSON object`);
  assertPublic(reply.data.json);
  return reply.data.json;
}

function sameIdentity(value: unknown, expected: Identity): boolean {
  return isRecord(value) && value.sessionKey === expected.sessionKey && value.agentId === expected.agentId
    && isRecord(value.endpoint) && value.endpoint.kind === endpoint.kind
    && value.endpoint.runtimeAdapterId === endpoint.runtimeAdapterId
    && value.endpoint.runtimeInstanceId === endpoint.runtimeInstanceId;
}

export class UseMatchaHistory extends Ability {
  private readonly owner = randomUUID();
  private nativeSessionId = '';
  private agentId: string | undefined;
  private baseline: Identity[] = [];
  private readonly marker = `MATCHA_PUBLIC_HISTORY_${randomUUID().replaceAll('-', '')}`;
  private readonly prompt = `Reply with exactly ${this.marker} and no other text.`;
  private identity: Identity | undefined;
  private runId: string | undefined;
  private assistantText: string | undefined;
  private turnMayBeRunning = false;
  private restartOutcomeUnknown = false;
  private canonicalItems: string | undefined;
  private observationActive = false;
  private deletionSubmitted = false;

  constructor(private readonly electron: UseElectron) { super(); }

  async prepare() {
    if (this.agentId) throw new Error('Matcha history preparation must not be replayed');
    const status = publicObject(await this.electron.fetchHostApi({
      path: '/api/matcha-agent/app-server/status', method: 'GET', timeoutMs: 10_000,
    }), 'Matcha app-server readiness');
    if (status.ready !== true || status.processState !== 'running') {
      throw new Error('Matcha history requires the existing native app-server to be running; no restart or guard bypass is permitted');
    }
    const directory = publicObject(await this.electron.fetchHostApi({
      path: '/api/runtime-endpoints/list', method: 'GET', timeoutMs: 5_000,
    }), 'Matcha public Agent directory');
    const runtime = Array.isArray(directory.endpoints) ? directory.endpoints.filter(isRecord).find(entry => {
      const ref = entry.endpointRef;
      return isRecord(ref) && ref.kind === endpoint.kind && ref.runtimeAdapterId === endpoint.runtimeAdapterId
        && ref.runtimeInstanceId === endpoint.runtimeInstanceId;
    }) : undefined;
    const agentId = runtime?.defaultAgentId;
    if (typeof agentId !== 'string' || !agentId || !Array.isArray(runtime?.agentIds) || !runtime.agentIds.includes(agentId)) {
      throw new Error('Matcha history requires the real default Agent from the ready public runtime directory');
    }
    this.agentId = agentId;
    return {
      ready: true, prompt: this.prompt, marker: this.marker,
      agentSelector: `[data-testid=${JSON.stringify(`agent-new-session-${agentId}`)}]`,
    };
  }

  async createSession() {
    if (!this.agentId || this.nativeSessionId || this.identity) throw new Error('Public Matcha creation requires preparation and cannot be replayed');
    this.nativeSessionId = randomUUID();
    const agentId = this.agentId;
    const expected: Identity = { endpoint, agentId, sessionKey: `matcha-agent:${agentId}:${this.nativeSessionId}` };
    if ((await this.catalog()).some(entry => sameIdentity(entry.sessionIdentity, expected))) {
      throw new Error('Reserved Matcha history identity already exists; it must not be touched');
    }
    const view = publicObject(await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST', timeoutMs: 15_000,
      body: {
        id: 'session.prompt', operationId: 'sessions.create',
        scope: { kind: 'agent', endpoint, agentId }, target: { kind: 'agent', agentId },
        input: { endpoint, agentId, endpointSessionId: this.nativeSessionId },
      },
    }), 'Matcha session creation');
    if (!sameIdentity(view.identity, expected) || view.sessionKey !== expected.sessionKey
      || view.endpointSessionId !== this.nativeSessionId) {
      throw new Error('Matcha session creation did not return the exact new public SessionView identity');
    }
    this.identity = expected;
    return this.sessionEvidence();
  }

  private sessionEvidence() {
    const identity = this.requireIdentity();
    const identityKey = JSON.stringify({
      type: 'session-identity', endpoint: { type: 'runtime-endpoint', ...endpoint },
      agentId: identity.agentId, sessionKey: identity.sessionKey,
    });
    return {
      created: true, sessionKey: identity.sessionKey,
      selector: `[data-testid=${JSON.stringify(`session-avatar-${identityKey}`)}]`,
    };
  }

  private requireIdentity(): Identity {
    if (!this.identity) throw new Error('Matcha history requires its own confirmed public session');
    return this.identity;
  }

  private async observeTerminal(): Promise<void> {
    await this.electron.page.evaluate(({ endpoint, agentId, baseline, owner }) => {
      const host = window as unknown as {
        __matchaHistoryObservation?: Observation;
        electron: { ipcRenderer: {
          on(channel: string, listener: (value: unknown) => void): (() => void) | void;
          off(channel: string, listener: (value: unknown) => void): void;
        } };
      };
      if (host.__matchaHistoryObservation) throw new Error('Matcha history observation is already owned');
      const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
      const state: Observation = { owner, terminals: [], overflow: false, dispose: () => undefined };
      const listener = (value: unknown) => {
        if (!record(value) || value.eventName !== 'session.delta' || !record(value.payload)) return;
        const delta = value.payload;
        if (!record(delta.identity) || !record(delta.identity.endpoint)) return;
        const actual = delta.identity;
        const actualEndpoint = actual.endpoint;
        if (!record(actualEndpoint) || typeof actual.sessionKey !== 'string' || actual.agentId !== agentId
          || actualEndpoint.kind !== endpoint.kind || actualEndpoint.runtimeAdapterId !== endpoint.runtimeAdapterId
          || actualEndpoint.runtimeInstanceId !== endpoint.runtimeInstanceId || !Array.isArray(delta.changes)
          || baseline.some(identity => identity.sessionKey === actual.sessionKey && identity.agentId === actual.agentId)) return;
        const identity: Identity = { endpoint, agentId, sessionKey: actual.sessionKey };
        for (const change of delta.changes) {
          if (!record(change) || change.kind !== 'runPhaseChanged' || typeof change.runId !== 'string'
            || typeof change.phase !== 'string' || !['completed', 'failed', 'cancelled', 'interrupted'].includes(change.phase)) continue;
          const runId = change.runId;
          const previous = state.terminals.find(item => item.runId === runId && item.identity.sessionKey === identity.sessionKey);
          if (previous) previous.phase = change.phase;
          else if (state.terminals.length < 16) state.terminals.push({ identity, runId, phase: change.phase });
          else state.overflow = true;
        }
      };
      const ipc = host.electron.ipcRenderer;
      const unsubscribe = ipc.on('host:event', listener);
      state.dispose = typeof unsubscribe === 'function' ? unsubscribe : () => ipc.off('host:event', listener);
      host.__matchaHistoryObservation = state;
    }, { endpoint, agentId: this.agentId!, baseline: this.baseline, owner: this.owner });
  }

  async prepareUiTurn(): Promise<void> {
    if (!this.agentId || this.identity || this.runId || this.turnMayBeRunning) throw new Error('Matcha history permits only one new draft composer send');
    this.baseline = (await this.catalog()).map(entry => this.catalogIdentity(entry));
    await this.observeTerminal();
    this.observationActive = true;
    this.turnMayBeRunning = true;
  }

  private catalogIdentity(entry: Record<string, unknown>): Identity {
    const identity = entry.sessionIdentity;
    if (!isRecord(identity) || typeof identity.agentId !== 'string' || !identity.agentId
      || typeof identity.sessionKey !== 'string' || !identity.sessionKey
      || !sameIdentity(identity, { endpoint, agentId: identity.agentId, sessionKey: identity.sessionKey })) {
      throw new Error('Matcha public catalog returned an invalid full identity');
    }
    return { endpoint, agentId: identity.agentId, sessionKey: identity.sessionKey };
  }

  private async bindUiSession(): Promise<boolean> {
    const candidates = (await this.catalog()).map(entry => this.catalogIdentity(entry)).filter(identity => identity.agentId === this.agentId
      && !this.baseline.some(previous => sameIdentity(identity, previous)));
    const matched: { identity: Identity; endpointSessionId: string }[] = [];
    for (const identity of candidates) {
      const view = publicObject(await this.electron.fetchHostApi({
        path: '/api/capabilities/execute', method: 'POST', timeoutMs: 5_000,
        body: {
          id: 'session.management', operationId: 'sessions.window',
          scope: { kind: 'session', identity }, target: { kind: 'session', identity },
          input: { sessionKey: identity.sessionKey, sessionIdentity: identity, mode: 'latest', limit: 50, includeCanonical: true },
        },
      }), 'Matcha UI-created session identity');
      if (!sameIdentity(view.identity, identity) || view.sessionKey !== identity.sessionKey) {
        throw new Error('Matcha UI session readback crossed identity');
      }
      if (view.items === 'unknown' || view.items === 'unavailable') continue;
      const fact = isRecord(view.items) ? view.items : {};
      const items = fact.complete ?? (isRecord(fact.incomplete) ? fact.incomplete.facts : undefined);
      if (!Array.isArray(items)) throw new Error('Matcha UI session readback did not deliver public item facts');
      const messages = items.filter(item => isRecord(item) && item.kind === 'userMessage' && item.text === this.prompt);
      if (!messages.length) continue;
      if (messages.length !== 1 || !isRecord(messages[0]) || messages[0].status !== 'final'
        || typeof view.endpointSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(view.endpointSessionId)
        || identity.sessionKey !== `matcha-agent:${identity.agentId}:${view.endpointSessionId}`) {
        throw new Error('Matcha UI send did not confirm one new native session and one exact user message');
      }
      matched.push({ identity, endpointSessionId: view.endpointSessionId });
    }
    if (matched.length > 1) throw new Error('Matcha UI prompt appeared in multiple new identities; none may be deleted');
    if (matched.length === 1) {
      if (this.identity && !sameIdentity(matched[0].identity, this.identity)) throw new Error('Matcha UI identity changed after binding');
      this.identity = matched[0].identity;
      this.nativeSessionId = matched[0].endpointSessionId;
    }
    return matched.length === 1;
  }

  async runRealTurn() {
    if (!this.observationActive) throw new Error('Observe public terminals before the single Matcha UI send');
    let primaryFailure: unknown;
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (!this.identity) await this.bindUiSession();
        const observation = await this.electron.page.evaluate(owner => {
          const state = (window as unknown as { __matchaHistoryObservation?: Observation }).__matchaHistoryObservation;
          if (state?.owner !== owner) throw new Error('Matcha history lost its terminal observation');
          return { terminals: state.terminals, overflow: state.overflow };
        }, this.owner);
        if (observation.overflow) throw new Error('Matcha public terminal observation overflowed; native outcome remains unknown');
        const terminals = observation.terminals.filter(item => this.identity && sameIdentity(item.identity, this.identity));
        if (terminals.length > 1) throw new Error('The owned Matcha UI send produced ambiguous native run identities');
        const terminal = terminals[0];
        if (terminal) {
          this.runId = terminal.runId;
          if (terminal.phase === 'completed') {
            if (!await this.bindUiSession()) throw new Error('The completed Matcha UI identity is no longer uniquely confirmed in the public catalog');
            this.turnMayBeRunning = false;
            return { completed: true, session: this.sessionEvidence() };
          }
          this.turnMayBeRunning = false;
          throw new Error(`Matcha real turn ended with ${terminal.phase}; queued or saved history is not successful execution`);
        }
        await delay(200);
      }
      throw new Error('Matcha UI send did not confirm a unique new identity and completed terminal within 45 seconds; no resend or blind deletion is permitted');
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      try { await this.disposeObservation(); }
      catch (error) {
        throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error],
          'Matcha terminal observation disposal failed; the original failure is retained');
      }
    }
  }

  private async disposeObservation(): Promise<void> {
    if (!this.observationActive) return;
    await this.electron.page.evaluate(owner => {
      const host = window as unknown as { __matchaHistoryObservation?: Observation };
      if (host.__matchaHistoryObservation?.owner !== owner) throw new Error('Matcha history cannot dispose another observer');
      host.__matchaHistoryObservation.dispose();
      delete host.__matchaHistoryObservation;
    }, this.owner);
    this.observationActive = false;
  }

  async capturePublicHistory(expectedItems?: string) {
    const identity = this.requireIdentity();
    if (!this.runId) throw new Error('Matcha history requires the returned native run identity');
    const deadline = Date.now() + 15_000;
    do {
      const view = publicObject(await this.electron.fetchHostApi({
        path: '/api/capabilities/execute', method: 'POST', timeoutMs: 10_000,
        body: {
          id: 'session.management', operationId: 'sessions.window',
          scope: { kind: 'session', identity }, target: { kind: 'session', identity },
          input: {
            sessionKey: identity.sessionKey, sessionIdentity: identity, endpointSessionId: this.nativeSessionId,
            mode: 'latest', limit: 50, includeCanonical: true,
          },
        },
      }), 'Matcha canonical public history');
      if (!sameIdentity(view.identity, identity) || view.sessionKey !== identity.sessionKey
        || view.endpointSessionId !== this.nativeSessionId) throw new Error('Matcha history returned a different session');
      const legalGaps = ['session_identity', 'catalog', 'usage', 'artifacts', 'context_tokens', 'tasks',
        'replay_cursor', 'bounded_history', 'partial_runtime', 'event_only'];
      const validGaps = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
        && new Set(value).size === value.length && value.every(gap => typeof gap === 'string' && legalGaps.includes(gap));
      const itemFact = view.items;
      if (!isRecord(itemFact) || Object.keys(itemFact).length !== 1) throw new Error('Matcha history did not deliver item facts');
      const incomplete = isRecord(itemFact.incomplete) ? itemFact.incomplete : undefined;
      const rawItems = itemFact.complete ?? incomplete?.facts;
      if (!Array.isArray(rawItems) || incomplete && (Object.keys(incomplete).length !== 2 || !validGaps(incomplete.gaps))) {
        throw new Error('Matcha history requires real item facts with legal, unique nonempty gaps when incomplete');
      }
      const items = rawItems.filter(isRecord);
      if (items.length !== rawItems.length || new Set(items.map(item => item.itemId)).size !== items.length
        || items.some(item => typeof item.kind !== 'string' || typeof item.itemId !== 'string' || !item.itemId
          || typeof item.text !== 'string')) throw new Error('Matcha public history items are invalid or duplicated');
      const completeness = view.completeness;
      if (completeness === 'complete') {
        if (!['items', 'tools', 'approvals', 'runtime', 'window'].every(key => isRecord(view[key])
          && Object.keys(view[key]).length === 1 && Object.hasOwn(view[key], 'complete'))) {
          throw new Error('Matcha history claimed complete while some facts remain incomplete');
        }
      } else if (!isRecord(completeness) || Object.keys(completeness).length !== 1 || !isRecord(completeness.incomplete)
        || Object.keys(completeness.incomplete).length !== 1 || !validGaps(completeness.incomplete.missing)
        || incomplete && !(incomplete.gaps as string[]).every(gap => (completeness.incomplete as { missing: string[] }).missing.includes(gap))) {
        throw new Error('Matcha history completeness did not accurately report its legal missing facts');
      }
      if (!isRecord(view.window) || Object.keys(view.window).length !== 1 || !isRecord(view.window.complete)) {
        throw new Error('Matcha history requires complete native window coordinates');
      }
      const windowFacts = view.window.complete;
      const fields = ['totalItemCount', 'windowStartOffset', 'windowEndOffset', 'hasMore', 'hasNewer', 'isAtLatest'];
      if (Object.keys(windowFacts).length !== fields.length || !fields.every(key => Object.hasOwn(windowFacts, key))
        || !Number.isSafeInteger(windowFacts.totalItemCount) || Number(windowFacts.totalItemCount) <= 0
        || windowFacts.windowStartOffset !== 0 || windowFacts.windowEndOffset !== windowFacts.totalItemCount
        || windowFacts.hasMore !== false || windowFacts.hasNewer !== false || windowFacts.isAtLatest !== true) {
        throw new Error('Matcha history must cover the entire new native transcript, not a partial raw-row window');
      }
      const user = items.find(item => item.kind === 'userMessage' && item.text === this.prompt && item.status === 'final');
      const assistant = items.find(item => item.kind === 'assistantTurn' && item.runId === this.runId
        && item.status === 'final' && typeof item.text === 'string' && item.text.trim() === this.marker);
      if (user && assistant && typeof assistant.text === 'string') {
        this.assistantText = assistant.text;
        const canonicalItems = JSON.stringify({ items: rawItems, window: windowFacts });
        if (expectedItems !== undefined && canonicalItems !== expectedItems) {
          throw new Error('Matcha canonical history changed across the native app-server restart');
        }
        if (this.canonicalItems === undefined) this.canonicalItems = canonicalItems;
        return {
          verified: true, identity, endpointSessionId: this.nativeSessionId, marker: this.marker,
          digest: createHash('sha256').update(canonicalItems).digest('hex'),
        };
      }
      await delay(200);
    } while (Date.now() < deadline);
    throw new Error('Completed Matcha turn did not appear as the exact public user message and matching assistant run');
  }

  async recoverAfterNativeRestart(): Promise<boolean> {
    this.requireIdentity();
    if (!this.canonicalItems || this.turnMayBeRunning) throw new Error('Matcha native recovery requires completed, verified canonical history');
    this.restartOutcomeUnknown = true;
    const receipt = publicObject(await this.electron.fetchHostApi({
      path: '/api/matcha-agent/app-server/restart', method: 'POST', timeoutMs: 10_000,
    }), 'Matcha native app-server restart admission', 202);
    if (receipt.accepted !== true || typeof receipt.callId !== 'string' || !/^[a-f0-9]{32}$/.test(receipt.callId)) {
      throw new Error('Matcha native restart did not return the current accepted call receipt');
    }
    const deadline = Date.now() + 25_000;
    let restartCompleted = false;
    while (Date.now() < deadline) {
      if (!restartCompleted) {
        const call = publicObject(await this.electron.fetchHostApi({
          path: '/api/calls/get', method: 'POST', body: { callId: receipt.callId }, timeoutMs: 5_000,
        }), 'Matcha native restart call');
        if (call.callId !== receipt.callId || call.module !== 'runtime-control'
          || typeof call.status !== 'string') throw new Error('Matcha restart call identity is invalid');
        if (['failed', 'rejected', 'unknown'].includes(call.status)) {
          this.restartOutcomeUnknown = call.status === 'unknown';
          throw new Error(`Matcha native restart ended with ${call.status}`);
        }
        if (!['received', 'accepted', 'running', 'waiting', 'succeeded'].includes(call.status)) {
          throw new Error('Matcha native restart call has an invalid status');
        }
        restartCompleted = call.status === 'succeeded';
        if (restartCompleted) this.restartOutcomeUnknown = false;
      }
      if (restartCompleted) {
        const status = publicObject(await this.electron.fetchHostApi({
          path: '/api/matcha-agent/app-server/status', method: 'GET', timeoutMs: 5_000,
        }), 'Matcha native readiness after restart');
        if (status.ready === true && status.processState === 'running') {
          await this.capturePublicHistory(this.canonicalItems);
          return true;
        }
      }
      await delay(200);
    }
    throw new Error('Matcha native app-server restart did not complete and become ready within 25 seconds');
  }

  private async catalog(): Promise<Record<string, unknown>[]> {
    const body = publicObject(await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST', timeoutMs: 5_000,
      body: { id: 'session.management', operationId: 'sessions.list',
        scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint } },
    }), 'Matcha public session catalog');
    if (!Array.isArray(body.sessions) || !body.sessions.every(isRecord)) throw new Error('Matcha public catalog did not deliver real session entries');
    return body.sessions;
  }

  async deleteOwnedSession() {
    await this.disposeObservation();
    if (this.turnMayBeRunning || this.restartOutcomeUnknown) return { state: 'retained-unknown-outcome', identity: this.identity };
    if (!this.identity) return { state: 'no-confirmed-session' };
    if (this.deletionSubmitted) throw new Error('Matcha cleanup outcome is unresolved; deletion must not be replayed');
    const identity = this.identity;
    this.deletionSubmitted = true;
    const receipt = publicObject(await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST', timeoutMs: 10_000,
      body: {
        id: 'session.management', operationId: 'sessions.delete',
        scope: { kind: 'session', identity }, target: { kind: 'session', identity },
        input: { sessionIdentity: identity },
      },
    }), 'Matcha owned history session cleanup');
    if (Object.keys(receipt).length !== 1 || receipt.outcome !== 'succeeded') {
      throw new Error('Matcha owned history session deletion was not confirmed; no replay is allowed');
    }
    const deadline = Date.now() + 8_000;
    do {
      if (!(await this.catalog()).some(entry => sameIdentity(entry.sessionIdentity, identity))) {
        this.identity = undefined;
        return { state: 'deleted', identity };
      }
      await delay(200);
    } while (Date.now() < deadline);
    throw new Error('The exact Matcha identity remains in the public native catalog after successful deletion');
  }

  async readMarkdownDownload(): Promise<boolean> {
    const identity = this.requireIdentity();
    if (!this.assistantText) throw new Error('Matcha Markdown export requires verified public assistant history');
    const download = await this.electron.page.waitForEvent('download', { timeout: 15_000 });
    try {
      if (!download.suggestedFilename().endsWith('.md')) throw new Error('Matcha UI did not export Markdown');
      const path = await download.path();
      if (!path) throw new Error('Matcha Markdown download has no readable artifact');
      const markdown = await readFile(path, 'utf8');
      assertPublic(markdown);
      const assistantSection = markdown.split(/^## Assistant(?: · .+)?\r?$/m)[1];
      return /^# .+\r?\n/.test(markdown) && markdown.includes(`- Session: ${identity.sessionKey}`)
        && markdown.includes(`## User\n\n${this.prompt}`) && typeof assistantSection === 'string'
        && assistantSection.includes(this.marker) && assistantSection.includes(this.assistantText);
    } finally {
      await download.delete();
    }
  }
}
