export type AgentSkillConfigUnsupportedReason = 'runtimeDoesNotExposeAgentSkillConfig' | 'agentNotConfigured';

export type AgentSkillConfigSupport =
  | { readonly supportType: 'supported' }
  | { readonly supportType: 'unsupported'; readonly reason: AgentSkillConfigUnsupportedReason };

export type AgentSkillSelectionMode = 'inheritsDefaultSkills' | 'usesExplicitSkillAllowlist';

export interface AgentSkillMissingRequirements {
  readonly bins: readonly string[];
  readonly anyBins: readonly string[];
  readonly env: readonly string[];
  readonly config: readonly string[];
  readonly os: readonly string[];
}

export type AgentSkillUnavailableReason = 'globalSkillDisabled' | 'blockedByRuntimeAllowlist' | 'missingRequirements';

export interface AgentSkillConfigOption {
  readonly skillKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly installed: boolean;
  readonly selectable: boolean;
  readonly unavailableReason?: AgentSkillUnavailableReason;
  readonly missingRequirements?: AgentSkillMissingRequirements;
}

export interface AgentSkillConfigView {
  readonly agentId: string;
  readonly support: AgentSkillConfigSupport;
  readonly selectionMode: AgentSkillSelectionMode;
  readonly explicitSkillKeys: readonly string[];
  readonly inheritedDefaultSkillKeys: readonly string[];
  readonly effectiveSkillKeys: readonly string[];
  readonly options: readonly AgentSkillConfigOption[];
  readonly revision: string;
  readonly updatedAt: number | null;
}

export interface SetAgentSkillConfigCommand {
  readonly agentId: string;
  readonly revision: string;
  readonly selection:
    | { readonly selectionType: 'inheritDefaultSkills' }
    | { readonly selectionType: 'setExplicitSkillAllowlist'; readonly skillKeys: readonly string[] };
}

export type SetAgentSkillConfigResult =
  | { readonly resultType: 'updated'; readonly view: AgentSkillConfigView }
  | { readonly resultType: 'staleRevision'; readonly latestView: AgentSkillConfigView }
  | { readonly resultType: 'unsupported'; readonly reason: AgentSkillConfigUnsupportedReason }
  | {
      readonly resultType: 'invalidSkillKeys';
      readonly unknownSkillKeys: readonly string[];
      readonly nonCanonicalSkillKeys: readonly string[];
    };

export interface AgentSkillConfigProjectionPort {
  readAgentSkillConfig(agentId: string): Promise<AgentSkillConfigView>;
  setAgentSkillConfig(command: SetAgentSkillConfigCommand): Promise<SetAgentSkillConfigResult>;
}
