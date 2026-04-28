import type { TaskStep } from './task-viz';

export interface ExecutionGraphData {
  id: string;
  anchorMessageKey: string;
  triggerMessageKey: string;
  replyMessageKey?: string;
  agentLabel: string;
  sessionLabel: string;
  steps: TaskStep[];
  active: boolean;
  suppressToolCardMessageKeys?: string[];
}
