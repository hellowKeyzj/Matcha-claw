import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimNextTask, listTasks, updateTaskStatus, upsertPlanTasks } from '@electron/adapters/platform/team-runtime/task-store';

describe('team runtime task store', () => {
  it('does not claim task with unresolved dependsOn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-task-store-'));
    try {
      await upsertPlanTasks({
        runtimeRoot: root,
        tasks: [
          { taskId: 'task-1', title: 'first', instruction: 'first task', dependsOn: [] },
          { taskId: 'task-2', title: 'second', instruction: 'second task', dependsOn: ['task-1'] },
        ],
      });

      const claimed = await claimNextTask({
        runtimeRoot: root,
        agentId: 'a1',
        sessionKey: 'session-a1',
        leaseMs: 30000,
      });

      expect(claimed?.taskId).toBe('task-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks claimed task with owner and session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-task-owner-'));
    try {
      await upsertPlanTasks({
        runtimeRoot: root,
        tasks: [{ taskId: 'task-1', instruction: 'first task' }],
      });

      const claimed = await claimNextTask({
        runtimeRoot: root,
        agentId: 'owner-a',
        sessionKey: 'owner-session',
        leaseMs: 30000,
      });

      expect(claimed?.ownerAgentId).toBe('owner-a');
      expect(claimed?.claimSessionKey).toBe('owner-session');

      const tasks = await listTasks(root);
      expect(tasks[0]?.status).toBe('claimed');
      expect(tasks[0]?.ownerAgentId).toBe('owner-a');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports blocked -> todo retry requeue flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-task-retry-'));
    try {
      await upsertPlanTasks({
        runtimeRoot: root,
        tasks: [{ taskId: 'task-1', instruction: 'first task' }],
      });

      const claimed = await claimNextTask({
        runtimeRoot: root,
        agentId: 'owner-a',
        sessionKey: 'owner-session',
        leaseMs: 30000,
      });
      expect(claimed?.status).toBe('claimed');

      await updateTaskStatus({
        runtimeRoot: root,
        taskId: 'task-1',
        nextStatus: 'running',
      });
      await updateTaskStatus({
        runtimeRoot: root,
        taskId: 'task-1',
        nextStatus: 'blocked',
        error: 'tool timeout',
      });
      await updateTaskStatus({
        runtimeRoot: root,
        taskId: 'task-1',
        nextStatus: 'todo',
      });

      const tasks = await listTasks(root);
      expect(tasks[0]?.status).toBe('todo');
      expect(tasks[0]?.ownerAgentId).toBeUndefined();
      expect(tasks[0]?.claimSessionKey).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
