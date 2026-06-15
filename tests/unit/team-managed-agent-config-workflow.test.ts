import { describe, expect, it } from 'vitest';
import { buildTeamManagedAgentId } from '../../packages/openclaw-team-runtime-plugin/src/domain/team-role';
import { TeamManagedAgentConfigWorkflow, type TeamManagedAgentConfigProjection } from '../../runtime-host/application/team-skill/team-managed-agent-config-workflow';

function createManagedConfig(runId = 'run-1'): TeamManagedAgentConfigProjection {
  return {
    kind: 'matchaclaw-team-managed-openclaw-agents',
    version: 1,
    source: 'matchaclaw.team-runtime',
    runId,
    leaderAgentId: buildTeamManagedAgentId(runId, 'leader'),
    agents: [
      {
        id: buildTeamManagedAgentId(runId, 'leader'),
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
          profile: 'full',
          allow: ['team_plan_workflow', 'sessions_spawn', 'team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task'],
          deny: ['sessions_yield', 'subagents'],
        },
        sandbox: {
          mode: 'off',
          scope: 'agent',
          workspaceAccess: 'rw',
        },
        subagents: {
          allowAgents: [buildTeamManagedAgentId(runId, 'operator-designer')],
          requireAgentId: true,
        },
      },
      {
        id: buildTeamManagedAgentId(runId, 'operator-designer'),
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
          profile: 'full',
          allow: ['team_submit_artifact', 'team_update_task'],
          deny: ['sessions_spawn', 'sessions_yield', 'subagents'],
        },
        sandbox: {
          mode: 'off',
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
            id: buildTeamManagedAgentId('run-1', 'leader'),
            name: 'old leader',
            workspace: '/old',
            managedBy: 'matchaclaw.team-runtime',
            source: 'matchaclaw.team-runtime',
            managedRunId: 'run-1',
            managedRoleId: 'leader',
            managedKind: 'team-role-agent',
          },
          { id: buildTeamManagedAgentId('run-2', 'leader'), name: 'other run', workspace: '/other' },
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
      agentIds: [buildTeamManagedAgentId('run-1', 'leader'), buildTeamManagedAgentId('run-1', 'operator-designer')],
    });

    const agents = (config.agents as { list: Array<Record<string, unknown>> }).list;
    expect(agents.find((agent) => agent.id === 'main')).toEqual({ id: 'main', name: 'Main', workspace: '/main' });
    expect(agents.find((agent) => agent.id === buildTeamManagedAgentId('run-2', 'leader'))).toEqual({
      id: buildTeamManagedAgentId('run-2', 'leader'),
      name: 'other run',
      workspace: '/other',
    });
    expect(agents.find((agent) => agent.id === buildTeamManagedAgentId('run-1', 'leader'))).toEqual({
      id: buildTeamManagedAgentId('run-1', 'leader'),
      name: 'leader',
      workspace: '/runs/run-1/leader',
      agentDir: '/agents/run-1/leader/agent',
      skills: [],
      tools: {
        profile: 'full',
        allow: ['team_plan_workflow', 'sessions_spawn', 'team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task'],
        deny: ['sessions_yield', 'subagents'],
      },
      sandbox: {
        mode: 'off',
        scope: 'agent',
        workspaceAccess: 'rw',
      },
      subagents: {
        allowAgents: [buildTeamManagedAgentId('run-1', 'operator-designer')],
        requireAgentId: true,
      },
    });
    expect(agents.find((agent) => agent.id === buildTeamManagedAgentId('run-1', 'operator-designer'))).toEqual({
      id: buildTeamManagedAgentId('run-1', 'operator-designer'),
      name: 'operator-designer',
      workspace: '/runs/run-1/roles/operator-designer',
      agentDir: '/agents/run-1/operator-designer/agent',
      skills: ['design'],
      tools: {
        profile: 'full',
        allow: ['team_submit_artifact', 'team_update_task'],
        deny: ['sessions_spawn', 'sessions_yield', 'subagents'],
      },
      sandbox: {
        mode: 'off',
        scope: 'agent',
        workspaceAccess: 'rw',
      },
    });
  });

  it('rejects managed agent ids that are invalid for OpenClaw config', async () => {
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate({})).result,
      },
    });
    const config = createManagedConfig('run-1');
    config.agents[0] = { ...config.agents[0]!, id: 'matchaclaw-team:run-2:leader' };

    await expect(workflow.apply(config)).rejects.toThrow('Team managed agent id is invalid for OpenClaw config');
  });

  it('accepts any OpenClaw-supported sandbox mode instead of requiring Team managed defaults', async () => {
    const config: Record<string, unknown> = { agents: { list: [] } };
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(config)).result,
      },
    });
    const managedConfig = createManagedConfig('run-1');
    managedConfig.agents = managedConfig.agents.map((agent) => ({
      ...agent,
      sandbox: { mode: 'non-main', scope: 'session', workspaceAccess: 'ro' },
    }));

    await expect(workflow.apply(managedConfig)).resolves.toEqual({
      changed: true,
      agentIds: [buildTeamManagedAgentId('run-1', 'leader'), buildTeamManagedAgentId('run-1', 'operator-designer')],
    });
  });

  it('replaces only agent ids present in the TeamRun projection and keeps other agents', async () => {
    const config: Record<string, unknown> = {
      agents: {
        list: [
          { id: 'main', name: 'Main' },
          { id: 'external-agent', name: 'external agent' },
          { id: buildTeamManagedAgentId('run-2', 'leader'), name: 'other run' },
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
    expect(agents.find((agent) => agent.id === 'main')).toEqual({ id: 'main', name: 'Main' });
    expect(agents.find((agent) => agent.id === 'external-agent')).toEqual({ id: 'external-agent', name: 'external agent' });
    expect(agents.find((agent) => agent.id === buildTeamManagedAgentId('run-2', 'leader'))).toEqual({ id: buildTeamManagedAgentId('run-2', 'leader'), name: 'other run' });
  });

  it('rejects unmanaged collisions on projected TeamRun agent ids', async () => {
    const config: Record<string, unknown> = {
      agents: {
        list: [
          {
            id: buildTeamManagedAgentId('run-1', 'operator-designer'),
            name: 'unmanaged id collision',
            managedBy: 'other-runtime',
            source: 'other-runtime',
            managedRunId: 'run-1',
            managedRoleId: 'operator-designer',
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

    await expect(workflow.apply(createManagedConfig())).rejects.toThrow(`Team managed agent id collides with unmanaged OpenClaw agent: ${buildTeamManagedAgentId('run-1', 'operator-designer')}`);
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
      subagents: { allowAgents: [buildTeamManagedAgentId('run-1', 'leader'), buildTeamManagedAgentId('run-1', 'missing-role')], requireAgentId: true },
    };
    await expect(workflow.apply(leaderAllowsUnknown)).rejects.toThrow('Team managed leader allowAgents contains non-role agent');

    const roleWithSubagents = createManagedConfig();
    roleWithSubagents.agents[1] = {
      ...roleWithSubagents.agents[1]!,
      subagents: { allowAgents: [], requireAgentId: true },
    };
    await expect(workflow.apply(roleWithSubagents)).rejects.toThrow('Team managed role agent cannot define subagents');

    const leaderWithoutRequiredAgentId = createManagedConfig();
    leaderWithoutRequiredAgentId.agents[0] = {
      ...leaderWithoutRequiredAgentId.agents[0]!,
      subagents: { allowAgents: [buildTeamManagedAgentId('run-1', 'operator-designer')], requireAgentId: false },
    };
    await expect(workflow.apply(leaderWithoutRequiredAgentId)).rejects.toThrow('Team managed leader subagent routing is invalid');

    const invalidTools = createManagedConfig();
    invalidTools.agents[1] = {
      ...invalidTools.agents[1]!,
      tools: { profile: 'full', allow: ['sessions_spawn'], deny: ['sessions_spawn', 'sessions_yield', 'subagents'] },
    };
    await expect(workflow.apply(invalidTools)).rejects.toThrow('Team managed role agent tools are invalid');

    const invalidSandbox = createManagedConfig();
    invalidSandbox.agents[1] = {
      ...invalidSandbox.agents[1]!,
      sandbox: { mode: 'none', scope: 'agent', workspaceAccess: 'rw' },
    };
    await expect(workflow.apply(invalidSandbox)).rejects.toThrow('Team managed agent sandbox is invalid');
  });

  it('removes only Team runtime owned agents for the current TeamRun', async () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: { workspace: '/main' },
        list: [
          { id: 'main', name: 'Main', workspace: '/main' },
          {
            id: buildTeamManagedAgentId('run-1', 'leader'),
            name: 'leader',
          },
          {
            id: buildTeamManagedAgentId('run-1', 'operator-designer'),
            name: 'operator-designer',
          },
          {
            id: buildTeamManagedAgentId('run-2', 'leader'),
            name: 'other run',
          },
        ],
      },
    };
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(config)).result,
      },
    });

    await expect(workflow.removeRun(createManagedConfig('run-1'))).resolves.toEqual({
      changed: true,
      agentIds: [buildTeamManagedAgentId('run-1', 'leader'), buildTeamManagedAgentId('run-1', 'operator-designer')],
    });

    const agents = (config.agents as { list: Array<Record<string, unknown>> }).list;
    expect(agents).toEqual([
      { id: 'main', name: 'Main', workspace: '/main' },
      {
        id: buildTeamManagedAgentId('run-2', 'leader'),
        name: 'other run',
      },
    ]);
  });

  it('does not change OpenClaw agents.list when removing a TeamRun without owned agents', async () => {
    const config: Record<string, unknown> = {
      agents: {
        list: [
          { id: 'main', name: 'Main' },
          {
            id: buildTeamManagedAgentId('run-2', 'leader'),
            name: 'other run',
          },
        ],
      },
    };
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(config)).result,
      },
    });

    await expect(workflow.removeRun(createManagedConfig('run-1'))).resolves.toEqual({ changed: false, agentIds: [] });
    expect(config.agents).toEqual({
      list: [
        { id: 'main', name: 'Main' },
        {
          id: buildTeamManagedAgentId('run-2', 'leader'),
          name: 'other run',
        },
      ],
    });
  });

  it('removes only agent ids listed by the TeamRun projection', async () => {
    const config: Record<string, unknown> = {
      agents: {
        list: [
          {
            id: buildTeamManagedAgentId('run-1', 'leader'),
            name: 'leader',
          },
        ],
      },
    };
    const workflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(config)).result,
      },
    });

    await expect(workflow.removeRun(createManagedConfig('run-1'))).resolves.toEqual({
      changed: true,
      agentIds: [buildTeamManagedAgentId('run-1', 'leader')],
    });
    expect(config.agents).toEqual({ list: [] });
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
      leaderAgentId: buildTeamManagedAgentId('run-1', 'missing-leader'),
    })).toThrow('Team managed leader agent is missing from projection agents');
  });
});
