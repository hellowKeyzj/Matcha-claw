import type { Task, TaskStatus } from '@/services/openclaw/task-manager-client';

const UNFINISHED_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'running',
  'waiting_for_input',
  'waiting_approval',
]);

export function filterUnfinishedTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => UNFINISHED_TASK_STATUSES.has(task.status));
}

export function parseAgentIdFromAssignedSession(session?: string): string | null {
  if (!session) {
    return null;
  }
  const matched = session.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

export function inferInputModeFromPrompt(prompt: string): 'decision' | 'free_text' {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return 'free_text';
  }
  const decisionHint = /(是否|批准|拒绝|approve|reject|yes|no|同意|驳回|通过|不通过)/i.test(trimmed);
  const detailHint = /(请提供|请输入|填写|金额|期限|利率|原因|信息|资料|姓名|手机号|身份证|邮箱)/i.test(trimmed);
  if (decisionHint && !detailHint) {
    return 'decision';
  }
  return 'free_text';
}

export function getBlockedPrompt(task: Task): string {
  const question = typeof task.blocked_info?.question === 'string' ? task.blocked_info.question.trim() : '';
  if (question) {
    return question;
  }
  const description = typeof task.blocked_info?.description === 'string' ? task.blocked_info.description.trim() : '';
  return description;
}

export function resolveTaskInputMode(task: Pick<Task, 'blocked_info'>): 'decision' | 'free_text' {
  const configured = task.blocked_info?.input_mode;
  if (configured === 'decision' || configured === 'free_text') {
    return configured;
  }
  const prompt = typeof task.blocked_info?.question === 'string'
    ? task.blocked_info.question
    : (typeof task.blocked_info?.description === 'string' ? task.blocked_info.description : '');
  return inferInputModeFromPrompt(prompt);
}
