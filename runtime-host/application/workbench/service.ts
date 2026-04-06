import { buildWorkbenchBootstrapPayload } from './bootstrap';

type RuntimeState = {
  lifecycle: string;
  plugins: Array<{ lifecycle?: string } & Record<string, any>>;
};

export interface WorkbenchServiceDeps {
  readonly buildLocalRuntimeState: () => RuntimeState;
}

export class WorkbenchService {
  constructor(private readonly deps: WorkbenchServiceDeps) {}

  bootstrap() {
    return buildWorkbenchBootstrapPayload(this.deps.buildLocalRuntimeState());
  }
}
