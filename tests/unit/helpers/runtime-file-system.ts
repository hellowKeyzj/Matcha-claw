import { NodeRuntimeFileSystem } from '../../../runtime-host/composition/runtime-host-infrastructure-adapters';

export function createTestRuntimeFileSystem(): NodeRuntimeFileSystem {
  return new NodeRuntimeFileSystem();
}
