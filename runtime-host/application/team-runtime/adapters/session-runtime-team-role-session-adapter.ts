import type { SessionPromptResult } from '../../../shared/session-adapter-types';
import type { ApplicationResponseOf } from '../../common/application-response';
import type { TeamRoleSessionBinding } from '../domain/team-run';
import type { TeamRoleEndpointSessionMaterializationPort } from '../ports/team-role-session-materialization-port';
import type {
  AbortTeamRoleSessionInput,
  DeleteTeamRoleSessionInput,
  EnsureTeamRoleSessionInput,
  PromptTeamRoleSessionInput,
  ReadTeamRoleSessionWindowInput,
  TeamRolePromptResult,
  TeamRoleSessionPort,
  TeamRoleSessionWindow,
} from '../ports/team-role-session-port';

interface SessionRuntimeRoleSessionAdapterDeps {
  readonly createSession: (payload: unknown) => Promise<ApplicationResponseOf>;
  readonly promptSession: (payload: unknown) => Promise<ApplicationResponseOf>;
  readonly abortSession: (payload: unknown) => Promise<ApplicationResponseOf>;
  readonly deleteSession: (payload: unknown) => Promise<ApplicationResponseOf>;
  readonly getSessionWindow: (payload: unknown) => Promise<ApplicationResponseOf>;
  readonly endpointSessionMaterialization?: TeamRoleEndpointSessionMaterializationPort;
}

export class SessionRuntimeTeamRoleSessionAdapter implements TeamRoleSessionPort {
  constructor(private readonly deps: SessionRuntimeRoleSessionAdapterDeps) {}

  async ensureRoleSession(input: EnsureTeamRoleSessionInput): Promise<TeamRoleSessionBinding> {
    const binding = buildTeamRoleSessionBinding(input);
    const response = await this.deps.createSession({
      sessionKey: binding.sessionKey,
      endpoint: binding.sessionIdentity.endpoint,
      agentId: binding.agentId,
    });
    assertSuccessfulSessionRuntimeResponse(response, `Unable to ensure Team role session ${binding.sessionKey}`);
    await this.deps.endpointSessionMaterialization?.materializeEndpointSession(binding);
    return binding;
  }

  async promptRoleSession(input: PromptTeamRoleSessionInput): Promise<TeamRolePromptResult> {
    const response = await this.deps.promptSession({
      sessionKey: input.binding.sessionKey,
      sessionIdentity: input.binding.sessionIdentity,
      message: input.message,
      ...(typeof input.displayMessage === 'string' ? { displayMessage: input.displayMessage } : {}),
      idempotencyKey: input.idempotencyKey,
      ...(typeof input.deliver === 'boolean' ? { deliver: input.deliver } : {}),
    });
    const data = readSuccessfulSessionRuntimeData<SessionPromptResult>(response, `Unable to prompt Team role session ${input.binding.sessionKey}`);
    const promptRunId = typeof data.runId === 'string' && data.runId.trim() ? data.runId : input.idempotencyKey;
    return {
      runId: input.binding.runId,
      roleId: input.binding.roleId,
      sessionKey: data.sessionKey || input.binding.sessionKey,
      promptRunId,
    };
  }

  async abortRoleSession(input: AbortTeamRoleSessionInput): Promise<void> {
    const response = await this.deps.abortSession({
      sessionKey: input.binding.sessionKey,
      sessionIdentity: input.binding.sessionIdentity,
      ...(input.runId ? { runId: input.runId } : {}),
    });
    assertSuccessfulSessionRuntimeResponse(response, `Unable to abort Team role session ${input.binding.sessionKey}`);
  }

  async deleteRoleSession(input: DeleteTeamRoleSessionInput): Promise<void> {
    const response = await this.deps.deleteSession({
      sessionKey: input.binding.sessionKey,
      sessionIdentity: input.binding.sessionIdentity,
    });
    if (response.status === 404) {
      return;
    }
    assertSuccessfulSessionRuntimeResponse(response, `Unable to delete Team role session ${input.binding.sessionKey}`);
  }

  async readRoleSessionWindow(input: ReadTeamRoleSessionWindowInput): Promise<TeamRoleSessionWindow> {
    const response = await this.deps.getSessionWindow({
      sessionKey: input.binding.sessionKey,
      sessionIdentity: input.binding.sessionIdentity,
      limit: input.limit,
    });
    if (response.status === 202) {
      return {
        resultType: 'pending_hydration',
        sessionKey: input.binding.sessionKey,
        message: `Session window for Team role ${input.binding.roleId} is hydrating. Retry readRoleSessionWindow after the queued hydration job completes.`,
      };
    }
    if (response.status !== 200) {
      return {
        resultType: 'unavailable',
        sessionKey: input.binding.sessionKey,
        message: sessionRuntimeErrorMessage(response.data) ?? `Unable to read Team role session window ${input.binding.sessionKey}: session runtime returned HTTP ${response.status}.`,
      };
    }
    const snapshot = readSnapshot(response.data);
    if (!snapshot || !Array.isArray(snapshot.items)) {
      return {
        resultType: 'unavailable',
        sessionKey: input.binding.sessionKey,
        message: `Unable to read Team role session window ${input.binding.sessionKey}: session runtime did not return a snapshot.items window.`,
      };
    }
    return {
      resultType: 'available',
      sessionKey: input.binding.sessionKey,
      items: snapshot.items,
    };
  }
}

function buildTeamRoleSessionBinding(input: EnsureTeamRoleSessionInput): TeamRoleSessionBinding {
  if (input.sessionIdentity.sessionKey.trim() === '') {
    throw new Error('Team role session identity must include a sessionKey before ensuring the role session.');
  }
  if (input.sessionIdentity.sessionKey !== input.sessionIdentity.sessionKey.trim()) {
    throw new Error('Team role session identity sessionKey must be trimmed before ensuring the role session.');
  }
  if (input.sessionIdentity.agentId !== input.agentId) {
    throw new Error(`Team role agentId ${input.agentId} must match SessionIdentity.agentId ${input.sessionIdentity.agentId}.`);
  }
  return {
    ...(input.teamId ? { teamId: input.teamId } : {}),
    runId: input.runId,
    roleId: input.roleId,
    agentId: input.agentId,
    sessionIdentity: input.sessionIdentity,
    sessionKey: input.sessionIdentity.sessionKey,
  };
}

function assertSuccessfulSessionRuntimeResponse(response: ApplicationResponseOf, prefix: string): void {
  readSuccessfulSessionRuntimeData(response, prefix);
}

function readSuccessfulSessionRuntimeData<T>(response: ApplicationResponseOf, prefix: string): T {
  if (response.status === 200) {
    return response.data as T;
  }
  throw new Error(`${prefix}: ${sessionRuntimeErrorMessage(response.data) ?? `session runtime returned HTTP ${response.status}`}`);
}

function sessionRuntimeErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const error = (data as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() ? error : null;
}

function readSnapshot(data: unknown): { items?: unknown } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const snapshot = (data as { snapshot?: unknown }).snapshot;
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as { items?: unknown }
    : null;
}
