import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { app } from 'electron';
import { getPort } from '../../utils/config';
import { getOpenClawConfigDir, getRuntimeHostStateDir } from '../../utils/paths';
import {
  resolveRuntimeHostBinary,
  type ResolveRuntimeHostBinaryOptions,
  type RuntimeHostBinaryResolverDependencies,
} from './binary';
import type { RuntimeHostBootstrapInput } from './bootstrap';

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
      | 'MATCHACLAW_SESSION_TRANSPORT'
      | 'MATCHACLAW_FLEET_TRANSPORT'
      | 'MATCHACLAW_DIAGNOSTICS_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_TEXT_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_BINARY_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_DIRECTORY_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_WRITE_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_MEDIA_TRANSPORT'
      | 'MATCHACLAW_SESSION_SEND_TRANSPORT'
      | 'MATCHACLAW_SESSION_ABORT_TRANSPORT'
      | 'MATCHACLAW_SECURITY_EMERGENCY_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_STATUS_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_CATALOG_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_CONTROL_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_PAIRING_TRANSPORT'
      | 'MATCHACLAW_SETTINGS_DESIRED_TRANSPORT'
      | 'MATCHACLAW_SECURITY_POLICY_TRANSPORT'
      | 'MATCHACLAW_SESSION_APPROVAL_TRANSPORT'
      | 'MATCHACLAW_OPENCLAW_HISTORY_TRANSPORT'
      | 'MATCHACLAW_MATCHA_HISTORY_TRANSPORT'
      | 'MATCHACLAW_USAGE_TRANSPORT'
      | 'MATCHACLAW_SESSION_MODEL_SELECTION_TRANSPORT'
      | 'MATCHACLAW_CRON_TRANSPORT'
      | 'MATCHACLAW_CRON_BROKER_TRANSPORT'
      | 'MATCHACLAW_TASK_MANAGER_TRANSPORT'
      | 'MATCHACLAW_AGENTS_TRANSPORT'
      | 'MATCHACLAW_TEAM_PUBLIC_TRANSPORT'
      | 'MATCHACLAW_TEAM_TASK_BOARD_TRANSPORT'
      | 'MATCHACLAW_TEAM_ROLE_SESSIONS_TRANSPORT'
      | 'MATCHACLAW_TEAM_APPROVALS_TRANSPORT'
      | 'MATCHACLAW_TEAM_DECISION_TRANSPORT'
      | 'MATCHACLAW_TEAM_ROLE_CHAT_TRANSPORT'
      | 'MATCHACLAW_TEAM_GRAPH_TRANSPORT'
      | 'MATCHACLAW_PROVIDER_MODELS_TRANSPORT'
      | 'MATCHACLAW_PROVIDER_ACCOUNTS_TRANSPORT'
      | 'MATCHACLAW_TEAM_SKILL_TRANSPORT'
      | 'MATCHACLAW_TEAM_TRIGGER_TRANSPORT'
      | 'MATCHACLAW_TEAM_LIFECYCLE_TRANSPORT'
      | 'MATCHACLAW_MANUAL_TEAM_TRANSPORT'
      | 'MATCHA_AGENT_APP_SERVER'
      | 'OPENCLAW_GATEWAY'
  ) => number;
  readonly isFile?: (absolutePath: string) => boolean;
  readonly resolveRuntimeHostBinary?: (
    options: ResolveRuntimeHostBinaryOptions,
    dependencies: RuntimeHostBinaryResolverDependencies
  ) => string;
}

const runtimeHostProcess = process as RuntimeHostProcess;

export function resolveRuntimeHostBootstrap(
  dependencies: RuntimeHostBootstrapResolverDependencies = {}
): RuntimeHostBootstrapInput {
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
    getPort: dependencies.getPort ?? getPort,
    isFile,
    runtimeHostBinary,
  });

  requireFiles(isFile, [
    currentProcess.execPath,
    layout.matcha.bunExecutable,
    layout.matcha.entry,
    layout.openClaw.entry,
    runtimeHostBinary,
    ...(platform === 'unix' ? [layout.guardianExecutable] : [layout.gitBash]),
  ]);

  if (platform === 'unix') {
    return {
      platform,
      appVersion: application.getVersion(),
      appLogDir: layout.appLogDir,
      runtimeHostStateDir: layout.runtimeHostStateDir,
      sessionTransportPort: layout.sessionTransportPort,
      fleetTransportPort: layout.fleetTransportPort,
      diagnosticsTransportPort: layout.diagnosticsTransportPort,
      workspaceTextTransportPort: layout.workspaceTextTransportPort,
      workspaceBinaryTransportPort: layout.workspaceBinaryTransportPort,
      workspaceDirectoryTransportPort: layout.workspaceDirectoryTransportPort,
      workspaceWriteTransportPort: layout.workspaceWriteTransportPort,
      workspaceMediaTransportPort: layout.workspaceMediaTransportPort,
      sessionSendTransportPort: layout.sessionSendTransportPort,
      sessionAbortTransportPort: layout.sessionAbortTransportPort,
      securityEmergencyTransportPort: layout.securityEmergencyTransportPort,
      channelStatusTransportPort: layout.channelStatusTransportPort,
      channelCatalogTransportPort: layout.channelCatalogTransportPort,
      channelControlTransportPort: layout.channelControlTransportPort,
      channelPairingTransportPort: layout.channelPairingTransportPort,
      settingsDesiredTransportPort: layout.settingsDesiredTransportPort,
      securityPolicyTransportPort: layout.securityPolicyTransportPort,
      sessionApprovalTransportPort: layout.sessionApprovalTransportPort,
      openclawHistoryTransportPort: layout.openclawHistoryTransportPort,
      matchaHistoryTransportPort: layout.matchaHistoryTransportPort,
      usageTransportPort: layout.usageTransportPort,
      sessionModelSelectionTransportPort: layout.sessionModelSelectionTransportPort,
      cronTransportPort: layout.cronTransportPort,
      cronBrokerTransportPort: layout.cronBrokerTransportPort,
      taskManagerTransportPort: layout.taskManagerTransportPort,
      agentsTransportPort: layout.agentsTransportPort,
      teamPublicTransportPort: layout.teamPublicTransportPort,
      teamTaskBoardTransportPort: layout.teamTaskBoardTransportPort,
      teamRoleSessionsTransportPort: layout.teamRoleSessionsTransportPort,
      teamApprovalsTransportPort: layout.teamApprovalsTransportPort,
      teamDecisionTransportPort: layout.teamDecisionTransportPort,
      teamRoleChatTransportPort: layout.teamRoleChatTransportPort,
      teamGraphTransportPort: layout.teamGraphTransportPort,
      providerModelsTransportPort: layout.providerModelsTransportPort,
      providerAccountsTransportPort: layout.providerAccountsTransportPort,
      teamSkillTransportPort: layout.teamSkillTransportPort,
      teamTriggerTransportPort: layout.teamTriggerTransportPort,
      teamLifecycleTransportPort: layout.teamLifecycleTransportPort,
      manualTeamTransportPort: layout.manualTeamTransportPort,
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
    sessionTransportPort: layout.sessionTransportPort,
    fleetTransportPort: layout.fleetTransportPort,
    diagnosticsTransportPort: layout.diagnosticsTransportPort,
    workspaceTextTransportPort: layout.workspaceTextTransportPort,
    workspaceBinaryTransportPort: layout.workspaceBinaryTransportPort,
    workspaceDirectoryTransportPort: layout.workspaceDirectoryTransportPort,
    workspaceWriteTransportPort: layout.workspaceWriteTransportPort,
    workspaceMediaTransportPort: layout.workspaceMediaTransportPort,
    sessionSendTransportPort: layout.sessionSendTransportPort,
    sessionAbortTransportPort: layout.sessionAbortTransportPort,
    securityEmergencyTransportPort: layout.securityEmergencyTransportPort,
    channelStatusTransportPort: layout.channelStatusTransportPort,
    channelCatalogTransportPort: layout.channelCatalogTransportPort,
    channelControlTransportPort: layout.channelControlTransportPort,
    channelPairingTransportPort: layout.channelPairingTransportPort,
    settingsDesiredTransportPort: layout.settingsDesiredTransportPort,
    securityPolicyTransportPort: layout.securityPolicyTransportPort,
    sessionApprovalTransportPort: layout.sessionApprovalTransportPort,
    openclawHistoryTransportPort: layout.openclawHistoryTransportPort,
    matchaHistoryTransportPort: layout.matchaHistoryTransportPort,
    usageTransportPort: layout.usageTransportPort,
    sessionModelSelectionTransportPort: layout.sessionModelSelectionTransportPort,
    cronTransportPort: layout.cronTransportPort,
    cronBrokerTransportPort: layout.cronBrokerTransportPort,
    taskManagerTransportPort: layout.taskManagerTransportPort,
    agentsTransportPort: layout.agentsTransportPort,
    teamPublicTransportPort: layout.teamPublicTransportPort,
    teamTaskBoardTransportPort: layout.teamTaskBoardTransportPort,
    teamRoleSessionsTransportPort: layout.teamRoleSessionsTransportPort,
    teamApprovalsTransportPort: layout.teamApprovalsTransportPort,
    teamDecisionTransportPort: layout.teamDecisionTransportPort,
    teamRoleChatTransportPort: layout.teamRoleChatTransportPort,
    teamGraphTransportPort: layout.teamGraphTransportPort,
    providerModelsTransportPort: layout.providerModelsTransportPort,
    providerAccountsTransportPort: layout.providerAccountsTransportPort,
    teamSkillTransportPort: layout.teamSkillTransportPort,
    teamTriggerTransportPort: layout.teamTriggerTransportPort,
    teamLifecycleTransportPort: layout.teamLifecycleTransportPort,
    manualTeamTransportPort: layout.manualTeamTransportPort,
    matcha: { ...layout.matcha, gitBash: layout.gitBash },
    openClaw: layout.openClaw,
  };
}

type RuntimeLayoutInput = {
  readonly app: RuntimeHostApp;
  readonly isFile: (absolutePath: string) => boolean;
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
      | 'MATCHACLAW_SESSION_TRANSPORT'
      | 'MATCHACLAW_FLEET_TRANSPORT'
      | 'MATCHACLAW_DIAGNOSTICS_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_TEXT_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_BINARY_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_DIRECTORY_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_WRITE_TRANSPORT'
      | 'MATCHACLAW_WORKSPACE_MEDIA_TRANSPORT'
      | 'MATCHACLAW_SESSION_SEND_TRANSPORT'
      | 'MATCHACLAW_SESSION_ABORT_TRANSPORT'
      | 'MATCHACLAW_SECURITY_EMERGENCY_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_STATUS_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_CATALOG_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_CONTROL_TRANSPORT'
      | 'MATCHACLAW_CHANNEL_PAIRING_TRANSPORT'
      | 'MATCHACLAW_SETTINGS_DESIRED_TRANSPORT'
      | 'MATCHACLAW_SECURITY_POLICY_TRANSPORT'
      | 'MATCHACLAW_SESSION_APPROVAL_TRANSPORT'
      | 'MATCHACLAW_OPENCLAW_HISTORY_TRANSPORT'
      | 'MATCHACLAW_MATCHA_HISTORY_TRANSPORT'
      | 'MATCHACLAW_USAGE_TRANSPORT'
      | 'MATCHACLAW_SESSION_MODEL_SELECTION_TRANSPORT'
      | 'MATCHACLAW_CRON_TRANSPORT'
      | 'MATCHACLAW_CRON_BROKER_TRANSPORT'
      | 'MATCHACLAW_TASK_MANAGER_TRANSPORT'
      | 'MATCHACLAW_AGENTS_TRANSPORT'
      | 'MATCHACLAW_TEAM_PUBLIC_TRANSPORT'
      | 'MATCHACLAW_TEAM_TASK_BOARD_TRANSPORT'
      | 'MATCHACLAW_TEAM_ROLE_SESSIONS_TRANSPORT'
      | 'MATCHACLAW_TEAM_APPROVALS_TRANSPORT'
      | 'MATCHACLAW_TEAM_DECISION_TRANSPORT'
      | 'MATCHACLAW_TEAM_ROLE_CHAT_TRANSPORT'
      | 'MATCHACLAW_TEAM_GRAPH_TRANSPORT'
      | 'MATCHACLAW_PROVIDER_MODELS_TRANSPORT'
      | 'MATCHACLAW_PROVIDER_ACCOUNTS_TRANSPORT'
      | 'MATCHACLAW_TEAM_SKILL_TRANSPORT'
      | 'MATCHACLAW_TEAM_TRIGGER_TRANSPORT'
      | 'MATCHACLAW_TEAM_LIFECYCLE_TRANSPORT'
      | 'MATCHACLAW_MANUAL_TEAM_TRANSPORT'
      | 'MATCHA_AGENT_APP_SERVER'
      | 'OPENCLAW_GATEWAY'
  ) => number;
};

type RuntimeLayout = {
  readonly appLogDir: string;
  readonly runtimeHostStateDir: string;
  readonly sessionTransportPort: number;
  readonly fleetTransportPort: number;
  readonly diagnosticsTransportPort: number;
  readonly workspaceTextTransportPort: number;
  readonly workspaceBinaryTransportPort: number;
  readonly workspaceDirectoryTransportPort: number;
  readonly workspaceWriteTransportPort: number;
  readonly workspaceMediaTransportPort: number;
  readonly sessionSendTransportPort: number;
  readonly sessionAbortTransportPort: number;
  readonly securityEmergencyTransportPort: number;
  readonly channelStatusTransportPort: number;
  readonly channelCatalogTransportPort: number;
  readonly channelControlTransportPort: number;
  readonly channelPairingTransportPort: number;
  readonly settingsDesiredTransportPort: number;
  readonly securityPolicyTransportPort: number;
  readonly sessionApprovalTransportPort: number;
  readonly openclawHistoryTransportPort: number;
  readonly matchaHistoryTransportPort: number;
  readonly usageTransportPort: number;
  readonly sessionModelSelectionTransportPort: number;
  readonly cronTransportPort: number;
  readonly cronBrokerTransportPort: number;
  readonly taskManagerTransportPort: number;
  readonly agentsTransportPort: number;
  readonly teamPublicTransportPort: number;
  readonly teamTaskBoardTransportPort: number;
  readonly teamRoleSessionsTransportPort: number;
  readonly teamApprovalsTransportPort: number;
  readonly teamDecisionTransportPort: number;
  readonly teamRoleChatTransportPort: number;
  readonly teamGraphTransportPort: number;
  readonly providerModelsTransportPort: number;
  readonly providerAccountsTransportPort: number;
  readonly teamSkillTransportPort: number;
  readonly teamTriggerTransportPort: number;
  readonly teamLifecycleTransportPort: number;
  readonly manualTeamTransportPort: number;
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
  const bunExecutable =
    input.mode === 'packaged'
      ? input.path.join(resourcesRoot!, 'bin', bunExecutableName)
      : input.path.join(projectRoot!, 'resources', 'bin', input.target, bunExecutableName);
  const entry =
    input.mode === 'packaged'
      ? input.path.join(resourcesRoot!, 'matcha-agent', 'dist', 'cli-bun.js')
      : input.path.join(projectRoot!, 'matcha-agent', 'scripts', 'dev.ts');
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
    sessionTransportPort: input.getPort('MATCHACLAW_SESSION_TRANSPORT'),
    fleetTransportPort: input.getPort('MATCHACLAW_FLEET_TRANSPORT'),
    diagnosticsTransportPort: input.getPort('MATCHACLAW_DIAGNOSTICS_TRANSPORT'),
    workspaceTextTransportPort: input.getPort('MATCHACLAW_WORKSPACE_TEXT_TRANSPORT'),
    workspaceBinaryTransportPort: input.getPort('MATCHACLAW_WORKSPACE_BINARY_TRANSPORT'),
    workspaceDirectoryTransportPort: input.getPort('MATCHACLAW_WORKSPACE_DIRECTORY_TRANSPORT'),
    workspaceWriteTransportPort: input.getPort('MATCHACLAW_WORKSPACE_WRITE_TRANSPORT'),
    workspaceMediaTransportPort: input.getPort('MATCHACLAW_WORKSPACE_MEDIA_TRANSPORT'),
    sessionSendTransportPort: input.getPort('MATCHACLAW_SESSION_SEND_TRANSPORT'),
    sessionAbortTransportPort: input.getPort('MATCHACLAW_SESSION_ABORT_TRANSPORT'),
    securityEmergencyTransportPort: input.getPort('MATCHACLAW_SECURITY_EMERGENCY_TRANSPORT'),
    channelStatusTransportPort: input.getPort('MATCHACLAW_CHANNEL_STATUS_TRANSPORT'),
    channelCatalogTransportPort: input.getPort('MATCHACLAW_CHANNEL_CATALOG_TRANSPORT'),
    channelControlTransportPort: input.getPort('MATCHACLAW_CHANNEL_CONTROL_TRANSPORT'),
    channelPairingTransportPort: input.getPort('MATCHACLAW_CHANNEL_PAIRING_TRANSPORT'),
    settingsDesiredTransportPort: input.getPort('MATCHACLAW_SETTINGS_DESIRED_TRANSPORT'),
    securityPolicyTransportPort: input.getPort('MATCHACLAW_SECURITY_POLICY_TRANSPORT'),
    sessionApprovalTransportPort: input.getPort('MATCHACLAW_SESSION_APPROVAL_TRANSPORT'),
    openclawHistoryTransportPort: input.getPort('MATCHACLAW_OPENCLAW_HISTORY_TRANSPORT'),
    matchaHistoryTransportPort: input.getPort('MATCHACLAW_MATCHA_HISTORY_TRANSPORT'),
    usageTransportPort: input.getPort('MATCHACLAW_USAGE_TRANSPORT'),
    sessionModelSelectionTransportPort: input.getPort(
      'MATCHACLAW_SESSION_MODEL_SELECTION_TRANSPORT'
    ),
    cronTransportPort: input.getPort('MATCHACLAW_CRON_TRANSPORT'),
    cronBrokerTransportPort: input.getPort('MATCHACLAW_CRON_BROKER_TRANSPORT'),
    taskManagerTransportPort: input.getPort('MATCHACLAW_TASK_MANAGER_TRANSPORT'),
    agentsTransportPort: input.getPort('MATCHACLAW_AGENTS_TRANSPORT'),
    teamPublicTransportPort: input.getPort('MATCHACLAW_TEAM_PUBLIC_TRANSPORT'),
    teamTaskBoardTransportPort: input.getPort('MATCHACLAW_TEAM_TASK_BOARD_TRANSPORT'),
    teamRoleSessionsTransportPort: input.getPort('MATCHACLAW_TEAM_ROLE_SESSIONS_TRANSPORT'),
    teamApprovalsTransportPort: input.getPort('MATCHACLAW_TEAM_APPROVALS_TRANSPORT'),
    teamDecisionTransportPort: input.getPort('MATCHACLAW_TEAM_DECISION_TRANSPORT'),
    teamRoleChatTransportPort: input.getPort('MATCHACLAW_TEAM_ROLE_CHAT_TRANSPORT'),
    teamGraphTransportPort: input.getPort('MATCHACLAW_TEAM_GRAPH_TRANSPORT'),
    providerModelsTransportPort: input.getPort('MATCHACLAW_PROVIDER_MODELS_TRANSPORT'),
    providerAccountsTransportPort: input.getPort('MATCHACLAW_PROVIDER_ACCOUNTS_TRANSPORT'),
    teamSkillTransportPort: input.getPort('MATCHACLAW_TEAM_SKILL_TRANSPORT'),
    teamTriggerTransportPort: input.getPort('MATCHACLAW_TEAM_TRIGGER_TRANSPORT'),
    teamLifecycleTransportPort: input.getPort('MATCHACLAW_TEAM_LIFECYCLE_TRANSPORT'),
    manualTeamTransportPort: input.getPort('MATCHACLAW_MANUAL_TEAM_TRANSPORT'),
    matcha: {
      bunExecutable,
      entry,
      workingDirectory,
      storageRoot,
      port: input.getPort('MATCHA_AGENT_APP_SERVER'),
      privateSecretRoot: input.path.join(storageRoot, 'private'),
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
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}
