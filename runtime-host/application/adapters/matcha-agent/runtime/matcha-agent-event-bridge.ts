import { MatchaAgentAppServerClient } from './matcha-agent-app-server-client';
import type { MatchaAgentSessionCheckpointStore } from './matcha-agent-session-checkpoint-store';
import {
  attachMatchaTerminalDeliveryTraceToEnvelope,
  createMatchaTerminalDeliveryTraceCorrelationFactory,
  type MatchaTerminalDeliveryTrace,
  type MatchaTerminalDeliveryTraceContext,
  type MatchaTerminalDeliveryTraceCorrelation,
} from '../../../../shared/matcha-terminal-delivery-trace';

export type MatchaAgentEventEnvelopeConsumer = (eventEnvelope: unknown) => void | Promise<void>;

type PendingSessionEvent = {
  eventEnvelope: unknown;
  correlation: MatchaTerminalDeliveryTraceCorrelation;
};

type SessionEventCheckpoint = {
  lastContiguousSeq: number;
  pendingBySeq: Map<number, PendingSessionEvent>;
};

export class MatchaAgentEventBridge {
  private unsubscribeEvents: (() => void) | null = null;
  private consumeTail: Promise<void> = Promise.resolve();
  private readonly checkpointsBySessionId = new Map<string, SessionEventCheckpoint>();
  private readonly bridgeTraceId: string;

  constructor(
    private readonly client: MatchaAgentAppServerClient,
    private readonly checkpoints: MatchaAgentSessionCheckpointStore,
    private readonly trace?: MatchaTerminalDeliveryTrace,
    private readonly traceCorrelations = createMatchaTerminalDeliveryTraceCorrelationFactory(),
  ) {
    this.bridgeTraceId = this.traceCorrelations.createBridgeTraceId();
  }

  async start(input: {
    sessionId: string;
    consume: MatchaAgentEventEnvelopeConsumer;
  }): Promise<void> {
    const afterSeq = await this.checkpoints.readLastSeq(input.sessionId);
    const bufferedLiveEvents: unknown[] = [];
    let isConsumingSubscriptionReplay = true;
    this.unsubscribeEvents = this.client.onEvent((eventEnvelope) => {
      if (isConsumingSubscriptionReplay) {
        bufferedLiveEvents.push(eventEnvelope);
        return;
      }
      this.enqueueEnvelope(input.sessionId, eventEnvelope, input.consume);
    });

    const subscribeResult = await this.client.request('events.subscribe', {
      sessionId: input.sessionId,
      ...(afterSeq !== null ? { afterSeq } : {}),
    });
    await this.consumeReplayResult(input.sessionId, subscribeResult, input.consume);
    await this.consumeBufferedLiveEvents(input.sessionId, bufferedLiveEvents, input.consume);
    isConsumingSubscriptionReplay = false;
  }

  stop(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  private async consumeBufferedLiveEvents(
    sessionId: string,
    events: unknown[],
    consume: MatchaAgentEventEnvelopeConsumer,
  ): Promise<void> {
    for (const eventEnvelope of events) {
      await this.consumeEnvelope(sessionId, eventEnvelope, consume);
    }
  }

  private async consumeReplayResult(
    sessionId: string,
    result: unknown,
    consume: MatchaAgentEventEnvelopeConsumer,
  ): Promise<void> {
    const record = asRecord(result);
    const events = Array.isArray(record?.events)
      ? record.events
      : Array.isArray(record?.replayed)
        ? record.replayed
        : [];
    for (const eventEnvelope of events) {
      await this.consumeEnvelope(sessionId, eventEnvelope, consume);
    }
  }

  private enqueueEnvelope(
    sessionId: string,
    eventEnvelope: unknown,
    consume: MatchaAgentEventEnvelopeConsumer,
  ): void {
    this.consumeTail = this.consumeTail
      .then(() => this.consumeEnvelope(sessionId, eventEnvelope, consume))
      .catch(() => undefined);
  }

  private async consumeEnvelope(
    sessionId: string,
    eventEnvelope: unknown,
    consume: MatchaAgentEventEnvelopeConsumer,
  ): Promise<void> {
    const record = asRecord(eventEnvelope);
    if (record?.sessionId !== sessionId) return;

    const correlation = this.traceCorrelations.readCorrelation(eventEnvelope, this.bridgeTraceId);
    const seq = readSeq(record);
    this.emitTrace('bridge_received', correlation, {
      receivedSeq: seq,
    });
    if (seq === null) {
      try {
        await consume(this.attachTerminalTrace(eventEnvelope, correlation));
        this.emitTrace('bridge_consume_resolved', correlation, {
          receivedSeq: null,
        });
      } catch (error) {
        this.emitTrace('bridge_consume_rejected', correlation, {
          receivedSeq: null,
          errorCategory: error instanceof Error ? 'error' : 'non_error',
        });
        throw error;
      }
      return;
    }

    const checkpoint = await this.readCheckpoint(sessionId);
    const expectedSeq = checkpoint.lastContiguousSeq + 1;
    if (seq <= checkpoint.lastContiguousSeq || checkpoint.pendingBySeq.has(seq)) {
      this.emitTrace('bridge_duplicate', correlation, {
        receivedSeq: seq,
        expectedSeq,
        checkpointSeq: checkpoint.lastContiguousSeq,
        pendingCount: checkpoint.pendingBySeq.size,
      });
      return;
    }
    checkpoint.pendingBySeq.set(seq, { eventEnvelope, correlation });
    if (seq !== expectedSeq) {
      this.emitTrace('bridge_gap_buffered', correlation, {
        receivedSeq: seq,
        expectedSeq,
        checkpointSeq: checkpoint.lastContiguousSeq,
        pendingCount: checkpoint.pendingBySeq.size,
      });
    }

    while (true) {
      const nextSeq = checkpoint.lastContiguousSeq + 1;
      const nextEnvelope = checkpoint.pendingBySeq.get(nextSeq);
      if (nextEnvelope === undefined) return;

      const { eventEnvelope: nextEventEnvelope, correlation: nextCorrelation } = nextEnvelope;
      const tracedEnvelope = this.attachTerminalTrace(nextEventEnvelope, nextCorrelation);
      checkpoint.pendingBySeq.delete(nextSeq);
      try {
        await consume(tracedEnvelope);
        this.emitTrace('bridge_consume_resolved', nextCorrelation, {
          receivedSeq: nextSeq,
          expectedSeq: nextSeq,
          checkpointSeq: checkpoint.lastContiguousSeq,
          pendingCount: checkpoint.pendingBySeq.size,
        });
      } catch (error) {
        this.emitTrace('bridge_consume_rejected', nextCorrelation, {
          receivedSeq: nextSeq,
          expectedSeq: nextSeq,
          checkpointSeq: checkpoint.lastContiguousSeq,
          pendingCount: checkpoint.pendingBySeq.size,
          errorCategory: error instanceof Error ? 'error' : 'non_error',
        });
        // This envelope has no retry channel. Advance the checkpoint so one malformed ingress does not stall later events.
      }
      checkpoint.lastContiguousSeq = nextSeq;
      await this.checkpoints.writeLastSeq(sessionId, nextSeq);
      this.emitTrace('bridge_checkpoint_advanced', nextCorrelation, {
        receivedSeq: nextSeq,
        expectedSeq: nextSeq,
        checkpointSeq: checkpoint.lastContiguousSeq,
        pendingCount: checkpoint.pendingBySeq.size,
      });
    }
  }

  private attachTerminalTrace(
    eventEnvelope: unknown,
    correlation: MatchaTerminalDeliveryTraceCorrelation,
  ): unknown {
    if (correlation.eventClass !== 'terminal' || !correlation.terminalPhase) {
      return eventEnvelope;
    }
    return attachMatchaTerminalDeliveryTraceToEnvelope(
      eventEnvelope,
      correlation as MatchaTerminalDeliveryTraceContext,
    );
  }

  private emitTrace(
    stage: Parameters<MatchaTerminalDeliveryTrace>[0]['stage'],
    correlation: MatchaTerminalDeliveryTraceCorrelation,
    details: Omit<Parameters<MatchaTerminalDeliveryTrace>[0], 'stage' | 'bridgeTraceId' | 'runTraceId' | 'eventClass' | 'terminalPhase'>,
  ): void {
    if (correlation.eventClass !== 'terminal') {
      return;
    }
    this.trace?.({
      stage,
      ...correlation,
      ...details,
    });
  }

  private async readCheckpoint(sessionId: string): Promise<SessionEventCheckpoint> {
    const existing = this.checkpointsBySessionId.get(sessionId);
    if (existing) return existing;

    const lastSeq = await this.checkpoints.readLastSeq(sessionId);
    const checkpoint: SessionEventCheckpoint = {
      lastContiguousSeq: lastSeq ?? 0,
      pendingBySeq: new Map(),
    };
    this.checkpointsBySessionId.set(sessionId, checkpoint);
    return checkpoint;
  }
}

function readSeq(record: Record<string, unknown>): number | null {
  return typeof record.seq === 'number' && Number.isInteger(record.seq) && record.seq > 0
    ? record.seq
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
