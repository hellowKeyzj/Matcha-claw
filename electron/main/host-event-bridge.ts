import type { BrowserWindow } from 'electron';
import type { HostEventBus } from '../api/event-bus';
import type { DirectRuntimeHostExit } from './runtime-host-delivery/direct-host';
import type { RuntimeHostLifecycle } from './runtime-host-delivery/lifecycle-owner';
import {
  decodeLegacySessionUpdateDelta,
  decodeSessionDelta,
} from './runtime-host-delivery/transport/sessions/session-contract';
import {
  readGatewayStatusProjection,
  readRuntimeHostStatusProjection,
  unavailableGatewayStatus,
} from '../api/routes/app';
import type { RendererEventRouteRegistry } from './renderer-event-routes';

type HostEventName =
  | 'gateway:status'
  | 'gateway:error'
  | 'gateway:notification'
  | 'session:update'
  | 'session.delta'
  | 'task:snapshot'
  | 'gateway:channel-status'
  | 'gateway:exit'
  | 'runtime-host:status'
  | 'runtime-host:error'
  | 'runtime-host:restart'
  | 'runtime-job:done'
  | 'runtime-job:progress'
  | 'license:gate-changed'
  | 'team:event'
  | 'openclaw:cli-installed'
  | 'oauth:code'
  | 'oauth:start'
  | 'oauth:success'
  | 'oauth:error'
  | 'openclaw:lifecycle'
  | 'openclaw:cron';

type EmitHostEvent = (eventName: HostEventName, payload: unknown) => void;

type RuntimeHostBridge = Pick<
  RuntimeHostLifecycle,
  'command' | 'onExit' | 'onRestart' | 'onSafeEvent'
>;

export function emitHostEvent(
  eventBus: HostEventBus,
  mainWindow: BrowserWindow | null,
  eventName: HostEventName,
  payload: unknown,
): void {
  eventBus.emit(eventName, payload);
  sendRendererHostEvent(mainWindow, eventName, payload);
}

function sendRendererHostEvent(
  mainWindow: BrowserWindow | null,
  eventName: HostEventName,
  payload: unknown,
): void {
  mainWindow?.webContents.send('host:event', { eventName, payload });
}

export function registerHostEventBridge(deps: {
  runtimeHost: RuntimeHostBridge;
  hostEventBus: HostEventBus;
  getMainWindow: () => BrowserWindow | null;
  rendererEventRoutes: Pick<RendererEventRouteRegistry, 'matchesSession' | 'release'>;
}): void {
  const emit: EmitHostEvent = (eventName, payload) => {
    emitHostEvent(deps.hostEventBus, deps.getMainWindow(), eventName, payload);
  };

  const publishRuntimeHostStatus = async (): Promise<void> => {
    const status = await readRuntimeHostStatusProjection(deps.runtimeHost);
    if (status) {
      emit('runtime-host:status', status);
      return;
    }
    emit('runtime-host:error', { status: 'error', message: 'Runtime Host is unavailable.' });
  };

  const publishGatewayStatus = async (
    options: { readonly freshness?: 'reuse-pending' | 'fresh' } = {},
  ): Promise<void> => {
    const status = await readGatewayStatusProjection(deps.runtimeHost, options)
      .then((projection) => projection ?? unavailableGatewayStatus());
    emit('gateway:status', status);
  };

  deps.hostEventBus.on('session:update', (payload) => {
    publishSessionDelta(decodeLegacySessionUpdateDelta(payload), emit, deps.rendererEventRoutes);
  });

  for (const eventName of [
    'gateway:error',
    'gateway:notification',
    'task:snapshot',
    'gateway:channel-status',
    'gateway:exit',
    'team:event',
    'runtime-job:done',
    'runtime-job:progress',
  ] as const) {
    deps.hostEventBus.on(eventName, (payload) => {
      sendRendererHostEvent(deps.getMainWindow(), eventName, payload);
    });
  }

  deps.hostEventBus.on('gateway:lifecycle', () => {
    void publishGatewayStatus();
  });

  deps.runtimeHost.onSafeEvent((event) => {
    switch (event.type) {
      case 'openclaw.lifecycle':
        emit('openclaw:lifecycle', {
          active: event.hasRun || event.hasMessage || event.hasSessionActivity,
        });
        void publishRuntimeHostStatus();
        void publishGatewayStatus();
        return;
      case 'openclaw.runtime':
        void publishRuntimeHostStatus();
        void publishGatewayStatus({ freshness: 'fresh' });
        return;
      case 'openclaw.cron.execution':
        emit('openclaw:cron', {
          jobId: event.jobId,
          runId: event.runId,
          status: event.status,
        });
        return;
      case 'matcha.session.activity':
      case 'openclaw.session.activity':
      case 'openclaw.session.update':
        return;
      case 'session.delta':
        publishSessionDelta(decodeSessionDelta(event.delta), emit, deps.rendererEventRoutes);
        return;
    }
  });
  deps.runtimeHost.onExit((exit) => {
    emitHostExit(emit, exit);
  });
  deps.runtimeHost.onRestart((restart) => {
    emit('runtime-host:restart', restart);
    void publishRuntimeHostStatus();
    void publishGatewayStatus();
  });
  void publishRuntimeHostStatus();
  void publishGatewayStatus();
}


function publishSessionDelta(
  delta: ReturnType<typeof decodeSessionDelta>,
  emit: EmitHostEvent,
  routes: Pick<RendererEventRouteRegistry, 'matchesSession' | 'release'>,
): void {
  if (!delta || delta.routeKey === undefined || !isBoundSessionDelta(delta, routes)) return;
  emit('session.delta', delta);
  if (delta.changes.some((change) => change.kind === 'runPhaseChanged'
    && isTerminalRunPhase(change.phase))) {
    routes.release(delta.routeKey);
  }
}

function isBoundSessionDelta(
  delta: { readonly sessionKey: string; readonly routeKey?: string },
  routes: Pick<RendererEventRouteRegistry, 'matchesSession'>,
): boolean {
  // The live wire carries only sessionKey/routeKey; matchesSession is the strongest
  // binding proof available without fabricating endpoint or agent identity.
  return delta.routeKey !== undefined && routes.matchesSession(delta.routeKey, delta.sessionKey);
}

function isTerminalRunPhase(phase: unknown): boolean {
  return phase === 'cancelled'
    || phase === 'completed'
    || phase === 'failed'
    || phase === 'interrupted';
}

function emitHostExit(emit: EmitHostEvent, exit: DirectRuntimeHostExit): void {
  if (exit.kind === 'exited' && exit.code === 0 && exit.signal === null) {
    emit('runtime-host:status', {
      status: 'stopped',
      hostLifecycle: 'shutDown',
      runtimeLifecycle: 'shutDown',
      updatedAt: Date.now(),
    });
    return;
  }
  emit('runtime-host:error', { message: 'Runtime Host is unavailable.' });
}
