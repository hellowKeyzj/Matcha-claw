import { join } from 'path';
import { homedir } from 'os';
import { discoverAgentIds, readJsonFile, writeJsonFile } from './openclaw-auth-store';

export async function updateAgentModelProvider(
  providerType: string,
  entry: {
    baseUrl?: string;
    api?: string;
    models?: Array<{ id: string; name: string }>;
    apiKey?: string;
    authHeader?: boolean;
  },
): Promise<void> {
  const agentIds = await discoverAgentIds();
  for (const agentId of agentIds) {
    const modelsPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'models.json');
    let data: Record<string, unknown>;
    try {
      data = (await readJsonFile<Record<string, unknown>>(modelsPath)) ?? {};
    } catch {
      data = {};
    }

    const providers = (
      data.providers && typeof data.providers === 'object' ? data.providers : {}
    ) as Record<string, Record<string, unknown>>;

    const existing: Record<string, unknown> =
      providers[providerType] && typeof providers[providerType] === 'object'
        ? { ...providers[providerType] }
        : {};

    const existingModels = Array.isArray(existing.models)
      ? (existing.models as Array<Record<string, unknown>>)
      : [];

    const mergedModels = (entry.models ?? []).map((model) => {
      const previous = existingModels.find((candidate) => candidate.id === model.id);
      return previous ? { ...previous, id: model.id, name: model.name } : { ...model };
    });

    if (entry.baseUrl !== undefined) existing.baseUrl = entry.baseUrl;
    if (entry.api !== undefined) existing.api = entry.api;
    if (mergedModels.length > 0) existing.models = mergedModels;
    if (entry.apiKey !== undefined) existing.apiKey = entry.apiKey;
    if (entry.authHeader !== undefined) existing.authHeader = entry.authHeader;

    providers[providerType] = existing;
    data.providers = providers;

    try {
      await writeJsonFile(modelsPath, data);
      console.log(`Updated models.json for agent "${agentId}" provider "${providerType}"`);
    } catch (error) {
      console.warn(`Failed to update models.json for agent "${agentId}":`, error);
    }
  }
}
