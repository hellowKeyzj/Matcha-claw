import { describe, expect, it, vi } from 'vitest';
import { MultiAgentTaskWorkflow } from '../../runtime-host/application/workflows/multi-agent-task/multi-agent-task-workflow';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const runtimeAddress: RuntimeAddress = {
  kind: 'native-runtime',
  capabilityId: 'multi-agent.task',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
};

describe('multi-agent-task workflow', () => {
  it('initializes team state, claims tasks per agent, snapshots task scope, and prompts each session', async () => {
    const teamRuntimeService = {
      init: vi.fn(async () => ({ ok: true })),
      planUpsert: vi.fn(async () => ({ ok: true })),
      claimNext: vi.fn(async ({ agentId, sessionKey }: { agentId: string; sessionKey: string }) => ({
        task: {
          taskId: `task-${agentId}`,
          title: `Task ${agentId}`,
          instruction: `Do work for ${agentId}`,
          dependsOn: [],
          status: 'claimed',
          ownerAgentId: agentId,
          claimSessionKey: sessionKey,
          attempt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      })),
      taskUpdate: vi.fn(async () => ({ ok: true })),
    };
    const taskService = {
      buildTaskSnapshot: vi.fn(async ({ sessionKey, teamKey }: { sessionKey: string; teamKey?: string }) => ({
        sessionKey,
        teamKey,
        tasks: [],
      })),
    };
    const promptService = {
      promptSession: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const workflow = new MultiAgentTaskWorkflow({
      teamRuntimeService,
      taskService,
      promptService,
    });

    const response = await workflow.start({
      runtimeAddress,
      teamId: 'team-1',
      leadAgentId: 'lead',
      agents: [
        { agentId: 'agent-a', sessionKey: 'session-a' },
        { agentId: 'agent-b', sessionKey: 'session-b', message: 'Custom context' },
      ],
      tasks: [
        { taskId: 'task-a', title: 'A', instruction: 'Do A' },
        { taskId: 'task-b', title: 'B', instruction: 'Do B', dependsOn: ['task-a'] },
      ],
      leaseMs: 1000,
    });

    expect(response.status).toBe(200);
    expect(teamRuntimeService.init).toHaveBeenCalledWith({
      teamId: 'team-1',
      leadAgentId: 'lead',
      runtimeAddress,
    });
    expect(teamRuntimeService.planUpsert).toHaveBeenCalledWith({
      teamId: 'team-1',
      tasks: [
        { taskId: 'task-a', title: 'A', instruction: 'Do A' },
        { taskId: 'task-b', title: 'B', instruction: 'Do B', dependsOn: ['task-a'] },
      ],
    });
    expect(teamRuntimeService.claimNext).toHaveBeenCalledTimes(2);
    expect(teamRuntimeService.taskUpdate).toHaveBeenCalledWith({
      teamId: 'team-1',
      taskId: 'task-agent-a',
      status: 'running',
    });
    expect(taskService.buildTaskSnapshot).toHaveBeenCalledWith({ sessionKey: 'session-a', teamKey: 'team-1' });
    expect(promptService.promptSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeAddress: {
        ...runtimeAddress,
        agentId: 'agent-a',
        sessionKey: 'session-a',
      },
      sessionKey: 'session-a',
      message: expect.stringContaining('Do work for agent-a'),
    }));
    expect(promptService.promptSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeAddress: {
        ...runtimeAddress,
        agentId: 'agent-b',
        sessionKey: 'session-b',
      },
      sessionKey: 'session-b',
      message: expect.stringContaining('Custom context'),
    }));
  });

  it('rejects malformed RuntimeAddress', async () => {
    const workflow = new MultiAgentTaskWorkflow({
      teamRuntimeService: {} as never,
      taskService: {} as never,
      promptService: {} as never,
    });

    await expect(workflow.start({
      runtimeAddress: { kind: 'native-runtime' },
      teamId: 'team-1',
      leadAgentId: 'lead',
      agents: [{ agentId: 'agent-a', sessionKey: 'session-a' }],
      tasks: [{ taskId: 'task-a', instruction: 'Do A' }],
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'RuntimeAddress capabilityId is required' },
    });
  });

  it('rejects requests without explicit RuntimeAddress', async () => {
    const workflow = new MultiAgentTaskWorkflow({
      teamRuntimeService: {} as never,
      taskService: {} as never,
      promptService: {} as never,
    });

    await expect(workflow.start({ teamId: 'team-1', leadAgentId: 'lead', agents: [], tasks: [] })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'RuntimeAddress is required' },
    });
  });
});
