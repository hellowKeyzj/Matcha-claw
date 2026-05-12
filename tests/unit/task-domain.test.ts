import { describe, expect, it } from 'vitest';
import {
  filterUnfinishedTasks,
} from '@/lib/task-domain';
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

describe('task domain helpers', () => {
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

  it('deleted 不会进入未完成任务', () => {
    expect(filterUnfinishedTasks([
      buildTask({ id: 'deleted', status: 'deleted' }),
      buildTask({ id: 'pending', status: 'pending' }),
    ]).map((item) => item.id)).toEqual(['pending']);
  });
});
