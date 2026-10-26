import { selectManagementEndpoint, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { runtimeEndpointsEqual, type RuntimeInstanceScope } from '@/types/desktop/runtime-address';

export function channelScopeCurrent(scope: RuntimeInstanceScope): boolean {
  const endpoint = selectManagementEndpoint(useRuntimeEndpointsStore.getState());
  return endpoint !== null && runtimeEndpointsEqual(endpoint, scope.endpoint);
}
