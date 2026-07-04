export type AgentToolConfigUnsupportedReason = 'runtimeDoesNotExposeAgentToolConfig' | 'agentNotConfigured';

export type AgentToolConfigSupport =
  | { readonly supportType: 'supported' }
  | { readonly supportType: 'unsupported'; readonly reason: AgentToolConfigUnsupportedReason };

export type AgentToolSelectionMode = 'inheritsDefaultTools' | 'usesAgentToolPolicy';

export interface AgentToolPolicy {
  readonly profile: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface AgentToolConfigOption {
  readonly toolKey: string;
  readonly displayName: string;
  readonly optionType: 'tool' | 'group';
}

export interface AgentToolConfigView {
  readonly agentId: string;
  readonly support: AgentToolConfigSupport;
  readonly selectionMode: AgentToolSelectionMode;
  readonly toolPolicy: AgentToolPolicy | null;
  readonly toolOptions: readonly AgentToolConfigOption[];
  readonly revision: string;
  readonly updatedAt: number | null;
}

export interface SetAgentToolPolicySelection {
  readonly selectionType: 'setAgentToolPolicy';
  readonly profile: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface SetAgentToolConfigCommand {
  readonly agentId: string;
  readonly revision: string;
  readonly selection:
    | { readonly selectionType: 'inheritDefaultTools' }
    | SetAgentToolPolicySelection;
}

export type SetAgentToolConfigResult =
  | { readonly resultType: 'updated'; readonly view: AgentToolConfigView }
  | { readonly resultType: 'staleRevision'; readonly latestView: AgentToolConfigView }
  | { readonly resultType: 'unsupported'; readonly reason: AgentToolConfigUnsupportedReason }
  | { readonly resultType: 'invalidToolKeys'; readonly unknownToolKeys: readonly string[] };

export interface AgentToolConfigProjectionPort {
  readAgentToolConfig(agentId: string): Promise<AgentToolConfigView>;
  setAgentToolConfig(command: SetAgentToolConfigCommand): Promise<SetAgentToolConfigResult>;
}
