import type { ComponentType, ReactNode } from 'react';
import type { NavigationContribution } from '@/app/extensions';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { AgentScope, RuntimeEndpointRef } from '@/types/desktop/runtime-address';
import type { AgentAvatarStyle, ModelCatalogEntry, SubagentSummary } from '@/types/subagent';
import type { AgentSkillConfigView, SetAgentSkillConfigCommand } from './stores/agent-skill-config';
import type { AgentToolConfigView, SetAgentToolConfigCommand } from './stores/agent-tool-config';
import type { useSubagentsStore } from './stores/subagents';

export type AgentWorkbenchPageContribution = Pick<
  NavigationContribution,
  'id' | 'to' | 'label' | 'icon' | 'order' | 'prefetch'
>;

export const agentWorkbenchPages = defineExtensionPoint<AgentWorkbenchPageContribution>('agents.workbench.pages');

export type AgentEditorMode = 'create' | 'edit';
export type AgentEditorTab = 'basic' | 'persona' | 'skills' | 'tools';
export interface AgentEditorValues {
  name: string;
  description: string;
  avatarSeed: string;
  avatarStyle: AgentAvatarStyle;
}

type SubagentsState = ReturnType<typeof useSubagentsStore.getState>;
export type AgentEditorCreateInput = Parameters<SubagentsState['createAgent']>[0];
export type AgentEditorUpdateInput = Parameters<SubagentsState['updateAgent']>[0];
export interface AgentEditorUpdate {
  input: AgentEditorUpdateInput;
  skillConfig?: SetAgentSkillConfigCommand;
  toolConfig?: SetAgentToolConfigCommand;
}
export type AgentEditorSubmission =
  | { mode: 'create'; input: AgentEditorCreateInput }
  | ({ mode: 'edit' } & AgentEditorUpdate);

export interface AgentEditorController {
  basicInfoLocked: boolean;
  valid: boolean;
  fields: { basic: ReactNode; skills: ReactNode; tools: ReactNode };
  reconcileName: (name: string) => void;
  prepareCreate: (values: AgentEditorValues) => AgentEditorCreateInput;
  prepareUpdate: (values: AgentEditorValues, agentId: string) => AgentEditorUpdate;
}

export interface AgentEditorOwnerProps {
  open: boolean;
  mode: AgentEditorMode;
  agentId?: string | null;
  scope: AgentScope | null;
  name: string;
  activeTab: AgentEditorTab;
  initialValues?: SubagentSummary;
  initialSnapshot: {
    initialValues?: SubagentSummary;
    modelOptions: ModelCatalogEntry[];
    existingAgents: Pick<SubagentSummary, 'id' | 'workspace' | 'isDefault'>[];
  };
  existingAgents: Pick<SubagentSummary, 'id' | 'workspace' | 'isDefault'>[];
  modelOptions: ModelCatalogEntry[];
  modelsLoading: boolean;
  skillConfigView?: AgentSkillConfigView | null;
  skillConfigLoading?: boolean;
  skillConfigError?: string | null;
  toolConfigView?: AgentToolConfigView | null;
  toolConfigLoading?: boolean;
  toolConfigError?: string | null;
  children: (editor: AgentEditorController) => ReactNode;
}

export interface AgentEditorRuntimeContribution {
  id: string;
  matches: (endpoint: RuntimeEndpointRef) => boolean;
  usesModelCatalog: boolean;
  supportsSkillConfig: boolean;
  owner: ComponentType<AgentEditorOwnerProps>;
}

export const agentEditorRuntimes = defineExtensionPoint<AgentEditorRuntimeContribution>('agents.editor.runtimes');
