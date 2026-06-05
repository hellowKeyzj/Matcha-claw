import type { PluginRuntimeService } from '../../plugins/plugin-runtime-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const PLUGIN_RUNTIME_CAPABILITY_ID = 'plugin.runtime';

export const pluginRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'plugins.setEnabled', title: 'Set enabled runtime plugins' },
] as const;

export function createPluginRuntimeCapabilityOperationRoutes(deps: {
  pluginRuntimeService: Pick<PluginRuntimeService, 'setEnabled'>;
}): readonly CapabilityOperationRoute[] {
  return [{
    capabilityId: PLUGIN_RUNTIME_CAPABILITY_ID,
    operationId: 'plugins.setEnabled',
    handle: (context) => deps.pluginRuntimeService.setEnabled(context.domainInput),
  }];
}

