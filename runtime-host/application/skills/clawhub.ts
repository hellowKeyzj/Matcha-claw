import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ParentShellAction, ParentTransportUpstreamPayload } from '../../api/dispatch/parent-transport';
import {
  expandHomePath,
  getOpenClawConfigDir,
  getRuntimeHostSettingsFilePath,
} from '../../api/storage/paths';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type LocalDispatchResponse = {
  status: number;
  data: unknown;
};

interface ClawHubServiceDeps {
  requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
}

function getOpenClawSkillsDir() {
  return join(getOpenClawConfigDir(), 'skills');
}

async function getAllSettings() {
  const filePath = getRuntimeHostSettingsFilePath();
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assertRequiredString(value: unknown, fieldName: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

const CLAWHUB_DEFAULT_REGISTRY = 'https://clawhub.ai';

function resolveRegistryBase() {
  const explicit = String(process.env.CLAWHUB_REGISTRY || process.env.CLAWDHUB_REGISTRY || '').trim();
  const registry = explicit || CLAWHUB_DEFAULT_REGISTRY;
  return registry.replace(/\/+$/, '');
}

async function readClawHubToken() {
  const settings = await getAllSettings();
  const tokenValue = typeof settings.clawHubToken === 'string' ? settings.clawHubToken : '';
  const normalized = tokenValue.trim().replace(/^Bearer\s+/i, '').trim();
  return normalized || undefined;
}

async function fetchRegistryJson(routePath: string, query?: Record<string, unknown>) {
  const url = new URL(routePath, `${resolveRegistryBase()}/`);
  const queryEntries = isRecord(query) ? Object.entries(query) : [];
  for (const [key, value] of queryEntries) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  const token = await readClawHubToken();
  const headers = {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(url.toString(), { method: 'GET', headers });
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

function mapSearchResults(payload: Record<string, any>) {
  const rows = Array.isArray(payload.results) ? payload.results : [];
  return rows
    .map((item) => {
      if (!isRecord(item)) return null;
      const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
      if (!slug) return null;
      const name = typeof item.displayName === 'string' && item.displayName.trim()
        ? item.displayName.trim()
        : slug;
      const description = typeof item.summary === 'string' ? item.summary.trim() : '';
      const version = typeof item.version === 'string' && item.version.trim() ? item.version.trim() : 'latest';
      return { slug, name, description, version };
    })
    .filter(Boolean);
}

function mapExploreResults(payload: Record<string, any>) {
  const rows = Array.isArray(payload.items) ? payload.items : [];
  return rows
    .map((item) => {
      if (!isRecord(item)) return null;
      const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
      if (!slug) return null;
      const name = typeof item.displayName === 'string' && item.displayName.trim()
        ? item.displayName.trim()
        : slug;
      const latestVersion = isRecord(item.latestVersion) && typeof item.latestVersion.version === 'string'
        ? item.latestVersion.version
        : 'latest';
      const description = typeof item.summary === 'string' ? item.summary.trim() : '';
      return {
        slug,
        name,
        version: String(latestVersion || 'latest').trim() || 'latest',
        description,
      };
    })
    .filter(Boolean);
}

function normalizeLimit(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(numeric), 1), 200);
}

function getCliEntryCandidates() {
  const explicit = String(process.env.MATCHACLAW_CLAWHUB_CLI_ENTRY || '').trim();
  return [
    explicit,
    join(process.cwd(), 'node_modules', 'clawhub', 'bin', 'clawdhub.js'),
    resolve(join(__dirname, '../../../node_modules/clawhub/bin/clawdhub.js')),
  ]
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => resolve(expandHomePath(item)));
}

function resolveCliEntry() {
  const candidates = getCliEntryCandidates();
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function runCommand(args: string[]) {
  const entry = resolveCliEntry();
  if (!entry) {
    return {
      ok: false,
      error: `ClawHub CLI entry not found. Checked: ${getCliEntryCandidates().join(' | ')}`,
    };
  }

  const workDir = getOpenClawConfigDir();
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: workDir,
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CI: 'true',
      FORCE_COLOR: '0',
      CLAWHUB_WORKDIR: workDir,
    },
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || `clawhub exited with code ${String(result.status)}`).trim(),
    };
  }
  return {
    ok: true,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function extractSkillFrontmatterName(manifestPath: string) {
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatter) return null;
    const nameMatch = frontmatter[1].match(/^\s*name\s*:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (!nameMatch) return null;
    const name = nameMatch[1].trim();
    return name || null;
  } catch {
    return null;
  }
}

function resolveSkillDirByManifestName(candidates: string[]) {
  const skillsRoot = getOpenClawSkillsDir();
  if (!existsSync(skillsRoot)) {
    return null;
  }
  const wanted = new Set(
    candidates
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  );
  if (wanted.size === 0) {
    return null;
  }

  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsRoot, entry.name);
    const skillManifestPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillManifestPath)) continue;
    const frontmatterName = extractSkillFrontmatterName(skillManifestPath);
    if (frontmatterName && wanted.has(frontmatterName.toLowerCase())) {
      return skillDir;
    }
  }
  return null;
}

function openPathWithDefaultApp(targetPath: string) {
  const normalized = resolve(targetPath);
  if (process.platform === 'win32') {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', 'start', '""', normalized], {
      windowsHide: true,
      shell: false,
    });
    return !result.error && (result.status === 0 || result.status === null);
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('open', [normalized], { shell: false });
    return !result.error && (result.status === 0 || result.status === null);
  }
  const result = spawnSync('xdg-open', [normalized], { shell: false });
  return !result.error && (result.status === 0 || result.status === null);
}

export async function listInstalledClawHubSkills() {
  const skillsRoot = getOpenClawSkillsDir();
  if (!existsSync(skillsRoot)) {
    return [];
  }
  const entries = await fsPromises.readdir(skillsRoot, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const skillDir = join(skillsRoot, slug);
    const skillManifestPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillManifestPath)) continue;
    const packageJsonPath = join(skillDir, 'package.json');
    let version = 'unknown';
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(await fsPromises.readFile(packageJsonPath, 'utf8'));
        if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version.trim()) {
          version = parsed.version.trim();
        }
      } catch {
        // ignore
      }
    }
    skills.push({
      slug,
      version,
      source: 'openclaw-managed',
      baseDir: skillDir,
    });
  }
  return skills.sort((left, right) => left.slug.localeCompare(right.slug));
}

export class ClawHubService {
  constructor(private readonly deps?: ClawHubServiceDeps) {}

  async search(params: Record<string, unknown>) {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const limit = normalizeLimit(params.limit, query ? 50 : 25);
    if (!query) {
      const payload = await fetchRegistryJson('/api/v1/skills', {
        limit: String(limit),
        sort: 'updated',
      });
      return mapExploreResults(payload);
    }
    const payload = await fetchRegistryJson('/api/v1/search', {
      q: query,
      limit: String(limit),
    });
    return mapSearchResults(payload);
  }

  async login() {
    const token = await readClawHubToken();
    if (token) {
      return { success: true };
    }
    throw new Error('ClawHub browser login is unavailable in runtime-host process. Please set token manually in Settings.');
  }

  async install(params: Record<string, unknown>) {
    const slug = assertRequiredString(params.slug, 'slug');
    const args = ['install', slug];
    if (typeof params.version === 'string' && params.version.trim()) {
      args.push('--version', params.version.trim());
    }
    if (params.force === true) {
      args.push('--force');
    }
    const result = runCommand(args);
    if (!result.ok) {
      throw new Error(result.error || 'clawhub install failed');
    }
    return { success: true };
  }

  async uninstall(params: Record<string, unknown>) {
    const slug = assertRequiredString(params.slug, 'slug');
    const skillDir = join(getOpenClawSkillsDir(), slug);
    await fsPromises.rm(skillDir, { recursive: true, force: true });

    const lockFile = join(getOpenClawConfigDir(), '.clawhub', 'lock.json');
    if (existsSync(lockFile)) {
      try {
        const raw = await fsPromises.readFile(lockFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (isRecord(parsed) && isRecord(parsed.skills) && Object.prototype.hasOwnProperty.call(parsed.skills, slug)) {
          delete parsed.skills[slug];
          await fsPromises.writeFile(lockFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        }
      } catch {
        // ignore
      }
    }
    return { success: true };
  }

  async list() {
    return await listInstalledClawHubSkills();
  }

  private resolveSkillDir(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string) {
    const preferred = typeof preferredBaseDir === 'string' ? preferredBaseDir.trim() : '';
    if (preferred && existsSync(preferred)) {
      return resolve(preferred);
    }

    const candidates = [skillKeyOrSlug, fallbackSlug]
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    if (candidates.length === 0) {
      return null;
    }

    const skillsRoot = getOpenClawSkillsDir();
    const directSkillDir = candidates
      .map((item) => join(skillsRoot, item))
      .find((dir) => existsSync(dir));
    return directSkillDir || resolveSkillDirByManifestName(candidates);
  }

  private async openPathViaMainProcess(targetPath: string): Promise<boolean> {
    if (!this.deps) {
      return false;
    }
    const upstream = await this.deps.requestParentShellAction('shell_open_path', { path: targetPath });
    const mapped = this.deps.mapParentTransportResponse(upstream);
    if (mapped.status < 200 || mapped.status >= 300) {
      const data = isRecord(mapped.data) ? mapped.data : {};
      const message = typeof data.error === 'string' ? data.error : `Failed to open path: ${targetPath}`;
      throw new Error(message);
    }
    return true;
  }

  async openReadme(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string) {
    const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
    if (!skillDir) {
      throw new Error('Skill directory not found');
    }

    const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];
    let targetPath = '';
    for (const fileName of possibleFiles) {
      const candidate = join(skillDir, fileName);
      if (existsSync(candidate)) {
        targetPath = candidate;
        break;
      }
    }
    if (!targetPath) {
      targetPath = skillDir;
    }

    const opened = await this.openPathViaMainProcess(targetPath) || openPathWithDefaultApp(targetPath);
    if (!opened) {
      throw new Error(`Failed to open path: ${targetPath}`);
    }
    return { success: true };
  }

  async openPath(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string) {
    const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
    if (!skillDir) {
      throw new Error('Skill directory not found');
    }
    const opened = await this.openPathViaMainProcess(skillDir) || openPathWithDefaultApp(skillDir);
    if (!opened) {
      throw new Error(`Failed to open path: ${skillDir}`);
    }
    return { success: true };
  }
}
