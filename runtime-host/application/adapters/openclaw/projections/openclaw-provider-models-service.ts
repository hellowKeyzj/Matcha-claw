import type {
  OpenClawProviderModelsEntry,
  OpenClawProviderModelsMap,
  OpenClawProviderModelsProjectionWorkflow,
  ProviderModelEntry,
} from '../workflows/openclaw-provider/openclaw-provider-models-projection-workflow';

export type {
  OpenClawProviderModelsEntry,
  OpenClawProviderModelsMap,
  ProviderModelEntry,
} from '../workflows/openclaw-provider/openclaw-provider-models-projection-workflow';

export class OpenClawProviderModelsService {
  constructor(
    private readonly projectionWorkflow: Pick<OpenClawProviderModelsProjectionWorkflow, 'readAll' | 'replaceAll'>,
  ) {}

  async readAll(): Promise<Record<string, ProviderModelEntry[]>> {
    return await this.projectionWorkflow.readAll();
  }

  async replaceAll(providerMap: OpenClawProviderModelsMap, validModelRefs?: readonly string[]): Promise<void> {
    await this.projectionWorkflow.replaceAll(providerMap, validModelRefs);
  }
}
