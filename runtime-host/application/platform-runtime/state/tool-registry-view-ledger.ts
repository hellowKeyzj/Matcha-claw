import type { RegistryQuery, ToolDefinition, ToolRegistryPort } from '../../../shared/platform-runtime-contracts';

export class ToolRegistryViewLedger {
  constructor(private readonly registry: ToolRegistryPort) {}

  async snapshot(query: RegistryQuery = {}): Promise<ToolDefinition[]> {
    return this.registry.listEffective(query);
  }
}
