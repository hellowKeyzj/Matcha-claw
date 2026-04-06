import type { BrowserWindow } from 'electron';
import type { GatewayManager } from '../gateway/manager';
import type { GatewayStatus } from '../gateway/manager';
import type { HostEventBus } from '../api/event-bus';
import type {
  RuntimeHostManager,
  RuntimeHostManagerHealth,
  RuntimeHostManagerState,
} from './runtime-host-manager';
import { browserOAuthManager } from '../services/providers/oauth/browser-oauth-manager';
import { deviceOAuthManager } from '../services/providers/oauth/device-oauth-manager';
import { whatsAppLoginManager } from '../services/channels/whatsapp-login-manager';
import { weixinLoginManager } from '../services/channels/weixin-login-manager';

type HostEventName =
  | 'gateway:status'
  | 'gateway:error'
  | 'gateway:connection'
  | 'gateway:notification'
  | 'gateway:chat-message'
  | 'gateway:channel-status'
  | 'gateway:exit'
  | 'runtime-host:status'
  | 'runtime-host:error'
  | 'runtime-host:restart'
  | 'oauth:code'
  | 'oauth:start'
  | 'oauth:success'
  | 'oauth:error'
  | 'channel:whatsapp-qr'
  | 'channel:whatsapp-success'
  | 'channel:whatsapp-error'
  | 'channel:weixin-qr'
  | 'channel:weixin-success'
  | 'channel:weixin-error';

type EmitHostEvent = (eventName: HostEventName, payload: unknown) => void;

type RuntimeHostLifecycleStatus =
  | 'starting'
  | 'running'
  | 'degraded'
  | 'error'
  | 'stopped';

type RuntimeHostStatusPayload = {
  status: RuntimeHostLifecycleStatus;
  hostLifecycle: RuntimeHostManagerState['lifecycle'];
  runtimeLifecycle: RuntimeHostManagerState['runtimeLifecycle'];
  activePluginCount: number;
  pluginExecutionEnabled: boolean;
  enabledPluginIds: readonly string[];
  pid?: number;
  error?: string;
  updatedAt: number;
};

function asRuntimeHostStatus(
  state: RuntimeHostManagerState,
  health: RuntimeHostManagerHealth,
): RuntimeHostStatusPayload {
  const stopped = state.lifecycle === 'stopped' || state.runtimeLifecycle === 'stopped';
  const starting = state.lifecycle === 'starting' || state.runtimeLifecycle === 'booting';
  const hardError = state.lifecycle === 'error' || state.runtimeLifecycle === 'error';
  const running = state.lifecycle === 'running' && state.runtimeLifecycle === 'running' && health.ok;
  const degraded = state.runtimeLifecycle === 'running' && !health.ok;

  let status: RuntimeHostLifecycleStatus = 'starting';
  if (stopped) {
    status = 'stopped';
  } else if (hardError) {
    status = 'error';
  } else if (running) {
    status = 'running';
  } else if (degraded) {
    status = 'degraded';
  } else if (starting) {
    status = 'starting';
  }

  const mergedError = state.lastError || health.error;
  return {
    status,
    hostLifecycle: state.lifecycle,
    runtimeLifecycle: state.runtimeLifecycle,
    activePluginCount: state.activePluginCount,
    pluginExecutionEnabled: state.pluginExecutionEnabled,
    enabledPluginIds: state.enabledPluginIds,
    ...(typeof state.pid === 'number' ? { pid: state.pid } : {}),
    ...(typeof mergedError === 'string' && mergedError.trim() ? { error: mergedError } : {}),
    updatedAt: Date.now(),
  };
}

export function emitHostEvent(
  eventBus: HostEventBus,
  mainWindow: BrowserWindow | null,
  eventName: HostEventName,
  payload: unknown,
): void {
  eventBus.emit(eventName, payload);
  mainWindow?.webContents.send('host:event', { eventName, payload });
}

export function registerHostEventBridge(deps: {
  gatewayManager: GatewayManager;
  runtimeHostManager: RuntimeHostManager;
  hostEventBus: HostEventBus;
  getMainWindow: () => BrowserWindow | null;
}): void {
  const emit: EmitHostEvent = (eventName, payload) => {
    emitHostEvent(deps.hostEventBus, deps.getMainWindow(), eventName, payload);
  };

  let previousGatewayState: GatewayStatus['state'] = deps.gatewayManager.getStatus().state;
  let previousRuntimeHostStatus: RuntimeHostLifecycleStatus | null = null;
  let previousRuntimeHostPid: number | undefined;
  let previousRuntimeHostError: string | undefined;
  let runtimeHostPollingBusy = false;

  const publishRuntimeHostSnapshot = async () => {
    if (runtimeHostPollingBusy) {
      return;
    }
    runtimeHostPollingBusy = true;
    try {
      const state = deps.runtimeHostManager.getState();
      const health = await deps.runtimeHostManager.checkHealth();
      const payload = asRuntimeHostStatus(state, health);
      const statusChanged = previousRuntimeHostStatus !== payload.status;
      const pidChanged = previousRuntimeHostPid !== payload.pid;
      const errorChanged = previousRuntimeHostError !== payload.error;
      const shouldEmitStatus = statusChanged || pidChanged || errorChanged;

      if (shouldEmitStatus) {
        emit('runtime-host:status', payload);
      }

      if (
        previousRuntimeHostPid
        && payload.pid
        && previousRuntimeHostPid !== payload.pid
        && payload.status === 'running'
      ) {
        emit('runtime-host:restart', {
          previousPid: previousRuntimeHostPid,
          pid: payload.pid,
          status: payload.status,
          recoveredAt: payload.updatedAt,
        });
      }

      if (
        (payload.status === 'degraded' || payload.status === 'error')
        && payload.error
        && (errorChanged || statusChanged)
      ) {
        emit('runtime-host:error', {
          status: payload.status,
          message: payload.error,
          pid: payload.pid,
          updatedAt: payload.updatedAt,
        });
      }

      previousRuntimeHostStatus = payload.status;
      previousRuntimeHostPid = payload.pid;
      previousRuntimeHostError = payload.error;
    } finally {
      runtimeHostPollingBusy = false;
    }
  };

  deps.gatewayManager.on('status', (status: GatewayStatus) => {
    emit('gateway:status', status);
    const transitionedToRunning = status.state === 'running' && previousGatewayState !== 'running';
    previousGatewayState = status.state;
    if (transitionedToRunning) {
      void deps.runtimeHostManager.syncSecurityPolicyToGatewayIfRunning();
    }
  });

  deps.gatewayManager.on('error', (error) => {
    emit('gateway:error', { message: error.message });
  });

  deps.gatewayManager.on('exit', (code) => {
    emit('gateway:exit', { code });
  });

  deps.runtimeHostManager.onGatewayEvent((eventName, payload) => {
    if (eventName === 'gateway:error') {
      emit('gateway:error', payload);
      return;
    }
    if (eventName === 'gateway:notification') {
      emit('gateway:notification', payload);
      return;
    }
    if (eventName === 'gateway:connection') {
      emit('gateway:connection', payload);
      return;
    }
    if (eventName === 'gateway:chat-message') {
      emit('gateway:chat-message', payload);
      return;
    }
    if (eventName === 'gateway:channel-status') {
      emit('gateway:channel-status', payload);
    }
  });

  deviceOAuthManager.on('oauth:start', (payload) => {
    emit('oauth:start', payload);
  });

  deviceOAuthManager.on('oauth:code', (payload) => {
    emit('oauth:code', payload);
  });

  deviceOAuthManager.on('oauth:success', (payload) => {
    emit('oauth:success', { ...payload, success: true });
  });

  deviceOAuthManager.on('oauth:error', (error) => {
    emit('oauth:error', error);
  });

  browserOAuthManager.on('oauth:start', (payload) => {
    emit('oauth:start', payload);
  });

  browserOAuthManager.on('oauth:code', (payload) => {
    emit('oauth:code', payload);
  });

  browserOAuthManager.on('oauth:success', (payload) => {
    emit('oauth:success', { ...payload, success: true });
  });

  browserOAuthManager.on('oauth:error', (error) => {
    emit('oauth:error', error);
  });

  whatsAppLoginManager.on('qr', (data) => {
    emit('channel:whatsapp-qr', data);
  });

  whatsAppLoginManager.on('success', (data) => {
    emit('channel:whatsapp-success', data);
  });

  whatsAppLoginManager.on('error', (error) => {
    emit('channel:whatsapp-error', error);
  });

  weixinLoginManager.on('qr', (data) => {
    emit('channel:weixin-qr', data);
  });

  weixinLoginManager.on('success', (data) => {
    emit('channel:weixin-success', data);
  });

  weixinLoginManager.on('error', (error) => {
    emit('channel:weixin-error', error);
  });

  void publishRuntimeHostSnapshot();
  const runtimeHostPollTimer = setInterval(() => {
    void publishRuntimeHostSnapshot();
  }, 1500);
  runtimeHostPollTimer.unref();
}
