import path from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import {
  assertExternalConnectorSpec,
  type ExternalConnectorSpec,
} from './external-connector-model';
import type { ExternalConnectorStorePort } from './external-connector-store';

export interface ExternalConnectorRuntimeDataPort {
  getRuntimeDataRootDir(): string;
}

export class ExternalConnectorJsonStore implements ExternalConnectorStorePort {
  constructor(private readonly deps: {
    readonly runtimeData: ExternalConnectorRuntimeDataPort;
    readonly fileSystem: RuntimeFileSystemPort;
  }) {}

  async readConnectors(): Promise<readonly ExternalConnectorSpec[]> {
    const storePath = this.storePath();
    if (!await this.deps.fileSystem.exists(storePath)) {
      return [];
    }
    const raw = await this.deps.fileSystem.readTextFile(storePath);
    const parsed = JSON.parse(raw) as unknown;
    const connectors = readConnectorArray(parsed);
    return connectors.map((connector) => assertExternalConnectorSpec(connector));
  }

  async writeConnectors(connectors: readonly ExternalConnectorSpec[]): Promise<void> {
    const storePath = this.storePath();
    await this.deps.fileSystem.ensureDirectory(path.dirname(storePath));
    const content = `${JSON.stringify({ version: 1, connectors }, null, 2)}\n`;
    await this.deps.fileSystem.writeTextFile(storePath, content);
  }

  private storePath(): string {
    return path.join(this.deps.runtimeData.getRuntimeDataRootDir(), 'external-connectors', 'connectors.json');
  }
}

function readConnectorArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const connectors = (value as Record<string, unknown>).connectors;
    if (Array.isArray(connectors)) {
      return connectors;
    }
  }
  throw new Error('External connector store must contain a connectors array');
}
