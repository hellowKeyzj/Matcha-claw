import type { CallDetailByModule, CallModule } from '../call-log';
import { decodeChannelsCallDetail } from './channels';
import { decodeConnectorsCallDetail } from './connectors';
import { decodeCronCallDetail } from './cron';
import { decodeDiagnosticsCallDetail } from './diagnostics';
import { decodeFleetCallDetail } from './fleet';
import { decodeGatewayCallDetail } from './openclaw-gateway';
import { decodePlatformCallDetail } from './openclaw-platform';
import { decodeOrganizationCallDetail } from './organization';
import { decodePlatformToolsCallDetail } from './platform-tools';
import { decodePluginsCallDetail } from './plugins';
import { decodeProviderCallDetail } from './provider';
import { decodeRuntimeControlCallDetail, decodeRuntimeDirectoryCallDetail } from './runtime-directory';
import { decodeSealedResourceCallDetail } from './sealed-resource';
import { decodeSecurityCallDetail } from './security';
import { decodeSessionsCallDetail } from './sessions';
import { decodeSettingsCallDetail } from './settings';
import { decodeSkillsCallDetail } from './skills';
import { decodeSubagentsCallDetail } from './subagents';
import { decodeTaskManagerCallDetail } from './task-manager';
import { decodeToolchainCallDetail } from './toolchain';
import { decodeUsageCallDetail } from './usage';
import { decodeWorkspaceCallDetail } from './workspace';
import { decodeWikiCallDetail } from './wiki';

export const callDetailDecoders = {
  channels: decodeChannelsCallDetail,
  connectors: decodeConnectorsCallDetail,
  cron: decodeCronCallDetail,
  diagnostics: decodeDiagnosticsCallDetail,
  fleet: decodeFleetCallDetail,
  'openclaw-gateway': decodeGatewayCallDetail,
  'openclaw-platform': decodePlatformCallDetail,
  organization: decodeOrganizationCallDetail,
  'platform-tools': decodePlatformToolsCallDetail,
  plugins: decodePluginsCallDetail,
  provider: decodeProviderCallDetail,
  'runtime-control': decodeRuntimeControlCallDetail,
  'runtime-directory': decodeRuntimeDirectoryCallDetail,
  'sealed-resource': decodeSealedResourceCallDetail,
  security: decodeSecurityCallDetail,
  sessions: decodeSessionsCallDetail,
  settings: decodeSettingsCallDetail,
  skills: decodeSkillsCallDetail,
  subagents: decodeSubagentsCallDetail,
  'task-manager': decodeTaskManagerCallDetail,
  toolchain: decodeToolchainCallDetail,
  usage: decodeUsageCallDetail,
  workspace: decodeWorkspaceCallDetail,
  wiki: decodeWikiCallDetail,
} satisfies { [M in CallModule]: (value: unknown) => CallDetailByModule[M] | null | undefined };

export const callModules = Object.keys(callDetailDecoders) as CallModule[];

export function isCallModule(value: unknown): value is CallModule {
  return typeof value === 'string' && Object.hasOwn(callDetailDecoders, value);
}

export function decodeCallDetail<M extends CallModule>(module: M, value: unknown): CallDetailByModule[M] | undefined {
  if (!isCallModule(module)) return undefined;
  try {
    return callDetailDecoders[module](value) as CallDetailByModule[M] | null | undefined ?? undefined;
  } catch {
    return undefined;
  }
}
