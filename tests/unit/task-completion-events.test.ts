import { describe, expect, it } from 'vitest';
import { normalizeTaskCompletionEvents } from '../../runtime-host/application/sessions/task-completion-events';

describe('task completion events normalization', () => {
  it('only accepts structured completion events', () => {
    expect(normalizeTaskCompletionEvents({
      taskCompletionEvents: [{
        kind: 'task_completion',
        source: 'subagent',
        childSessionKey: 'agent:coder:main',
        childSessionId: 'child-1',
      }],
    })).toEqual([{
      kind: 'task_completion',
      source: 'subagent',
      childSessionKey: 'agent:coder:main',
      childSessionId: 'child-1',
      childAgentId: 'coder',
    }]);
  });

  it('does not parse injected completion text fallback', () => {
    expect(normalizeTaskCompletionEvents({
      taskCompletionEvents: [],
      internalEvents: [],
    })).toBeUndefined();
  });
});
