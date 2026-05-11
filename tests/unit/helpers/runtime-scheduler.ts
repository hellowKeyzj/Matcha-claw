import type { RuntimeScheduledTask, RuntimeSchedulerPort, RuntimeTimerPort } from '../../../runtime-host/application/common/runtime-ports';

export class TestRuntimeScheduler implements RuntimeSchedulerPort {
  schedule(delayMs: number, task: () => void): RuntimeScheduledTask {
    const timer = setTimeout(task, Math.max(0, delayMs));
    return {
      cancel: () => clearTimeout(timer),
    };
  }
}

export function createTestRuntimeScheduler(): RuntimeSchedulerPort {
  return new TestRuntimeScheduler();
}

export function createImmediateRuntimeTimer(): RuntimeTimerPort {
  return {
    sleep: async () => {},
  };
}
