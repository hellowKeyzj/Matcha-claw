import type { TeamAgentMaterializationPort, TeamAgentMaterializationResult, RemoveTeamAgentsInput, TeamAgentMaterializationSpec } from './ports/team-agent-materialization-port';
import type {
  AbortTeamRoleSessionInput,
  DeleteTeamRoleSessionInput,
  EnsureTeamRoleSessionInput,
  PromptTeamRoleSessionInput,
  ReadTeamRoleSessionWindowInput,
  TeamRolePromptResult,
  TeamRoleSessionPort,
  TeamRoleSessionWindow,
} from './ports/team-role-session-port';
import type { TeamSkillCatalogPort } from './team-runtime-service';
import type { DeleteTeamManagedAgentsJobPayload, TeamRuntimeJobPort, TeamRuntimeJobSubmission } from './team-runtime-jobs';
import { isTeamRuntimeDebugLoggingEnabled } from './team-runtime-debug-logging';
import type { TeamRuntimeHostRequest, TeamRuntimeHostResponse } from './team-runtime-worker-contracts';
import type { TeamRoleSessionBinding } from './domain/team-run';

type SendHostRequest = (message: TeamRuntimeHostRequest) => void;
type PendingHostRequest = {
  readonly type: TeamRuntimeHostRequest['type'];
  readonly startedAtMs: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

const HOST_RPC_LOG_NAMESPACE = '[team-runtime:worker-host-rpc]';
const LOG_TEXT_LIMIT = 240;

function formatHostRpcLogFields(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function logHostRpcInfo(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.info(`${HOST_RPC_LOG_NAMESPACE} ${event} ${formatHostRpcLogFields(fields)}`);
  }
}

function logHostRpcWarn(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.warn(`${HOST_RPC_LOG_NAMESPACE} ${event} ${formatHostRpcLogFields(fields)}`);
  }
}

function logHostRpcError(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.error(`${HOST_RPC_LOG_NAMESPACE} ${event} ${formatHostRpcLogFields(fields)}`);
  }
}

function sanitizeLogText(value: string): string {
  const redacted = value
    .replace(/(api[_-]?key|authorization|token|password|secret)(["'\s:=]+)[^"'\s,}]+/gi, '$1$2[redacted]')
    .replace(/(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20,})/g, '$1sk-[redacted]');
  return redacted.length <= LOG_TEXT_LIMIT ? redacted : `${redacted.slice(0, LOG_TEXT_LIMIT)}…`;
}

function hostRpcErrorSummary(error: unknown): { readonly errorName: string; readonly errorMessage: string } {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: sanitizeLogText(error.message) };
  }
  return { errorName: typeof error, errorMessage: sanitizeLogText(String(error)) };
}

function hostResponseErrorSummary(error: { readonly name?: string; readonly message: string }): { readonly errorName: string; readonly errorMessage: string } {
  return { errorName: error.name ?? 'Error', errorMessage: sanitizeLogText(error.message) };
}

export class TeamRuntimeWorkerHostRpc {
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingHostRequest>();

  constructor(private readonly send: SendHostRequest) {}

  pendingCount(): number {
    return this.pending.size;
  }

  request(type: TeamRuntimeHostRequest['type'], input: unknown): Promise<unknown> {
    const requestId = `team-worker-host-${++this.nextRequestId}`;
    const message = { type, requestId, input } as TeamRuntimeHostRequest;
    const startedAtMs = Date.now();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { type, startedAtMs, resolve, reject });
      logHostRpcInfo('request send', { requestId, type, durationMs: 0, pendingCount: this.pending.size });
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(requestId);
        logHostRpcError('request error', {
          requestId,
          type,
          durationMs: Date.now() - startedAtMs,
          pendingCount: this.pending.size,
          ...hostRpcErrorSummary(error),
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  resolve(message: TeamRuntimeHostResponse): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) {
      logHostRpcWarn('request orphan', { requestId: message.requestId, type: message.type, durationMs: 0, pendingCount: this.pending.size });
      return;
    }
    this.pending.delete(message.requestId);
    if (message.ok) {
      logHostRpcInfo('request result', {
        requestId: message.requestId,
        type: entry.type,
        durationMs: Date.now() - entry.startedAtMs,
        pendingCount: this.pending.size,
      });
      entry.resolve(message.result);
      return;
    }
    logHostRpcError('request error', {
      requestId: message.requestId,
      type: entry.type,
      durationMs: Date.now() - entry.startedAtMs,
      pendingCount: this.pending.size,
      ...hostResponseErrorSummary(message.error),
    });
    entry.reject(new Error(message.error.message));
  }

  rejectAll(error: Error): void {
    for (const [requestId, entry] of this.pending.entries()) {
      logHostRpcWarn('request rejectAll', {
        requestId,
        type: entry.type,
        durationMs: Date.now() - entry.startedAtMs,
        pendingCount: this.pending.size,
        ...hostRpcErrorSummary(error),
      });
      entry.reject(error);
    }
    this.pending.clear();
  }
}

export class WorkerProxyTeamRoleSessionPort implements TeamRoleSessionPort {
  constructor(private readonly rpc: TeamRuntimeWorkerHostRpc) {}

  async ensureRoleSession(input: EnsureTeamRoleSessionInput): Promise<TeamRoleSessionBinding> {
    return await this.rpc.request('host.roleSession.ensure', input) as TeamRoleSessionBinding;
  }

  async promptRoleSession(input: PromptTeamRoleSessionInput): Promise<TeamRolePromptResult> {
    return await this.rpc.request('host.roleSession.prompt', input) as TeamRolePromptResult;
  }

  async abortRoleSession(input: AbortTeamRoleSessionInput): Promise<void> {
    await this.rpc.request('host.roleSession.abort', input);
  }

  async deleteRoleSession(input: DeleteTeamRoleSessionInput): Promise<void> {
    await this.rpc.request('host.roleSession.delete', input);
  }

  async readRoleSessionWindow(input: ReadTeamRoleSessionWindowInput): Promise<TeamRoleSessionWindow> {
    return await this.rpc.request('host.roleSession.readWindow', input) as TeamRoleSessionWindow;
  }
}

export class WorkerProxyTeamAgentMaterializationPort implements TeamAgentMaterializationPort {
  constructor(private readonly rpc: TeamRuntimeWorkerHostRpc) {}

  async materialize(input: TeamAgentMaterializationSpec): Promise<TeamAgentMaterializationResult> {
    return await this.rpc.request('host.agentMaterialization.materialize', input) as TeamAgentMaterializationResult;
  }

  async removeTeamAgents(input: RemoveTeamAgentsInput): Promise<void> {
    await this.rpc.request('host.agentMaterialization.remove', input);
  }
}

export class WorkerProxyTeamRuntimeJobPort implements TeamRuntimeJobPort {
  constructor(private readonly rpc: TeamRuntimeWorkerHostRpc) {}

  async submitDeleteManagedAgents(payload: DeleteTeamManagedAgentsJobPayload): Promise<TeamRuntimeJobSubmission> {
    return await this.rpc.request('host.job.deleteManagedAgents', payload) as TeamRuntimeJobSubmission;
  }
}

export class WorkerProxyTeamSkillCatalogPort implements TeamSkillCatalogPort {
  constructor(private readonly rpc: TeamRuntimeWorkerHostRpc) {}

  async snapshot(): Promise<unknown> {
    return await this.rpc.request('host.skillCatalog.snapshot', {});
  }
}
