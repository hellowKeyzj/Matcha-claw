import { homedir, tmpdir } from 'node:os';
import type { RuntimeSystemEnvironmentPort } from '../../../runtime-host/application/common/runtime-ports';
import { OpenClawEnvironmentRepository } from '../../../runtime-host/application/openclaw/openclaw-environment-repository';
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

export function createTestOpenClawEnvironmentRepository(
  overrides: Partial<RuntimeSystemEnvironmentPort> = {},
): OpenClawEnvironmentRepository {
  return new OpenClawEnvironmentRepository(
    createTestRuntimeSystemEnvironment(overrides),
    createTestRuntimeFileSystem(),
  );
}
