import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import type { LineDiffEntry } from '@/lib/line-diff';

export type SubagentTargetFile = (typeof SUBAGENT_TARGET_FILES)[number];

export interface AgentIdentitySummary {
  name?: string;
  theme?: string;
  avatar?: string;
  avatarUrl?: string;
}

export interface SubagentSummary {
  id: string;
  name?: string;
  description?: string;
  workspace?: string;
  model?: string;
  skills?: string[];
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  identity?: AgentIdentitySummary;
  isDefault?: boolean;
}

export interface SubagentAvatarPresentation {
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

export interface SubagentConfigPackage {
  schema: 'matchaclaw.agent-config';
  version: 1;
  agent: {
    name: string;
    description?: string;
    skills?: string[];
    skillBundles?: SubagentSkillBundle[];
    files: Partial<Record<SubagentTargetFile, string>>;
  };
}

export interface SubagentSkillBundle {
  skillKey: string;
  files: Array<{
    path: string;
    content: string;
  }>;
}

export interface SubagentImportResult {
  agentId: string;
  warning?: string;
}

export interface SubagentTemplateSummary {
  id: string;
  name: string;
  summary?: string;
  categoryId?: string;
  subcategoryId?: string;
  order?: number;
  sourcePath?: string;
  files: SubagentTargetFile[];
}

export interface SubagentTemplateCategory {
  id: string;
  order?: number;
}

export interface SubagentTemplateCatalogResult {
  sourceDir?: string;
  categories: SubagentTemplateCategory[];
  templates: SubagentTemplateSummary[];
}

export interface SubagentTemplateDetail extends SubagentTemplateSummary {
  sourceDir?: string;
  fileContents: Partial<Record<SubagentTargetFile, string>>;
}

export interface AgentsListResult {
  agents: SubagentSummary[];
  defaultId?: string;
  mainKey?: string;
  scope?: string;
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  credentialId?: string;
  providerLabel: string;
  modelLabel: string;
  displayLabel: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface SubagentDraftFile {
  name: SubagentTargetFile;
  content: string;
  reason: string;
  confidence: number;
  needsReview: boolean;
}

export type DraftByFile = Partial<Record<SubagentTargetFile, SubagentDraftFile>>;
export type PreviewDiffByFile = Partial<Record<SubagentTargetFile, LineDiffEntry[]>>;
