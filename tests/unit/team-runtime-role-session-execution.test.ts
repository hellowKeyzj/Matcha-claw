import { describe, expect, it, vi } from 'vitest';
import { OpenClawRoleSessionExecution } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/openclaw-role-session-execution';

describe('OpenClawRoleSessionExecution', () => {
  it('delegates dispatch execution to native OpenClaw subagent spawn with Team requester context', async () => {
    const spawn = vi.fn().mockResolvedValue({
      status: 'accepted',
      runId: 'openclaw-run-1',
      childSessionKey: 'agent:matchaclaw-team:team-run-1:operator-designer:subagent:child-1',
      mode: 'run',
    });
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const execution = new OpenClawRoleSessionExecution({ spawn, deleteSession });

    await expect(execution.executeDispatch({
      runId: 'team-run-1',
      prompt: '# Dispatch prompt',
      dispatch: {
        dispatchId: 'dispatch-1',
        runId: 'team-run-1',
        stageId: 'step-1-design-operator-blueprint',
        roleId: 'operator-designer',
        promptRef: 'dispatches/prompts/dispatch-1.md',
        inputArtifactIds: [],
        kickbackIds: [],
        idempotencyKey: 'dispatch-key',
        createdAt: 1,
      },
      role: {
        runId: 'team-run-1',
        roleId: 'operator-designer',
        agentId: 'matchaclaw-team:team-run-1:operator-designer',
        agentName: 'operator-designer',
        workspaceDir: '/workspace/roles/operator-designer',
        agentDir: '/agents/operator-designer',
        skills: [],
        tools: [],
        sandboxPolicy: { workspaceAccess: 'read-only', profile: 'review' },
        status: 'provisioned',
      },
    })).resolves.toEqual({
      executionId: 'openclaw-run-1',
      childSessionKey: 'agent:matchaclaw-team:team-run-1:operator-designer:subagent:child-1',
      spawnMode: 'run',
      status: 'queued',
      roleId: 'operator-designer',
      dispatchId: 'dispatch-1',
    });

    expect(spawn).toHaveBeenCalledWith({
      task: '# Dispatch prompt',
      taskName: 'step-1-design-operator-blueprint:operator-designer',
      label: 'operator-designer',
      agentId: 'matchaclaw-team:team-run-1:operator-designer',
      requesterAgentId: 'matchaclaw-team:team-run-1:leader',
      requesterSessionKey: 'agent:matchaclaw-team:team-run-1:leader:main',
      workspaceDir: '/workspace/roles/operator-designer',
      mode: 'run',
      cleanup: 'keep',
      context: 'isolated',
    });
  });

  it('cancels active dispatch execution by deleting the OpenClaw child session', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const execution = new OpenClawRoleSessionExecution({ spawn: vi.fn(), deleteSession });

    await expect(execution.cancelDispatchExecution({
      reason: 'user cancelled run',
      execution: {
        executionRecordId: 'execution-record-1',
        runId: 'team-run-1',
        dispatchId: 'dispatch-1',
        stageId: 'step-1-design-operator-blueprint',
        roleId: 'operator-designer',
        executionId: 'openclaw-run-1',
        childSessionKey: 'agent:matchaclaw-team:team-run-1:operator-designer:subagent:child-1',
        spawnMode: 'run',
        status: 'queued',
        idempotencyKey: 'dispatch-key',
        createdAt: 1,
      },
    })).resolves.toEqual({
      executionRecordId: 'execution-record-1',
      executionId: 'openclaw-run-1',
      childSessionKey: 'agent:matchaclaw-team:team-run-1:operator-designer:subagent:child-1',
      cancelled: true,
    });
    expect(deleteSession).toHaveBeenCalledWith({
      sessionKey: 'agent:matchaclaw-team:team-run-1:operator-designer:subagent:child-1',
      deleteTranscript: false,
    });
  });
});
