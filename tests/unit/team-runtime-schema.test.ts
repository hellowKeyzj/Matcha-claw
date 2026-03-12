import { describe, expect, it } from 'vitest';
import { isTaskStatusTransitionAllowed, sanitizeTaskRecord } from '@electron/main/team-runtime/schema';

describe('team runtime schema', () => {
  it('allows running -> blocked -> running', () => {
    expect(isTaskStatusTransitionAllowed('running', 'blocked')).toBe(true);
    expect(isTaskStatusTransitionAllowed('blocked', 'running')).toBe(true);
  });

  it('allows blocked -> todo for retry requeue', () => {
    expect(isTaskStatusTransitionAllowed('blocked', 'todo')).toBe(true);
  });

  it('rejects done -> running', () => {
    expect(isTaskStatusTransitionAllowed('done', 'running')).toBe(false);
  });

  it('normalizes minimal task record', () => {
    const row = sanitizeTaskRecord({ taskId: 't1', instruction: 'do something', dependsOn: [] }, 10);
    expect(row.status).toBe('todo');
    expect(row.attempt).toBe(0);
    expect(row.createdAt).toBe(10);
    expect(row.updatedAt).toBe(10);
  });
});
