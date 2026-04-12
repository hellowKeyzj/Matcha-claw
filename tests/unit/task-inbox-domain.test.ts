import { describe, expect, it } from 'vitest';
import {
  filterUnfinishedTasks,
  parseAgentIdFromSessionKey,
} from '@/lib/task-inbox';
import type { Task } from '@/services/openclaw/task-manager-client';

function buildTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    subject: 'task',
    description: 'desc',
    status: 'pending',
    blockedBy: [],
    blocks: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('task inbox domain helpers', () => {
  it('只保留未完成任务状态', () => {
    const tasks: Task[] = [
      buildTask({ id: 'pending', status: 'pending' }),
      buildTask({ id: 'in-progress', status: 'in_progress' }),
      buildTask({ id: 'done', status: 'completed' }),
    ];

    expect(filterUnfinishedTasks(tasks).map((item) => item.id)).toEqual([
      'pending',
      'in-progress',
    ]);
  });

  it('能从 session key 解析 agentId', () => {
    expect(parseAgentIdFromSessionKey('agent:alpha:main')).toBe('alpha');
    expect(parseAgentIdFromSessionKey('agent:beta:session-1')).toBe('beta');
    expect(parseAgentIdFromSessionKey('')).toBeNull();
    expect(parseAgentIdFromSessionKey(undefined)).toBeNull();
  });
});
