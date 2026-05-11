import { NodeRuntimeIdGenerator } from '../../../runtime-host/composition/runtime-host-infrastructure-adapters';

export function createTestRuntimeIdGenerator(): NodeRuntimeIdGenerator {
  return new NodeRuntimeIdGenerator();
}
