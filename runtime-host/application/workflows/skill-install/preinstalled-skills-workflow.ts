import { dirname, join } from 'node:path';
import type { RuntimeClockPort, RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { SkillsJobPort } from '../../skills/skills-jobs';
import type { SkillsConfigRepository } from '../../skills/store';
import type { RuntimeHostLogger } from '../../../shared/logger';

const SKILL_MANIFEST_FILE = 'SKILL.md';
const PREINSTALLED_MARKER_NAME = '.matchaclaw-preinstalled.json';

export interface PreinstalledSkillsWorkspacePort {
  getSkillsDir(): string;
  getPreinstalledManifestCandidates(): readonly string[];
  getPreinstalledSourceRootCandidates(): readonly string[];
}

export interface EnsurePreinstalledSkillsResult {
  success: true;
  installed: string[];
  stateSyncs: Array<{ skillKey: string; enabled: boolean }>;
}

export interface PreinstalledSkillsWorkflowDeps {
  readonly repository: Pick<SkillsConfigRepository, 'getAllConfigs' | 'setEnabled'>;
  readonly jobs: Pick<SkillsJobPort, 'submitGatewayUpdate'>;
  readonly clock: RuntimeClockPort;
  readonly fileSystem: RuntimeFileSystemPort;
  readonly workspace: PreinstalledSkillsWorkspacePort;
  readonly logger: RuntimeHostLogger;
}

interface PreinstalledSkillSpec {
  slug: string;
  version?: string;
  autoEnable?: boolean;
}

interface PreinstalledMarker {
  source: 'matchaclaw-preinstalled';
  slug: string;
  version: string;
  installedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class PreinstalledSkillsWorkflow {
  constructor(private readonly deps: PreinstalledSkillsWorkflowDeps) {}

  async execute(): Promise<EnsurePreinstalledSkillsResult> {
    const skills = await this.readPreinstalledManifest();
    if (skills.length === 0) {
      return { success: true, installed: [], stateSyncs: [] };
    }

    const sourceRoot = await this.firstExistingPath([...this.deps.workspace.getPreinstalledSourceRootCandidates()]);
    if (!sourceRoot) {
      this.deps.logger.warn('Preinstalled skills source root not found; skipping preinstall.');
      return { success: true, installed: [], stateSyncs: [] };
    }

    const lockVersions = await this.readPreinstalledLockVersions(sourceRoot);
    const currentConfigs = await this.deps.repository.getAllConfigs();
    const targetRoot = this.deps.workspace.getSkillsDir();
    await this.deps.fileSystem.ensureDirectory(targetRoot);
    const installed: string[] = [];
    const stateSyncs: Array<{ skillKey: string; enabled: boolean }> = [];

    for (const spec of skills) {
      await this.ensurePreinstalledSkill({
        spec,
        sourceRoot,
        targetRoot,
        lockVersions,
        currentConfigs,
        installed,
        stateSyncs,
      });
    }

    return { success: true, installed, stateSyncs };
  }

  private async ensurePreinstalledSkill(input: {
    spec: PreinstalledSkillSpec;
    sourceRoot: string;
    targetRoot: string;
    lockVersions: Map<string, string>;
    currentConfigs: Record<string, unknown>;
    installed: string[];
    stateSyncs: Array<{ skillKey: string; enabled: boolean }>;
  }): Promise<void> {
    const sourceDir = join(input.sourceRoot, input.spec.slug);
    const sourceManifest = join(sourceDir, SKILL_MANIFEST_FILE);
    if (!(await this.deps.fileSystem.exists(sourceManifest))) {
      this.deps.logger.warn(`Preinstalled skill source missing SKILL.md, skipping: ${sourceDir}`);
      return;
    }

    const targetDir = join(input.targetRoot, input.spec.slug);
    const targetManifest = join(targetDir, SKILL_MANIFEST_FILE);
    const markerPath = join(targetDir, PREINSTALLED_MARKER_NAME);
    const desiredEnabled = input.spec.autoEnable === true;
    const desiredVersion = input.lockVersions.get(input.spec.slug) || input.spec.version?.trim() || 'unknown';
    const marker = await this.tryReadPreinstalledMarker(markerPath);
    const currentConfig = isRecord(input.currentConfigs[input.spec.slug])
      ? input.currentConfigs[input.spec.slug] as Record<string, unknown>
      : {};

    if (await this.deps.fileSystem.exists(targetManifest)) {
      await this.ensureExistingSkillState({
        spec: input.spec,
        marker,
        currentConfig,
        desiredEnabled,
        desiredVersion,
        stateSyncs: input.stateSyncs,
      });
      return;
    }

    await this.copyDirectory(sourceDir, targetDir);
    const markerPayload: PreinstalledMarker = {
      source: 'matchaclaw-preinstalled',
      slug: input.spec.slug,
      version: desiredVersion,
      installedAt: this.deps.clock.nowIso(),
    };
    await this.deps.fileSystem.writeTextFile(markerPath, `${JSON.stringify(markerPayload, null, 2)}\n`);
    if (await this.syncSkillState(input.spec.slug, desiredEnabled)) {
      input.stateSyncs.push({ skillKey: input.spec.slug, enabled: desiredEnabled });
    }
    input.installed.push(input.spec.slug);
    this.deps.logger.info(`Installed preinstalled skill: ${input.spec.slug} -> ${targetDir}`);
  }

  private async ensureExistingSkillState(input: {
    spec: PreinstalledSkillSpec;
    marker: PreinstalledMarker | null;
    currentConfig: Record<string, unknown>;
    desiredEnabled: boolean;
    desiredVersion: string;
    stateSyncs: Array<{ skillKey: string; enabled: boolean }>;
  }): Promise<void> {
    if (!input.marker) {
      this.deps.logger.info(`Skipping user-managed skill: ${input.spec.slug}`);
      return;
    }
    if (typeof input.currentConfig.enabled !== 'boolean') {
      if (await this.syncSkillState(input.spec.slug, input.desiredEnabled)) {
        input.stateSyncs.push({ skillKey: input.spec.slug, enabled: input.desiredEnabled });
      }
    }
    if (input.marker.version !== input.desiredVersion) {
      this.deps.logger.info(`Skipping preinstalled skill update for ${input.spec.slug} (local marker version=${input.marker.version}, desired=${input.desiredVersion})`);
    }
  }

  private async syncSkillState(skillKey: string, enabled: boolean): Promise<boolean> {
    const stateResult = await this.deps.repository.setEnabled(skillKey, enabled);
    if (stateResult.success !== true) {
      return false;
    }
    this.deps.jobs.submitGatewayUpdate({ skillKey, updates: { enabled } });
    return true;
  }

  private async readPreinstalledManifest(): Promise<PreinstalledSkillSpec[]> {
    const manifestPath = await this.firstExistingPath([...this.deps.workspace.getPreinstalledManifestCandidates()]);
    if (!manifestPath) {
      return [];
    }
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(manifestPath));
      const skills = isRecord(parsed) && Array.isArray(parsed.skills) ? parsed.skills : [];
      return skills
        .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.slug === 'string')
        .map((item) => ({
          slug: String(item.slug).trim(),
          ...(typeof item.version === 'string' ? { version: item.version } : {}),
          ...(typeof item.autoEnable === 'boolean' ? { autoEnable: item.autoEnable } : {}),
        }))
        .filter((item) => item.slug.length > 0);
    } catch (error) {
      this.deps.logger.warn(`Failed to read preinstalled-skills manifest: ${String(error)}`);
      return [];
    }
  }

  private async firstExistingPath(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.deps.fileSystem.exists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private async readPreinstalledLockVersions(sourceRoot: string): Promise<Map<string, string>> {
    const lockPath = join(sourceRoot, '.preinstalled-lock.json');
    if (!(await this.deps.fileSystem.exists(lockPath))) {
      return new Map();
    }
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(lockPath));
      const entries = isRecord(parsed) && Array.isArray(parsed.skills) ? parsed.skills : [];
      const versions = new Map<string, string>();
      for (const entry of entries) {
        if (!isRecord(entry)) {
          continue;
        }
        const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
        const version = typeof entry.version === 'string' ? entry.version.trim() : '';
        if (slug && version) {
          versions.set(slug, version);
        }
      }
      return versions;
    } catch (error) {
      this.deps.logger.warn(`Failed to read preinstalled-skills lock file: ${String(error)}`);
      return new Map();
    }
  }

  private async tryReadPreinstalledMarker(markerPath: string): Promise<PreinstalledMarker | null> {
    if (!(await this.deps.fileSystem.exists(markerPath))) {
      return null;
    }
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(markerPath));
      if (!isRecord(parsed) || parsed.source !== 'matchaclaw-preinstalled') {
        return null;
      }
      const slug = typeof parsed.slug === 'string' ? parsed.slug : '';
      const version = typeof parsed.version === 'string' ? parsed.version : '';
      const installedAt = typeof parsed.installedAt === 'string' ? parsed.installedAt : '';
      return slug && version && installedAt
        ? { source: 'matchaclaw-preinstalled', slug, version, installedAt }
        : null;
    } catch {
      return null;
    }
  }

  private async copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
    await this.deps.fileSystem.ensureDirectory(targetDir);
    const entries = await this.deps.fileSystem.listDirectory(sourceDir);
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory) {
        await this.copyDirectory(sourcePath, targetPath);
        continue;
      }
      if (entry.isFile) {
        await this.deps.fileSystem.ensureDirectory(dirname(targetPath));
        await this.deps.fileSystem.copyFile(sourcePath, targetPath);
      }
    }
  }
}
