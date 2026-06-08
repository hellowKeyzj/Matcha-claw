import type { PluginRuntimeService } from '../../plugins/plugin-runtime-service';
import { badRequest } from '../../common/application-response';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';

export const PLUGIN_RUNTIME_CAPABILITY_ID = 'plugin.runtime';

export const pluginRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'plugins.setEnabled', title: 'Set enabled runtime plugins', targetKind: 'plugin' },
] as const;

export function createPluginRuntimeCapabilityOperationRoutes(deps: {
  pluginRuntimeService: Pick<PluginRuntimeService, 'setEnabled'>;
}): readonly CapabilityOperationRoute[] {
  return [{
    capabilityId: PLUGIN_RUNTIME_CAPABILITY_ID,
    operationId: 'plugins.setEnabled',
    handle: (context) => {
      const targetError = validatePluginTargetInput(context);
      return targetError ? badRequest(targetError) : deps.pluginRuntimeService.setEnabled(context.domainInput);
    },
  }];
}

function validatePluginTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'plugin') {
    return 'Capability target kind must be plugin';
  }
  const targetPluginId = typeof context.target.pluginId === 'string' && context.target.pluginId.trim()
    ? context.target.pluginId
    : '';
  if (!targetPluginId) {
    return 'Capability target pluginId is required';
  }
  const pluginIds = context.domainInput.pluginIds;
  return Array.isArray(pluginIds)
    && pluginIds.length === 1
    && pluginIds[0] === targetPluginId
    ? null
    : 'Capability target pluginId must match the single input pluginId';
}

