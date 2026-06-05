import type { ApplicationResponse } from '../common/application-response';
import type { PluginRuntimeOperationsWorkflow } from '../workflows/plugin-runtime/plugin-runtime-operations-workflow';

export interface PluginRuntimeServiceDeps {
  operationsWorkflow: Pick<PluginRuntimeOperationsWorkflow, 'runtime' | 'catalog' | 'setEnabled'>;
}

export class PluginRuntimeService {
  constructor(private readonly deps: PluginRuntimeServiceDeps) {}

  runtime(): ApplicationResponse {
    return this.deps.operationsWorkflow.runtime();
  }

  catalog(): ApplicationResponse {
    return this.deps.operationsWorkflow.catalog();
  }

  setEnabled(payload: unknown): ApplicationResponse {
    return this.deps.operationsWorkflow.setEnabled(payload);
  }
}
