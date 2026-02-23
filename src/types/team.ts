export type TeamReportStatus = 'done' | 'partial' | 'blocked';
export type TeamPhase = 'discussion' | 'planning' | 'team-setup' | 'convergence' | 'execution' | 'done';
export type TeamMessageRole = 'user' | 'assistant' | 'system';
export type TeamMessageKind = 'normal' | 'plan' | 'report';
export type TeamTaskStatus = 'pending' | 'running' | 'done' | 'partial' | 'blocked' | 'error' | 'missing-report';
export type TeamMemberStatus =
  'idle'
  | 'discussing'
  | 'planning'
  | 'waiting'
  | 'running'
  | 'done'
  | 'partial'
  | 'blocked'
  | 'error'
  | 'missing-report';
export type TeamBindingStatus =
  'idle'
  | 'loading-members'
  | 'validating-agents'
  | 'missing-agents'
  | 'binding-sessions'
  | 'loading-history'
  | 'ready'
  | 'error';

export type TeamFlowEventType =
  | 'phase-transition'
  | 'controller-decision'
  | 'tool-policy-blocked'
  | 'review-collected'
  | 'convergence-digest'
  | 'convergence-round'
  | 'execution-blueprint'
  | 'action';

export interface TeamReport {
  reportId: string;
  task_id: string;
  agent_id: string;
  status: TeamReportStatus;
  result: string[];
  evidence?: string[];
  next_steps?: string[];
  risks?: string[];
}

export interface TeamContext {
  goal: string;
  plan: string[];
  roles: string[];
  status: string;
  decisions: string[];
  openQuestions: string[];
  artifacts: string[];
  updatedAt: string;
}

export interface TeamPlanTask {
  taskId: string;
  agentId?: string;
  role?: string;
  instruction: string;
  acceptance: string[];
  dependsOn?: string[];
}

export interface TeamPlan {
  objective: string;
  scope?: string[];
  tasks: TeamPlanTask[];
  risks?: string[];
}

export interface TeamTaskRuntime {
  taskId: string;
  agentId: string;
  instruction: string;
  acceptance: string[];
  status: TeamTaskStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  runId?: string;
  reportId?: string;
  lastError?: string;
}

export interface TeamMemberRuntime {
  agentId: string;
  status: TeamMemberStatus;
  currentTaskId?: string;
  lastTaskId?: string;
  lastRunId?: string;
  lastReportId?: string;
  lastDurationMs?: number;
  lastError?: string;
  updatedAt: number;
}

export interface TeamAuditRecord {
  teamId: string;
  agentId: string;
  taskId: string;
  runId?: string;
  reportId?: string;
  status: TeamTaskStatus | 'error';
  timestamp: number;
  error?: string;
}

export interface TeamFlowEvent {
  id: string;
  teamId: string;
  phase: TeamPhase;
  type: TeamFlowEventType;
  actor: 'program' | 'controller' | 'member';
  agentId?: string;
  timestamp: number;
  note?: string;
  payload?: Record<string, unknown>;
}

export interface TeamBindingState {
  status: TeamBindingStatus;
  missingAgentIds: string[];
  error?: string;
}

export interface Team {
  id: string;
  name: string;
  controllerId: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TeamMessage {
  id: string;
  role: TeamMessageRole;
  agentId?: string;
  content: string;
  kind: TeamMessageKind;
  timestamp: number;
}
