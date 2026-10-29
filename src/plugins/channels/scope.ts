import { selectManagementEndpoint, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { runtimeEndpointsEqual, type RuntimeInstanceScope } from '@/types/desktop/runtime-address';

export function channelScopeCurrent(scope: RuntimeInstanceScope): boolean {
  const endpoint = selectManagementEndpoint(useRuntimeEndpointsStore.getState());
  return endpoint !== null && runtimeEndpointsEqual(endpoint, scope.endpoint);
}
