import { describe, expect, it, vi } from 'vitest';
import { buildTeamManagedAgentId } from '../../packages/openclaw-team-runtime-plugin/src/domain/team-role';
import { OpenClawRoleSessionExecution } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/openclaw-role-session-execution';

function createRuntimePort(overrides: Partial<ConstructorParameters<typeof OpenClawRoleSessionExecution>[0]> = {}) {
  return {
    run: vi.fn().mockResolvedValue({ runId: 'openclaw-run' }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('OpenClawRoleSessionExecution', () => {
  it('maps gateway-scoped subagent runtime failures to Team leader bootstrap guidance', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Plugin runtime subagent methods are only available during a gateway request.'));
    const execution = new OpenClawRoleSessionExecution(createRuntimePort({ run }));

    await expect(execution.executeLeader({
      runId: 'team-run-1',
      prompt: '# Leader prompt',
      dispatch: {
        dispatchId: 'dispatch-leader',
        runId: 'team-run-1',
        stageId: 'leader',
        roleId: 'leader',
        promptRef: 'dispatches/prompts/dispatch-leader.md',
        inputArtifactIds: [],
        kickbackIds: [],
        idempotencyKey: 'leader-key',
        createdAt: 1,
      },
      role: {
        runId: 'team-run-1',
        roleId: 'leader',
        agentId: buildTeamManagedAgentId('team-run-1', 'leader'),
        agentName: 'leader',
        workspaceDir: '/workspace/leader',
        agentDir: '/agents/leader',
        skills: [],
        tools: [],
        status: 'provisioned',
      },
    })).rejects.toThrow('Team leader bootstrap requires an OpenClaw gateway request context. Retry the TeamRun start from the Team gateway so the runtime owns the native leader session.');
  });

  it('starts the managed leader through the trusted runtime run surface', async () => {
    const run = vi.fn().mockResolvedValue({ runId: 'leader-run-1' });
    const execution = new OpenClawRoleSessionExecution(createRuntimePort({ run }));

    await expect(execution.executeLeader({
      runId: 'team-run-1',
      prompt: '# Leader prompt',
      dispatch: {
        dispatchId: 'dispatch-leader',
        runId: 'team-run-1',
        stageId: 'leader',
        roleId: 'leader',
        promptRef: 'dispatches/prompts/dispatch-leader.md',
        inputArtifactIds: [],
        kickbackIds: [],
        idempotencyKey: 'leader-key',
        createdAt: 1,
      },
      role: {
        runId: 'team-run-1',
        roleId: 'leader',
        agentId: buildTeamManagedAgentId('team-run-1', 'leader'),
        agentName: 'leader',
        workspaceDir: '/workspace/leader',
        agentDir: '/agents/leader',
        skills: [],
        tools: [],
        status: 'provisioned',
      },
    })).resolves.toEqual({
      executionId: 'leader-run-1',
      childSessionKey: `agent:${buildTeamManagedAgentId('team-run-1', 'leader')}:main`,
      spawnMode: 'run',
      status: 'queued',
      roleId: 'leader',
      dispatchId: 'dispatch-leader',
    });

    const leaderAgentId = buildTeamManagedAgentId('team-run-1', 'leader');
    expect(run).toHaveBeenCalledWith({
      sessionKey: `agent:${leaderAgentId}:main`,
      message: '# Leader prompt',
      idempotencyKey: 'leader-key',
      lane: 'agent',
      deliver: true,
    });
  });

  it('deletes only active native session keys once when cancelling TeamRun sessions', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const execution = new OpenClawRoleSessionExecution(createRuntimePort({ deleteSession }));

    await execution.cancelRunSessions({
      runId: 'run-cancel-native',
      reason: 'user requested cancellation',
      executions: [
        {
          executionRecordId: 'execution-1',
          runId: 'run-cancel-native',
          dispatchId: 'dispatch-1',
          stageId: 'leader',
          roleId: 'leader',
          childSessionKey: 'agent:matchaclaw-team:run-cancel-native:leader:main',
          status: 'queued',
          idempotencyKey: 'leader-execution',
          createdAt: 1,
        },
        {
          executionRecordId: 'execution-2',
          runId: 'run-cancel-native',
          dispatchId: 'dispatch-2',
          stageId: 'design-blueprint',
          roleId: 'operator-designer',
          childSessionKey: 'agent:matchaclaw-team:run-cancel-native:operator-designer:subagent:design-blueprint',
          status: 'queued',
          idempotencyKey: 'design-execution',
          createdAt: 1,
        },
        {
          executionRecordId: 'execution-3',
          runId: 'run-cancel-native',
          dispatchId: 'dispatch-3',
          stageId: 'design-blueprint-retry',
          roleId: 'operator-designer',
          childSessionKey: 'agent:matchaclaw-team:run-cancel-native:operator-designer:subagent:design-blueprint',
          status: 'claimed',
          idempotencyKey: 'design-execution-retry',
          createdAt: 1,
        },
        {
          executionRecordId: 'execution-4',
          runId: 'run-cancel-native',
          dispatchId: 'dispatch-4',
          stageId: 'completed-task',
          roleId: 'kernel-coder',
          childSessionKey: 'agent:matchaclaw-team:run-cancel-native:kernel-coder:subagent:completed',
          status: 'completed',
          idempotencyKey: 'completed-execution',
          createdAt: 1,
        },
      ],
    });

    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenNthCalledWith(1, { sessionKey: 'agent:matchaclaw-team:run-cancel-native:leader:main' });
    expect(deleteSession).toHaveBeenNthCalledWith(2, { sessionKey: 'agent:matchaclaw-team:run-cancel-native:operator-designer:subagent:design-blueprint' });
  });
});
