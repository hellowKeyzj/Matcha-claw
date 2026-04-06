import type { OpenClawBridge } from '../../openclaw-bridge';
import type { RuntimeHostPlatformFacade } from '../platform/runtime-root';
import type { ParentShellAction, ParentTransportUpstreamPayload } from './parent-transport';

export interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

export interface RuntimeStateSnapshot {
  lifecycle: string;
  plugins: Array<{ lifecycle?: string } & Record<string, any>>;
}

export interface LocalBusinessDispatchContext {
  buildLocalRuntimeState: () => RuntimeStateSnapshot;
  buildLocalRuntimeHealth: (state: unknown) => unknown;
  buildTransportStatsSnapshot: () => Record<string, number>;
  buildLocalPluginsRuntimePayload: () => unknown;
  refreshPluginCatalog: () => Promise<void>;
  getPluginExecutionEnabled: () => boolean;
  getEnabledPluginIds: () => string[];
  getPluginCatalog: () => Array<Record<string, any>>;
  openclawBridge: OpenClawBridge;
  platformRuntime: RuntimeHostPlatformFacade;
  requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
}

export interface LocalBusinessDispatchRequest {
  method: string;
  route: string;
  payload: unknown;
  routePath: string;
  routeUrl: URL;
}

export type LocalBusinessHandler = (
  request: LocalBusinessDispatchRequest,
) => Promise<LocalDispatchResponse | null> | LocalDispatchResponse | null;

export type LocalBusinessHandlerKey =
  | 'workbench'
  | 'runtime_host'
  | 'cron_usage'
  | 'license'
  | 'settings'
  | 'provider'
  | 'channel'
  | 'openclaw'
  | 'skills'
  | 'task_plugin'
  | 'team_runtime'
  | 'clawhub'
  | 'toolchain_uv'
  | 'session'
  | 'plugin_runtime'
  | 'gateway'
  | 'security'
  | 'platform';

export interface LocalBusinessHandlerEntry {
  key: LocalBusinessHandlerKey;
  handle: LocalBusinessHandler;
}
