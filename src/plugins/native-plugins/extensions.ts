import type { TFunction } from 'i18next';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { AgentScope, RuntimeEndpointRef } from '@/types/desktop/runtime-address';
import type { PluginCatalogItem, PluginRuntimeId, PluginScope } from '@/types/plugins';

export interface NativePluginCard {
  name: string;
  description?: string;
  companionSkillSlugs?: readonly string[];
  enabled: boolean;
  kind?: 'builtin' | 'third-party';
  identityScope: string | null;
  searchText: readonly (string | undefined)[];
  pills: readonly string[];
  detail?: string;
}

export interface NativePluginManagerContribution {
  runtime: PluginRuntimeId;
  selectScope: (endpoint: RuntimeEndpointRef | null, agentScope: AgentScope | null) => PluginScope | null;
  requiresRuntimeStatus: boolean;
  supportsKindFilter: boolean;
  card: (plugin: PluginCatalogItem, enabledPluginIds: ReadonlySet<string>, t: TFunction) => NativePluginCard | null;
}

// These adapters manage native plugins; they do not load Renderer extensions.
export const nativePluginManagers = defineExtensionPoint<NativePluginManagerContribution>('native-plugins.managers');
