import type { RuntimeFileSystemPort, RuntimeHttpClientPort } from '../common/runtime-ports';

const CLAWHUB_PRIMARY_REGISTRY = 'https://cn.clawhub-mirror.com';
const CLAWHUB_BACKUP_REGISTRY = 'https://mirror-cn.clawhub.com';

interface ClawHubMappedSearchResult {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
  stars?: number;
  score: number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRegistryBase(value: string) {
  return value.replace(/\/+$/, '');
}

function resolveClawHubRegistryBases() {
  return Array.from(new Set([
    normalizeRegistryBase(CLAWHUB_PRIMARY_REGISTRY),
    normalizeRegistryBase(CLAWHUB_BACKUP_REGISTRY),
  ]));
}

async function fetchRegistryJsonFromBase(
  httpClient: RuntimeHttpClientPort,
  registryBase: string,
  routePath: string,
  token?: string,
  query?: Record<string, unknown>,
) {
  const url = new URL(routePath, `${registryBase}/`);
  const queryEntries = isRecord(query) ? Object.entries(query) : [];
  for (const [key, value] of queryEntries) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  const headers = {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await httpClient.request(url.toString(), { method: 'GET', headers });
  const rawText = await response.text();
  if (!response.ok) {
    const message = rawText.trim();
    if (response.status === 429) {
      throw new Error('Rate limit exceeded');
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  if (!rawText.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawText);
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new Error('Invalid ClawHub registry response');
  }
}

function normalizeOptionalNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function mapClawHubSearchResults(payload: Record<string, any>, options?: { sortByHot?: boolean }) {
  const rows = Array.isArray(payload.results) ? payload.results : [];
  const mapped: ClawHubMappedSearchResult[] = [];
  for (const item of rows) {
    if (!isRecord(item)) {
      continue;
    }
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (!slug) {
      continue;
    }
    const name = typeof item.displayName === 'string' && item.displayName.trim()
      ? item.displayName.trim()
      : slug;
    const description = typeof item.summary === 'string' ? item.summary.trim() : '';
    const version = typeof item.version === 'string' && item.version.trim() ? item.version.trim() : 'latest';
    const author = isRecord(item.metaContent) && typeof item.metaContent.owner === 'string'
      ? item.metaContent.owner.trim()
      : (typeof item.author === 'string' ? item.author.trim() : '');
    const stats = isRecord(item.stats) ? item.stats : {};
    mapped.push({
      slug,
      name,
      description,
      version,
      author: author || undefined,
      downloads: normalizeOptionalNumber(stats.downloads),
      stars: normalizeOptionalNumber(stats.stars),
      score: normalizeOptionalNumber(item.score) ?? 0,
    });
  }

  if (options?.sortByHot) {
    mapped.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.name.localeCompare(right.name);
    });
  }

  return mapped.map(({ score: _score, ...item }) => item);
}

export interface ClawHubRegistryRuntimePort {
  getClawHubRegistryBases(): readonly string[];
  getRuntimeHostSettingsFilePath(): string;
}

export class ClawHubRegistryClient {
  constructor(
    private readonly runtime: ClawHubRegistryRuntimePort,
    private readonly httpClient: RuntimeHttpClientPort,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  resolveRegistryBases(): string[] {
    const configured = this.runtime.getClawHubRegistryBases().map(normalizeRegistryBase);
    return configured.length > 0 ? configured : resolveClawHubRegistryBases();
  }

  async fetchJson(routePath: string, query?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const registries = this.resolveRegistryBases();
    const token = await this.readToken();
    const errors: string[] = [];
    for (const registryBase of registries) {
      try {
        return await fetchRegistryJsonFromBase(this.httpClient, registryBase, routePath, token, query);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${registryBase}: ${message}`);
      }
    }
    throw new Error(errors.join(' | ') || 'Failed to reach ClawHub registry');
  }

  async hasToken(): Promise<boolean> {
    return Boolean(await this.readToken());
  }

  private async readToken(): Promise<string | undefined> {
    const settings = await this.getAllSettings();
    const tokenValue = typeof settings.clawHubToken === 'string' ? settings.clawHubToken : '';
    const normalized = tokenValue.trim().replace(/^Bearer\s+/i, '').trim();
    return normalized || undefined;
  }

  private async getAllSettings(): Promise<Record<string, unknown>> {
    const filePath = this.runtime.getRuntimeHostSettingsFilePath();
    try {
      const raw = await this.fileSystem.readTextFile(filePath);
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}
