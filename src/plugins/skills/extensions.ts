import type { ComponentType, ReactNode } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { RuntimeScope } from '@/types/desktop/runtime-address';
import type { SealedSkillMetadata } from '@/types/skill';

export interface SkillScopeContext {
  scope: RuntimeScope | null;
  scopeKey: string | null;
  openClaw: boolean;
  nativeAgent: boolean;
  selectionCurrent: () => boolean;
}

export interface SkillViewProps extends SkillScopeContext {
  active: boolean;
  view: 'grid' | 'list';
}

export interface SkillToolbarProps extends SkillViewProps {
  navigation?: ReactNode;
  entries: ReactNode;
  viewControls: ReactNode;
}

export interface SkillOwnerProps extends SkillScopeContext {
  activeViewId: string;
  view: 'grid' | 'list';
  children: ReactNode;
}

export interface SkillSourceView {
  id: string;
  area: 'main' | 'packages';
  label: string;
  order: number;
  component: ComponentType<SkillViewProps>;
  toolbar?: ComponentType<SkillToolbarProps>;
  headerActions?: ComponentType<SkillViewProps>;
  badge?: ComponentType<SkillViewProps>;
}

export interface SkillSourceContribution {
  id: string;
  views: readonly SkillSourceView[];
  owner?: ComponentType<SkillOwnerProps>;
}

export interface SkillPackageMenuProps extends SkillScopeContext {
  skill: SealedSkillMetadata;
  disabled: boolean;
}

export interface SkillTransferContribution {
  id: string;
  owner: ComponentType<SkillOwnerProps>;
  toolbarEntries: readonly {
    viewId: string;
    component: ComponentType<SkillViewProps>;
  }[];
  packageMenuItems?: ComponentType<SkillPackageMenuProps>;
}

export const skillSources = defineExtensionPoint<SkillSourceContribution>('skills.sources');
export const skillTransfers = defineExtensionPoint<SkillTransferContribution>('skills.transfers');
