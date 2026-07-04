export type SubagentModelValue = string | { readonly primary?: string; readonly fallbacks?: readonly string[] };

export interface SubagentConfigAgentDisplayEntry {
  readonly id: string;
  readonly description?: string;
  readonly workspace?: string;
  readonly model?: SubagentModelValue;
  readonly skills?: readonly string[];
}

export interface SubagentConfigDisplayDefaults {
  readonly workspace?: string;
  readonly model?: SubagentModelValue;
  readonly skills?: readonly string[];
}

export interface SubagentConfigDisplayView {
  readonly agents: readonly SubagentConfigAgentDisplayEntry[];
  readonly defaults?: SubagentConfigDisplayDefaults;
  readonly revision: string;
  readonly ready: true;
  readonly refreshing: false;
  readonly updatedAt: number | null;
  readonly error: null;
}

export interface SubagentConfigSnapshot {
  readonly config: Record<string, unknown>;
  readonly revision: string;
  readonly path?: string;
  readonly updatedAt: number | null;
}

export type SubagentConfigReplaceResult =
  | { readonly resultType: 'updated'; readonly snapshot: SubagentConfigSnapshot }
  | { readonly resultType: 'staleRevision'; readonly latestSnapshot: SubagentConfigSnapshot };

export interface SetSubagentDescriptionCommand {
  readonly agentId: string;
  readonly description?: string;
}

export interface SetSubagentModelCommand {
  readonly agentId: string;
  readonly model?: string;
}

export interface SetSubagentSkillsCommand {
  readonly agentId: string;
  readonly skills?: readonly string[];
}

export interface SubagentConfigProjectionPort {
  readDisplayConfig(): Promise<SubagentConfigDisplayView>;
  setAgentDescription(command: SetSubagentDescriptionCommand): Promise<SubagentConfigSnapshot>;
  setAgentModel(command: SetSubagentModelCommand): Promise<SubagentConfigSnapshot>;
  setAgentSkills(command: SetSubagentSkillsCommand): Promise<SubagentConfigSnapshot>;
  readConfig(): Promise<SubagentConfigSnapshot>;
  replaceConfig(command: { readonly revision: string; readonly config: Record<string, unknown> }): Promise<SubagentConfigReplaceResult>;
}
