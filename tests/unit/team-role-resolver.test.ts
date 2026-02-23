import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSubagentNameToSlug } from '@/lib/subagent/workspace';
import { resolvePlanAssignmentsForTeam } from '@/lib/team/role-resolver';
import type { SubagentSummary } from '@/types/subagent';
import type { TeamPlan } from '@/types/team';

vi.mock('@/lib/team/roles-metadata', () => ({
  resolveRolesMetadataRoot: vi.fn(() => '/tmp/workspace'),
  readRolesMetadata: vi.fn(async () => []),
  writeRolesMetadata: vi.fn(async () => undefined),
  mergeRolesFromAgents: vi.fn((current, _agents) => current),
  isRoleMetadataWeak: vi.fn((entry: { summary?: string; tags?: string[] }) => {
    const summary = (entry?.summary ?? '').trim();
    const tags = Array.isArray(entry?.tags) ? entry.tags.filter(Boolean) : [];
    return tags.length === 0 && summary.includes('handles tasks in its specialty and reports outcomes.');
  }),
  selectRolesByGoalWithLlm: vi.fn(async () => ({
    selectedAgentIds: [],
    missingRoles: [{ role: 'qa-agent', summary: '负责测试与质量保障' }],
  })),
}));

const team = {
  id: 'team-1',
  name: 'Team 1',
  controllerId: 'controller',
  memberIds: ['controller'],
  createdAt: 1,
  updatedAt: 1,
};

const basePlan: TeamPlan = {
  objective: 'Build feature',
  tasks: [
    {
      taskId: 'task-1',
      role: 'qa-agent',
      instruction: 'Write tests',
      acceptance: ['tests added'],
    },
    {
      taskId: 'task-2',
      role: 'qa-agent',
      instruction: 'Run tests',
      acceptance: ['tests passed'],
    },
  ],
};

function createAgent(agentId: string): SubagentSummary {
  return {
    id: agentId,
    name: agentId,
    workspace: `/workspace/${agentId}`,
    model: 'gpt-4o-mini',
    isDefault: false,
  };
}

describe('resolvePlanAssignmentsForTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pending creations when allowCreate=false', async () => {
    const agents: SubagentSummary[] = [createAgent('controller')];
    const createSpy = vi.fn(async () => undefined);

    const result = await resolvePlanAssignmentsForTeam({
      team,
      plan: basePlan,
      agents,
      getAgents: () => agents,
      createAgent: createSpy,
      loadAgents: async () => undefined,
      allowCreate: false,
    });

    expect(createSpy).not.toHaveBeenCalled();
    expect(result.pendingAgentCreations).toHaveLength(1);
    expect(result.pendingAgentCreations[0]?.role).toBe('qa-agent');
    expect(result.pendingAgentCreations[0]?.taskIds).toEqual(['task-1', 'task-2']);
    expect(result.addedAgentIds).toEqual([]);
  });

  it('creates missing agent when allowCreate=true', async () => {
    const agents: SubagentSummary[] = [createAgent('controller')];
    const createSpy = vi.fn(async ({ name }: { name: string }) => {
      const agentId = normalizeSubagentNameToSlug(name);
      agents.push(createAgent(agentId));
    });

    const result = await resolvePlanAssignmentsForTeam({
      team,
      plan: basePlan,
      agents,
      getAgents: () => agents,
      createAgent: createSpy,
      loadAgents: async () => undefined,
      allowCreate: true,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.addedAgentIds).toHaveLength(1);
    expect(result.pendingAgentCreations).toEqual([]);
    expect(result.resolvedAgentByTaskId['task-1']).toBeTruthy();
    expect(result.resolvedAgentByTaskId['task-2']).toBeTruthy();
  });

  it('skips weak default metadata and creates pending role', async () => {
    const agents: SubagentSummary[] = [createAgent('controller'), createAgent('dev')];
    const rolesModule = await import('@/lib/team/roles-metadata');

    vi.mocked(rolesModule.mergeRolesFromAgents).mockImplementation(() => ([
      {
        agentId: 'dev',
        name: 'dev',
        role: 'dev',
        summary: 'dev handles tasks in its specialty and reports outcomes.',
        tags: [],
        updatedAt: new Date().toISOString(),
      },
    ]));
    vi.mocked(rolesModule.selectRolesByGoalWithLlm).mockResolvedValue({
      selectedAgentIds: [],
      missingRoles: [],
    });

    const result = await resolvePlanAssignmentsForTeam({
      team,
      plan: {
        objective: 'Build feature',
        tasks: [
          {
            taskId: 'task-1',
            role: 'dev',
            instruction: 'Implement',
            acceptance: ['done'],
          },
        ],
      },
      agents,
      getAgents: () => agents,
      createAgent: async () => undefined,
      loadAgents: async () => undefined,
      allowCreate: false,
    });

    expect(result.resolvedAgentByTaskId['task-1']).toBeUndefined();
    expect(result.pendingAgentCreations).toHaveLength(1);
    expect(result.pendingAgentCreations[0]?.role).toBe('dev');
  });
});
