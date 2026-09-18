import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import {
  resolveRuntimeHostBootstrap,
  RuntimeHostBootstrapResolutionError,
} from '../../electron/main/runtime-host-delivery/bootstrap-resources';

const projectRoot = '/workspace/matchaclaw';
const resourcesRoot = '/Applications/MatchaClaw/resources';
const windowsProjectRoot = 'C:\\workspace\\matchaclaw';
const windowsResourcesRoot = 'C:\\Program Files\\MatchaClaw\\resources';
const userDataRoot = '/Users/example/Library/Application Support/MatchaClaw';

function resolveBootstrap(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly files: readonly string[];
  readonly resourcesPath?: string;
  readonly projectRoot?: string;
  readonly workingDirectory?: string;
}): ReturnType<typeof resolveRuntimeHostBootstrap> {
  const path = input.platform === 'win32' ? win32 : posix;
  const target = `${input.platform}-${input.arch}`;
  const defaultRoot =
    input.platform === 'win32'
      ? input.isPackaged
        ? windowsResourcesRoot
        : windowsProjectRoot
      : input.isPackaged
        ? resourcesRoot
        : projectRoot;
  const modeRoot = input.isPackaged
    ? (input.resourcesPath ?? defaultRoot)
    : (input.projectRoot ?? defaultRoot);
  const files = new Set(input.files);

  return resolveRuntimeHostBootstrap({
    app: {
      isPackaged: input.isPackaged,
      getVersion: () => '1.2.3',
      getPath: () =>
        input.platform === 'win32'
          ? 'C:\\Users\\example\\AppData\\Roaming\\MatchaClaw'
          : userDataRoot,
    },
    process: {
      platform: input.platform,
      arch: input.arch,
      execPath:
        input.platform === 'win32'
          ? 'C:\\Program Files\\MatchaClaw\\MatchaClaw.exe'
          : '/Applications/MatchaClaw.app/Contents/MacOS/MatchaClaw',
      ...(input.isPackaged ? { resourcesPath: modeRoot } : {}),
      cwd: () => input.workingDirectory ?? modeRoot,
    },
    getOpenClawConfigDir: () =>
      input.platform === 'win32' ? 'C:\\Users\\example\\.openclaw' : '/Users/example/.openclaw',
    getRuntimeHostStateDir: () =>
      input.platform === 'win32'
        ? 'C:\\Users\\example\\AppData\\Roaming\\MatchaClaw\\runtime-host'
        : `${userDataRoot}/runtime-host`,
    getPort: (name) => {
      if (name === 'MATCHACLAW_RUNTIME_HOST') return 32_111;
      if (name === 'MATCHA_AGENT_APP_SERVER') return 32_112;
      if (name === 'OPENCLAW_GATEWAY') return 18_789;
      return 18_789;
    },
    isFile: (file) => files.has(file),
    resolveRuntimeHostBinary: () =>
      path.join(
        modeRoot,
        ...(input.isPackaged ? ['bin', target] : ['runtime-host', 'dist', target]),
        input.platform === 'win32' ? 'runtime-host.exe' : 'runtime-host'
      ),
  });
}

function expectedFiles(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}): string[] {
  const path = input.platform === 'win32' ? win32 : posix;
  const target = `${input.platform}-${input.arch}`;
  const modeRoot =
    input.platform === 'win32'
      ? input.isPackaged
        ? windowsResourcesRoot
        : windowsProjectRoot
      : input.isPackaged
        ? resourcesRoot
        : projectRoot;
  const runtimeHostDirectory = path.join(
    modeRoot,
    ...(input.isPackaged ? ['bin', target] : ['runtime-host', 'dist', target])
  );
  const entry = input.isPackaged
    ? path.join(modeRoot, 'matcha-agent', 'dist', 'cli-bun.js')
    : path.join(modeRoot, 'matcha-agent', 'scripts', 'dev.ts');
  const bun = input.isPackaged
    ? path.join(modeRoot, 'bin', input.platform === 'win32' ? 'bun.exe' : 'bun')
    : path.join(
        modeRoot,
        'resources',
        'bin',
        target,
        input.platform === 'win32' ? 'bun.exe' : 'bun'
      );
  const electronImage =
    input.platform === 'win32'
      ? 'C:\\Program Files\\MatchaClaw\\MatchaClaw.exe'
      : '/Applications/MatchaClaw.app/Contents/MacOS/MatchaClaw';
  const openClawEntry = input.isPackaged
    ? path.join(modeRoot, 'openclaw', 'openclaw.mjs')
    : path.join(modeRoot, 'node_modules', 'openclaw', 'openclaw.mjs');

  return [
    electronImage,
    bun,
    entry,
    openClawEntry,
    path.join(
      runtimeHostDirectory,
      input.platform === 'win32' ? 'runtime-host.exe' : 'runtime-host'
    ),
    path.join(
      runtimeHostDirectory,
      input.platform === 'win32' ? 'runtime-host-mcp.exe' : 'runtime-host-mcp'
    ),
    input.platform === 'win32'
      ? input.isPackaged
        ? path.join(modeRoot, 'bin', 'git-for-windows', 'bin', 'bash.exe')
        : path.join(modeRoot, 'resources', 'bin', target, 'git-for-windows', 'bin', 'bash.exe')
      : path.join(runtimeHostDirectory, 'runtime-host-guardian'),
  ];
}

describe('resolveRuntimeHostBootstrap', () => {
  it.each([
    [false, 'darwin', 'arm64'],
    [true, 'darwin', 'x64'],
    [true, 'linux', 'arm64'],
    [false, 'win32', 'x64'],
    [true, 'win32', 'arm64'],
  ] as const)(
    'resolves exact %s %s-%s non-secret bootstrap inputs',
    (isPackaged, platform, arch) => {
      const bootstrap = resolveBootstrap({
        isPackaged,
        platform,
        arch,
        files: expectedFiles({ isPackaged, platform, arch }),
      });
      const path = platform === 'win32' ? win32 : posix;
      const modeRoot =
        platform === 'win32'
          ? isPackaged
            ? windowsResourcesRoot
            : windowsProjectRoot
          : isPackaged
            ? resourcesRoot
            : projectRoot;
      const target = `${platform}-${arch}`;
      const userData =
        platform === 'win32' ? 'C:\\Users\\example\\AppData\\Roaming\\MatchaClaw' : userDataRoot;
      const storageRoot = path.join(userData, 'matcha-agent', 'app-server');

      expect(bootstrap).toMatchObject({
        platform: platform === 'win32' ? 'win32' : 'unix',
        appVersion: '1.2.3',
        appLogDir: path.join(userData, 'logs'),
        runtimeHostStateDir: path.join(userData, 'runtime-host'),
        runtimeHostMcpExecutable: path.join(
          modeRoot,
          ...(isPackaged ? ['bin', target] : ['runtime-host', 'dist', target]),
          platform === 'win32' ? 'runtime-host-mcp.exe' : 'runtime-host-mcp'
        ),
        runtimeHostTransportPort: 32_111,
        matcha: {
          bunExecutable: isPackaged
            ? path.join(modeRoot, 'bin', platform === 'win32' ? 'bun.exe' : 'bun')
            : path.join(
                modeRoot,
                'resources',
                'bin',
                target,
                platform === 'win32' ? 'bun.exe' : 'bun'
              ),
          entry: isPackaged
            ? path.join(modeRoot, 'matcha-agent', 'dist', 'cli-bun.js')
            : path.join(modeRoot, 'matcha-agent', 'scripts', 'dev.ts'),
          workingDirectory: modeRoot,
          storageRoot,
          port: 32_112,
        },
        openClaw: {
          electronImage:
            platform === 'win32'
              ? 'C:\\Program Files\\MatchaClaw\\MatchaClaw.exe'
              : '/Applications/MatchaClaw.app/Contents/MacOS/MatchaClaw',
          companionSkillSourceRoot: path.join(modeRoot, 'resources', 'skills', 'plugin-companion-skills'),
          managedPluginRoot: path.join(
            modeRoot,
            ...(isPackaged ? ['openclaw-plugins'] : ['build', 'openclaw-plugins'])
          ),
          port: 18_789,
        },
      });
      expect(bootstrap).not.toHaveProperty('sessionTransportPort');
      expect(bootstrap).not.toHaveProperty('fleetTransportPort');
      expect(JSON.stringify(bootstrap)).not.toContain('token');
      expect(JSON.stringify(bootstrap)).not.toContain('skipChannels');

      if (platform === 'win32') {
        expect(bootstrap).not.toHaveProperty('guardianExecutable');
        expect(bootstrap.matcha).toHaveProperty(
          'gitBash',
          isPackaged
            ? path.join(modeRoot, 'bin', 'git-for-windows', 'bin', 'bash.exe')
            : path.join(modeRoot, 'resources', 'bin', target, 'git-for-windows', 'bin', 'bash.exe')
        );
      } else {
        expect(bootstrap).toHaveProperty(
          'guardianExecutable',
          path.join(
            modeRoot,
            ...(isPackaged ? ['bin', target] : ['runtime-host', 'dist', target]),
            'runtime-host-guardian'
          )
        );
        expect(bootstrap.matcha).not.toHaveProperty('gitBash');
      }
    }
  );

  it('resolves development artifacts from the project cwd rather than compiled main output', () => {
    const bootstrap = resolveBootstrap({
      isPackaged: false,
      platform: 'win32',
      arch: 'x64',
      workingDirectory: windowsProjectRoot,
      files: expectedFiles({ isPackaged: false, platform: 'win32', arch: 'x64' }),
    });

    expect(bootstrap.matcha).toMatchObject({
      bunExecutable: win32.join(windowsProjectRoot, 'resources', 'bin', 'win32-x64', 'bun.exe'),
      entry: win32.join(windowsProjectRoot, 'matcha-agent', 'scripts', 'dev.ts'),
      workingDirectory: windowsProjectRoot,
    });
    expect(bootstrap.openClaw).toMatchObject({
      openclawDir: win32.join(windowsProjectRoot, 'node_modules', 'openclaw'),
      companionSkillSourceRoot: win32.join(windowsProjectRoot, 'resources', 'skills', 'plugin-companion-skills'),
      managedPluginRoot: win32.join(windowsProjectRoot, 'build', 'openclaw-plugins'),
      entry: win32.join(windowsProjectRoot, 'node_modules', 'openclaw', 'openclaw.mjs'),
    });
  });

  it('fails closed with a redacted typed error when runtime-host-mcp is absent', () => {
    const files = expectedFiles({ isPackaged: true, platform: 'darwin', arch: 'arm64' });
    const mcp = posix.join(resourcesRoot, 'bin', 'darwin-arm64', 'runtime-host-mcp');
    const error = expectResolutionFailure(() =>
      resolveBootstrap({
        isPackaged: true,
        platform: 'darwin',
        arch: 'arm64',
        files: files.filter((file) => file !== mcp),
      })
    );

    expect(error.code).toBe('RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND');
    expect(error.message).not.toContain(mcp);
  });

  it('fails closed with a redacted typed error when a Unix guardian is absent', () => {
    const files = expectedFiles({ isPackaged: true, platform: 'darwin', arch: 'arm64' });
    const guardian = posix.join(resourcesRoot, 'bin', 'darwin-arm64', 'runtime-host-guardian');
    const error = expectResolutionFailure(() =>
      resolveBootstrap({
        isPackaged: true,
        platform: 'darwin',
        arch: 'arm64',
        files: files.filter((file) => file !== guardian),
      })
    );

    expect(error.code).toBe('RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND');
    expect(error.message).not.toContain(guardian);
  });

  it.each([
    [true, 'x64'],
    [false, 'arm64'],
  ] as const)(
    'fails closed with a redacted typed error when %s-mode Windows %s Git Bash is absent',
    (isPackaged, arch) => {
      const files = expectedFiles({ isPackaged, platform: 'win32', arch });
      const bash = isPackaged
        ? win32.join(windowsResourcesRoot, 'bin', 'git-for-windows', 'bin', 'bash.exe')
        : win32.join(
            windowsProjectRoot,
            'resources',
            'bin',
            `win32-${arch}`,
            'git-for-windows',
            'bin',
            'bash.exe'
          );
      const error = expectResolutionFailure(() =>
        resolveBootstrap({
          isPackaged,
          platform: 'win32',
          arch,
          files: files.filter((file) => file !== bash),
        })
      );

      expect(error.code).toBe('RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND');
      expect(error.message).not.toContain(bash);
    }
  );

  it('rejects unsupported platforms without leaking runtime paths', () => {
    const error = expectResolutionFailure(() =>
      resolveBootstrap({
        isPackaged: false,
        platform: 'freebsd',
        arch: 'x64',
        files: [],
      })
    );

    expect(error.code).toBe('RUNTIME_HOST_BOOTSTRAP_PLATFORM_UNSUPPORTED');
    expect(error.message).not.toContain(projectRoot);
  });
});

function expectResolutionFailure(resolve: () => unknown): RuntimeHostBootstrapResolutionError {
  try {
    resolve();
    throw new Error('Expected resolver to reject unavailable bootstrap resources.');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeHostBootstrapResolutionError);
    return error as RuntimeHostBootstrapResolutionError;
  }
}
