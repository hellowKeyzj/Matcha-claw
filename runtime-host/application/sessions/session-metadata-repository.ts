import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';
import type { SessionStorageDescriptor } from './session-storage-repository';

export interface SessionMetadataRepositoryDeps {
  workspace: Pick<OpenClawWorkspacePort, 'getConfigDir'>;
  fileSystem: RuntimeFileSystemPort;
}

export interface SessionMetadataPort {
  resolveSessionModel(input: {
    sessionKey: string;
    storageDescriptor: SessionStorageDescriptor | null;
    runtimeModel?: string | null;
  }): Promise<string | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseSessionKeyAgent(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) {
    return null;
  }
  const parts = sessionKey.split(':');
  const agentId = parts[1]?.trim();
  return agentId || null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readAgentModelValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const model = value.model;
  if (typeof model === 'string') {
    const normalized = normalizeString(model);
    return normalized || null;
  }
  if (isRecord(model)) {
    const primary = normalizeString(model.primary);
    return primary || null;
  }
  return null;
}

function qualifySessionModel(provider: string, model: string): string | null {
  if (!model) {
    return null;
  }
  if (provider && model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) {
    return model;
  }
  return provider ? `${provider}/${model}` : model;
}

function readSessionStoreResolvedModel(entry: Record<string, unknown> | null): string | null {
  if (!entry) {
    return null;
  }
  const providerOverride = normalizeString(entry.providerOverride);
  const modelOverride = normalizeString(entry.modelOverride);
  const overrideModel = qualifySessionModel(providerOverride, modelOverride);
  if (overrideModel) {
    return overrideModel;
  }
  const runtimeProvider = normalizeString(entry.modelProvider);
  const runtimeModel = normalizeString(entry.model);
  return qualifySessionModel(runtimeProvider, runtimeModel);
}

function resolveAgentConfigDefaultModel(
  config: Record<string, unknown> | null,
  sessionKey: string,
): string | null {
  if (!config) {
    return null;
  }
  const agents = isRecord(config.agents) ? config.agents : null;
  const agentId = parseSessionKeyAgent(sessionKey);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  if (agentId) {
    const matchedAgent = list.find((candidate) => (
      isRecord(candidate) && normalizeString(candidate.id) === agentId
    ));
    const agentModel = readAgentModelValue(matchedAgent);
    if (agentModel) {
      return agentModel;
    }
  }
  return readAgentModelValue(agents?.defaults);
}

export class SessionMetadataRepository implements SessionMetadataPort {
  constructor(private readonly deps: SessionMetadataRepositoryDeps) {}

  async resolveSessionModel(input: {
    sessionKey: string;
    storageDescriptor: SessionStorageDescriptor | null;
    runtimeModel?: string | null;
  }): Promise<string | null> {
    if (input.runtimeModel) {
      return input.runtimeModel;
    }
    const entryModel = readSessionStoreResolvedModel(input.storageDescriptor?.sessionStoreEntry ?? null);
    if (entryModel) {
      return entryModel;
    }
    return resolveAgentConfigDefaultModel(await this.readOpenClawConfig(), input.sessionKey);
  }

  private openClawConfigPath(): string {
    return join(this.deps.workspace.getConfigDir(), 'openclaw.json');
  }

  private async readOpenClawConfig(): Promise<Record<string, unknown> | null> {
    try {
      return parseJsonRecord(await this.deps.fileSystem.readTextFile(this.openClawConfigPath()));
    } catch {
      return null;
    }
  }
}
