import type { SessionPromptResult } from '../../../shared/session-adapter-types';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import { buildRuntimeEndpointKey } from '../../agent-runtime/contracts/runtime-address';
import type { ApplicationResponseOf } from '../../common/application-response';
import type { TeamRoleSessionBinding } from '../domain/team-run';
import type { TeamRoleEndpointSessionMaterializationPort } from '../ports/team-role-session-materialization-port';
import type {
  AbortTeamRoleSessionInput,
  DeleteTeamRoleSessionInput,
  EnsureTeamRoleSessionInput,
  PromptTeamRoleSessionInput,
  ReadTeamRoleSessionWindowInput,
  RememberTeamRoleSessionBindingInput,
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
  readonly agentRuntimeRegistry: Pick<AgentRuntimeRegistry, 'rememberSessionIdentity' | 'forgetSessionContext'>;
  readonly endpointSessionMaterialization?: TeamRoleEndpointSessionMaterializationPort;
}

export class SessionRuntimeTeamRoleSessionAdapter implements TeamRoleSessionPort {
  constructor(private readonly deps: SessionRuntimeRoleSessionAdapterDeps) {}

  private resolveEndpointSessionId(binding: TeamRoleSessionBinding): string {
    return this.deps.endpointSessionMaterialization?.resolveEndpointSessionId(binding) ?? binding.endpointSessionId;
  }

  private rememberRuntimeSessionBinding(binding: TeamRoleSessionBinding): void {
    this.deps.agentRuntimeRegistry.rememberSessionIdentity(
      binding.sessionIdentity,
      this.resolveEndpointSessionId(binding),
    );
  }

  async ensureRoleSession(input: EnsureTeamRoleSessionInput): Promise<TeamRoleSessionBinding> {
    const binding = buildTeamRoleSessionBinding(input);
    const endpointSessionId = this.resolveEndpointSessionId(binding);
    const response = await this.deps.createSession({
      sessionKey: binding.localSessionId,
      endpoint: binding.endpointRef,
      agentId: binding.agentId,
      endpointSessionId,
    });
    assertSuccessfulSessionRuntimeResponse(response, `Unable to ensure Team role session ${binding.localSessionId}`);
    try {
      await this.deps.endpointSessionMaterialization?.materializeEndpointSession(binding);
    } catch (error) {
      await this.cleanupCreatedRoleSession(binding).catch(() => undefined);
      throw error;
    }
    this.rememberRuntimeSessionBinding(binding);
    return binding;
  }

  async rememberRoleSessionBinding(input: RememberTeamRoleSessionBindingInput): Promise<void> {
    assertTeamRoleSessionBinding(input.binding);
    this.rememberRuntimeSessionBinding(input.binding);
  }

  private async cleanupCreatedRoleSession(binding: TeamRoleSessionBinding): Promise<void> {
    const response = await this.deps.deleteSession({
      sessionKey: binding.localSessionId,
      sessionIdentity: binding.sessionIdentity,
    });
    if (response.status !== 404) {
      assertSuccessfulSessionRuntimeResponse(response, `Unable to clean up Team role session ${binding.localSessionId}`);
    }
    this.deps.agentRuntimeRegistry.forgetSessionContext(binding.sessionIdentity);
  }

  async promptRoleSession(input: PromptTeamRoleSessionInput): Promise<TeamRolePromptResult> {
    const response = await this.deps.promptSession({
      sessionKey: input.binding.localSessionId,
      endpointSessionId: this.resolveEndpointSessionId(input.binding),
      sessionIdentity: input.binding.sessionIdentity,
      message: input.message,
      ...(typeof input.displayMessage === 'string' ? { displayMessage: input.displayMessage } : {}),
      idempotencyKey: input.idempotencyKey,
      ...(typeof input.deliver === 'boolean' ? { deliver: input.deliver } : {}),
    });
    const data = readSuccessfulSessionRuntimeData<SessionPromptResult>(response, `Unable to prompt Team role session ${input.binding.localSessionId}`);
    const promptRunId = typeof data.runId === 'string' && data.runId.trim() ? data.runId : input.idempotencyKey;
    return {
      runId: input.binding.runId,
      roleId: input.binding.roleId,
      localSessionId: input.binding.localSessionId,
      promptRunId,
    };
  }

  async abortRoleSession(input: AbortTeamRoleSessionInput): Promise<void> {
    const response = await this.deps.abortSession({
      sessionKey: input.binding.localSessionId,
      endpointSessionId: this.resolveEndpointSessionId(input.binding),
      sessionIdentity: input.binding.sessionIdentity,
      ...(input.runId ? { runId: input.runId } : {}),
    });
    assertSuccessfulSessionRuntimeResponse(response, `Unable to abort Team role session ${input.binding.localSessionId}`);
  }

  async deleteRoleSession(input: DeleteTeamRoleSessionInput): Promise<void> {
    let deletedLocalSession = false;
    const response = await this.deps.deleteSession({
      sessionKey: input.binding.localSessionId,
      sessionIdentity: input.binding.sessionIdentity,
    });
    if (response.status === 404) {
      deletedLocalSession = true;
    } else {
      assertSuccessfulSessionRuntimeResponse(response, `Unable to delete Team role session ${input.binding.localSessionId}`);
      deletedLocalSession = true;
    }
    await this.deps.endpointSessionMaterialization?.dematerializeEndpointSession(input.binding);
    if (deletedLocalSession) {
      this.deps.agentRuntimeRegistry.forgetSessionContext(input.binding.sessionIdentity);
    }
  }

  async readRoleSessionWindow(input: ReadTeamRoleSessionWindowInput): Promise<TeamRoleSessionWindow> {
    const response = await this.deps.getSessionWindow({
      sessionKey: input.binding.localSessionId,
      endpointSessionId: this.resolveEndpointSessionId(input.binding),
      sessionIdentity: input.binding.sessionIdentity,
      limit: input.limit,
    });
    if (response.status === 202) {
      return {
        resultType: 'pending_hydration',
        localSessionId: input.binding.localSessionId,
        message: `Session window for Team role ${input.binding.roleId} is hydrating. Retry readRoleSessionWindow after the queued hydration job completes.`,
      };
    }
    if (response.status !== 200) {
      return {
        resultType: 'unavailable',
        localSessionId: input.binding.localSessionId,
        message: sessionRuntimeErrorMessage(response.data) ?? `Unable to read Team role session window ${input.binding.localSessionId}: session runtime returned HTTP ${response.status}.`,
      };
    }
    const snapshot = readSnapshot(response.data);
    if (!snapshot || !Array.isArray(snapshot.items)) {
      return {
        resultType: 'unavailable',
        localSessionId: input.binding.localSessionId,
        message: `Unable to read Team role session window ${input.binding.localSessionId}: session runtime did not return a snapshot.items window.`,
      };
    }
    return {
      resultType: 'available',
      localSessionId: input.binding.localSessionId,
      items: snapshot.items,
    };
  }
}

function buildTeamRoleSessionBinding(input: EnsureTeamRoleSessionInput): TeamRoleSessionBinding {
  const sessionIdentity = input.sessionIdentity ?? {
    endpoint: input.endpointRef,
    agentId: input.agentId,
    sessionKey: input.localSessionId,
  };
  const binding: TeamRoleSessionBinding = {
    ...(input.teamId ? { teamId: input.teamId } : {}),
    runId: input.runId,
    roleId: input.roleId,
    agentId: input.agentId,
    endpointRef: input.endpointRef,
    localSessionId: input.localSessionId,
    endpointSessionId: input.endpointSessionId,
    sessionIdentity,
  };
  assertTeamRoleSessionBinding(binding);
  return binding;
}

function assertTeamRoleSessionBinding(binding: TeamRoleSessionBinding): void {
  if (binding.localSessionId.trim() === '') {
    throw new Error('Team role session identity must include a localSessionId before ensuring the role session.');
  }
  if (binding.localSessionId !== binding.localSessionId.trim()) {
    throw new Error('Team role localSessionId must be trimmed before ensuring the role session.');
  }
  if (binding.endpointSessionId.trim() === '') {
    throw new Error('Team role session identity must include an endpointSessionId before ensuring the role session.');
  }
  if (binding.endpointSessionId !== binding.endpointSessionId.trim()) {
    throw new Error('Team role endpointSessionId must be trimmed before ensuring the role session.');
  }
  if (binding.endpointSessionId.startsWith('agent:')) {
    throw new Error('Team role endpointSessionId must be opaque and must not contain OpenClaw agent-prefixed grammar.');
  }
  if (binding.sessionIdentity.sessionKey !== binding.localSessionId) {
    throw new Error('Team role localSessionId must match SessionIdentity.sessionKey.');
  }
  if (binding.sessionIdentity.agentId !== binding.agentId) {
    throw new Error(`Team role agentId ${binding.agentId} must match SessionIdentity.agentId ${binding.sessionIdentity.agentId}.`);
  }
  if (buildRuntimeEndpointKey(binding.sessionIdentity.endpoint) !== buildRuntimeEndpointKey(binding.endpointRef)) {
    throw new Error('Team role endpointRef must match SessionIdentity.endpoint.');
  }
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
