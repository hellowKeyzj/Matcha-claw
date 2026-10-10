import type { TeamGraphEdgeRecord, TeamGraphNodeRecord, TeamRoleBindingRecord, TeamScriptReviewRule } from '@/types/team-design';
import type { TeamWebhookAuthProjection } from '@/services/openclaw/team-runtime-client';
import type { TeamRunGraphCanvasLabels } from './TeamRunGraphCanvas';

export type TeamGraphCanvasNodeKind = 'start' | 'work' | 'review' | 'human_decision' | 'script_review' | 'join' | 'end';
export type TeamGraphStartTriggerMode = 'manual' | 'webhook' | 'cron';
export type TeamGraphCronPresetId = 'every10Minutes' | 'every30Minutes' | 'hourly' | 'dailyAt9' | 'custom';
export type TeamGraphCronCustomKind = 'intervalMinutes' | 'intervalHours' | 'dailyAt';
export type CustomCronSchedule = { kind: TeamGraphCronCustomKind; intervalMinutes: string; intervalHours: string; time: string };
export type CronScheduleDraft =
  | { mode: 'expression'; expression: string }
  | { mode: 'simple'; presetId: TeamGraphCronPresetId; custom: CustomCronSchedule };

type EditorPresentation = {
  editable: boolean;
  disabled: boolean;
  labels: TeamRunGraphCanvasLabels;
};

export type TeamAssignmentEditorProps = EditorPresentation & {
  kind: 'work' | 'review';
  roleId: string;
  sessionRef: string;
  roles: readonly TeamRoleBindingRecord[];
  prompt: string;
  outputArtifactKind: string;
  onBindingChange: (roleId: string, sessionRef: string) => void;
  onPromptChange: (value: string) => void;
  onOutputArtifactKindChange: (value: string) => void;
};

export type TeamStartEditorProps = EditorPresentation & {
  triggerMode: TeamGraphStartTriggerMode;
  webhookPath: string;
  webhookPublicBaseUrl: string;
  cronSchedule: CronScheduleDraft;
  webhookAuth?: TeamWebhookAuthProjection | null;
  copiedWebhookPublicUrl: boolean;
  onTriggerModeChange: (mode: TeamGraphStartTriggerMode) => void;
  onWebhookPathChange: (value: string) => void;
  onWebhookPublicBaseUrlChange: (value: string) => void;
  onCronScheduleChange: (value: CronScheduleDraft) => void;
  onCopyWebhookPublicUrl: () => void;
};

export type TeamScriptReviewEditorProps = EditorPresentation & {
  rule: TeamScriptReviewRule | '';
  onRuleChange: (value: TeamScriptReviewRule | '') => void;
};

export type TeamControlNodeDetailsProps = {
  kind: 'human_decision' | 'join' | 'end' | 'review' | 'script_review';
  node: TeamGraphNodeRecord;
  nodes: readonly TeamGraphNodeRecord[];
  edges: readonly TeamGraphEdgeRecord[];
  labels: TeamRunGraphCanvasLabels;
};
