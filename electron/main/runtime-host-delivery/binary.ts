import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type RuntimeHostBinaryDeliveryMode = 'development' | 'packaged';

export type RuntimeHostBinaryResolutionErrorCode =
  | 'RUNTIME_HOST_BINARY_NOT_FOUND'
  | 'RUNTIME_HOST_PROJECT_ROOT_UNAVAILABLE'
  | 'RUNTIME_HOST_RESOURCES_PATH_UNAVAILABLE'
  | 'RUNTIME_HOST_TARGET_UNSUPPORTED';

export class RuntimeHostBinaryResolutionError extends Error {
  readonly code: RuntimeHostBinaryResolutionErrorCode;
  readonly deliveryMode: RuntimeHostBinaryDeliveryMode;
  readonly target: string;

  constructor(input: {
    readonly code: RuntimeHostBinaryResolutionErrorCode;
    readonly deliveryMode: RuntimeHostBinaryDeliveryMode;
    readonly target: string;
  }) {
    super(`Runtime-host delivery binary is unavailable for ${input.target} in ${input.deliveryMode} mode.`);
    this.name = 'RuntimeHostBinaryResolutionError';
    this.code = input.code;
    this.deliveryMode = input.deliveryMode;
    this.target = input.target;
  }
}

export interface ResolveRuntimeHostBinaryOptions {
  readonly isPackaged: boolean;
  readonly projectRoot?: string;
  readonly resourcesPath?: string;
}

export interface RuntimeHostBinaryResolverDependencies {
  readonly isFile?: (absolutePath: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}

const SUPPORTED_RUNTIME_HOST_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

const runtimeHostBinaryFileExists = (absolutePath: string): boolean => {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
};

export function resolveRuntimeHostBinary(
  options: ResolveRuntimeHostBinaryOptions,
  dependencies: RuntimeHostBinaryResolverDependencies = {},
): string {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const target = `${platform}-${arch}`;
  const deliveryMode: RuntimeHostBinaryDeliveryMode = options.isPackaged ? 'packaged' : 'development';
  if (!SUPPORTED_RUNTIME_HOST_TARGETS.has(target)) {
    throw new RuntimeHostBinaryResolutionError({
      code: 'RUNTIME_HOST_TARGET_UNSUPPORTED',
      deliveryMode,
      target,
    });
  }

  const executableName = platform === 'win32' ? 'runtime-host.exe' : 'runtime-host';
  const binaryPath = options.isPackaged
    ? resolvePackagedRuntimeHostBinaryPath(
      options.resourcesPath ?? electronResourcesPath(),
      target,
      executableName,
    )
    : resolveDevelopmentRuntimeHostBinaryPath(options.projectRoot, target, executableName);
  const isFile = dependencies.isFile ?? runtimeHostBinaryFileExists;

  if (!isFile(binaryPath)) {
    throw new RuntimeHostBinaryResolutionError({
      code: 'RUNTIME_HOST_BINARY_NOT_FOUND',
      deliveryMode,
      target,
    });
  }

  return binaryPath;
}

function electronResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
}

function resolveDevelopmentRuntimeHostBinaryPath(
  projectRoot: string | undefined,
  target: string,
  executableName: string,
): string {
  if (!projectRoot?.trim()) {
    throw new RuntimeHostBinaryResolutionError({
      code: 'RUNTIME_HOST_PROJECT_ROOT_UNAVAILABLE',
      deliveryMode: 'development',
      target,
    });
  }

  return join(resolve(projectRoot), 'runtime-host', 'dist', target, executableName);
}

function resolvePackagedRuntimeHostBinaryPath(
  resourcesPath: string | undefined,
  target: string,
  executableName: string,
): string {
  if (!resourcesPath?.trim()) {
    throw new RuntimeHostBinaryResolutionError({
      code: 'RUNTIME_HOST_RESOURCES_PATH_UNAVAILABLE',
      deliveryMode: 'packaged',
      target,
    });
  }

  return join(resolve(resourcesPath), 'bin', target, executableName);
}
