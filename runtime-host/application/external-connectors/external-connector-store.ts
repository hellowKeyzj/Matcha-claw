import {
  assertExternalConnectorSpec,
  type ExternalConnectorSpec,
} from './external-connector-model';

export interface ExternalConnectorStorePort {
  readConnectors(): Promise<readonly ExternalConnectorSpec[]>;
  writeConnectors(connectors: readonly ExternalConnectorSpec[]): Promise<void>;
}

export type ExternalConnectorUpsertResult =
  | { readonly resultType: 'created'; readonly connector: ExternalConnectorSpec }
  | { readonly resultType: 'updated'; readonly connector: ExternalConnectorSpec };

export class ExternalConnectorRegistry {
  private readonly connectors = new Map<string, ExternalConnectorSpec>();

  constructor(connectors: readonly ExternalConnectorSpec[] = []) {
    for (const connector of connectors) {
      this.upsert(connector);
    }
  }

  list(): ExternalConnectorSpec[] {
    return Array.from(this.connectors.values()).map((connector) => structuredClone(connector));
  }

  get(connectorId: string): ExternalConnectorSpec | null {
    const connector = this.connectors.get(connectorId);
    return connector ? structuredClone(connector) : null;
  }

  upsert(input: unknown): ExternalConnectorUpsertResult {
    const connector = assertExternalConnectorSpec(input);
    const resultType = this.connectors.has(connector.id) ? 'updated' : 'created';
    const stored = structuredClone(connector);
    this.connectors.set(stored.id, stored);
    return { resultType, connector: structuredClone(stored) };
  }

  remove(connectorId: string): ExternalConnectorSpec | null {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      return null;
    }
    this.connectors.delete(connectorId);
    return structuredClone(connector);
  }
}

export class ExternalConnectorRepository {
  constructor(private readonly store: ExternalConnectorStorePort) {}

  async list(): Promise<ExternalConnectorSpec[]> {
    const registry = await this.loadRegistry();
    return registry.list();
  }

  async get(connectorId: string): Promise<ExternalConnectorSpec | null> {
    const registry = await this.loadRegistry();
    return registry.get(connectorId);
  }

  async upsert(input: unknown): Promise<ExternalConnectorUpsertResult> {
    const registry = await this.loadRegistry();
    const result = registry.upsert(input);
    await this.store.writeConnectors(registry.list());
    return result;
  }

  async remove(connectorId: string): Promise<ExternalConnectorSpec | null> {
    const registry = await this.loadRegistry();
    const removed = registry.remove(connectorId);
    if (removed) {
      await this.store.writeConnectors(registry.list());
    }
    return removed;
  }

  private async loadRegistry(): Promise<ExternalConnectorRegistry> {
    const connectors = await this.store.readConnectors();
    return new ExternalConnectorRegistry(connectors);
  }
}
