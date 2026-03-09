import { describe, expect, it } from 'vitest';
import {
  filterUnfinishedTasks,
  inferInputModeFromPrompt,
  parseAgentIdFromAssignedSession,
  resolveTaskInputMode,
} from '@/lib/task-inbox';

describe('task inbox domain', () => {
  it('只保留未完成状态任务', () => {
    const result = filterUnfinishedTasks([
      { id: '1', status: 'pending' },
      { id: '2', status: 'running' },
      { id: '3', status: 'waiting_for_input' },
      { id: '4', status: 'waiting_approval' },
      { id: '5', status: 'completed' },
      { id: '6', status: 'failed' },
    ] as never[]);
    expect(result.map((x) => x.id)).toEqual(['1', '2', '3', '4']);
  });

  it('从 assigned_session 提取 agentId', () => {
    expect(parseAgentIdFromAssignedSession('agent:business-expert:subagent:abc')).toBe('business-expert');
    expect(parseAgentIdFromAssignedSession(undefined)).toBeNull();
  });

  it('根据 prompt 推断输入模式', () => {
    expect(inferInputModeFromPrompt('是否批准该贷款申请？')).toBe('decision');
    expect(inferInputModeFromPrompt('请提供批贷金额、批贷期限和执行利率')).toBe('free_text');
  });

  it('优先使用 blocked_info.input_mode', () => {
    expect(resolveTaskInputMode({
      blocked_info: {
        reason: 'need_user_confirm',
        input_mode: 'decision',
      },
    })).toBe('decision');
  });
});
