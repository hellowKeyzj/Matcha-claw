import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import type {
  SetSubagentDescriptionCommand,
  SetSubagentModelCommand,
  SetSubagentSkillsCommand,
  SubagentConfigAgentDisplayEntry,
  SubagentConfigDisplayDefaults,
  SubagentConfigDisplayView,
  SubagentConfigProjectionPort,
  SubagentConfigReplaceResult,
  SubagentConfigSnapshot,
} from '../../../subagents/subagent-config-contracts';

interface OpenClawSubagentConfigProjectionDeps {
  readonly config: Pick<OpenClawConfigRepositoryPort, 'read' | 'updateDirty' | 'getConfigFilePath'>;
  readonly hashConfig: (config: Record<string, unknown>) => string;
  readonly clock?: { nowMs(): number };
}

export class OpenClawSubagentConfigProjection implements SubagentConfigProjectionPort {
  constructor(private readonly deps: OpenClawSubagentConfigProjectionDeps) {}

  async readDisplayConfig(): Promise<SubagentConfigDisplayView> {
    const snapshot = await this.readConfig();
    const agents = readRecord(snapshot.config.agents);
    const defaults = readDisplayDefaults(agents.defaults);
    return {
      agents: readDisplayAgentEntries(agents.list),
      ...(defaults ? { defaults } : {}),
      revision: snapshot.revision,
      ready: true,
      refreshing: false,
      updatedAt: snapshot.updatedAt,
      error: null,
    };
  }

  async setAgentDescription(command: SetSubagentDescriptionCommand): Promise<SubagentConfigSnapshot> {
    return await this.updateAgentEntry(command.agentId, (entry) => {
      if (command.description === undefined) {
        delete entry.description;
      } else {
        entry.description = command.description;
      }
    });
  }

  async setAgentModel(command: SetSubagentModelCommand): Promise<SubagentConfigSnapshot> {
    return await this.updateAgentEntry(command.agentId, (entry) => {
      if (command.model === undefined) {
        delete entry.model;
      } else {
        entry.model = command.model;
      }
    });
  }

  async setAgentSkills(command: SetSubagentSkillsCommand): Promise<SubagentConfigSnapshot> {
    return await this.updateAgentEntry(command.agentId, (entry) => {
      if (command.skills === undefined) {
        delete entry.skills;
      } else {
        entry.skills = [...command.skills];
      }
    });
  }

  async readConfig(): Promise<SubagentConfigSnapshot> {
    return this.buildSnapshot(await this.deps.config.read());
  }

  async replaceConfig(command: { readonly revision: string; readonly config: Record<string, unknown> }): Promise<SubagentConfigReplaceResult> {
    return await this.deps.config.updateDirty((config) => {
      const currentSnapshot = this.buildSnapshot(config);
      if (currentSnapshot.revision !== command.revision) {
        return {
          result: { resultType: 'staleRevision', latestSnapshot: currentSnapshot } as const,
          changed: false,
        };
      }
      replaceRecordContents(config, cloneRecord(command.config));
      return {
        result: { resultType: 'updated', snapshot: this.buildSnapshot(config) } as const,
        changed: true,
      };
    });
  }

  private async updateAgentEntry(agentId: string, mutate: (entry: Record<string, unknown>) => void): Promise<SubagentConfigSnapshot> {
    const normalizedAgentId = agentId.trim();
    return await this.deps.config.updateDirty((config) => {
      const agents = ensureRecordSection(config, 'agents');
      const list = Array.isArray(agents.list) ? [...agents.list] : [];
      const targetIndex = list.findIndex((entry) => readString(readRecord(entry).id) === normalizedAgentId);
      const currentEntry = targetIndex >= 0 ? readRecord(list[targetIndex]) : { id: normalizedAgentId };
      const nextEntry = { ...currentEntry, id: readString(currentEntry.id) || normalizedAgentId };
      mutate(nextEntry);
      if (targetIndex >= 0) {
        list[targetIndex] = nextEntry;
      } else {
        list.push(nextEntry);
      }
      agents.list = list;
      return {
        result: this.buildSnapshot(config),
        changed: true,
      };
    });
  }

  private buildSnapshot(config: Record<string, unknown>): SubagentConfigSnapshot {
    return {
      config: cloneRecord(config),
      revision: this.deps.hashConfig(config),
      path: this.deps.config.getConfigFilePath(),
      updatedAt: this.deps.clock?.nowMs() ?? null,
    };
  }
}

function readDisplayAgentEntries(value: unknown): SubagentConfigAgentDisplayEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): SubagentConfigAgentDisplayEntry[] => {
    const entry = readRecord(item);
    const id = readString(entry.id);
    if (!id) {
      return [];
    }
    const description = readString(entry.description);
    const workspace = readString(entry.workspace);
    const model = readModelValue(entry.model);
    const skills = readStringArray(entry.skills);
    return [{
      id,
      ...(description ? { description } : {}),
      ...(workspace ? { workspace } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(skills !== undefined ? { skills } : {}),
    }];
  });
}

function readDisplayDefaults(value: unknown): SubagentConfigDisplayDefaults | undefined {
  const defaults = readRecord(value);
  const workspace = readString(defaults.workspace);
  const model = readModelValue(defaults.model);
  const skills = readStringArray(defaults.skills);
  if (!workspace && model === undefined && skills === undefined) {
    return undefined;
  }
  return {
    ...(workspace ? { workspace } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(skills !== undefined ? { skills } : {}),
  };
}

function readModelValue(value: unknown): string | { readonly primary?: string; readonly fallbacks?: readonly string[] } | undefined {
  const modelId = readString(value);
  if (modelId) {
    return modelId;
  }
  const model = readRecord(value);
  const primary = readString(model.primary);
  const fallbacks = readStringArray(model.fallbacks);
  if (!primary && fallbacks === undefined) {
    return undefined;
  }
  return {
    ...(primary ? { primary } : {}),
    ...(fallbacks !== undefined ? { fallbacks } : {}),
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const item of value) {
    const normalized = readString(item);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function ensureRecordSection(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = readRecord(config[key]);
  const section = { ...current };
  config[key] = section;
  return section;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function replaceRecordContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}


function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
