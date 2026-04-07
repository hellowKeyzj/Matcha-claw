import type { BrowserWindow } from 'electron';
import type { GatewayManager } from '../gateway/manager';
import type { HostEventBus } from './event-bus';
import type { RuntimeHostManager } from '../main/runtime-host-manager';

export interface HostApiContext {
  gatewayManager: GatewayManager;
  eventBus: HostEventBus;
  mainWindow: BrowserWindow | null;
  runtimeHost: RuntimeHostManager;
}

export type RuntimeHostApiContext = Pick<HostApiContext, 'runtimeHost'>;
export type PluginApiContext = Pick<HostApiContext, 'runtimeHost' | 'gatewayManager'>;

export type GatewayApiContext = Pick<HostApiContext, 'gatewayManager' | 'runtimeHost'>;

export type GatewayControlApiContext = Pick<HostApiContext, 'gatewayManager'>;

export type DiagnosticsApiContext = Pick<HostApiContext, 'gatewayManager' | 'runtimeHost'>;

export type AppApiContext = Pick<HostApiContext, 'eventBus' | 'gatewayManager'>;

export type LogApiContext = {};

export type FileApiContext = {};

