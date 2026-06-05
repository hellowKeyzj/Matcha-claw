import { join, resolve } from 'node:path';
import type { ParentShellPort } from '../runtime-host/parent-shell-port';
import type { RuntimeCommandExecutorPort, RuntimeFileSystemPort, RuntimePlatform } from '../common/runtime-ports';
import {
  mapClawHubSearchResults,
  type ClawHubRegistryClient,
} from './clawhub-registry-client';
import type { ClawHubJobPort } from './clawhub-jobs';
import type { ClawHubSkillInstallWorkflow } from '../workflows/skill-install/clawhub-skill-install-workflow';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface ClawHubRuntimePort {
  getPlatform(): RuntimePlatform;
}

export interface ClawHubSkillInventoryStoragePort {
  getSkillsRootDir(): string;
  getLockFilePath(): string;
}

interface ClawHubServiceDeps {
  parentShell: ParentShellPort;
  registryClient: ClawHubRegistryClient;
  skillInstallWorkflow: Pick<ClawHubSkillInstallWorkflow, 'executeInstall' | 'executeUninstall'>;
  skillInventory: ClawHubSkillInventory;
  runtime: ClawHubRuntimePort;
  commandExecutor: RuntimeCommandExecutorPort;
  fileSystem: RuntimeFileSystemPort;
  jobs: ClawHubJobPort;
}

function assertRequiredString(value: unknown, fieldName: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeLimit(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(numeric), 1), 200);
}

async function extractSkillFrontmatterName(
  fileSystem: RuntimeFileSystemPort,
  manifestPath: string,
) {
  try {
    const raw = await fileSystem.readTextFile(manifestPath);
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

async function resolveSkillDirByManifestName(
  fileSystem: RuntimeFileSystemPort,
  skillsRoot: string,
  candidates: string[],
) {
  if (!await fileSystem.exists(skillsRoot)) {
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

  const entries = await fileSystem.listDirectory(skillsRoot);
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const skillDir = join(skillsRoot, entry.name);
    const skillManifestPath = join(skillDir, 'SKILL.md');
    if (!await fileSystem.exists(skillManifestPath)) continue;
    const frontmatterName = await extractSkillFrontmatterName(fileSystem, skillManifestPath);
    if (frontmatterName && wanted.has(frontmatterName.toLowerCase())) {
      return skillDir;
    }
  }
  return null;
}

async function openPathWithDefaultApp(
  targetPath: string,
  platform: RuntimePlatform,
  commandExecutor: RuntimeCommandExecutorPort,
) {
  const normalized = resolve(targetPath);
  try {
    if (platform === 'win32') {
      await commandExecutor.execFile('cmd.exe', ['/d', '/s', '/c', 'start', '""', normalized], {
        windowsHide: true,
        shell: false,
      });
      return true;
    }
    if (platform === 'darwin') {
      await commandExecutor.execFile('open', [normalized], { shell: false });
      return true;
    }
    await commandExecutor.execFile('xdg-open', [normalized], { shell: false });
    return true;
  } catch {
    return false;
  }
}

export class ClawHubSkillInventory {
  constructor(
    private readonly storage: ClawHubSkillInventoryStoragePort,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  get skillsRoot(): string {
    return this.storage.getSkillsRootDir();
  }

  get lockFilePath(): string {
    return this.storage.getLockFilePath();
  }

  async listInstalled() {
    const skillsRoot = this.skillsRoot;
    if (!await this.fileSystem.exists(skillsRoot)) {
      return [];
    }
    const entries = await this.fileSystem.listDirectory(skillsRoot);
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const slug = entry.name;
      const skillDir = join(skillsRoot, slug);
      const skillManifestPath = join(skillDir, 'SKILL.md');
      if (!await this.fileSystem.exists(skillManifestPath)) continue;
      const packageJsonPath = join(skillDir, 'package.json');
      let version = 'unknown';
      if (await this.fileSystem.exists(packageJsonPath)) {
        try {
          const parsed = JSON.parse(await this.fileSystem.readTextFile(packageJsonPath));
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
        source: 'managed',
        baseDir: skillDir,
      });
    }
    return skills.sort((left, right) => left.slug.localeCompare(right.slug));
  }
}

export class ClawHubService {
  constructor(private readonly deps: ClawHubServiceDeps) {}

  private get skillsRoot(): string {
    return this.deps.skillInventory.skillsRoot;
  }

  async search(params: Record<string, unknown>) {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const limit = normalizeLimit(params.limit, query ? 50 : 25);
    if (!query) {
      const payload = await this.deps.registryClient.fetchJson('/api/v1/search', {
        limit: String(limit),
      });
      return mapClawHubSearchResults(payload, { sortByHot: true });
    }
    const payload = await this.deps.registryClient.fetchJson('/api/v1/search', {
      q: query,
      limit: String(limit),
    });
    return mapClawHubSearchResults(payload);
  }

  async login() {
    if (await this.deps.registryClient.hasToken()) {
      return { success: true };
    }
    throw new Error('ClawHub browser login is unavailable in runtime-host process. Please set token manually in Settings.');
  }

  install(params: Record<string, unknown>) {
    const slug = assertRequiredString(params.slug, 'slug');
    return this.deps.jobs.submitInstall({
      slug,
      ...(typeof params.version === 'string' && params.version.trim() ? { version: params.version.trim() } : {}),
      ...(params.force === true ? { force: true } : {}),
    });
  }

  async executeInstall(params: Record<string, unknown>) {
    return await this.deps.skillInstallWorkflow.executeInstall(params);
  }

  uninstall(params: Record<string, unknown>) {
    const slug = assertRequiredString(params.slug, 'slug');
    return this.deps.jobs.submitUninstall({ slug });
  }

  async executeUninstall(params: Record<string, unknown>) {
    return await this.deps.skillInstallWorkflow.executeUninstall(params);
  }

  private async resolveSkillDir(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string) {
    const preferred = typeof preferredBaseDir === 'string' ? preferredBaseDir.trim() : '';
    if (preferred && await this.deps.fileSystem.exists(preferred)) {
      return resolve(preferred);
    }

    const candidates = [skillKeyOrSlug, fallbackSlug]
      .flatMap((item) => (typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : []));
    if (candidates.length === 0) {
      return null;
    }

    const skillsRoot = this.skillsRoot;
    for (const candidate of candidates) {
      const directSkillDir = join(skillsRoot, candidate);
      if (await this.deps.fileSystem.exists(directSkillDir)) {
        return directSkillDir;
      }
    }
    return await resolveSkillDirByManifestName(this.deps.fileSystem, skillsRoot, candidates);
  }

  private async openPathViaMainProcess(targetPath: string): Promise<boolean> {
    const upstream = await this.deps.parentShell.request('shell_open_path', { path: targetPath });
    const mapped = this.deps.parentShell.mapResponse(upstream);
    if (mapped.status < 200 || mapped.status >= 300) {
      const data = isRecord(mapped.data) ? mapped.data : {};
      const message = typeof data.error === 'string' ? data.error : `Failed to open path: ${targetPath}`;
      throw new Error(message);
    }
    return true;
  }

  async openReadme(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string) {
    const skillDir = await this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
    if (!skillDir) {
      throw new Error('Skill directory not found');
    }

    const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];
    let targetPath = '';
    for (const fileName of possibleFiles) {
      const candidate = join(skillDir, fileName);
      if (await this.deps.fileSystem.exists(candidate)) {
        targetPath = candidate;
        break;
      }
    }
    if (!targetPath) {
      targetPath = skillDir;
    }

    const opened = await this.openPathViaMainProcess(targetPath) || await openPathWithDefaultApp(
      targetPath,
      this.deps.runtime.getPlatform(),
      this.deps.commandExecutor,
    );
    if (!opened) {
      throw new Error(`Failed to open path: ${targetPath}`);
    }
    return { success: true };
  }

  async openPath(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string) {
    const skillDir = await this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
    if (!skillDir) {
      throw new Error('Skill directory not found');
    }
    const opened = await this.openPathViaMainProcess(skillDir) || await openPathWithDefaultApp(
      skillDir,
      this.deps.runtime.getPlatform(),
      this.deps.commandExecutor,
    );
    if (!opened) {
      throw new Error(`Failed to open path: ${skillDir}`);
    }
    return { success: true };
  }
}
