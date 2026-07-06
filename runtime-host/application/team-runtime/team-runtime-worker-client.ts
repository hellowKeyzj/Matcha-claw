import { Worker } from 'node:worker_threads';
import type { ApplicationResponseOf } from '../common/application-response';
import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { RuntimeHostLogger } from '../../shared/logger';
import { isTeamRuntimeDebugLoggingEnabled } from './team-runtime-debug-logging';
import type { TeamRuntimeOperationId } from './team-runtime-operation-id';
import type { TeamAgentMaterializationPort } from './ports/team-agent-materialization-port';
import type { TeamRoleSessionPort } from './ports/team-role-session-port';
import type { SkillsService } from '../skills/service';
import type { TeamRuntimeJobPort } from './team-runtime-jobs';
import type { TeamRuntimePort } from './team-runtime-port';
import type {
  TeamRuntimeHostRequest,
  TeamRuntimeHostResponse,
  TeamRuntimeMainToWorkerMessage,
  TeamRuntimeWorkerConfig,
  TeamRuntimeWorkerResponse,
  TeamRuntimeWorkerToMainMessage,
  TeamRuntimeWorkerError,
} from './team-runtime-worker-contracts';

type TeamRuntimeWorkerClientLogger = Pick<RuntimeHostLogger, 'debug' | 'warn' | 'error'>;
type TeamRuntimeWorkerClientOperationId = TeamRuntimeOperationId | 'team-runtime.close';

interface TeamRuntimeWorkerClientDeps {
  readonly workerScriptPath: string;
  readonly config: TeamRuntimeWorkerConfig;
  readonly roleSessions: TeamRoleSessionPort;
  readonly agentMaterialization: TeamAgentMaterializationPort;
  readonly jobs: TeamRuntimeJobPort;
  readonly skillsService: Pick<SkillsService, 'refreshStatus'>;
  readonly logger?: TeamRuntimeWorkerClientLogger;
}

interface PendingInvoke {
  readonly resolve: (value: ApplicationResponseOf) => void;
  readonly reject: (error: Error) => void;
  readonly operationId: TeamRuntimeWorkerClientOperationId;
  readonly startedAtMs: number;
}

interface TeamRuntimeWorkerLogFields {
  readonly requestId?: string;
  readonly operationId?: string;
  readonly hostRequestType?: TeamRuntimeHostRequest['type'];
  readonly status: string;
  readonly durationMs?: number;
  readonly pendingCount?: number;
  readonly exitCode?: number;
  readonly errorName?: string;
}

export class WorkerBackedTeamRuntimeService implements TeamRuntimePort {
  private readonly worker: Worker;
  private nextRequestId = 0;
  private closed = false;
  private readonly pending = new Map<string, PendingInvoke>();

  constructor(private readonly deps: TeamRuntimeWorkerClientDeps) {
    this.worker = new Worker(deps.workerScriptPath, {
      workerData: deps.config,
    });
    this.logWorkerRpc('worker start', { status: 'started' });
    this.worker.on('message', (message: TeamRuntimeWorkerToMainMessage) => {
      void this.handleWorkerMessage(message);
    });
    this.worker.on('error', (error) => {
      this.logWorkerRpc('worker error', { status: 'errored', errorName: safeErrorName(error) });
      this.rejectAll(error);
    });
    this.worker.on('exit', (code) => {
      this.logWorkerRpc('worker exit', { status: 'exited', exitCode: code });
      this.closed = true;
      if (code !== 0) {
        this.rejectAll(new Error(`TeamRuntime worker exited with code ${code}`));
      }
    });
  }

  async invoke(operationId: TeamRuntimeOperationId, params: unknown, scope?: RuntimeScope): Promise<ApplicationResponseOf> {
    if (this.closed) {
      this.logWorkerRpc('invoke error', { operationId, status: 'failed', errorName: 'TeamRuntimeWorkerClosed' });
      throw new Error('TeamRuntime worker is closed');
    }
    const requestId = `team-worker-${++this.nextRequestId}`;
    return await this.sendWorkerRequest(requestId, operationId, {
      type: 'team-runtime.invoke',
      requestId,
      operationId,
      params,
      ...(scope ? { scope } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    const startedAtMs = Date.now();
    this.logWorkerRpc('worker close', { status: 'closing' });
    try {
      await this.invokeWorkerClose();
    } finally {
      this.closed = true;
      await this.worker.terminate();
      this.rejectAll(new Error('TeamRuntime worker closed'));
      this.logWorkerRpc('worker close', { status: 'closed', durationMs: elapsedMsSince(startedAtMs) });
    }
  }

  private async invokeWorkerClose(): Promise<void> {
    const requestId = `team-worker-${++this.nextRequestId}`;
    await this.sendWorkerRequest(requestId, 'team-runtime.close', { type: 'team-runtime.close', requestId });
  }

  private async sendWorkerRequest(
    requestId: string,
    operationId: TeamRuntimeWorkerClientOperationId,
    message: TeamRuntimeMainToWorkerMessage,
  ): Promise<ApplicationResponseOf> {
    const startedAtMs = Date.now();
    return await new Promise<ApplicationResponseOf>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, operationId, startedAtMs });
      try {
        this.post(message);
        this.logWorkerRpc('invoke send', { requestId, operationId, status: 'sent' });
      } catch (error) {
        this.pending.delete(requestId);
        this.logWorkerRpc('invoke error', {
          requestId,
          operationId,
          status: 'failed',
          durationMs: elapsedMsSince(startedAtMs),
          errorName: safeErrorName(error),
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private post(message: TeamRuntimeMainToWorkerMessage): void {
    this.worker.postMessage(message);
  }

  private async handleWorkerMessage(message: TeamRuntimeWorkerToMainMessage): Promise<void> {
    if (message.type === 'team-runtime.result') {
      this.resolveInvoke(message);
      return;
    }
    await this.handleHostRequest(message);
  }

  private resolveInvoke(message: TeamRuntimeWorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.logWorkerRpc('invoke result', { requestId: message.requestId, status: 'orphaned' });
      return;
    }
    this.pending.delete(message.requestId);
    const durationMs = elapsedMsSince(pending.startedAtMs);
    if (message.ok) {
      this.logWorkerRpc('invoke result', {
        requestId: message.requestId,
        operationId: pending.operationId,
        status: 'succeeded',
        durationMs,
      });
      pending.resolve(message.response);
      return;
    }
    this.logWorkerRpc('invoke error', {
      requestId: message.requestId,
      operationId: pending.operationId,
      status: 'failed',
      durationMs,
      errorName: message.error.name ?? 'Error',
    });
    pending.reject(errorFromWorker(message.error));
  }

  private async handleHostRequest(message: TeamRuntimeHostRequest): Promise<void> {
    const startedAtMs = Date.now();
    this.logWorkerRpc('host request dispatch', {
      requestId: message.requestId,
      hostRequestType: message.type,
      status: 'dispatching',
    });
    try {
      const result = await this.dispatchHostRequest(message);
      this.post({ type: 'host.result', requestId: message.requestId, ok: true, result } satisfies TeamRuntimeHostResponse);
      this.logWorkerRpc('host request result', {
        requestId: message.requestId,
        hostRequestType: message.type,
        status: 'succeeded',
        durationMs: elapsedMsSince(startedAtMs),
      });
    } catch (error) {
      this.post({ type: 'host.result', requestId: message.requestId, ok: false, error: serializeError(error) } satisfies TeamRuntimeHostResponse);
      this.logWorkerRpc('host request error', {
        requestId: message.requestId,
        hostRequestType: message.type,
        status: 'failed',
        durationMs: elapsedMsSince(startedAtMs),
        errorName: safeErrorName(error),
      });
    }
  }

  private async dispatchHostRequest(message: TeamRuntimeHostRequest): Promise<unknown> {
    switch (message.type) {
      case 'host.roleSession.ensure':
        return await this.deps.roleSessions.ensureRoleSession(message.input);
      case 'host.roleSession.remember':
        await this.deps.roleSessions.rememberRoleSessionBinding(message.input);
        return { success: true };
      case 'host.roleSession.prompt':
        return await this.deps.roleSessions.promptRoleSession(message.input);
      case 'host.roleSession.abort':
        return await this.deps.roleSessions.abortRoleSession(message.input);
      case 'host.roleSession.delete':
        return await this.deps.roleSessions.deleteRoleSession(message.input);
      case 'host.roleSession.readWindow':
        return await this.deps.roleSessions.readRoleSessionWindow(message.input);
      case 'host.agentMaterialization.materialize':
        return await this.deps.agentMaterialization.materialize(message.input);
      case 'host.agentMaterialization.remove':
        await this.deps.agentMaterialization.removeTeamAgents(message.input);
        return { success: true };
      case 'host.job.deleteManagedAgents':
        return await this.deps.jobs.submitDeleteManagedAgents(message.input);
      case 'host.skillCatalog.snapshot':
        return await this.deps.skillsService.refreshStatus();
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private logWorkerRpc(event: string, fields: TeamRuntimeWorkerLogFields): void {
    if (!isTeamRuntimeDebugLoggingEnabled()) {
      return;
    }
    const logFields = {
      requestId: fields.requestId ?? 'none',
      operationId: fields.operationId ?? 'none',
      hostRequestType: fields.hostRequestType ?? 'none',
      status: fields.status,
      durationMs: fields.durationMs ?? 0,
      pendingCount: fields.pendingCount ?? this.pending.size,
      ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
      ...(fields.errorName ? { errorName: fields.errorName } : {}),
    };

    if (fields.status === 'failed' || fields.status === 'errored') {
      this.deps.logger?.warn(`[team-runtime:worker-client] ${event}`, logFields);
      return;
    }

    this.deps.logger?.debug(`[team-runtime:worker-client] ${event}`, logFields);
  }
}

function elapsedMsSince(startedAtMs: number): number {
  return Date.now() - startedAtMs;
}

function safeErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return typeof error;
}

function errorFromWorker(error: TeamRuntimeWorkerError): Error {
  const next = new Error(error.message);
  next.name = error.name ?? next.name;
  if (error.stack) {
    next.stack = error.stack;
  }
  return next;
}

function serializeError(error: unknown): TeamRuntimeWorkerError {
  return error instanceof Error
    ? { message: error.message, name: error.name, stack: error.stack }
    : { message: String(error) };
}
