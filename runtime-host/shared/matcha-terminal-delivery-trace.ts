import type { RuntimeHostLogger } from './logger';
import type { SessionUpdateEvent } from './session-adapter-types';

export type MatchaTerminalDeliveryPhase = 'final' | 'error' | 'aborted';
export type MatchaTerminalDeliveryEventClass = 'terminal' | 'lifecycle' | 'non_terminal';

export interface MatchaTerminalDeliveryTraceCorrelation {
  readonly bridgeTraceId: string;
  readonly runTraceId: string | null;
  readonly eventClass: MatchaTerminalDeliveryEventClass;
  readonly terminalPhase: MatchaTerminalDeliveryPhase | null;
}

export interface MatchaTerminalDeliveryTraceContext extends MatchaTerminalDeliveryTraceCorrelation {
  readonly eventClass: 'terminal';
  readonly terminalPhase: MatchaTerminalDeliveryPhase;
}

export type MatchaTerminalDeliveryTraceStage =
  | 'bridge_received'
  | 'bridge_duplicate'
  | 'bridge_gap_buffered'
  | 'bridge_consume_resolved'
  | 'bridge_consume_rejected'
  | 'bridge_checkpoint_advanced'
  | 'ingress_resolved'
  | 'ingress_rejected'
  | 'canonical_terminal_applied'
  | 'session_update_emit_started'
  | 'session_update_emit_resolved'
  | 'session_update_emit_rejected'
  | 'renderer_event_rejected_shape'
  | 'renderer_event_received'
  | 'renderer_event_applied'
  | 'renderer_event_rejected';

export type MatchaTerminalDeliveryTraceRecord = {
  readonly stage: MatchaTerminalDeliveryTraceStage;
  readonly bridgeTraceId: string;
  readonly runTraceId: string | null;
  readonly eventClass: MatchaTerminalDeliveryEventClass;
  readonly terminalPhase: MatchaTerminalDeliveryPhase | null;
  readonly receivedSeq?: number | null;
  readonly expectedSeq?: number | null;
  readonly checkpointSeq?: number | null;
  readonly pendingCount?: number;
  readonly errorCategory?: 'error' | 'non_error';
};

export type MatchaTerminalDeliveryTrace = (record: MatchaTerminalDeliveryTraceRecord) => void;

const MATCHA_TERMINAL_DELIVERY_META_KEY = 'matchaTerminalDelivery';
const MATCHA_TERMINAL_DELIVERY_TRACE_LEVEL = 4;
const BRIDGE_TRACE_ID_PATTERN = /^matcha-bridge-[1-9]\d*$/;
const RUN_TRACE_ID_PATTERN = /^matcha-run-[1-9]\d*$/;

export function createMatchaTerminalDeliveryTraceLogger(
  logger: Pick<RuntimeHostLogger, 'traceDebug'>,
): MatchaTerminalDeliveryTrace {
  return (record) => {
    logger.traceDebug?.(MATCHA_TERMINAL_DELIVERY_TRACE_LEVEL, '[matcha-terminal-delivery]', record);
  };
}

export function createMatchaTerminalDeliveryTraceCorrelationFactory(): MatchaTerminalDeliveryTraceCorrelationFactory {
  return new MatchaTerminalDeliveryTraceCorrelationFactory();
}

export class MatchaTerminalDeliveryTraceCorrelationFactory {
  private nextBridgeTraceId = 1;
  private nextRunTraceId = 1;

  createBridgeTraceId(): string {
    const bridgeTraceId = `matcha-bridge-${this.nextBridgeTraceId}`;
    this.nextBridgeTraceId += 1;
    return bridgeTraceId;
  }

  readCorrelation(value: unknown, bridgeTraceId: string): MatchaTerminalDeliveryTraceCorrelation {
    const record = asRecord(value);
    const event = asRecord(record?.event);
    const eventType = typeof event?.type === 'string' ? event.type : '';
    return this.createCorrelation({
      bridgeTraceId,
      eventType,
      terminalPhase: terminalPhaseForEventType(eventType),
    });
  }

  createCorrelation(input: {
    bridgeTraceId: string;
    eventType: string;
    terminalPhase?: MatchaTerminalDeliveryPhase | null;
  }): MatchaTerminalDeliveryTraceCorrelation {
    const terminalPhase = input.terminalPhase ?? terminalPhaseForEventType(input.eventType);
    const eventClass = terminalPhase ? 'terminal' : input.eventType.startsWith('run.') ? 'lifecycle' : 'non_terminal';
    return {
      bridgeTraceId: input.bridgeTraceId,
      runTraceId: eventClass === 'terminal' ? this.createRunTraceId() : null,
      eventClass,
      terminalPhase,
    };
  }

  private createRunTraceId(): string {
    const runTraceId = `matcha-run-${this.nextRunTraceId}`;
    this.nextRunTraceId += 1;
    return runTraceId;
  }
}

export function readMatchaTerminalDeliveryTraceContext(value: unknown): MatchaTerminalDeliveryTraceContext | null {
  const event = asRecord(value);
  if (!event) {
    return null;
  }
  if (
    event.sessionUpdate !== undefined
    && (
      event.sessionUpdate !== 'session_info_update'
      || !isMatchaTerminalDeliveryPhase(event.phase)
    )
  ) {
    return null;
  }
  const phase = event.sessionUpdate === 'session_info_update' ? event.phase : null;
  const trace = asRecord(asRecord(event._meta)?.[MATCHA_TERMINAL_DELIVERY_META_KEY]);
  if (
    !trace
    || trace.eventClass !== 'terminal'
    || !isMatchaTerminalDeliveryPhase(trace.terminalPhase)
    || (phase !== null && trace.terminalPhase !== phase)
    || !isBridgeTraceId(trace.bridgeTraceId)
    || !isRunTraceId(trace.runTraceId)
  ) {
    return null;
  }
  return {
    bridgeTraceId: trace.bridgeTraceId,
    runTraceId: trace.runTraceId,
    eventClass: 'terminal',
    terminalPhase: trace.terminalPhase,
  };
}

export function attachMatchaTerminalDeliveryTraceToEnvelope(
  eventEnvelope: unknown,
  trace: MatchaTerminalDeliveryTraceContext,
): unknown {
  const event = asRecord(eventEnvelope);
  if (!event) {
    return eventEnvelope;
  }
  return {
    ...event,
    _meta: {
      ...(asRecord(event._meta) ?? {}),
      [MATCHA_TERMINAL_DELIVERY_META_KEY]: trace,
    },
  };
}

export function attachMatchaTerminalDeliveryTrace(
  event: SessionUpdateEvent,
  trace: MatchaTerminalDeliveryTraceContext,
): SessionUpdateEvent {
  if (
    event.sessionUpdate !== 'session_info_update'
    || event.phase !== trace.terminalPhase
  ) {
    return event;
  }
  return {
    ...event,
    _meta: {
      ...(asRecord(event._meta) ?? {}),
      [MATCHA_TERMINAL_DELIVERY_META_KEY]: trace,
    },
  };
}

export function isMatchaTerminalDeliveryPhase(value: unknown): value is MatchaTerminalDeliveryPhase {
  return value === 'final' || value === 'error' || value === 'aborted';
}

function terminalPhaseForEventType(eventType: string): MatchaTerminalDeliveryPhase | null {
  if (eventType === 'run.completed') {
    return 'final';
  }
  if (eventType === 'run.failed') {
    return 'error';
  }
  if (eventType === 'run.cancelled' || eventType === 'run.interrupted') {
    return 'aborted';
  }
  return null;
}

function isBridgeTraceId(value: unknown): value is string {
  return typeof value === 'string' && BRIDGE_TRACE_ID_PATTERN.test(value);
}

function isRunTraceId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && RUN_TRACE_ID_PATTERN.test(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
