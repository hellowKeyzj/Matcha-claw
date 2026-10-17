import { accessSync, constants, statSync } from 'node:fs';
import { isNativeExecutable } from './native-artifact.mjs';
import { posix, win32 } from 'node:path';
import { app } from 'electron';
import { getPort } from '../../utils/config';
import { getOpenClawConfigDir, getRuntimeHostStateDir } from '../../utils/paths';
import {
  resolveRuntimeHostBinary,
  type ResolveRuntimeHostBinaryOptions,
  type RuntimeHostBinaryResolverDependencies,
} from './binary';
import type {
  RuntimeHostBootstrapInput,
  UnixRuntimeHostBootstrapInput,
  WindowsRuntimeHostBootstrapInput,
} from './bootstrap';

type RuntimeHostBootstrapDeliveryField =
  | 'deliveryVerificationKey'
  | 'parentCallbackBaseUrl'
  | 'parentCallbackDispatchToken'
  | 'providerCredentialResolver';

type RuntimeHostBootstrapResources =
  | Omit<UnixRuntimeHostBootstrapInput, RuntimeHostBootstrapDeliveryField>
  | Omit<WindowsRuntimeHostBootstrapInput, RuntimeHostBootstrapDeliveryField>;

type BootstrapPlatform = 'unix' | 'win32';
type DeliveryPath = typeof posix | typeof win32;

type RuntimeHostApp = {
  readonly isPackaged: boolean;
  getVersion(): string;
  getPath(name: 'userData'): string;
};

type RuntimeHostProcess = {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly execPath: string;
  readonly resourcesPath?: string;
  cwd(): string;
};

export type RuntimeHostBootstrapResolutionErrorCode =
  | 'RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND'
  | 'RUNTIME_HOST_BOOTSTRAP_PLATFORM_UNSUPPORTED';

export class RuntimeHostBootstrapResolutionError extends Error {
  constructor(readonly code: RuntimeHostBootstrapResolutionErrorCode) {
    super('Runtime-host bootstrap resources are unavailable.');
    this.name = 'RuntimeHostBootstrapResolutionError';
  }
}

export interface RuntimeHostBootstrapResolverDependencies {
  readonly app?: RuntimeHostApp;
  readonly process?: RuntimeHostProcess;
  readonly getOpenClawConfigDir?: () => string;
  readonly getRuntimeHostStateDir?: () => string;
  readonly getPort?: (
    name:
      | 'MATCHACLAW_RUNTIME_HOST'
      | 'MATCHA_AGENT_APP_SERVER'
      | 'OPENCLAW_GATEWAY'
  ) => number;
  readonly isFile?: (absolutePath: string) => boolean;
  readonly isExecutable?: (absolutePath: string, platform: NodeJS.Platform, arch: NodeJS.Architecture) => boolean;
  readonly resolveRuntimeHostBinary?: (
    options: ResolveRuntimeHostBinaryOptions,
    dependencies: RuntimeHostBinaryResolverDependencies
  ) => string;
}

const runtimeHostProcess = process as RuntimeHostProcess;
type RuntimeHostPortName = Parameters<NonNullable<RuntimeHostBootstrapResolverDependencies['getPort']>>[0];

function getRuntimeHostBootstrapPort(name: RuntimeHostPortName): number {
  return getPort(name as Parameters<typeof getPort>[0]);
}

export function resolveRuntimeHostBootstrap(
  dependencies: RuntimeHostBootstrapResolverDependencies = {}
): RuntimeHostBootstrapResources {
  const application = dependencies.app ?? app;
  const currentProcess = dependencies.process ?? runtimeHostProcess;
  const platform = bootstrapPlatform(currentProcess.platform);
  const path = pathFor(platform);
  const mode = application.isPackaged ? 'packaged' : 'development';
  const projectRoot = mode === 'development' ? path.resolve(currentProcess.cwd()) : undefined;
  const resourcesPath = mode === 'packaged' ? currentProcess.resourcesPath : undefined;
  const target = `${currentProcess.platform}-${currentProcess.arch}`;
  const isFile = dependencies.isFile ?? runtimeHostArtifactIsFile;
  const resolveBinary = dependencies.resolveRuntimeHostBinary ?? resolveRuntimeHostBinary;
  const runtimeHostBinary = resolveBinary(
    { isPackaged: application.isPackaged, projectRoot, resourcesPath },
    { isFile, platform: currentProcess.platform, arch: currentProcess.arch }
  );
  const layout = resolveRuntimeLayout({
    app: application,
    currentProcess,
    path,
    platform,
    mode,
    projectRoot,
    resourcesPath,
    target,
    getOpenClawConfigDir: dependencies.getOpenClawConfigDir ?? getOpenClawConfigDir,
    getRuntimeHostStateDir: dependencies.getRuntimeHostStateDir ?? getRuntimeHostStateDir,
    getPort: dependencies.getPort ?? getRuntimeHostBootstrapPort,
    runtimeHostBinary,
  });

  const cliRoot = path.dirname(layout.matcha.cliArgs[0]!);
  const vendorTarget = `${currentProcess.arch}-${currentProcess.platform}`;
  const platformExecutable = platform === 'unix' ? layout.guardianExecutable : layout.gitBash;
  requireFiles(isFile, [
    currentProcess.execPath,
    layout.matcha.serverExecutable,
    layout.matcha.cliExecutable,
    ...layout.matcha.cliArgs,
    path.join(cliRoot, 'cli.js'),
    path.join(cliRoot, 'vendor', 'audio-capture', vendorTarget, 'audio-capture.node'),
    layout.openClaw.entry,
    runtimeHostBinary,
    platformExecutable,
  ]);

  const executable = dependencies.isExecutable ?? isNativeExecutable;
  const ripgrep = path.join(cliRoot, 'vendor', 'ripgrep', vendorTarget, platform === 'win32' ? 'rg.exe' : 'rg');
  if (![layout.matcha.serverExecutable, layout.matcha.cliExecutable, runtimeHostBinary, ripgrep, platformExecutable]
    .every(file => executable(file, currentProcess.platform, currentProcess.arch))) {
    throw new RuntimeHostBootstrapResolutionError('RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND');
  }

  if (platform === 'unix') {
    return {
      platform,
      appVersion: application.getVersion(),
      appLogDir: layout.appLogDir,
      runtimeHostStateDir: layout.runtimeHostStateDir,
      runtimeHostMcpExecutable: layout.runtimeHostMcpExecutable,
      runtimeHostTransportPort: layout.runtimeHostTransportPort,
      matcha: layout.matcha,
      openClaw: layout.openClaw,
      guardianExecutable: layout.guardianExecutable,
    };
  }

  return {
    platform,
    appVersion: application.getVersion(),
    appLogDir: layout.appLogDir,
    runtimeHostStateDir: layout.runtimeHostStateDir,
    runtimeHostMcpExecutable: layout.runtimeHostMcpExecutable,
    runtimeHostTransportPort: layout.runtimeHostTransportPort,
    matcha: { ...layout.matcha, gitBash: layout.gitBash },
    openClaw: layout.openClaw,
  };
}

type RuntimeLayoutInput = {
  readonly app: RuntimeHostApp;
  readonly currentProcess: RuntimeHostProcess;
  readonly path: DeliveryPath;
  readonly platform: BootstrapPlatform;
  readonly mode: 'development' | 'packaged';
  readonly projectRoot: string | undefined;
  readonly resourcesPath: string | undefined;
  readonly target: string;
  readonly runtimeHostBinary: string;
  readonly getOpenClawConfigDir: () => string;
  readonly getRuntimeHostStateDir: () => string;
  readonly getPort: (
    name:
      | 'MATCHACLAW_RUNTIME_HOST'
      | 'MATCHA_AGENT_APP_SERVER'
      | 'OPENCLAW_GATEWAY'
  ) => number;
};

type RuntimeLayout = {
  readonly appLogDir: string;
  readonly runtimeHostStateDir: string;
  readonly runtimeHostMcpExecutable: string;
  readonly runtimeHostTransportPort: number;
  readonly matcha: RuntimeHostBootstrapInput['matcha'];
  readonly openClaw: RuntimeHostBootstrapInput['openClaw'];
  readonly guardianExecutable: string;
  readonly gitBash: string;
};

function resolveRuntimeLayout(input: RuntimeLayoutInput): RuntimeLayout {
  const userData = input.app.getPath('userData');
  const storageRoot = input.path.join(userData, 'matcha-agent', 'app-server');
  const resourcesRoot =
    input.mode === 'packaged' ? requireResourcesRoot(input.resourcesPath, input.path) : undefined;
  const projectRoot =
    input.mode === 'development' ? requireProjectRoot(input.projectRoot, input.path) : undefined;
  const bunExecutableName = input.platform === 'win32' ? 'bun.exe' : 'bun';
  const cliExecutable =
    input.mode === 'packaged'
      ? input.path.join(resourcesRoot!, 'bin', bunExecutableName)
      : input.path.join(projectRoot!, 'resources', 'bin', input.target, bunExecutableName);
  const serverName = input.platform === 'win32' ? 'matcha-app-server.exe' : 'matcha-app-server';
  const serverExecutable = input.mode === 'packaged'
    ? input.path.join(resourcesRoot!, 'bin', input.target, serverName)
    : input.path.join(projectRoot!, 'matcha-agent', 'app-server', 'dist', input.target, serverName);
  const cliEntry = input.path.join(resourcesRoot ?? projectRoot!, 'matcha-agent', 'dist', 'cli-bun.js');
  const workingDirectory = input.mode === 'packaged' ? resourcesRoot! : projectRoot!;
  const openClawDir = input.mode === 'packaged'
    ? input.path.join(resourcesRoot!, 'openclaw')
    : input.path.join(projectRoot!, 'node_modules', 'openclaw');
  const managedPluginRoot = input.mode === 'packaged'
    ? input.path.join(resourcesRoot!, 'openclaw-plugins')
    : input.path.join(projectRoot!, 'build', 'openclaw-plugins');
  const companionSkillSourceRoot = input.mode === 'packaged'
    ? input.path.join(resourcesRoot!, 'resources', 'skills', 'plugin-companion-skills')
    : input.path.join(projectRoot!, 'resources', 'skills', 'plugin-companion-skills');
  const gitBash =
    input.mode === 'packaged'
      ? input.path.join(resourcesRoot!, 'bin', 'git-for-windows', 'bin', 'bash.exe')
      : input.path.join(
          projectRoot!,
          'resources',
          'bin',
          input.target,
          'git-for-windows',
          'bin',
          'bash.exe'
        );
  const runtimeHostDirectory = input.path.dirname(input.runtimeHostBinary);
  const guardianExecutable = input.path.join(runtimeHostDirectory, 'runtime-host-guardian');
  return {
    appLogDir: input.path.join(userData, 'logs'),
    runtimeHostStateDir: input.getRuntimeHostStateDir(),
    runtimeHostMcpExecutable: input.runtimeHostBinary,
    runtimeHostTransportPort: input.getPort('MATCHACLAW_RUNTIME_HOST'),
    matcha: {
      serverExecutable,
      cliExecutable,
      cliArgs: [cliEntry],
      workingDirectory,
      storageRoot,
      port: input.getPort('MATCHA_AGENT_APP_SERVER'),
    },
    openClaw: {
      electronImage: input.currentProcess.execPath,
      workingDirectory,
      openclawDir: openClawDir,
      managedPluginRoot,
      companionSkillSourceRoot,
      subagentTemplateDir: input.mode === 'packaged'
        ? input.path.join(resourcesRoot!, 'resources', 'subagent-templates')
        : input.path.join(projectRoot!, 'src', 'features', 'subagents', 'templates'),
      entry: input.path.join(openClawDir, 'openclaw.mjs'),
      stateDir: input.getOpenClawConfigDir(),
      port: input.getPort('OPENCLAW_GATEWAY'),
    },
    guardianExecutable,
    gitBash,
  };
}

function bootstrapPlatform(platform: NodeJS.Platform): BootstrapPlatform {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin' || platform === 'linux') return 'unix';
  throw new RuntimeHostBootstrapResolutionError('RUNTIME_HOST_BOOTSTRAP_PLATFORM_UNSUPPORTED');
}

function pathFor(platform: BootstrapPlatform): DeliveryPath {
  return platform === 'win32' ? win32 : posix;
}

function requireProjectRoot(value: string | undefined, path: DeliveryPath): string {
  if (value?.trim()) return path.resolve(value);
  throw new RuntimeHostBootstrapResolutionError('RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND');
}

function requireResourcesRoot(value: string | undefined, path: DeliveryPath): string {
  if (value?.trim()) return path.resolve(value);
  throw new RuntimeHostBootstrapResolutionError('RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND');
}

function requireFiles(isFile: (absolutePath: string) => boolean, paths: readonly string[]): void {
  if (paths.every(isFile)) return;
  throw new RuntimeHostBootstrapResolutionError('RUNTIME_HOST_BOOTSTRAP_ARTIFACT_NOT_FOUND');
}

function runtimeHostArtifactIsFile(absolutePath: string): boolean {
  try {
    accessSync(absolutePath, constants.R_OK);
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}
