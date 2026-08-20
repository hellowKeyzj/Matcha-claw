import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  resolveRuntimeHostBinary,
  RuntimeHostBinaryResolutionError,
} from '../../electron/main/runtime-host-delivery/binary';

const currentTarget = `${process.platform}-${process.arch}`;
const runtimeHostExecutableName = process.platform === 'win32' ? 'runtime-host.exe' : 'runtime-host';

function resolveBinaryPath(input: {
  readonly isPackaged: boolean;
  readonly projectRoot?: string;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly files?: readonly string[];
}): string {
  const { arch, files: sourceFiles, platform, ...options } = input;
  const files = new Set(sourceFiles ?? []);
  return resolveRuntimeHostBinary(options, {
    isFile: (absolutePath) => files.has(absolutePath),
    ...(platform === undefined ? {} : { platform }),
    ...(arch === undefined ? {} : { arch }),
  });
}

function expectRuntimeHostBinaryResolutionError(
  resolveBinary: () => string,
  expected: Partial<RuntimeHostBinaryResolutionError>,
): void {
  try {
    resolveBinary();
    throw new Error('Expected runtime-host binary resolution to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeHostBinaryResolutionError);
    expect(error).toMatchObject(expected);
  }
}

describe('resolveRuntimeHostBinary', () => {
  it('resolves the development artifact for the exact current target', () => {
    const projectRoot = resolve('/workspace/matchaclaw');
    const expectedPath = join(
      projectRoot,
      'runtime-host',
      'dist',
      currentTarget,
      runtimeHostExecutableName,
    );

    expect(resolveBinaryPath({
      isPackaged: false,
      projectRoot,
      files: [expectedPath],
    })).toBe(expectedPath);
  });

  it('resolves the packaged artifact from resources/bin for the exact current target', () => {
    const resourcesPath = resolve('/applications/MatchaClaw/resources');
    const expectedPath = join(resourcesPath, 'bin', currentTarget, runtimeHostExecutableName);

    expect(resolveBinaryPath({
      isPackaged: true,
      resourcesPath,
      files: [expectedPath],
    })).toBe(expectedPath);
  });

  it('does not use the current working directory as a development artifact fallback', () => {
    expectRuntimeHostBinaryResolutionError(
      () => resolveBinaryPath({ isPackaged: false }),
      {
        code: 'RUNTIME_HOST_PROJECT_ROOT_UNAVAILABLE',
        deliveryMode: 'development',
        target: currentTarget,
      },
    );
  });

  it('throws a typed error when the selected development artifact is absent', () => {
    expectRuntimeHostBinaryResolutionError(
      () => resolveBinaryPath({
        isPackaged: false,
        projectRoot: '/workspace/matchaclaw',
      }),
      {
        code: 'RUNTIME_HOST_BINARY_NOT_FOUND',
        deliveryMode: 'development',
        target: currentTarget,
      },
    );
  });

  it('fails closed without exposing the packaged artifact path when it is absent', () => {
    const resourcesPath = resolve('/applications/MatchaClaw/resources');
    try {
      resolveBinaryPath({ isPackaged: true, resourcesPath });
      throw new Error('Expected packaged runtime-host artifact resolution to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeHostBinaryResolutionError);
      expect(error).toMatchObject({
        code: 'RUNTIME_HOST_BINARY_NOT_FOUND',
        deliveryMode: 'packaged',
        target: currentTarget,
      });
      expect((error as Error).message).not.toContain(resourcesPath);
    }
  });

  it('throws a typed error without filesystem details when packaged resources are unavailable', () => {
    expectRuntimeHostBinaryResolutionError(
      () => resolveBinaryPath({ isPackaged: true, resourcesPath: '' }),
      {
        code: 'RUNTIME_HOST_RESOURCES_PATH_UNAVAILABLE',
        deliveryMode: 'packaged',
        target: currentTarget,
      },
    );
  });

  it.each([
    ['linux', 'ia32'],
    ['win32', 'ia32'],
  ] as const)('rejects an unsupported %s-%s target even when a matching artifact is present', (platform, arch) => {
    const projectRoot = resolve('/workspace/matchaclaw');
    const executableName = platform === 'win32' ? 'runtime-host.exe' : 'runtime-host';
    const unsupportedPath = join(projectRoot, 'runtime-host', 'dist', `${platform}-${arch}`, executableName);

    expectRuntimeHostBinaryResolutionError(
      () => resolveBinaryPath({
        isPackaged: false,
        projectRoot,
        platform,
        arch,
        files: [unsupportedPath],
      }),
      {
        deliveryMode: 'development',
        target: `${platform}-${arch}`,
      },
    );
  });

  it.each([
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ] as const)('resolves development and packaged artifacts for the supported %s-%s target', (platform, arch) => {
    const target = `${platform}-${arch}`;
    const executableName = platform === 'win32' ? 'runtime-host.exe' : 'runtime-host';
    const projectRoot = resolve('/workspace/matchaclaw');
    const resourcesPath = resolve('/applications/MatchaClaw/resources');
    const developmentPath = join(projectRoot, 'runtime-host', 'dist', target, executableName);
    const packagedPath = join(resourcesPath, 'bin', target, executableName);

    expect(resolveBinaryPath({
      isPackaged: false,
      projectRoot,
      platform,
      arch,
      files: [developmentPath],
    })).toBe(developmentPath);
    expect(resolveBinaryPath({
      isPackaged: true,
      resourcesPath,
      platform,
      arch,
      files: [packagedPath],
    })).toBe(packagedPath);
  });
});
