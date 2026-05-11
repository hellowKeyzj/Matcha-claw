import type {
  AuditSinkPort,
  RegistryQuery,
  ToolDefinition,
  ToolId,
  ToolRegistryPort,
} from '../../shared/platform-runtime-contracts';
import type { RuntimeClockPort } from '../common/runtime-ports';

export class ToolCatalogService {
  constructor(
    private readonly toolRegistry: ToolRegistryPort,
    private readonly auditSink: AuditSinkPort,
    private readonly clock: RuntimeClockPort,
  ) {}

  async listEffective(query: RegistryQuery = {}): Promise<ToolDefinition[]> {
    return this.toolRegistry.listEffective(query);
  }

  async upsertPlatformTools(tools: ToolDefinition[]): Promise<void> {
    await this.toolRegistry.upsertPlatform(tools);
    await this.auditSink.append({
      type: 'tool_catalog.upsert_platform',
      ts: this.clock.nowMs(),
      payload: { count: tools.length },
    });
  }

  async setToolEnabled(toolId: ToolId, enabled: boolean): Promise<void> {
    await this.toolRegistry.setEnabled(toolId, enabled);
    await this.auditSink.append({
      type: 'tool_catalog.set_enabled',
      ts: this.clock.nowMs(),
      payload: { toolId, enabled },
    });
  }
}
