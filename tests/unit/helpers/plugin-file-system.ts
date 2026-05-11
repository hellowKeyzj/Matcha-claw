import { NodePluginFileSystem } from '../../../runtime-host/composition/plugin-file-system-adapter';

export function createTestPluginFileSystem(): NodePluginFileSystem {
  return new NodePluginFileSystem();
}
