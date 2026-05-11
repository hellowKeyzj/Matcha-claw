import { RuntimeHostContainer } from '../../../runtime-host/composition/container';
import { createTestRuntimeClock } from './runtime-clock';

export function createTestRuntimeHostContainer(): RuntimeHostContainer {
  const container = new RuntimeHostContainer();
  container.registerValue('runtime.clock', createTestRuntimeClock());
  container.registerValue('runtime.idGenerator', {
    randomId: () => 'test-runtime-id',
    randomHex: (bytes: number) => 'a'.repeat(Math.max(1, bytes) * 2),
  });
  return container;
}
