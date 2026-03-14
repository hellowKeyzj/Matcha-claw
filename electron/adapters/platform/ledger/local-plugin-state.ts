import type { ToolDefinition, ToolId } from '../../../core/contracts';

export class LocalPluginStateLedger {
  private readonly records = new Map<ToolId, ToolDefinition>();

  setAll(tools: ToolDefinition[]): void {
    this.records.clear();
    for (const tool of tools) {
      this.records.set(tool.id, { ...tool, source: 'platform' });
    }
  }

  upsert(tool: ToolDefinition): void {
    this.records.set(tool.id, { ...tool, source: 'platform' });
  }

  list(): ToolDefinition[] {
    return [...this.records.values()];
  }
}
