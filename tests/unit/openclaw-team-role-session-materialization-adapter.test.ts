import { describe, expect, it, vi } from 'vitest';
import { OpenClawTeamRoleSessionMaterializationAdapter } from '../../runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-role-session-materialization-adapter';
import type { TeamRoleSessionBinding } from '../../runtime-host/application/team-runtime/domain/team-run';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

function createBinding(
  endpointSessionId = 'team-endpoint-session-run-1-reviewer',
  agentId = 'mct-team',
  localSessionId = 'team-role-session-run-1-reviewer',
): TeamRoleSessionBinding {
  const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, agentId);
  return {
    teamId: 'team-1',
    runId: 'run-1',
    roleId: 'reviewer',
    agentId,
    endpointRef: openClawTestRuntimeEndpoint,
    localSessionId,
    endpointSessionId,
    sessionIdentity,
  };
}

describe('OpenClawTeamRoleSessionMaterializationAdapter', () => {
  it('creates the matching OpenClaw gateway session entry for a Team role binding', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true, key: 'agent:mct-team:team-endpoint-session-run-1-reviewer' }));
    const adapter = new OpenClawTeamRoleSessionMaterializationAdapter({ gateway: { gatewayRpc } });
    const binding = createBinding();

    expect(adapter.resolveEndpointSessionId(binding)).toBe('agent:mct-team:team-endpoint-session-run-1-reviewer');

    await adapter.materializeEndpointSession(binding);

    expect(gatewayRpc).toHaveBeenCalledWith('sessions.create', {
      key: 'agent:mct-team:team-endpoint-session-run-1-reviewer',
      agentId: 'mct-team',
    }, 10_000);
  });

  it('deletes the matching OpenClaw gateway session entry for a Team role binding', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const adapter = new OpenClawTeamRoleSessionMaterializationAdapter({ gateway: { gatewayRpc } });
    const binding = createBinding();

    await adapter.dematerializeEndpointSession(binding);

    expect(gatewayRpc).toHaveBeenCalledWith('sessions.delete', {
      key: 'agent:mct-team:team-endpoint-session-run-1-reviewer',
      agentId: 'mct-team',
    }, 10_000);
  });

  it('does not touch OpenClaw gateway for non-OpenClaw endpoints', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const adapter = new OpenClawTeamRoleSessionMaterializationAdapter({ gateway: { gatewayRpc } });
    const protocolEndpoint = {
      kind: 'protocol-connector',
      protocolId: 'acp',
      connectorId: 'local-acp',
      endpointId: 'default',
    } as const;
    const binding: TeamRoleSessionBinding = {
      ...createBinding('protocol-endpoint-session', 'role-agent', 'protocol-local-session'),
      agentId: 'role-agent',
      endpointRef: protocolEndpoint,
      sessionIdentity: {
        endpoint: protocolEndpoint,
        agentId: 'role-agent',
        sessionKey: 'protocol-local-session',
      },
    };

    expect(adapter.resolveEndpointSessionId(binding)).toBe('protocol-endpoint-session');

    await adapter.materializeEndpointSession(binding);

    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
