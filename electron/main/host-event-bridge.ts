import type { BrowserWindow } from 'electron';
import type { HostEventBus } from '../api/event-bus';
import type { DirectRuntimeHostExit } from './runtime-host-delivery/direct-host';
import type { RuntimeHostLifecycle } from './runtime-host-delivery/lifecycle-owner';
import {
  decodeSessionDelta,
  decodeSessionResync,
} from './runtime-host-delivery/transport/sessions/session-contract';
import {
  readGatewayStatusProjection,
  readRuntimeHostStatusProjection,
  unavailableGatewayStatus,
} from '../api/routes/app';
import type { RendererSessionObservationRegistry } from './renderer-event-routes';
import type { SessionEventsTransport } from './runtime-host-delivery/transport/sessions/events';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionChanges, summarizeSessionIdentity } from './runtime-host-delivery/transport/sessions/trace';

type HostEventName =
  | 'gateway:status'
  | 'gateway:error'
  | 'gateway:notification'
  | 'session.delta'
  | 'session.resync'
  | 'task:snapshot'
  | 'gateway:channel-status'
  | 'gateway:exit'
  | 'runtime-host:status'
  | 'runtime-host:error'
  | 'runtime-host:restart'
  | 'runtime-host:disconnected'
  | 'package:changed'
  | 'team:event'
  | 'team:changed'
  | 'matcha-agent:status'
  | 'openclaw:cli-installed'
  | 'oauth:code'
  | 'oauth:start'
  | 'oauth:success'
  | 'oauth:error'
  | 'openclaw:lifecycle'
  | 'openclaw:questions-changed'
  | 'openclaw:cron'
  | 'call:changed'
  | 'calls:resync';

type EmitHostEvent = (eventName: HostEventName, payload: unknown) => void;

type RuntimeHostBridge = Pick<
  RuntimeHostLifecycle,
  'command' | 'onDisconnect' | 'onExit' | 'onRestart' | 'onSafeEvent'
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
  sessionObservers: RendererSessionObservationRegistry;
  sessionEvents?: SessionEventsTransport;
  resyncSessions: () => Promise<void>;
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

  deps.sessionEvents?.onDelta((delta) => {
    publishSessionDelta(decodeSessionDelta(delta), deps.sessionObservers);
  });
  deps.sessionEvents?.onResync((payload) => {
    const event = decodeSessionResync(payload);
    if (event) deps.sessionObservers.publish(event.identity, 'session.resync', event);
  });
  deps.sessionEvents?.onReconnect(() => { void deps.resyncSessions(); });

  for (const eventName of [
    'gateway:error',
    'gateway:notification',
    'task:snapshot',
    'gateway:channel-status',
    'gateway:exit',
    'team:event',
    'package:changed',
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
      case 'call.changed':
        emit('call:changed', { callId: event.callId, revision: event.revision });
        return;
      case 'calls.resync':
        emit('calls:resync', {});
        return;
      case 'organization.changed':
        emit('team:changed', {});
        return;
      case 'openclaw.lifecycle':
        emit('openclaw:lifecycle', {
          active: event.hasRun || event.hasMessage || event.hasSessionActivity,
        });
        void publishRuntimeHostStatus();
        void publishGatewayStatus();
        return;
      case 'openclaw.questions.changed':
        emit('openclaw:questions-changed', {});
        return;
      case 'openclaw.runtime':
        void publishRuntimeHostStatus();
        void publishGatewayStatus({ freshness: 'fresh' });
        return;
      case 'matcha.lifecycle':
        emit('matcha-agent:status', {
          processState: event.lifecycle,
          port: null,
          pid: null,
          ready: event.ready,
          lastError: null,
          updatedAt: event.observedAtMs,
        });
        return;
      case 'openclaw.cron.execution':
        emit('openclaw:cron', {
          jobId: event.jobId,
          runId: event.runId,
          status: event.status,
        });
        return;
    }
  });
  deps.runtimeHost.onDisconnect(() => {
    emit('runtime-host:disconnected', {});
  });
  deps.runtimeHost.onExit((exit) => {
    emitHostExit(emit, exit);
  });
  deps.runtimeHost.onRestart((restart) => {
    emit('runtime-host:restart', restart);
    void deps.resyncSessions();
    void publishRuntimeHostStatus();
    void publishGatewayStatus();
  });
  void publishRuntimeHostStatus();
  void publishGatewayStatus();
}


function publishSessionDelta(
  delta: ReturnType<typeof decodeSessionDelta>,
  observers: RendererSessionObservationRegistry,
): void {
  if (!delta) return;
  if (isSessionTraceEnabled()) logSessionTrace('electron.session.delta.publish', 'session-delta-boundary', {
    identity: summarizeSessionIdentity(delta.identity),
    sessionKey: summarizeIdentifier(delta.sessionKey),
    runId: summarizeIdentifier(sessionDeltaRunId(delta)),
    epoch: delta.epoch,
    seq: delta.seq,
    cursor: delta.cursor,
    changeKinds: delta.changes.map((change) => change.kind),
    changeCount: delta.changes.length,
    textLength: sessionDeltaTextLength(delta.changes),
    mappedChanges: summarizeSessionChanges(delta.changes),
  });
  observers.publish(delta.identity, 'session.delta', delta);
  observers.terminal(delta);
}

function sessionDeltaTextLength(changes: readonly unknown[]): number {
  return changes.reduce<number>((total, change) => {
    if (!isRecord(change)) return total;
    if (change.kind === 'messageDelta') return total + publicTextLength(change.text);
    if (change.kind === 'itemsReplaced' && Array.isArray(change.items)) {
      return total + change.items.reduce<number>((length, item) => length + sessionItemTextLength(item), 0);
    }
    if (change.kind !== 'messageUpdated' && change.kind !== 'messageReplaced') return total;
    return total + sessionItemTextLength(change.item);
  }, 0);
}

function sessionItemTextLength(item: unknown): number {
  if (!isRecord(item)) return 0;
  if (item.kind === 'userMessage') return itemTextOrSegmentsLength(item, 'content');
  if (item.kind === 'assistantTurn') return itemTextOrSegmentsLength(item, 'segments');
  if (item.kind === 'system') return publicTextLength(item.text);
  return 0;
}

function itemTextOrSegmentsLength(
  item: Record<string, unknown>,
  segmentsKey: 'content' | 'segments',
): number {
  const segmentsLength = publicSegmentsTextLength(item[segmentsKey]);
  return segmentsLength > 0 ? segmentsLength : publicTextLength(item.text);
}

function publicSegmentsTextLength(segments: unknown): number {
  if (!Array.isArray(segments)) return 0;
  return segments.reduce((total, segment) => {
    if (!isRecord(segment)) return total;
    if (segment.kind !== 'text' && segment.kind !== 'thinking' && segment.kind !== 'largeText') return total;
    return total + publicTextLength(segment.text);
  }, 0);
}

function publicTextLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionDeltaRunId(delta: ReturnType<typeof decodeSessionDelta>): string | undefined {
  if (delta?.runId) return delta.runId;
  for (const change of delta?.changes ?? []) {
    if ('runId' in change && typeof change.runId === 'string') return change.runId;
  }
  return undefined;
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
