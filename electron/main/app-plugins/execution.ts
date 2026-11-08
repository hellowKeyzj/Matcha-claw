import { isAppExecutionRequest, type AppExecutionRequest, type AppExecutionResult, type AppTeam, type AppTeamRun, type AppTeamRunStatus, type AppTeamRunTarget, type AppTeamScope } from '../../../sdk/app-plugins/src/execution';
import { decodeTeamDesignSnapshot, isTeamDesignFailure, isTeamGraphVersion } from '../../../src/types/team-design';
import { isTeamMessageCursor, isTeamRuntimeCapabilityRequest } from '../runtime-host-delivery/transport/teams/contract';
import type { RuntimeHostTransportBundle } from '../composition/transports';
import { isRecord } from '../runtime-host-delivery/transport/client';
import { isProductRuntimeEndpoint } from '../runtime-host-delivery/transport/runtime-scope';
import { SessionExecutionError, cancelSessionRun, createSession, listSessionAgents, readSessionRun, sendAndWaitSession, sendSessionMessage } from '../sessions/execution';
import type { TeamRuntimeTransport } from '../runtime-host-delivery/transport/teams/runtime';
import { AppPluginError } from './package';
import type { AppPluginContext } from '../../../sdk/app-plugins/src/api';
import { decodeTeamApprovals, resolveTeamApproval } from './team-approvals';

const MAX_RESULT_BYTES = 1024 * 1024;
const TEAM_RUN_STATUSES: readonly AppTeamRunStatus[] = ['created', 'provisioning', 'waiting_for_user', 'running', 'paused', 'cancelling', 'completed', 'failed', 'cancelled'];

export function createAppPluginExecution(options: {
  getTransports(): Promise<RuntimeHostTransportBundle>;
  listTeams(): Promise<{ readonly teams: readonly AppTeam[] }>;
}) {
  const execute = async (request: AppExecutionRequest, signal: AbortSignal, confirm?: AppPluginContext['requestConfirmation']): Promise<AppExecutionResult> => {
    if (!isAppExecutionRequest(request)) throw invalid('Invalid execution request.');
    signal.throwIfAborted();
    if (request.operation === 'listTeams') return options.listTeams();
    const bundle = await options.getTransports();
    const transports = bundle.hostApiTransports;
    signal.throwIfAborted();
    switch (request.operation) {
      case 'listAgents':
        return listSessionAgents(bundle);
      case 'createSession':
        return createSession(bundle, request.input);
      case 'sendMessage':
        return sendSessionMessage(bundle, request.input, signal);
      case 'sendAndWaitSession':
        return sendAndWaitSession(bundle, request.input, signal);
      case 'readSession':
        return readSessionRun(bundle, request.input, signal);
      case 'cancelSession':
        return cancelSessionRun(bundle, request.input);
      case 'createTeamRun': {
        const { scope, teamId, packagePath, sourceType, runId, idempotencyKey, sourceAgentId } = request.input;
        const response = await executeTeam(transports.teamRuntimeTransport, scope, 'team.runCreate',
          { kind: 'team', teamId, packagePath },
          { teamId, packagePath, sourceType, runId, idempotencyKey, ...(sourceAgentId === undefined ? {} : { sourceAgentId }) });
        const run = teamRun(response.body, runId);
        return { runId: run.runId, status: run.status, revision: run.revision };
      }
      case 'readTeamRun':
        return readTeamRun(transports.teamRuntimeTransport, request.input, signal);
      case 'resolveTeamApproval':
        return resolveTeamApproval(transports.teamRuntimeTransport, request.input, signal, confirm);
      case 'importTeamGraph': {
        const { scope, runId, yaml, idempotencyKey } = request.input;
        const response = await executeTeam(transports.teamRuntimeTransport, scope, 'team.graphImportYaml',
          { kind: 'team-run', runId }, { runId, yaml, idempotencyKey });
        if (!isRecord(response.body) || response.body.runId !== runId || response.body.imported !== true) throw unavailable('Team graph import outcome');
        return { runId, imported: true };
      }
      case 'startTeamRun': {
        const { scope, teamId, runId, designEpoch, expectedGraphVersion, idempotencyKey } = request.input;
        const response = await executeTeam(transports.teamRuntimeTransport, scope, 'team.runStart',
          { kind: 'team', teamId }, { teamId, runId, designEpoch, expectedGraphVersion, idempotencyKey });
        if (!isRecord(response.body) || response.body.success !== true || response.body.outcome !== 'started') throw unavailable('Team start outcome');
        return { outcome: 'started' };
      }
      case 'cancelTeamRun': {
        const { scope, runId, reason, idempotencyKey } = request.input;
        const response = await executeTeam(transports.teamRuntimeTransport, scope, 'team.runCancel',
          { kind: 'team-run', runId }, { runId, idempotencyKey, ...(reason === undefined ? {} : { reason }) });
        if (!isRecord(response.body) || response.body.success !== true || response.body.runId !== runId
          || !['cancelling', 'cancelled', 'tombstoned'].includes(String(response.body.state))) return { outcome: 'unknown' };
        return { outcome: 'requested' };
      }
    }
  };
  return {
    async execute(request: AppExecutionRequest, signal: AbortSignal, confirm?: AppPluginContext['requestConfirmation']): Promise<AppExecutionResult> {
      try {
        const result = await execute(request, signal, confirm);
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) throw new AppPluginError('busy', 'Execution result exceeds the 1 MiB response limit.');
        return result;
      } catch (error) {
        if (error instanceof SessionExecutionError) throw new AppPluginError(error.reason === 'invalid_request' ? 'invalid_package' : 'busy', error.message);
        throw error;
      }
    },
  };
}

async function readTeamRun(transport: TeamRuntimeTransport, target: AppTeamRunTarget, signal: AbortSignal): Promise<AppTeamRun> {
  const { scope, teamId, runId } = target;
  const [snapshot, design] = await Promise.all([
    executeTeam(transport, scope, 'team.runSnapshot', { kind: 'team-run', runId }, { runId }),
    executeTeam(transport, scope, 'team.designSnapshot', { kind: 'team', teamId }, { teamId, runId }),
  ]);
  signal.throwIfAborted();
  let view = teamResultSnapshot(snapshot.body, target);
  const designView = decodeTeamDesignSnapshot(design.body, { teamId, runId });
  const artifacts: AppTeamRun['artifacts'][number][] = [];
  const messages: AppTeamRun['messages'][number][] = [];
  const result = {
    ...target, status: view.run.status, revision: view.run.revision,
    designEpoch: designView.designEpoch, graphVersion: designView.graphVersion,
    approvals: decodeTeamApprovals(snapshot.body, target),
    artifacts, messagesStatus: 'unavailable' as AppTeamRun['messagesStatus'], messages,
  };
  // Reserve the bounded worker envelope; keep the public 1 MiB response ceiling unchanged.
  const budget = MAX_RESULT_BYTES - 4096;
  let resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const incomplete = () => { result.messagesStatus = 'incomplete'; return result; };
  const stale = () => { artifacts.length = 0; messages.length = 0; return incomplete(); };
  const revision = view.page.revision;
  const currentAttempts = view.currentAttempts;
  const artifactIds = new Set<string>();
  for (const artifact of view.artifacts) {
    if (!isRecord(artifact) || typeof artifact.currentAttempt !== 'boolean') throw unavailable('Team artifacts');
    const fence = teamResultFence(artifact, runId);
    if (artifact.currentAttempt !== currentAttempts.has(fence)) throw unavailable('Team artifact attempt');
    if (!artifact.currentAttempt) continue;
    if (typeof artifact.artifactId !== 'string' || !artifact.artifactId.length || artifactIds.has(artifact.artifactId)
      || typeof artifact.title !== 'string' || typeof artifact.contentRef !== 'string'
      || (artifact.summary != null && typeof artifact.summary !== 'string')) throw unavailable('Team artifacts');
    artifactIds.add(artifact.artifactId);
    const item = { id: artifact.artifactId, title: artifact.title, contentRef: artifact.contentRef,
      ...(artifact.summary == null ? {} : { summary: artifact.summary }) };
    resultBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (artifacts.length ? 1 : 0);
    if (resultBytes > budget) return incomplete();
    artifacts.push(item);
  }
  const messageIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: { revision: string; messageId: string; bodyOffset: number } | undefined;
  let pending: { id: string; fence: string; total: number; offset: number; chunks: string[] } | undefined;
  while (true) {
    signal.throwIfAborted();
    if (view.page.status === 'stale' || view.page.revision !== revision
      || view.run.status !== result.status || view.run.revision !== result.revision
      || view.currentAttempts.size !== currentAttempts.size
      || [...view.currentAttempts].some(fence => !currentAttempts.has(fence))) return stale();
    if (view.page.status === 'unavailable') {
      if (view.messages.length || view.page.nextCursor !== null) return stale();
      messages.length = 0;
      return result;
    }
    if (view.messages.length > 64 || (cursor && (!isRecord(view.messages[0])
      || view.messages[0].messageId !== cursor.messageId || view.messages[0].bodyOffset !== cursor.bodyOffset))) return stale();
    let pageBytes = 0;
    for (const message of view.messages) {
      if (!isRecord(message) || typeof message.messageId !== 'string' || !message.messageId.length
        || typeof message.body !== 'string' || typeof message.bodyComplete !== 'boolean'
        || typeof message.bodyOffset !== 'number' || !Number.isSafeInteger(message.bodyOffset) || message.bodyOffset < 0
        || typeof message.bodyBytes !== 'number' || !Number.isSafeInteger(message.bodyBytes) || message.bodyBytes < 0) {
        throw unavailable('Team messages');
      }
      const fence = teamResultFence(message, runId);
      if (!currentAttempts.has(fence)) throw unavailable('Team message attempt');
      const chunk = Buffer.from(message.body, 'utf8');
      pageBytes += chunk.length;
      if (chunk.toString('utf8') !== message.body || pageBytes > 48 * 1024) throw unavailable('Team message encoding');
      const end = message.bodyOffset + chunk.length;
      if (!Number.isSafeInteger(end) || end > message.bodyBytes || message.bodyComplete !== (end === message.bodyBytes)
        || (!message.bodyComplete && !chunk.length)) return stale();
      if (!pending) {
        if (message.bodyOffset !== 0 || messageIds.has(message.messageId)) return stale();
        messageIds.add(message.messageId);
        resultBytes += Buffer.byteLength(JSON.stringify({ id: message.messageId, body: '' }), 'utf8') + (messages.length ? 1 : 0);
        if (resultBytes + message.bodyBytes > budget) return incomplete();
        pending = { id: message.messageId, fence, total: message.bodyBytes, offset: 0, chunks: [] };
      }
      if (pending.id !== message.messageId || pending.fence !== fence || pending.total !== message.bodyBytes
        || pending.offset !== message.bodyOffset) return stale();
      resultBytes += Buffer.byteLength(JSON.stringify(message.body), 'utf8') - 2;
      if (resultBytes > budget) return incomplete();
      pending.chunks.push(message.body);
      pending.offset = end;
      if (message.bodyComplete) {
        messages.push({ id: pending.id, body: pending.chunks.join('') });
        pending = undefined;
      }
    }
    const next = view.page.nextCursor;
    if (next === null) {
      if (pending) return incomplete();
      result.messagesStatus = view.page.status === 'complete' ? 'complete' : 'incomplete';
      return result;
    }
    if (view.page.status !== 'incomplete' || !view.messages.length || next.revision !== revision
      || (pending ? next.messageId !== pending.id || next.bodyOffset !== pending.offset
        : next.bodyOffset !== 0 || messageIds.has(next.messageId))) return stale();
    const key = JSON.stringify(next);
    if (cursors.has(key)) return stale();
    cursors.add(key);
    cursor = next;
    signal.throwIfAborted();
    const response = await executeTeam(transport, scope, 'team.runSnapshot', { kind: 'team-run', runId }, { runId, messageCursor: cursor });
    signal.throwIfAborted();
    view = teamResultSnapshot(response.body, target);
  }
}

function teamResultSnapshot(value: unknown, target: AppTeamRunTarget) {
  if (!isRecord(value) || !isRecord(value.run) || value.run.teamId !== target.teamId
    || !Array.isArray(value.nodeExecutions) || !Array.isArray(value.artifacts) || !Array.isArray(value.messages)
    || !isRecord(value.messagePage) || !isTeamGraphVersion(value.messagePage.revision)
    || !['complete', 'incomplete', 'unavailable', 'stale'].includes(String(value.messagePage.status))
    || (value.messagePage.nextCursor !== null && !isTeamMessageCursor(value.messagePage.nextCursor))) throw unavailable('Team run results');
  const run = teamRun(value.run, target.runId);
  const currentAttempts = new Set<string>();
  const currentNodes = new Set<string>();
  for (const attempt of value.nodeExecutions) {
    if (!isRecord(attempt) || typeof attempt.currentAttempt !== 'boolean') throw unavailable('Team node executions');
    const fence = teamResultFence(attempt, target.runId);
    if (!attempt.currentAttempt) continue;
    if (currentNodes.has(attempt.nodeId as string)) throw unavailable('Team current attempt');
    currentNodes.add(attempt.nodeId as string);
    currentAttempts.add(fence);
  }
  return { run, currentAttempts, artifacts: value.artifacts, messages: value.messages,
    page: { revision: value.messagePage.revision, status: value.messagePage.status,
      nextCursor: value.messagePage.nextCursor } };
}

function teamResultFence(value: Record<string, unknown>, runId: string): string {
  if (value.runId !== runId || [value.nodeId, value.nodeExecutionId, value.attemptId]
    .some(id => typeof id !== 'string' || !id.length || id.includes('\0'))) throw unavailable('Team result ownership');
  return JSON.stringify([value.nodeId, value.nodeExecutionId, value.attemptId]);
}

async function executeTeam(transport: TeamRuntimeTransport, scope: AppTeamScope, operationId: string, target: Record<string, unknown>, input: Record<string, unknown>) {
  if (!isProductRuntimeEndpoint(scope.endpoint)) throw unsupportedEndpoint();
  const request = { id: 'team.runtime', operationId, scope: { kind: 'runtime-instance', endpoint: scope.endpoint }, target, input };
  if (!isTeamRuntimeCapabilityRequest(request)) throw invalid('Team execution requires the native source Agent and exact operation fields.');
  const response = await transport.execute(request);
  if (isTeamDesignFailure(response.body)) throw new AppPluginError('conflict', response.body.error);
  if (response.status !== 200) throw unavailable('Team execution outcome');
  return response;
}

function teamRun(value: unknown, runId: string): Pick<AppTeamRun, 'runId' | 'status' | 'revision'> {
  if (!isRecord(value) || value.runId !== runId || !TEAM_RUN_STATUSES.includes(value.status as AppTeamRunStatus)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw unavailable('Team run');
  return { runId, status: value.status as AppTeamRunStatus, revision: value.revision };
}

function invalid(message: string): AppPluginError {
  return new AppPluginError('invalid_package', message);
}

function unsupportedEndpoint(): AppPluginError {
  return invalid('Execution requires an explicit local OpenClaw or Matcha Agent identity; connector endpoints and workspace overrides are not supported.');
}

function unavailable(subject: string): AppPluginError {
  return new AppPluginError('busy', `${subject} is unavailable.`);
}
