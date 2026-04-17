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
  workspace?: string;
  model?: string;
  skills?: string[];
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  identity?: AgentIdentitySummary;
  isDefault?: boolean;
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
}

export interface ModelCatalogEntry {
  id: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
}

export interface AgentModelObject {
  primary?: string;
  fallbacks?: string[];
}

export type AgentModelValue = string | AgentModelObject;

export interface AgentConfigEntry {
  id: string;
  default?: boolean;
  model?: AgentModelValue;
  skills?: string[];
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  [key: string]: unknown;
}

export interface ConfigProviderModelEntry {
  id?: string;
  [key: string]: unknown;
}

export interface ConfigProviderEntry {
  models?: Array<string | ConfigProviderModelEntry>;
  [key: string]: unknown;
}

export interface ConfigGetResult {
  baseHash?: string;
  hash?: string;
  path?: string;
  config: {
    agents?: {
      defaults?: {
        workspace?: string;
        model?: AgentModelValue;
        models?: Record<string, unknown>;
      };
      list?: AgentConfigEntry[];
    };
    models?: {
      providers?: Record<string, ConfigProviderEntry>;
    };
    [key: string]: unknown;
  };
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
