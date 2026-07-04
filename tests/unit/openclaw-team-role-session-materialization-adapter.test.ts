import { describe, expect, it, vi } from 'vitest';
import { OpenClawTeamRoleSessionMaterializationAdapter } from '../../runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-role-session-materialization-adapter';
import type { TeamRoleSessionBinding } from '../../runtime-host/application/team-runtime/domain/team-run';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

function createBinding(sessionKey = 'agent:mct-team:team-role:run-1:reviewer', agentId = 'mct-team'): TeamRoleSessionBinding {
  const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey, agentId);
  return {
    teamId: 'team-1',
    runId: 'run-1',
    roleId: 'reviewer',
    agentId,
    sessionIdentity,
    sessionKey,
  };
}

describe('OpenClawTeamRoleSessionMaterializationAdapter', () => {
  it('creates the matching OpenClaw gateway session entry for a Team role binding', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true, key: 'agent:mct-team:team-role:run-1:reviewer' }));
    const adapter = new OpenClawTeamRoleSessionMaterializationAdapter({ gateway: { gatewayRpc } });
    const binding = createBinding();

    await adapter.materializeEndpointSession(binding);

    expect(gatewayRpc).toHaveBeenCalledWith('sessions.create', {
      key: 'agent:mct-team:team-role:run-1:reviewer',
      agentId: 'mct-team',
    }, 10_000);
  });

  it('does not touch OpenClaw gateway for non-OpenClaw endpoints', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const adapter = new OpenClawTeamRoleSessionMaterializationAdapter({ gateway: { gatewayRpc } });
    const binding: TeamRoleSessionBinding = {
      ...createBinding('protocol-session', 'role-agent'),
      agentId: 'role-agent',
      sessionIdentity: {
        endpoint: {
          kind: 'protocol-connector',
          protocolId: 'acp',
          connectorId: 'local-acp',
          endpointId: 'default',
        },
        agentId: 'role-agent',
        sessionKey: 'protocol-session',
      },
      sessionKey: 'protocol-session',
    };

    await adapter.materializeEndpointSession(binding);

    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
