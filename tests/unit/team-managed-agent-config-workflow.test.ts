import { describe, expect, it } from 'vitest';
import { TeamManagedAgentConfigWorkflow, type TeamManagedAgentConfigProjection } from '../../runtime-host/application/team-skill/team-managed-agent-config-workflow';

function createManagedConfig(runId = 'run-1'): TeamManagedAgentConfigProjection {
  return {
    kind: 'matchaclaw-team-managed-openclaw-agents',
    version: 1,
    source: 'matchaclaw.team-runtime',
    runId,
    leaderAgentId: `matchaclaw-team:${runId}:leader`,
    agents: [
      {
        id: `matchaclaw-team:${runId}:leader`,
        name: 'leader',
        workspace: `/runs/${runId}/leader`,
        agentDir: `/agents/${runId}/leader/agent`,
        skills: [],
        managedBy: 'matchaclaw.team-runtime',
        source: 'matchaclaw.team-runtime',
        managedRunId: runId,
        managedRoleId: 'leader',
        managedKind: 'team-role-agent',
        tools: {
          profile: 'coding',
          alsoAllow: ['sessions_spawn', 'sessions_yield', 'subagents'],
          deny: [],
        },
        sandbox: {
          mode: 'all',
          scope: 'agent',
          workspaceAccess: 'rw',
        },
        subagents: {
          allowAgents: [`matchaclaw-team:${runId}:operator-designer`],
          requireAgentId: true,
        },
      },
      {
        id: `matchaclaw-team:${runId}:operator-designer`,
        name: 'operator-designer',
        workspace: `/runs/${runId}/roles/operator-designer`,
        agentDir: `/agents/${runId}/operator-designer/agent`,
        skills: ['design'],
        managedBy: 'matchaclaw.team-runtime',
        source: 'matchaclaw.team-runtime',
        managedRunId: runId,
        managedRoleId: 'operator-designer',
        managedKind: 'team-role-agent',
        tools: {
          profile: 'coding',
          allow: ['team_submit_artifact', 'team_update_task'],
          deny: ['sessions_spawn', 'sessions_yield', 'subagents'],
        },
        sandbox: {
          mode: 'all',
          scope: 'agent',
          workspaceAccess: 'rw',
        },
      },
    ],
  };
}

describe('TeamManagedAgentConfigWorkflow', () => {
  it('upserts TeamRun agents into OpenClaw agents.list without touching unrelated agents', async () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: { workspace: '/main' },
        list: [
          { id: 'main', name: 'Main', workspace: '/main' },
          {
            id: 'matchaclaw-team:run-1:leader',
            name: 'old leader',
            workspace: '/old',
            managedBy: 'matchaclaw.team-runtime',
            source: 'matchaclaw.team-runtime',
            managedRunId: 'run-1',
            managedRoleId: 'leader',
            managedKind: 'team-role-agent',
          },
          {
            id: 'matchaclaw-team:run-1:removed-role',
            name: 'removed role',
            workspace: '/removed',
            managedBy: 'matchaclaw.team-runtime',
            source: 'matchaclaw.team-runtime',
            managedRunId: 'run-1',
            managedRoleId: 'removed-role',
            managedKind: 'team-role-agent',
          },
          { id: 'matchaclaw-team:run-2:leader', name: 'other run', workspace: '/other' },
        ],
      },
    };
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(config)).result,
      },
    });

    await expect(workflow.apply(createManagedConfig())).resolves.toEqual({
      changed: true,
      agentIds: ['matchaclaw-team:run-1:leader', 'matchaclaw-team:run-1:operator-designer'],
    });

    const agents = (config.agents as { list: Array<Record<string, unknown>> }).list;
    expect(agents.find((agent) => agent.id === 'main')).toEqual({ id: 'main', name: 'Main', workspace: '/main' });
    expect(agents.find((agent) => agent.id === 'matchaclaw-team:run-1:removed-role')).toBeUndefined();
    expect(agents.find((agent) => agent.id === 'matchaclaw-team:run-2:leader')).toEqual({
      id: 'matchaclaw-team:run-2:leader',
      name: 'other run',
      workspace: '/other',
    });
    expect(agents.find((agent) => agent.id === 'matchaclaw-team:run-1:leader')).toMatchObject({
      id: 'matchaclaw-team:run-1:leader',
      name: 'leader',
      workspace: '/runs/run-1/leader',
      managedBy: 'matchaclaw.team-runtime',
      source: 'matchaclaw.team-runtime',
      managedRunId: 'run-1',
      managedRoleId: 'leader',
      managedKind: 'team-role-agent',
      subagents: {
        allowAgents: ['matchaclaw-team:run-1:operator-designer'],
        requireAgentId: true,
      },
    });
    expect(agents.find((agent) => agent.id === 'matchaclaw-team:run-1:operator-designer')).toMatchObject({
      id: 'matchaclaw-team:run-1:operator-designer',
      managedBy: 'matchaclaw.team-runtime',
      source: 'matchaclaw.team-runtime',
      managedRunId: 'run-1',
      managedRoleId: 'operator-designer',
      managedKind: 'team-role-agent',
      tools: {
        allow: ['team_submit_artifact', 'team_update_task'],
        deny: ['sessions_spawn', 'sessions_yield', 'subagents'],
      },
    });
  });

  it('rejects managed agent ids that do not belong to the TeamRun', async () => {
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate({})).result,
      },
    });
    const config = createManagedConfig('run-1');
    config.agents[0] = { ...config.agents[0]!, id: 'matchaclaw-team:run-2:leader' };

    await expect(workflow.apply(config)).rejects.toThrow('Team managed agent id does not belong to run run-1');
  });

  it('does not delete prefix-matching agents unless structured ownership matches the current run', async () => {
    const config: Record<string, unknown> = {
      agents: {
        list: [
          {
            id: 'matchaclaw-team:run-1:external-role',
            name: 'unowned prefix match',
            managedBy: 'someone-else',
            source: 'someone-else',
            managedRunId: 'run-1',
            managedKind: 'team-role-agent',
          },
          {
            id: 'matchaclaw-team:run-1:missing-source',
            name: 'missing source',
            managedBy: 'matchaclaw.team-runtime',
            managedRunId: 'run-1',
            managedKind: 'team-role-agent',
          },
          {
            id: 'matchaclaw-team:run-1:removed-role',
            name: 'owned removed role',
            managedBy: 'matchaclaw.team-runtime',
            source: 'matchaclaw.team-runtime',
            managedRunId: 'run-1',
            managedKind: 'team-role-agent',
          },
        ],
      },
    };
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(config)).result,
      },
    });

    await workflow.apply(createManagedConfig());

    const agents = (config.agents as { list: Array<Record<string, unknown>> }).list;
    expect(agents.find((agent) => agent.id === 'matchaclaw-team:run-1:external-role')).toBeDefined();
    expect(agents.find((agent) => agent.id === 'matchaclaw-team:run-1:missing-source')).toBeDefined();
    expect(agents.find((agent) => agent.id === 'matchaclaw-team:run-1:removed-role')).toBeUndefined();
  });

  it('rejects replacing an unmanaged OpenClaw agent with the same id as a Team projection agent', async () => {
    const config: Record<string, unknown> = {
      agents: {
        list: [
          {
            id: 'matchaclaw-team:run-1:leader',
            name: 'unowned leader collision',
            managedBy: 'someone-else',
            source: 'someone-else',
            managedRunId: 'run-1',
            managedKind: 'team-role-agent',
          },
        ],
      },
    };
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(config)).result,
      },
    });

    await expect(workflow.apply(createManagedConfig())).rejects.toThrow('Team managed agent id collides with unmanaged OpenClaw agent');
  });

  it('rejects duplicate agents, missing leader, invalid subagent projection, tools, and sandbox', async () => {
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate({})).result,
      },
    });
    const duplicate = createManagedConfig();
    duplicate.agents.push({ ...duplicate.agents[1]! });
    await expect(workflow.apply(duplicate)).rejects.toThrow('Duplicate Team managed agent id');

    const missingLeader = createManagedConfig();
    missingLeader.leaderAgentId = 'matchaclaw-team:run-1:missing-leader';
    await expect(workflow.apply(missingLeader)).rejects.toThrow('Team managed leader agent is missing from projection agents');

    const leaderAllowsUnknown = createManagedConfig();
    leaderAllowsUnknown.agents[0] = {
      ...leaderAllowsUnknown.agents[0]!,
      subagents: { allowAgents: ['matchaclaw-team:run-1:leader'], requireAgentId: true },
    };
    await expect(workflow.apply(leaderAllowsUnknown)).rejects.toThrow('Team managed leader allowAgents contains non-role agent');

    const roleWithSubagents = createManagedConfig();
    roleWithSubagents.agents[1] = {
      ...roleWithSubagents.agents[1]!,
      subagents: { allowAgents: [], requireAgentId: true },
    };
    await expect(workflow.apply(roleWithSubagents)).rejects.toThrow('Team managed role agent cannot define subagents');

    const invalidTools = createManagedConfig();
    invalidTools.agents[1] = {
      ...invalidTools.agents[1]!,
      tools: { profile: 'coding', allow: ['sessions_spawn'], deny: ['sessions_spawn', 'sessions_yield', 'subagents'] },
    };
    await expect(workflow.apply(invalidTools)).rejects.toThrow('Team managed role agent tools are invalid');

    const invalidSandbox = createManagedConfig();
    invalidSandbox.agents[1] = {
      ...invalidSandbox.agents[1]!,
      sandbox: { mode: 'none', scope: 'agent', workspaceAccess: 'rw' },
    };
    await expect(workflow.apply(invalidSandbox)).rejects.toThrow('Team managed agent sandbox is invalid');
  });

  it('reads and strips managed config from TeamRun create responses', () => {
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate({})).result,
      },
    });
    const response = { runId: 'run-1', status: 'created', revision: 1, managedAgentConfig: createManagedConfig() };

    expect(workflow.readManagedAgentConfig(response.managedAgentConfig)).toEqual(createManagedConfig());
    expect(workflow.stripManagedAgentConfig(response)).toEqual({ runId: 'run-1', status: 'created', revision: 1 });
  });

  it('rejects malformed managed config instead of treating it as absent', () => {
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate({})).result,
      },
    });

    expect(workflow.readManagedAgentConfig(undefined)).toBeNull();
    expect(() => workflow.readManagedAgentConfig({ kind: 'matchaclaw-team-managed-openclaw-agents' })).toThrow('Invalid Team managed agent config projection');
    expect(() => workflow.readManagedAgentConfig({
      ...createManagedConfig(),
      agents: [{ ...createManagedConfig().agents[0]!, workspace: '' }],
    })).toThrow('Team managed agent config projection is incomplete');
    expect(() => workflow.readManagedAgentConfig({
      ...createManagedConfig(),
      leaderAgentId: 'matchaclaw-team:run-1:missing-leader',
    })).toThrow('Team managed leader agent is missing from projection agents');
  });
});
