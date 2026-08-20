export type TaskDataStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskData {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskDataStatus;
  metadata?: Record<string, unknown>;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  createdAt?: number;
  updatedAt?: number;
  content?: string;
  dependencies?: string[];
}

export interface TodoItem {
  id?: string;
  content: string;
  activeForm?: string;
  status: TaskDataStatus;
  owner?: string;
}

export interface TaskScopeSnapshot {
  type: 'session' | 'team';
  key: string;
  label: string;
  sessionKey?: string;
  teamKey?: string;
  agentId?: string;
}

export interface TaskSnapshotEvent {
  sessionKey: string;
  scope?: TaskScopeSnapshot;
  tasks: TaskData[];
  todos?: TodoItem[];
  source: 'tool' | 'todo' | 'plan' | 'artifact' | 'replay';
  enableEdit?: boolean;
  uri?: string;
}
