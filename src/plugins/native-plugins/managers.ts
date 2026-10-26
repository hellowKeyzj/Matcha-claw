import { isPluginScope } from '@/types/plugins';
import { runtimeInstanceScope } from '@/types/desktop/runtime-address';
import type { NativePluginManagerContribution } from './extensions';

export const openClawPluginManager: NativePluginManagerContribution = {
  runtime: 'openclaw',
  selectScope(endpoint) {
    if (endpoint?.kind !== 'native-runtime' || endpoint.runtimeAdapterId !== 'openclaw') return null;
    const scope = runtimeInstanceScope(endpoint);
    return isPluginScope(scope) ? scope : null;
  },
  requiresRuntimeStatus: true,
  supportsKindFilter: true,
  card(plugin, enabledPluginIds, t) {
    if (plugin.runtime !== 'openclaw') return null;
    return {
      name: plugin.name,
      description: plugin.description,
      companionSkillSlugs: plugin.companionSkillSlugs,
      enabled: enabledPluginIds.has(plugin.id),
      kind: plugin.kind,
      identityScope: null,
      searchText: [plugin.id, plugin.version, plugin.name, plugin.description, plugin.platform],
      pills: [t(`plugins:catalog.platform.${plugin.platform}`), t(`plugins:catalog.kind.${plugin.kind}`)],
    };
  },
};

export const matchaPluginManager: NativePluginManagerContribution = {
  runtime: 'matcha-agent',
  selectScope(_endpoint, agentScope) {
    return isPluginScope(agentScope) ? agentScope : null;
  },
  requiresRuntimeStatus: false,
  supportsKindFilter: false,
  card(plugin, _enabledPluginIds, t) {
    if (plugin.runtime !== 'matcha-agent') return null;
    return {
      name: plugin.id,
      enabled: plugin.enabled,
      identityScope: plugin.scope,
      searchText: [plugin.id, plugin.version, plugin.scope],
      pills: [plugin.scope],
      detail: t('plugins:catalog.nativeErrors', { count: plugin.errorCount, defaultValue: '加载错误：{{count}}' }),
    };
  },
};
