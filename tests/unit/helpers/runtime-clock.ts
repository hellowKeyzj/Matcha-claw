import type { RuntimeClockPort } from '../../../runtime-host/application/common/runtime-ports';

export function createTestRuntimeClock(): RuntimeClockPort {
  return {
    nowMs: () => 1_700_000_000_000,
    nowIso: () => '2023-11-14T22:13:20.000Z',
    toIsoString: (ms) => new Date(ms).toISOString(),
  };
}
