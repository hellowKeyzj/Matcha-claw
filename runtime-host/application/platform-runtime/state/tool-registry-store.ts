import type {
  RegistryQuery,
  ToolDefinition,
  ToolId,
  ToolRegistryPort,
} from '../../../shared/platform-runtime-contracts';

function filterWithQuery(tools: ToolDefinition[], query: RegistryQuery): ToolDefinition[] {
  const filteredByEnabled = query.includeDisabled
    ? tools
    : tools.filter((tool) => tool.enabled !== false);

  if (!query.requestedToolIds || query.requestedToolIds.length === 0) {
    return filteredByEnabled;
  }

  const requestedSet = new Set(query.requestedToolIds);
  return filteredByEnabled.filter((tool) => requestedSet.has(tool.id));
}

export class ToolRegistryStore implements ToolRegistryPort {
  private readonly nativeTools = new Map<ToolId, ToolDefinition>();
  private readonly platformTools = new Map<ToolId, ToolDefinition>();

  async upsertNative(tools: ToolDefinition[]): Promise<void> {
    for (const tool of tools) {
      this.nativeTools.set(tool.id, { ...tool, source: 'native' });
    }
  }

  async upsertPlatform(tools: ToolDefinition[]): Promise<void> {
    for (const tool of tools) {
      this.platformTools.set(tool.id, { ...tool, source: 'platform' });
    }
  }

  async setEnabled(toolId: ToolId, enabled: boolean): Promise<void> {
    const native = this.nativeTools.get(toolId);
    if (native) {
      this.nativeTools.set(toolId, { ...native, enabled });
    }

    const platform = this.platformTools.get(toolId);
    if (platform) {
      this.platformTools.set(toolId, { ...platform, enabled });
    }
  }

  async listEffective(query: RegistryQuery): Promise<ToolDefinition[]> {
    const merged = [...this.nativeTools.values(), ...this.platformTools.values()];
    return filterWithQuery(merged, query);
  }

  snapshotNative(): ToolDefinition[] {
    return [...this.nativeTools.values()];
  }

  snapshotPlatform(): ToolDefinition[] {
    return [...this.platformTools.values()];
  }
}
