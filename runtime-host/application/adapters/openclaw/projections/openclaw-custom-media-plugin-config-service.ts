import type {
  OpenClawCustomMediaModelEntry,
  OpenClawCustomMediaPluginConfigWorkflow,
  OpenClawCustomMediaProviderMap,
} from '../workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow';

export type {
  OpenClawCustomMediaModelEntry,
  OpenClawCustomMediaProviderEntry,
  OpenClawCustomMediaProviderMap,
} from '../workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow';

export class OpenClawCustomMediaPluginConfigService {
  constructor(
    private readonly configWorkflow: Pick<OpenClawCustomMediaPluginConfigWorkflow, 'readAll' | 'replaceAll'>,
  ) {}

  async readAll(): Promise<Record<string, OpenClawCustomMediaModelEntry[]>> {
    return await this.configWorkflow.readAll();
  }

  async replaceAll(providerMap: OpenClawCustomMediaProviderMap): Promise<void> {
    await this.configWorkflow.replaceAll(providerMap);
  }
}
