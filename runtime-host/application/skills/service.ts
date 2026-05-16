import { basename, dirname, extname, join } from 'node:path';
import type { GatewayRpcPort } from '../gateway/gateway-runtime-port';
import { isGatewayReadyForSnapshot, isGatewayStartupConnectionError } from '../gateway/gateway-readiness';
import {
  accepted,
  badRequest,
  serverError,
  type ApplicationResponse,
} from '../common/application-response';
import type {
  RuntimeClockPort,
  RuntimeCommandExecutorPort,
  RuntimeFileSystemPort,
  RuntimeSystemEnvironmentPort,
} from '../common/runtime-ports';
import type { SkillsJobPort } from './skills-jobs';
import type { SkillReadmePreviewRepository, SkillsConfigRepository } from './store';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import type { RuntimeHostLogger } from '../../shared/logger';

interface SkillsServiceDeps {
  repository: Pick<SkillsConfigRepository, 'getAllConfigs' | 'updateConfig' | 'setEnabled' | 'listEffective'>;
  readmePreviews: Pick<SkillReadmePreviewRepository, 'read'>;
  gateway: GatewayRpcPort;
  jobs: SkillsJobPort;
  clock: RuntimeClockPort;
  fileSystem: RuntimeFileSystemPort;
  commandExecutor: RuntimeCommandExecutorPort;
  systemEnvironment: RuntimeSystemEnvironmentPort;
  workspace: Pick<OpenClawWorkspacePort, 'getSkillsDir'>;
  environment: Pick<OpenClawEnvironmentRepository, 'getResourcesPath' | 'getWorkingDir'>;
  logger: RuntimeHostLogger;
}

interface SkillMutationResult {
  success: boolean;
  error?: string;
  syncError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const SKILL_MANIFEST_FILE = 'SKILL.md';
const PREINSTALLED_MANIFEST_NAME = 'preinstalled-manifest.json';
const PREINSTALLED_MARKER_NAME = '.matchaclaw-preinstalled.json';
const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const CONTROL_CHAR_RANGE_PATTERN = `${String.fromCharCode(0)}-${String.fromCharCode(31)}`;
const INVALID_SKILL_KEY_CHARS_PATTERN = new RegExp(`[<>:"/\\\\|?*${CONTROL_CHAR_RANGE_PATTERN}]+`, 'g');

type SkillSourceKind = 'directory' | 'zip' | 'markdown';

interface PreinstalledSkillSpec {
  slug: string;
  version?: string;
  autoEnable?: boolean;
}

interface LocalSkillImportResult {
  success: true;
  skillKey: string;
  installedPath: string;
  sourceKind: SkillSourceKind;
}

interface PreinstalledMarker {
  source: 'matchaclaw-preinstalled';
  slug: string;
  version: string;
  installedAt: string;
}

export class SkillsService {
  private statusSnapshot: unknown = { skills: [] };
  private statusSnapshotReady = false;
  private statusSnapshotError: string | null = null;
  private statusSnapshotUpdatedAt: number | null = null;

  constructor(private readonly deps: SkillsServiceDeps) {}

  private buildStatusPayload() {
    return {
      success: true,
      ...(isRecord(this.statusSnapshot) ? this.statusSnapshot : { result: this.statusSnapshot }),
      ready: this.statusSnapshotReady,
      updatedAt: this.statusSnapshotUpdatedAt,
      error: this.statusSnapshotError,
    };
  }

  async status() {
    if (await isGatewayReadyForSnapshot(this.deps.gateway)) {
      this.deps.jobs.submitRefreshStatus();
    }
    return this.buildStatusPayload();
  }

  async refreshStatus() {
    if (!(await isGatewayReadyForSnapshot(this.deps.gateway))) {
      return this.buildStatusPayload();
    }
    try {
      this.statusSnapshot = await this.deps.gateway.gatewayRpc('skills.status');
      this.statusSnapshotReady = true;
      this.statusSnapshotError = null;
      this.statusSnapshotUpdatedAt = this.deps.clock.nowMs();
      return this.buildStatusPayload();
    } catch (error) {
      if (isGatewayStartupConnectionError(error)) {
        return this.buildStatusPayload();
      }
      this.statusSnapshotError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async executeGatewayUpdate(
    skillKey: string,
    updates: Record<string, unknown>,
  ): Promise<string | null> {
    let gatewayRunning: boolean;
    try {
      gatewayRunning = await this.deps.gateway.isGatewayRunning();
    } catch (error) {
      return String(error);
    }
    if (!gatewayRunning) {
      return null;
    }
    try {
      await this.deps.gateway.gatewayRpc('skills.update', {
        skillKey,
        ...updates,
      });
      this.deps.jobs.submitRefreshStatus();
      return null;
    } catch (error) {
      return String(error);
    }
  }

  private normalizeSkillKey(input: string): string {
    const normalized = input
      .trim()
      .replace(/\s+/g, '-')
      .replace(INVALID_SKILL_KEY_CHARS_PATTERN, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '');
    return normalized || `skill-${this.deps.clock.nowMs()}`;
  }

  private parseFrontmatterField(frontmatter: string, field: 'name' | 'description'): string | null {
    const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'im');
    const match = frontmatter.match(pattern);
    if (!match) {
      return null;
    }
    return match[1].trim().replace(/^["']|["']$/g, '') || null;
  }

  private readRequiredSkillManifestFrontmatter(markdown: string): { name: string; description: string } {
    const frontmatterMatch = markdown.match(FRONTMATTER_PATTERN);
    if (!frontmatterMatch) {
      throw new Error('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
    }
    const frontmatter = frontmatterMatch[1];
    const name = this.parseFrontmatterField(frontmatter, 'name');
    const description = this.parseFrontmatterField(frontmatter, 'description');
    if (!name || !description) {
      throw new Error('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
    }
    return { name, description };
  }

  private async validateSkillManifest(skillDir: string): Promise<void> {
    const manifestPath = join(skillDir, SKILL_MANIFEST_FILE);
    const markdown = await this.deps.fileSystem.readTextFile(manifestPath);
    this.readRequiredSkillManifestFrontmatter(markdown);
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

  private async collectSkillManifestDirs(rootDir: string): Promise<string[]> {
    const manifestDirs: string[] = [];
    const visit = async (currentDir: string): Promise<void> => {
      const entries = await this.deps.fileSystem.listDirectory(currentDir);
      if (entries.some((entry) => entry.isFile && entry.name === SKILL_MANIFEST_FILE)) {
        manifestDirs.push(currentDir);
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory) {
          await visit(join(currentDir, entry.name));
        }
      }
    };
    await visit(rootDir);
    return manifestDirs;
  }

  private async resolveSkillDirectory(rootDir: string): Promise<string> {
    const manifestDirs = await this.collectSkillManifestDirs(rootDir);
    if (manifestDirs.length === 0) {
      throw new Error('未找到 SKILL.md，无法识别为技能目录。');
    }
    if (manifestDirs.length > 1) {
      throw new Error('检测到多个 SKILL.md，请一次只导入一个技能。');
    }
    return manifestDirs[0];
  }

  private async extractZipArchive(zipPath: string, destinationDir: string): Promise<void> {
    if (this.deps.systemEnvironment.platform === 'win32') {
      const systemRoot = this.deps.systemEnvironment.getEnv('SystemRoot') || 'C:\\Windows';
      const powershellPath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await this.deps.commandExecutor.execFile(powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
      ], { windowsHide: true });
      return;
    }

    if (this.deps.systemEnvironment.platform === 'darwin') {
      try {
        await this.deps.commandExecutor.execFile('/usr/bin/ditto', ['-x', '-k', zipPath, destinationDir]);
        return;
      } catch (error) {
        this.deps.logger.warn(`Failed to extract skill zip with ditto: ${String(error)}`);
      }
    }

    try {
      await this.deps.commandExecutor.execFile('unzip', ['-qq', '-o', zipPath, '-d', destinationDir]);
    } catch {
      await this.deps.commandExecutor.execFile(
        this.deps.systemEnvironment.platform === 'win32' ? 'python' : 'python3',
        ['-m', 'zipfile', '-e', zipPath, destinationDir],
      );
    }
  }

  private async createMarkdownSkillDirectory(sourcePath: string, stagingRoot: string): Promise<string> {
    const markdown = await this.deps.fileSystem.readTextFile(sourcePath);
    const { name } = this.readRequiredSkillManifestFrontmatter(markdown);
    const fileBaseName = basename(sourcePath, extname(sourcePath));
    const suggestedName = fileBaseName.toLowerCase() === 'skill'
      ? basename(dirname(sourcePath))
      : fileBaseName;
    const skillKey = this.normalizeSkillKey(suggestedName || name);
    const skillDir = join(stagingRoot, skillKey);
    await this.deps.fileSystem.ensureDirectory(skillDir);
    await this.deps.fileSystem.writeTextFile(join(skillDir, SKILL_MANIFEST_FILE), markdown);
    return skillDir;
  }

  private async prepareImportSource(
    sourcePath: string,
    stagingRoot: string,
  ): Promise<{ skillDir: string; sourceKind: SkillSourceKind }> {
    const info = await this.deps.fileSystem.stat(sourcePath);
    if (info.isDirectory) {
      const skillDir = await this.resolveSkillDirectory(sourcePath);
      await this.validateSkillManifest(skillDir);
      return {
        skillDir,
        sourceKind: 'directory',
      };
    }
    if (!info.isFile) {
      throw new Error('只支持导入技能文件夹、.zip 压缩包或 .md 技能文件。');
    }
    const extension = extname(sourcePath).toLowerCase();
    if (extension === '.zip') {
      const extractRoot = join(stagingRoot, 'zip');
      await this.deps.fileSystem.ensureDirectory(extractRoot);
      await this.extractZipArchive(sourcePath, extractRoot);
      const skillDir = await this.resolveSkillDirectory(extractRoot);
      await this.validateSkillManifest(skillDir);
      return {
        skillDir,
        sourceKind: 'zip',
      };
    }
    if (extension === '.md') {
      return {
        skillDir: await this.createMarkdownSkillDirectory(sourcePath, stagingRoot),
        sourceKind: 'markdown',
      };
    }
    throw new Error('只支持导入技能文件夹、.zip 压缩包或 .md 技能文件。');
  }

  importLocal(payload: unknown): ApplicationResponse {
    const body = isRecord(payload) ? payload : {};
    const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath.trim() : '';
    if (!sourcePath) {
      return badRequest('sourcePath is required');
    }
    return accepted(this.deps.jobs.submitImportLocal({ sourcePath }));
  }

  async executeImportLocal(payload: unknown): Promise<LocalSkillImportResult> {
    const body = isRecord(payload) ? payload : {};
    const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath.trim() : '';
    if (!sourcePath) {
      throw new Error('sourcePath is required');
    }
    if (!(await this.deps.fileSystem.exists(sourcePath))) {
      throw new Error('选择的技能来源不存在。');
    }

    const stagingRoot = join(
      this.deps.systemEnvironment.tempDir,
      `matchaclaw-skill-import-${this.deps.clock.nowMs()}-${Math.random().toString(36).slice(2)}`,
    );
    await this.deps.fileSystem.ensureDirectory(stagingRoot);
    try {
      const { skillDir, sourceKind } = await this.prepareImportSource(sourcePath, stagingRoot);
      const skillKey = this.normalizeSkillKey(basename(skillDir));
      const skillsRoot = this.deps.workspace.getSkillsDir();
      const installedPath = join(skillsRoot, skillKey);
      await this.deps.fileSystem.ensureDirectory(skillsRoot);
      if (await this.deps.fileSystem.exists(installedPath)) {
        throw new Error(`技能 "${skillKey}" 已存在，请先删除旧版本后再导入。`);
      }
      await this.copyDirectory(skillDir, installedPath);
      this.deps.logger.info(`Imported local skill "${skillKey}" from ${sourcePath} -> ${installedPath}`);
      return {
        success: true,
        skillKey,
        installedPath,
        sourceKind,
      };
    } finally {
      await this.deps.fileSystem.removeDirectory(stagingRoot);
    }
  }

  private getPreinstalledManifestCandidates(): string[] {
    const resourcesPath = this.deps.environment.getResourcesPath();
    return [
      resourcesPath ? join(resourcesPath, 'resources', 'skills', PREINSTALLED_MANIFEST_NAME) : '',
      resourcesPath ? join(resourcesPath, 'skills', PREINSTALLED_MANIFEST_NAME) : '',
      join(this.deps.environment.getWorkingDir(), 'resources', 'skills', PREINSTALLED_MANIFEST_NAME),
    ].filter((item) => item.trim().length > 0);
  }

  private getPreinstalledSourceRootCandidates(): string[] {
    const resourcesPath = this.deps.environment.getResourcesPath();
    return [
      resourcesPath ? join(resourcesPath, 'preinstalled-skills') : '',
      resourcesPath ? join(resourcesPath, 'resources', 'preinstalled-skills') : '',
      join(this.deps.environment.getWorkingDir(), 'build', 'preinstalled-skills'),
    ].filter((item) => item.trim().length > 0);
  }

  private async readPreinstalledManifest(): Promise<PreinstalledSkillSpec[]> {
    const manifestPath = await this.firstExistingPath(this.getPreinstalledManifestCandidates());
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

  ensurePreinstalled(): ApplicationResponse {
    return accepted(this.deps.jobs.submitEnsurePreinstalled());
  }

  async executeEnsurePreinstalled() {
    const skills = await this.readPreinstalledManifest();
    if (skills.length === 0) {
      return { success: true, installed: [], stateSyncs: [] };
    }

    const sourceRoot = await this.firstExistingPath(this.getPreinstalledSourceRootCandidates());
    if (!sourceRoot) {
      this.deps.logger.warn('Preinstalled skills source root not found; skipping preinstall.');
      return { success: true, installed: [], stateSyncs: [] };
    }

    const lockVersions = await this.readPreinstalledLockVersions(sourceRoot);
    const currentConfigs = await this.configs();
    const targetRoot = this.deps.workspace.getSkillsDir();
    await this.deps.fileSystem.ensureDirectory(targetRoot);
    const installed: string[] = [];
    const stateSyncs: Array<{ skillKey: string; enabled: boolean }> = [];

    for (const spec of skills) {
      const sourceDir = join(sourceRoot, spec.slug);
      const sourceManifest = join(sourceDir, SKILL_MANIFEST_FILE);
      if (!(await this.deps.fileSystem.exists(sourceManifest))) {
        this.deps.logger.warn(`Preinstalled skill source missing SKILL.md, skipping: ${sourceDir}`);
        continue;
      }
      const targetDir = join(targetRoot, spec.slug);
      const targetManifest = join(targetDir, SKILL_MANIFEST_FILE);
      const markerPath = join(targetDir, PREINSTALLED_MARKER_NAME);
      const desiredEnabled = spec.autoEnable === true;
      const desiredVersion = lockVersions.get(spec.slug) || spec.version?.trim() || 'unknown';
      const marker = await this.tryReadPreinstalledMarker(markerPath);
      const currentConfig = isRecord((currentConfigs as Record<string, unknown>)[spec.slug])
        ? (currentConfigs as Record<string, Record<string, unknown>>)[spec.slug]
        : {};

      if (await this.deps.fileSystem.exists(targetManifest)) {
        if (!marker) {
          this.deps.logger.info(`Skipping user-managed skill: ${spec.slug}`);
          continue;
        }
        if (typeof currentConfig.enabled !== 'boolean') {
          const update = await this.updateState({ skillKey: spec.slug, enabled: desiredEnabled });
          if (update.status < 400) {
            stateSyncs.push({ skillKey: spec.slug, enabled: desiredEnabled });
          }
        }
        if (marker.version !== desiredVersion) {
          this.deps.logger.info(`Skipping preinstalled skill update for ${spec.slug} (local marker version=${marker.version}, desired=${desiredVersion})`);
        }
        continue;
      }

      await this.copyDirectory(sourceDir, targetDir);
      const markerPayload: PreinstalledMarker = {
        source: 'matchaclaw-preinstalled',
        slug: spec.slug,
        version: desiredVersion,
        installedAt: this.deps.clock.nowIso(),
      };
      await this.deps.fileSystem.writeTextFile(markerPath, `${JSON.stringify(markerPayload, null, 2)}\n`);
      const update = await this.updateState({ skillKey: spec.slug, enabled: desiredEnabled });
      if (update.status < 400) {
        stateSyncs.push({ skillKey: spec.slug, enabled: desiredEnabled });
      }
      installed.push(spec.slug);
      this.deps.logger.info(`Installed preinstalled skill: ${spec.slug} -> ${targetDir}`);
    }

    return { success: true, installed, stateSyncs };
  }

  private async applyUpdates(
    skillKey: string,
    updates: Record<string, unknown>,
    persistLocal: () => Promise<unknown>,
  ): Promise<ApplicationResponse> {
    const localResult = await persistLocal();
    const normalizedLocalResult = isRecord(localResult) && typeof localResult.success === 'boolean'
      ? localResult as unknown as SkillMutationResult
      : { success: false, error: 'Invalid local skills mutation result' };
    if (normalizedLocalResult.success !== true) {
      return serverError(normalizedLocalResult.error || 'Failed to persist local skills config');
    }

    return accepted(this.deps.jobs.submitGatewayUpdate({ skillKey, updates }));
  }

  async configs() {
    return await this.deps.repository.getAllConfigs();
  }

  async updateConfig(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
    if (!skillKey.trim()) {
      return badRequest('skillKey is required');
    }
    const updates = {
      ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      ...(isRecord(body.env) ? { env: body.env } : {}),
    };
    if (Object.keys(updates).length === 0) {
      return badRequest('No config updates provided');
    }
    return await this.applyUpdates(
      skillKey,
      updates,
      async () => await this.deps.repository.updateConfig(skillKey, updates),
    );
  }

  async updateState(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
    if (!skillKey.trim()) {
      return badRequest('skillKey is required');
    }
    if (typeof body.enabled !== 'boolean') {
      return badRequest('enabled must be a boolean');
    }

    return await this.applyUpdates(
      skillKey,
      { enabled: body.enabled },
      async () => await this.deps.repository.setEnabled(skillKey, Boolean(body.enabled)),
    );
  }

  async effective() {
    return {
      success: true,
      tools: await this.deps.repository.listEffective(),
    };
  }

  async readmePreview(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey.trim() : '';
    if (!skillKey) {
      return badRequest('skillKey is required');
    }

    return await this.deps.readmePreviews.read(skillKey, {
      filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
      baseDir: typeof body.baseDir === 'string' ? body.baseDir : undefined,
    });
  }
}
