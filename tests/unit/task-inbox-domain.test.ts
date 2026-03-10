import { describe, expect, it } from 'vitest';
import {
  filterUnfinishedTasks,
  getBlockedPrompt,
  inferInputModeFromPrompt,
  parseAgentIdFromAssignedSession,
  resolveTaskInputMode,
} from '@/lib/task-inbox';
import type { Task } from '@/lib/openclaw/task-manager-client';

function buildTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    goal: 'goal',
    status: 'pending',
    progress: 0,
    plan_markdown: '',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('task inbox domain helpers', () => {
  it('只保留未完成任务状态', () => {
    const tasks: Task[] = [
      buildTask({ id: 'pending', status: 'pending' }),
      buildTask({ id: 'running', status: 'running' }),
      buildTask({ id: 'waiting', status: 'waiting_for_input' }),
      buildTask({ id: 'done', status: 'completed' }),
      buildTask({ id: 'failed', status: 'failed' }),
    ];

    expect(filterUnfinishedTasks(tasks).map((item) => item.id)).toEqual([
      'pending',
      'running',
      'waiting',
    ]);
  });

  it('能从 assigned_session 解析 agentId', () => {
    expect(parseAgentIdFromAssignedSession('agent:alpha:main')).toBe('alpha');
    expect(parseAgentIdFromAssignedSession('agent:beta:session-1')).toBe('beta');
    expect(parseAgentIdFromAssignedSession('')).toBeNull();
    expect(parseAgentIdFromAssignedSession(undefined)).toBeNull();
  });

  it('根据提示词推断决策模式与自由输入模式', () => {
    expect(inferInputModeFromPrompt('请问是否批准该请求')).toBe('decision');
    expect(inferInputModeFromPrompt('请提供审批理由与补充信息')).toBe('free_text');
    expect(inferInputModeFromPrompt('')).toBe('free_text');
  });

  it('blocked prompt 优先 question，回退 description', () => {
    const withQuestion = buildTask({
      blocked_info: {
        reason: 'need_user_confirm',
        question: '是否继续',
        description: '备用描述',
      },
    });
    const withDescriptionOnly = buildTask({
      blocked_info: {
        reason: 'need_user_confirm',
        description: '请补充参数',
      },
    });

    expect(getBlockedPrompt(withQuestion)).toBe('是否继续');
    expect(getBlockedPrompt(withDescriptionOnly)).toBe('请补充参数');
  });

  it('resolveTaskInputMode 优先使用 blocked_info.input_mode', () => {
    const explicit = buildTask({
      blocked_info: {
        reason: 'need_user_confirm',
        input_mode: 'decision',
        question: '请输入信息',
      },
    });
    const inferred = buildTask({
      blocked_info: {
        reason: 'need_user_confirm',
        question: '是否同意该方案',
      },
    });

    expect(resolveTaskInputMode(explicit)).toBe('decision');
    expect(resolveTaskInputMode(inferred)).toBe('decision');
  });
});
