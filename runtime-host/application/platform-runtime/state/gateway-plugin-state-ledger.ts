import type { ToolDefinition, ToolId } from '../../../shared/platform-runtime-contracts';

export class GatewayPluginStateLedger {
  private readonly records = new Map<ToolId, ToolDefinition>();

  setAll(tools: ToolDefinition[]): void {
    this.records.clear();
    for (const tool of tools) {
      this.records.set(tool.id, { ...tool, source: 'native' });
    }
  }

  list(): ToolDefinition[] {
    return [...this.records.values()];
  }
}
