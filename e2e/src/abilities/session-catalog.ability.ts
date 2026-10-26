import { Ability } from '@serenity-js/core';
import { UseElectron } from './use-electron.ability.js';

const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
type Identity = { endpoint: typeof endpoint; agentId: string; sessionKey: string };
type CatalogEntry = { key: string; agentId: string; sessionIdentity: Identity; endpointSessionId: unknown; kind: unknown };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function identity(value: unknown): Identity {
  const candidate = record(value);
  const address = record(candidate.endpoint);
  if (address.kind !== endpoint.kind || address.runtimeAdapterId !== endpoint.runtimeAdapterId
    || address.runtimeInstanceId !== endpoint.runtimeInstanceId || typeof candidate.agentId !== 'string'
    || !candidate.agentId || typeof candidate.sessionKey !== 'string' || !candidate.sessionKey) {
    throw new Error('Public OpenClaw catalog returned an invalid complete session identity');
  }
  return { endpoint, agentId: candidate.agentId, sessionKey: candidate.sessionKey };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.endpoint.kind === right.endpoint.kind
    && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId
    && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId
    && left.agentId === right.agentId && left.sessionKey === right.sessionKey;
}

function identities(entries: CatalogEntry[]): string[] {
  return entries.map(entry => JSON.stringify(entry.sessionIdentity)).sort();
}

function hasValidGaps(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every(gap => typeof gap === 'string' && [
      'session_identity', 'catalog', 'usage', 'artifacts', 'context_tokens', 'tasks',
      'replay_cursor', 'bounded_history', 'partial_runtime', 'event_only',
    ].includes(gap));
}

function deliveredItems(value: unknown): { items: unknown[]; gaps: string[] } | undefined {
  const availability = record(value);
  if (Object.keys(availability).length !== 1) return;
  if (Array.isArray(availability.complete)) return { items: availability.complete, gaps: [] };
  const incomplete = record(availability.incomplete);
  if (Object.keys(incomplete).length !== 2 || !Array.isArray(incomplete.facts) || !hasValidGaps(incomplete.gaps)) return;
  return { items: incomplete.facts, gaps: incomplete.gaps };
}

export class SessionCatalog extends Ability {
  private baseline?: CatalogEntry[];

  constructor(private readonly electron: UseElectron) { super(); }

  async rememberCatalog(): Promise<void> {
    this.baseline = await this.list();
  }

  async draftDidNotCreateSession(): Promise<boolean> {
    if (!this.baseline) throw new Error('Session catalog baseline was not captured before selecting the draft');
    return JSON.stringify(identities(await this.list())) === JSON.stringify(identities(this.baseline));
  }

  async verifyIndependentSession() {
    const before = await this.list();
    let ownedIdentity: Identity | undefined;
    const failures: unknown[] = [];
    let receipt;
    try {
      // Omit endpointSessionId: the public create owner generates its own key grammar.
      const created = await this.execute({
        id: 'session.prompt', operationId: 'sessions.create',
        scope: { kind: 'agent', endpoint, agentId: 'main' }, target: { kind: 'agent', agentId: 'main' },
        input: { endpoint, agentId: 'main' },
      });
      const createdIdentity = identity(created.identity);
      if (createdIdentity.agentId !== 'main' || created.sessionKey !== createdIdentity.sessionKey
        || before.some(entry => sameIdentity(entry.sessionIdentity, createdIdentity))) {
        throw new Error('Public create did not confirm a new independent main Agent session; no deletion was attempted');
      }
      ownedIdentity = createdIdentity;
      if (typeof created.endpointSessionId !== 'string' || !created.endpointSessionId) {
        throw new Error('Public create did not return the native endpoint session identifier');
      }
      const after = await this.list();
      const matches = after.filter(entry => sameIdentity(entry.sessionIdentity, createdIdentity));
      const loaded = await this.execute({
        id: 'session.management', operationId: 'sessions.load',
        scope: { kind: 'session', identity: createdIdentity }, target: { kind: 'session', identity: createdIdentity },
        input: { sessionKey: createdIdentity.sessionKey, sessionIdentity: createdIdentity, limit: 20 },
      });
      const items = deliveredItems(loaded.items);
      const windowAvailability = record(loaded.window);
      const window = record(windowAvailability.complete);
      const completeness = record(loaded.completeness);
      const incomplete = record(completeness.incomplete);
      const missing = incomplete.missing;
      const allFactsAreComplete = ['items', 'tools', 'approvals', 'runtime', 'window'].every(field => {
        const availability = record(loaded[field]);
        return Object.keys(availability).length === 1 && Object.hasOwn(availability, 'complete');
      });
      const completenessAccuratelyReportsGaps = items !== undefined && (loaded.completeness === 'complete'
        ? allFactsAreComplete
        : Object.keys(completeness).length === 1 && Object.keys(incomplete).length === 1
          && hasValidGaps(missing) && items.gaps.every(gap => missing.includes(gap)));
      const projected = JSON.stringify({ created, sessions: after, loaded });
      receipt = {
        independent: true,
        listedIdentityMatches: matches.length === 1 && matches[0]!.agentId === 'main'
          && matches[0]!.key === createdIdentity.sessionKey && matches[0]!.kind === 'session'
          && matches[0]!.endpointSessionId === created.endpointSessionId,
        loadedIdentityMatches: sameIdentity(identity(loaded.identity), createdIdentity)
          && loaded.sessionKey === createdIdentity.sessionKey && loaded.endpointSessionId === created.endpointSessionId,
        itemsAreDeliveredAndEmpty: items !== undefined && items.items.length === 0,
        windowIsCompleteAndEmpty: Object.keys(windowAvailability).length === 1
          && window.totalItemCount === 0 && window.windowStartOffset === 0
          && window.windowEndOffset === 0 && window.hasMore === false && window.hasNewer === false && window.isAtLatest === true,
        completenessAccuratelyReportsGaps,
        hasNoPrivateFields: !['privateToken', 'rawPayload', 'nativeError', 'sessionStorage'].some(field => projected.includes(field)),
      };
    } catch (error) { failures.push(error); }
    finally {
      if (ownedIdentity) {
        try {
          const deleted = await this.execute({
            id: 'session.management', operationId: 'sessions.delete',
            scope: { kind: 'session', identity: ownedIdentity }, target: { kind: 'session', identity: ownedIdentity },
            input: { sessionIdentity: ownedIdentity },
          });
          if (deleted.outcome !== 'succeeded') {
            throw new Error('Owned catalog session deletion was not confirmed; do not retry an unknown mutation');
          }
          if ((await this.list()).some(entry => sameIdentity(entry.sessionIdentity, ownedIdentity!))) {
            throw new Error('The exact owned session identity remains in the public catalog after deletion');
          }
        } catch (error) { failures.push(error); }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Session catalog verification failed; cleanup errors retain the original failure');
    return receipt!;
  }

  private async list(): Promise<CatalogEntry[]> {
    const body = await this.execute({
      id: 'session.management', operationId: 'sessions.list',
      scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint },
    });
    if (!Array.isArray(body.sessions)) throw new Error('Public session catalog did not return a session array');
    const projected = JSON.stringify(body);
    if (['privateToken', 'rawPayload', 'nativeError', 'sessionStorage'].some(field => projected.includes(field))) {
      throw new Error('Public session catalog exposed a private field');
    }
    return body.sessions.map(value => {
      const entry = record(value);
      const sessionIdentity = identity(entry.sessionIdentity);
      if (entry.key !== sessionIdentity.sessionKey || entry.agentId !== sessionIdentity.agentId) {
        throw new Error('Public catalog key or Agent does not match its complete session identity');
      }
      return { key: sessionIdentity.sessionKey, agentId: sessionIdentity.agentId, sessionIdentity, endpointSessionId: entry.endpointSessionId, kind: entry.kind };
    });
  }

  private async execute(body: unknown): Promise<Record<string, unknown>> {
    const reply = await this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', body, timeoutMs: 30_000 });
    if (!reply.ok) throw new Error(`Public session catalog IPC failed (${reply.error.code}); mutations are not retried`);
    if (reply.data.status !== 200 || !reply.data.ok) throw new Error(`Public session catalog returned HTTP ${reply.data.status}`);
    const result = record(reply.data.json);
    if (result.outcome === 'unknown' || result.outcome === 'target_rejected') {
      throw new Error(`Public session catalog operation returned ${result.outcome}; mutation was not retried`);
    }
    return result;
  }
}
