import { dirname, join, resolve } from 'node:path';
import type {
  RuntimeFileSystemPort,
  RuntimePlatform,
  RuntimeProcessEnvironment,
  RuntimeSystemEnvironmentPort,
} from '../common/runtime-ports';

export interface OpenClawStatusSnapshot {
  packageExists: boolean;
  isBuilt: boolean;
  entryPath: string;
  dir: string;
  version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expandHomePath(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  if (value.startsWith('~')) {
    return value;
  }
  return value;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class OpenClawEnvironmentRepository {
  constructor(
    private readonly system: RuntimeSystemEnvironmentPort,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  private expandHomePathValue(value: unknown): string {
    const input = expandHomePath(value);
    if (input.startsWith('~')) {
      return input.replace('~', this.system.homeDir);
    }
    return input;
  }

  getPlatform(): RuntimePlatform {
    return this.system.platform;
  }

  getArch(): string {
    return this.system.arch;
  }

  getWorkingDir(): string {
    return this.system.workingDir;
  }

  getEnv(name: string): string {
    return this.system.getEnv(name);
  }

  getProcessEnv(): RuntimeProcessEnvironment {
    return this.system.getProcessEnv();
  }

  getSystemLocaleCandidates(): string[] {
    return [
      this.getEnv('LC_ALL'),
      this.getEnv('LC_MESSAGES'),
      this.getEnv('LANG'),
      this.system.locale,
    ].filter((value) => value.trim().length > 0);
  }

  getResourcesPath(): string | null {
    return this.system.resourcesPath;
  }

  expandHomePath(value: unknown): string {
    return this.expandHomePathValue(value);
  }

  getOpenClawDirPath(): string {
    const explicitDir = this.getEnv('MATCHACLAW_OPENCLAW_DIR');
    if (explicitDir) {
      return resolve(this.expandHomePathValue(explicitDir));
    }
    const resourcesPath = this.getResourcesPath();
    if (resourcesPath) {
      return resolve(join(resourcesPath, 'openclaw'));
    }
    return resolve(join(this.getWorkingDir(), 'node_modules/openclaw'));
  }

  async getOpenClawStatus(): Promise<OpenClawStatusSnapshot> {
    const dir = this.getOpenClawDirPath();
    const entryPath = join(dir, 'openclaw.mjs');
    const packagePath = join(dir, 'package.json');
    const distDir = join(dir, 'dist');
    const packageExists = (await this.pathExists(dir)) && (await this.pathExists(packagePath));
    const isBuilt = await this.pathExists(distDir);
    let version: string | undefined;
    if (packageExists) {
      try {
        const parsed = parseJsonRecord(await this.fileSystem.readTextFile(packagePath));
        if (typeof parsed?.version === 'string' && parsed.version.trim()) {
          version = parsed.version;
        }
      } catch {
        // ignore version read errors
      }
    }
    return {
      packageExists,
      isBuilt,
      entryPath,
      dir,
      ...(version ? { version } : {}),
    };
  }

  async pathExists(pathname: string): Promise<boolean> {
    return await this.fileSystem.exists(pathname);
  }

  async ensureParentDir(pathname: string): Promise<void> {
    await this.fileSystem.ensureDirectory(dirname(pathname));
  }

  getOpenClawConfigDir(): string {
    const explicitConfigDir = this.getEnv('OPENCLAW_CONFIG_DIR');
    if (explicitConfigDir) {
      return resolve(this.expandHomePathValue(explicitConfigDir));
    }
    return resolve(join(this.system.homeDir, '.openclaw'));
  }

  getOpenClawConfigFilePath(): string {
    return join(this.getOpenClawConfigDir(), 'openclaw.json');
  }

  async readOpenClawConfigJson(): Promise<Record<string, unknown>> {
    try {
      return parseJsonRecord(await this.fileSystem.readTextFile(this.getOpenClawConfigFilePath())) ?? {};
    } catch {
      return {};
    }
  }

  async writeOpenClawConfigJson(config: Record<string, unknown>): Promise<void> {
    await this.fileSystem.ensureDirectory(this.getOpenClawConfigDir());
    await this.fileSystem.writeTextFile(this.getOpenClawConfigFilePath(), JSON.stringify(config, null, 2));
  }

  getRuntimeHostDataDir(): string {
    const explicit = this.getEnv('MATCHACLAW_RUNTIME_HOST_DATA_DIR');
    if (explicit) {
      return resolve(this.expandHomePathValue(explicit));
    }
    return this.getOpenClawConfigDir();
  }

  getRuntimeHostSettingsFilePath(): string {
    const explicit = this.getEnv('MATCHACLAW_RUNTIME_HOST_SETTINGS_FILE');
    if (explicit) {
      return resolve(this.expandHomePathValue(explicit));
    }
    return join(this.getRuntimeHostDataDir(), 'matchaclaw-settings.json');
  }

  getProviderStoreFilePath(): string {
    const explicit = this.getEnv('MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE');
    if (explicit) {
      return resolve(this.expandHomePathValue(explicit));
    }
    return join(this.getRuntimeHostDataDir(), 'matchaclaw-provider-accounts.json');
  }

  getProviderModelsStoreFilePath(): string {
    const explicit = this.getEnv('MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE');
    if (explicit) {
      return resolve(this.expandHomePathValue(explicit));
    }
    return join(this.getRuntimeHostDataDir(), 'matchaclaw-provider-models.json');
  }

  getCapabilityRoutingStoreFilePath(): string {
    const explicit = this.getEnv('MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE');
    if (explicit) {
      return resolve(this.expandHomePathValue(explicit));
    }
    return join(this.getRuntimeHostDataDir(), 'matchaclaw-capability-routing.json');
  }

  getBundledUvPathCandidates(): string[] {
    return this.getBundledToolPathCandidates('uv', 'MATCHACLAW_UV_BIN');
  }

  getBundledBunPathCandidates(): string[] {
    return this.getBundledToolPathCandidates('bun', 'MATCHACLAW_BUN_BIN');
  }

  private getBundledToolPathCandidates(toolName: string, overrideEnvName: string): string[] {
    const binName = this.getPlatform() === 'win32' ? `${toolName}.exe` : toolName;
    const target = `${this.getPlatform()}-${this.getArch()}`;
    const resourcesPath = this.getResourcesPath();
    return [...new Set([
      this.getEnv(overrideEnvName),
      join(this.getWorkingDir(), 'resources', 'bin', target, binName),
      resolve(join(__dirname, '../../../resources/bin', target, binName)),
      resourcesPath ? join(resourcesPath, 'bin', binName) : '',
    ]
      .filter((item) => item.trim().length > 0)
      .map((item) => resolve(this.expandHomePathValue(item))))];
  }

  getCompanionSkillRootCandidates(): string[] {
    const resourcesPath = this.getResourcesPath();
    return [...new Set([
      join(this.getWorkingDir(), 'resources', 'skills', 'plugin-companion-skills'),
      resourcesPath ? join(resourcesPath, 'resources', 'skills', 'plugin-companion-skills') : '',
      resourcesPath ? join(resourcesPath, 'skills', 'plugin-companion-skills') : '',
    ].filter((item) => item.trim().length > 0))];
  }

  getManagedPluginRegistryRootCandidates(): string[] {
    const resourcesPath = this.getResourcesPath();
    return [...new Set([
      join(this.getWorkingDir(), 'build', 'openclaw-plugins'),
      resourcesPath ? join(resourcesPath, 'openclaw-plugins') : '',
      resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'openclaw-plugins') : '',
      resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins') : '',
    ].filter((item) => item.trim().length > 0))];
  }

  getUserMatchaClawPluginDir(): string {
    return resolve(join(this.system.homeDir, '.matchaclaw', 'plugins'));
  }

  getLocalBuildOpenClawPluginsDir(): string {
    return resolve(join(this.getWorkingDir(), 'build', 'openclaw-plugins'));
  }

  getSubagentTemplateSourceCandidates(): string[] {
    const resourcesPath = this.getResourcesPath();
    return [...new Set([
      this.getEnv('MATCHACLAW_SUBAGENT_TEMPLATE_DIR'),
      resourcesPath ? join(resourcesPath, 'resources', 'subagent-templates') : '',
      join(this.getWorkingDir(), 'src', 'features', 'subagents', 'templates'),
      join(this.getOpenClawConfigDir(), 'agency-agents'),
    ]
      .filter((item) => item.trim().length > 0)
      .map((item) => resolve(this.expandHomePathValue(item))))];
  }

  getClawHubCliEntryCandidates(): string[] {
    return [...new Set([
      this.getEnv('MATCHACLAW_CLAWHUB_CLI_ENTRY'),
      join(this.getWorkingDir(), 'node_modules', 'clawhub', 'bin', 'clawdhub.js'),
      resolve(join(__dirname, '../../../node_modules/clawhub/bin/clawdhub.js')),
    ]
      .filter((item) => item.trim().length > 0)
      .map((item) => resolve(this.expandHomePathValue(item))))];
  }

  getClawHubRegistryBases(): string[] {
    const explicit = this.getEnv('CLAWHUB_REGISTRY');
    if (explicit) {
      return [explicit.replace(/\/+$/, '')];
    }
    return [];
  }
}
