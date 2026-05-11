import { createRuntimeLogger } from '../../../runtime-host/shared/logger';
import { createTestRuntimeClock } from './runtime-clock';

export function createTestRuntimeLogger(scope = 'test') {
  return createRuntimeLogger(scope, createTestRuntimeClock(), {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
}
