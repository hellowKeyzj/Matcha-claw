import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeSystemEnvironmentPort } from '../../../runtime-host/application/common/runtime-ports';
import { OpenClawEnvironmentRepository } from '../../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-environment-repository';
import { OpenClawEnvironmentConfigFileWorkflow } from '../../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow';
import { OpenClawEnvironmentStatusWorkflow } from '../../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-status-workflow';
import { createTestRuntimeFileSystem } from './runtime-file-system';

export function createTestRuntimeSystemEnvironment(
  overrides: Partial<RuntimeSystemEnvironmentPort> = {},
): RuntimeSystemEnvironmentPort {
  return {
    appName: 'MatchaClaw',
    appVersion: '0.0.0-test',
    isPackaged: false,
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    workingDir: process.cwd(),
    homeDir: homedir(),
    tempDir: tmpdir(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    resourcesPath: null,
    getEnv: (name) => String(process.env[name] || '').trim(),
    getProcessEnv: () => ({ ...process.env }),
    ...overrides,
  };
}

function expandHomePath(value: string, homeDir: string): string {
  return value.startsWith('~') ? value.replace('~', homeDir) : value;
}

export function createTestOpenClawEnvironmentRepository(
  overrides: Partial<RuntimeSystemEnvironmentPort> = {},
): OpenClawEnvironmentRepository {
  const fileSystem = createTestRuntimeFileSystem();
  const systemEnvironment = createTestRuntimeSystemEnvironment(overrides);
  const layout = {
    getOpenClawDirPath: () => {
      const explicitDir = systemEnvironment.getEnv('MATCHACLAW_OPENCLAW_DIR');
      if (explicitDir) {
        return resolve(expandHomePath(explicitDir, systemEnvironment.homeDir));
      }
      if (systemEnvironment.resourcesPath) {
        return resolve(join(systemEnvironment.resourcesPath, 'openclaw'));
      }
      return resolve(join(systemEnvironment.workingDir, 'node_modules/openclaw'));
    },
    getOpenClawConfigDir: () => {
      const explicitConfigDir = systemEnvironment.getEnv('OPENCLAW_CONFIG_DIR');
      if (explicitConfigDir) {
        return resolve(expandHomePath(explicitConfigDir, systemEnvironment.homeDir));
      }
      return resolve(join(systemEnvironment.homeDir, '.openclaw'));
    },
    getOpenClawConfigFilePath() {
      return join(this.getOpenClawConfigDir(), 'openclaw.json');
    },
  };
  return new OpenClawEnvironmentRepository(
    systemEnvironment,
    fileSystem,
    new OpenClawEnvironmentConfigFileWorkflow({ fileSystem, layout }),
    new OpenClawEnvironmentStatusWorkflow({ fileSystem, layout }),
  );
}
