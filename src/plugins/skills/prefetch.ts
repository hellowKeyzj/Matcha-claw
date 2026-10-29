import { isGatewayOperational } from '@/plugins/runtime/gateway-status';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useSkillsStore } from './stores/skills';

export function prefetchSkills(): void {
  if (isGatewayOperational(useGatewayStore.getState().status)) {
    void useSkillsStore.getState().fetchSkills({ silent: true });
  }
}
