import type { HostWikiResearchTask } from '@/lib/host-api';
import type { WikiReviewItem } from './wiki-model';

export type WikiResearchTask = HostWikiResearchTask;

export function isTerminalResearchTask(task: WikiResearchTask): boolean {
  return task.status === 'done' || task.status === 'error';
}

export function hasActiveResearchRerun(tasks: readonly WikiResearchTask[], taskId: string): boolean {
  return tasks.some((task) => task.rerunOfTaskId === taskId && !isTerminalResearchTask(task));
}

export function reviewResearchTopic(item: WikiReviewItem): string {
  return item.title.replace(/^(Save to Wiki|Create|Research)[:\s]*/i, '').trim() || item.description.split('\n')[0].trim();
}

export function isResearchReviewAction(action: string): boolean {
  return action === '__deep_research__' || (!action.startsWith('__') && /research|investigate|explore|look into|研究|调研|探索/i.test(action));
}
