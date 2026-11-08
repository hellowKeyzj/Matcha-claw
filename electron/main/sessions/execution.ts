import { randomUUID } from 'node:crypto';
import type { AppAgentTarget, AppExecutionResults, AppSessionCreated, AppSessionExecutionResult, AppSessionRun, AppSessionRunRequest, AppSessionSendRequest, AppSessionSendResult } from '../../../sdk/app-plugins/src/execution';
import type { RuntimeHostTransportBundle } from '../composition/transports';
import { isProductRuntimeEndpoint } from '../runtime-host-delivery/transport/runtime-scope';
import { observationRequest } from '../runtime-host-delivery/transport/sessions/observation';
import { isSessionIdentity, sameSessionIdentity, type SessionDelta } from '../runtime-host-delivery/transport/sessions/session-contract';

export class SessionExecutionError extends Error {
  constructor(readonly reason: 'invalid_request' | 'unavailable', message: string) { super(message); }
}

export async function listSessionAgents(bundle: RuntimeHostTransportBundle): Promise<AppExecutionResults['listAgents']> {
  const response = await bundle.hostApiTransports.runtimeDirectoryTransport.list();
  if (response.status !== 200 || !('endpoints' in response.body)) throw unavailable('Agent directory');
  return {
    agents: response.body.endpoints.flatMap((endpoint) => isProductRuntimeEndpoint(endpoint.endpointRef)
      ? endpoint.agents.map((agent) => ({
        endpoint: endpoint.endpointRef,
        agentId: agent.agentId,
        name: agent.displayName ?? agent.agentId,
        ready: endpoint.lifecycle.ready && agent.capabilities.chat,
      }))
      : []),
  };
}

export async function createSession(bundle: RuntimeHostTransportBundle, input: AppAgentTarget): Promise<AppSessionCreated> {
  const { endpoint, agentId } = input;
  if (!isProductRuntimeEndpoint(endpoint)) throw unsupportedEndpoint();
  const response = await bundle.hostApiTransports.sessionCreateTransport.create({
    id: 'session.prompt', operationId: 'sessions.create',
    scope: { kind: 'agent', endpoint, agentId }, target: { kind: 'agent', agentId }, input: { endpoint, agentId },
  });
  if ('outcome' in response.body) return { outcome: response.body.outcome };
  if (response.status !== 200 || !('identity' in response.body)) throw unavailable('Session creation');
  return { outcome: 'created', session: { identity: response.body.identity, endpointSessionId: response.body.endpointSessionId } };
}

export async function sendSessionMessage(bundle: RuntimeHostTransportBundle, input: AppSessionSendRequest, signal: AbortSignal): Promise<AppSessionSendResult> {
  const { identity, message, idempotencyKey } = input;
  if (!isSessionIdentity(identity)) throw unsupportedEndpoint();
  const target = { kind: 'session', identity };
  const response = await bundle.hostApiTransports.sessionSendTransport.send({
    id: 'session.prompt', operationId: 'sessions.send', scope: target, target,
    input: { identity, message, idempotencyKey, attachments: [] },
  }, null, signal);
  if (!('outcome' in response.body) || response.body.outcome === 'unavailable') throw unavailable('Session send');
  if (response.body.outcome === 'queued' || response.body.outcome === 'succeeded') {
    return { outcome: 'accepted', runId: response.body.runId, queued: response.body.outcome === 'queued' };
  }
  return { outcome: response.body.outcome === 'unknown' ? 'unknown' : 'target_rejected' };
}

export async function readSessionRun(bundle: RuntimeHostTransportBundle, input: AppSessionRunRequest, signal: AbortSignal): Promise<AppSessionRun> {
  const { identity, runId } = input;
  if (!isSessionIdentity(identity)) throw unsupportedEndpoint();
  const target = { kind: 'session', identity };
  const response = await bundle.hostApiTransports.sessionRunTransport.read({
    id: 'session.management', operationId: 'sessions.run.read', scope: target, target,
    input: { identity, runId },
  }, signal);
  if (response.status !== 200) throw unavailable('Session view');
  return response.body;
}

export async function cancelSessionRun(bundle: RuntimeHostTransportBundle, input: AppSessionRunRequest): Promise<AppExecutionResults['cancelSession']> {
  const { identity, runId } = input;
  if (!isSessionIdentity(identity)) throw unsupportedEndpoint();
  const target = { kind: 'session', identity };
  const response = await bundle.hostApiTransports.sessionAbortTransport.abort({
    id: 'session.abort', operationId: 'sessions.abort', scope: target, target, input: { identity, runId },
  });
  return { outcome: response.body.outcome === 'succeeded' ? 'requested' : response.body.outcome };
}

export async function sendAndWaitSession(bundle: RuntimeHostTransportBundle, input: AppSessionSendRequest, signal: AbortSignal): Promise<AppSessionExecutionResult> {
  const { identity, message, idempotencyKey } = input;
  if (!isSessionIdentity(identity)) throw unsupportedEndpoint();
  const events = bundle.sessionEventsTransport;
  const transports = bundle.hostApiTransports;
  const leaseId = randomUUID();
  const stopped = new AbortController();
  const abort = () => stopped.abort(signal.reason);
  const timer = setTimeout(() => stopped.abort(new Error('Session execution deadline exceeded.')), 5 * 60_000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let rejectStopped: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const onStopped = () => rejectStopped(stopped.signal.reason);
  stopped.signal.addEventListener('abort', onStopped, { once: true });
  if (stopped.signal.aborted) onStopped();
  void interrupted.catch(() => {});
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interrupted]);
  const inflight = new Set<Promise<unknown>>();
  const own = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
    return promise;
  };
  type Terminal = 'completed' | 'failed' | 'cancelled' | 'interrupted';
  type RunEvent = (Pick<SessionDelta, 'epoch' | 'seq' | 'cursor'> & {
    kind: 'delta';
    recovery: boolean;
    phases: { runId: string; phase: Terminal }[];
  }) | { kind: 'sync'; epoch: number; seq: number };
  const pending: RunEvent[] = [];
  const terminals: { runId: string; phase: Terminal }[] = [];
  let watermark: Pick<SessionDelta, 'epoch' | 'seq' | 'cursor'> | undefined;
  let runId: string | undefined;
  let observing = false;
  let dispatched = false;
  let resolveTerminal: (phase: Terminal) => void = () => {};
  const terminal = new Promise<Terminal>((resolve) => { resolveTerminal = resolve; });
  const consume = (event: RunEvent) => {
    if (!watermark || stopped.signal.aborted) return;
    if (event.epoch < watermark.epoch || (event.epoch === watermark.epoch && event.seq <= watermark.seq
      && (event.kind === 'sync' || event.cursor <= watermark.cursor))) return;
    if (event.epoch !== watermark.epoch || event.seq !== watermark.seq + 1
      || (event.kind === 'delta' && (event.cursor !== watermark.cursor + 1 || event.recovery))) {
      stopped.abort(new Error('Session event continuity was lost.'));
      return;
    }
    // Native reconcile_sync advances both counters once and publishes resync, not delta.
    watermark = { epoch: event.epoch, seq: event.seq, cursor: event.kind === 'sync' ? watermark.cursor + 1 : event.cursor };
    if (event.kind === 'sync') return;
    for (const phase of event.phases) {
      if (terminals.length >= 128) { stopped.abort(new Error('Session terminal event buffer exceeded.')); return; }
      terminals.push(phase);
      if (phase.runId === runId) resolveTerminal(phase.phase);
    }
  };
  const receive = (event: RunEvent) => {
    if (watermark) consume(event);
    else if (pending.length < 128) pending.push(event);
    else stopped.abort(new Error('Session event buffer exceeded.'));
  };
  const offDelta = events.onDelta((delta) => {
    if (!sameSessionIdentity(delta.identity, identity) || stopped.signal.aborted) return;
    receive({
      kind: 'delta', epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor,
      recovery: delta.changes.some((change) => change.kind === 'recoveryRequired'),
      phases: delta.changes.flatMap((change) => change.kind === 'runPhaseChanged'
        && (change.phase === 'completed' || change.phase === 'failed' || change.phase === 'cancelled' || change.phase === 'interrupted')
        ? [{ runId: change.runId, phase: change.phase }] : []),
    });
  });
  const offResync = events.onResync((event) => {
    if (sameSessionIdentity(event.identity, identity) && !stopped.signal.aborted) receive({ kind: 'sync', epoch: event.epoch, seq: event.seq });
  });
  let lifetime: AbortSignal | undefined;
  const disconnected = () => stopped.abort(new Error('Session events connection ended.'));
  const release = () => transports.sessionObservationTransport.release(observationRequest(identity, leaseId, 'sessions.release'));
  try {
    lifetime = await wait(events.ready(stopped.signal));
    lifetime.addEventListener('abort', disconnected, { once: true });
    if (lifetime.aborted) disconnected();
    stopped.signal.throwIfAborted();
    observing = true;
    const observed = await wait(own(transports.sessionObservationTransport.observe(observationRequest(identity, leaseId, 'sessions.observe', 200))));
    const baseline = observed.status === 200 && 'view' in observed.body ? observed.body.view : null;
    if (!baseline) throw unavailable('Session observation');
    watermark = { epoch: baseline.epoch, seq: baseline.seq, cursor: baseline.cursor };
    pending.splice(0).forEach(consume);
    stopped.signal.throwIfAborted();
    const target = { kind: 'session', identity };
    dispatched = true;
    const response = await wait(own(transports.sessionSendTransport.send({
      id: 'session.prompt', operationId: 'sessions.send', scope: target, target,
      input: { identity, message, idempotencyKey, attachments: [] },
    }, null, stopped.signal)));
    if (!('outcome' in response.body) || (response.body.outcome !== 'queued' && response.body.outcome !== 'succeeded')) {
      return { outcome: 'unknown' };
    }
    runId = response.body.runId;
    const early = terminals.find((event) => event.runId === runId);
    if (early) resolveTerminal(early.phase);
    const phase = await wait(terminal);
    stopped.signal.throwIfAborted();
    const result = await wait(own(readSessionRun(bundle, { identity, runId }, stopped.signal)));
    stopped.signal.throwIfAborted();
    return { ...result, terminal: phase };
  } catch (error) {
    if (!dispatched && !stopped.signal.aborted) throw error;
    return { outcome: 'unknown', ...(runId === undefined ? {} : { runId }) };
  } finally {
    clearTimeout(timer);
    stopped.abort(new Error('Session execution observation ended.'));
    signal.removeEventListener('abort', abort);
    stopped.signal.removeEventListener('abort', onStopped);
    lifetime?.removeEventListener('abort', disconnected);
    offDelta();
    offResync();
    // Observe/release have native 30s HTTP bounds; release only after a late observe settles.
    await Promise.allSettled(inflight);
    if (observing) await Promise.allSettled([release()]);
  }
}

function unsupportedEndpoint(): SessionExecutionError {
  return new SessionExecutionError('invalid_request', 'Execution requires an explicit local OpenClaw or Matcha Agent identity; connector endpoints and workspace overrides are not supported.');
}

function unavailable(subject: string): SessionExecutionError {
  return new SessionExecutionError('unavailable', `${subject} is unavailable.`);
}
