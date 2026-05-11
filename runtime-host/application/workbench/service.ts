import { buildWorkbenchBootstrapPayload } from './bootstrap';
import type { RuntimeClockPort } from '../common/runtime-ports';
import type { RuntimeHostStatePort } from '../runtime-host/runtime-state';

export interface WorkbenchServiceDeps {
  readonly runtimeState: Pick<RuntimeHostStatePort, 'runtimeState'>;
  readonly clock: RuntimeClockPort;
}

export class WorkbenchService {
  constructor(private readonly deps: WorkbenchServiceDeps) {}

  bootstrap() {
    return buildWorkbenchBootstrapPayload(this.deps.runtimeState.runtimeState(), this.deps.clock.nowMs());
  }
}
