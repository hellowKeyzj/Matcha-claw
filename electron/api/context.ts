import type { BrowserWindow } from 'electron';
import type { GatewayManager } from '../main/process-runtime/openclaw-gateway/manager';
import type { HostEventBus } from './event-bus';
import type { RuntimeHostManager } from '../main/runtime-host-manager';
import type { MatchaAgentAppServerProcessManager } from '../main/process-runtime/matcha-agent-app-server-process-manager';

export interface HostApiContext {
  gatewayManager: GatewayManager;
  eventBus: HostEventBus;
  mainWindow: BrowserWindow | null;
  runtimeHost: RuntimeHostManager;
  matchaAgentAppServerManager: MatchaAgentAppServerProcessManager;
}

export type RuntimeHostApiContext = Pick<HostApiContext, 'runtimeHost'>;

export type GatewayApiContext = Pick<HostApiContext, 'gatewayManager' | 'runtimeHost'>;

export type GatewayControlApiContext = Pick<HostApiContext, 'gatewayManager'>;

export type DiagnosticsApiContext = Pick<HostApiContext, 'gatewayManager' | 'runtimeHost'>;

export type AppApiContext = Pick<HostApiContext, 'eventBus' | 'gatewayManager' | 'runtimeHost'>;

export type MatchaAgentAppServerApiContext = Pick<HostApiContext, 'matchaAgentAppServerManager'>;

export type LogApiContext = {};

export type FileApiContext = {};
