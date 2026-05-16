import type { BrowserWindow } from 'electron';
import type { GatewayManager } from '../gateway/manager';
import type { HostEventBus } from '../api/event-bus';
import type {
  RuntimeHostManager,
  RuntimeHostManagerHealth,
  RuntimeHostManagerState,
} from './runtime-host-manager';
import { buildPublicGatewayStatus } from '../gateway/public-status';
import { browserOAuthManager } from '../services/providers/oauth/browser-oauth-manager';
import { deviceOAuthManager } from '../services/providers/oauth/device-oauth-manager';
import { getE2EGatewayStatus } from './e2e-fixture-loader';

type HostEventName =
  | 'gateway:status'
  | 'gateway:error'
  | 'gateway:notification'
  | 'session:update'
  | 'task:snapshot'
  | 'gateway:channel-status'
  | 'gateway:exit'
  | 'runtime-host:status'
  | 'runtime-host:error'
  | 'runtime-host:restart'
  | 'runtime-job:done'
  | 'runtime-job:progress'
  | 'openclaw:cli-installed'
  | 'oauth:code'
  | 'oauth:start'
  | 'oauth:success'
  | 'oauth:error';

type EmitHostEvent = (eventName: HostEventName, payload: unknown) => void;

type RuntimeHostLifecycleStatus =
  | 'starting'
  | 'running'
  | 'restarting'
  | 'degraded'
  | 'error'
  | 'stopped';

type RuntimeHostStatusPayload = {
  status: RuntimeHostLifecycleStatus;
  hostLifecycle: RuntimeHostManagerState['lifecycle'];
  runtimeLifecycle: RuntimeHostManagerState['runtimeLifecycle'];
  activePluginCount: number;
  pid?: number;
  error?: string;
  updatedAt: number;
};

function asRuntimeHostStatus(
  state: RuntimeHostManagerState,
  health: RuntimeHostManagerHealth,
): RuntimeHostStatusPayload {
  const stopped = state.lifecycle === 'stopped' || state.runtimeLifecycle === 'stopped';
  const restarting = state.lifecycle === 'restarting' || state.runtimeLifecycle === 'restarting';
  const starting = state.lifecycle === 'starting' || state.runtimeLifecycle === 'starting';
  const hardError = state.lifecycle === 'error' || state.runtimeLifecycle === 'error';
  const running = state.lifecycle === 'running' && state.runtimeLifecycle === 'running' && health.ok;
  const degraded = !restarting && state.runtimeLifecycle === 'running' && !health.ok;

  let status: RuntimeHostLifecycleStatus = 'starting';
  if (restarting) {
    status = 'restarting';
  } else if (stopped) {
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

  const mergedError = status === 'restarting' || status === 'starting'
    ? undefined
    : (state.lastError || health.error);
  return {
    status,
    hostLifecycle: state.lifecycle,
    runtimeLifecycle: state.runtimeLifecycle,
    activePluginCount: state.activePluginCount,
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

  let previousRuntimeHostStatus: RuntimeHostLifecycleStatus | null = null;
  let previousRuntimeHostPid: number | undefined;
  let previousRuntimeHostError: string | undefined;
  let runtimeHostPollingBusy = false;

  const publishGatewaySnapshot = async () => {
    const e2eStatus = await getE2EGatewayStatus<ReturnType<typeof buildPublicGatewayStatus>>();
    if (e2eStatus) {
      emit('gateway:status', e2eStatus);
      return;
    }
    const baseStatus = deps.gatewayManager.getStatus();
    const runtimeGatewayStatus = await deps.runtimeHostManager.readGatewayStatus();
    emit('gateway:status', buildPublicGatewayStatus(baseStatus, runtimeGatewayStatus));
  };

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

  deps.gatewayManager.on('status', () => {
    void publishGatewaySnapshot();
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
    if (eventName === 'session:update') {
      emit('session:update', payload);
      return;
    }
    if (eventName === 'task:snapshot') {
      emit('task:snapshot', payload);
      return;
    }
    if (eventName === 'gateway:channel-status') {
      emit('gateway:channel-status', payload);
    }
  });

  deps.runtimeHostManager.onRuntimeJobEvent((eventName, payload) => {
    if (eventName === 'runtime-job:done' || eventName === 'runtime-job:progress') {
      emit(eventName, payload);
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

  void publishGatewaySnapshot();
  void publishRuntimeHostSnapshot();
  const runtimeHostPollTimer = setInterval(() => {
    void publishGatewaySnapshot();
    void publishRuntimeHostSnapshot();
  }, 1500);
  runtimeHostPollTimer.unref();
}
