import type { AuditSinkPort, RegistryQuery, ToolDefinition, ToolId, ToolRegistryPort } from '../contracts';

export class ToolCatalogService {
  constructor(
    private readonly toolRegistry: ToolRegistryPort,
    private readonly auditSink: AuditSinkPort,
  ) {}

  async listEffective(query: RegistryQuery = {}): Promise<ToolDefinition[]> {
    return this.toolRegistry.listEffective(query);
  }

  async upsertPlatformTools(tools: ToolDefinition[]): Promise<void> {
    await this.toolRegistry.upsertPlatform(tools);
    await this.auditSink.append({
      type: 'tool_catalog.upsert_platform',
      ts: Date.now(),
      payload: { count: tools.length },
    });
  }

  async setToolEnabled(toolId: ToolId, enabled: boolean): Promise<void> {
    await this.toolRegistry.setEnabled(toolId, enabled);
    await this.auditSink.append({
      type: 'tool_catalog.set_enabled',
      ts: Date.now(),
      payload: { toolId, enabled },
    });
  }
}
