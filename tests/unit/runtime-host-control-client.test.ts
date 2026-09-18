import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES,
  RuntimeHostControlClient,
  RuntimeHostControlError,
  type RuntimeHostControlInput,
} from '../../electron/main/runtime-host-delivery/control';

class ControlStreams {
  readonly output = new EventEmitter();
  readonly writes: Buffer[] = [];
  readonly input: RuntimeHostControlInput = {
    write: (chunk, callback) => {
      this.writes.push(Buffer.from(chunk));
      callback(null);
      return true;
    },
  };
}

function createClient(options: { maxPendingCommands?: number; defaultTimeoutMs?: number } = {}) {
  const streams = new ControlStreams();
  const client = new RuntimeHostControlClient({
    stdin: streams.input,
    stdout: streams.output,
    ...options,
  });
  return { client, streams };
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const result = Buffer.alloc(4 + body.length);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

function outboundCommand(frameBytes: Buffer): Record<string, unknown> {
  const bodyLength = frameBytes.readUInt32BE(0);
  const expectedPrefix = Buffer.alloc(4);
  expectedPrefix.writeUInt32BE(frameBytes.length - 4, 0);
  expect(frameBytes.subarray(0, 4)).toEqual(expectedPrefix);
  expect(frameBytes.length).toBe(4 + bodyLength);
  return JSON.parse(frameBytes.subarray(4).toString('utf8')) as Record<string, unknown>;
}

function readyFrame(): Buffer {
  return frame({ version: 1, type: 'ready' });
}

function eventFrame(): Buffer {
  return frame({
    version: 1,
    type: 'event',
    event: {
      type: 'openclaw.lifecycle',
      sequence: 12,
      hasRun: true,
      hasMessage: false,
      hasSessionActivity: true,
    },
  });
}

function runtimeEventFrame(): Buffer {
  return frame({
    version: 1,
    type: 'event',
    event: { type: 'openclaw.runtime' },
  });
}

function matchaLifecycleEventFrame(): Buffer {
  return frame({
    version: 1,
    type: 'event',
    event: {
      type: 'matcha.lifecycle',
      lifecycle: 'running',
      ready: true,
      observedAtMs: 1_725_000_000_000,
    },
  });
}

function succeededOutcome(id: unknown, result: unknown): Buffer {
  return frame({
    version: 1,
    type: 'outcome',
    id,
    outcome: { kind: 'succeeded', result },
  });
}

describe('runtime-host framed control client', () => {
  it('writes semantic commands in the frozen v1 length frame and incrementally dispatches typed events', async () => {
    const { client, streams } = createClient();
    const ready = vi.fn();
    const event = vi.fn();
    client.onReady(ready);
    client.onSafeEvent(event);

    const outcome = client.command(
      { name: 'host.health' },
      { timeoutMs: 25 },
    );
    const outbound = outboundCommand(streams.writes[0]);
    expect(outbound).toMatchObject({
      version: 1,
      type: 'command',
      timeoutMs: 25,
      command: { name: 'host.health' },
    });
    expect(Object.keys(outbound).sort()).toEqual(['command', 'id', 'timeoutMs', 'type', 'version']);
    expect(Object.keys(outbound.command as Record<string, unknown>).sort()).toEqual(['name']);
    expect(outbound.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(outbound)).not.toContain('method');
    expect(JSON.stringify(outbound)).not.toContain('route');
    expect(JSON.stringify(outbound)).not.toContain('payload');

    const output = Buffer.concat([
      readyFrame(),
      eventFrame(),
      succeededOutcome(outbound.id, { accepted: true }),
    ]);
    streams.output.emit('data', output.subarray(0, 7));
    streams.output.emit('data', output.subarray(7));

    await expect(outcome).resolves.toEqual({ kind: 'succeeded', result: { accepted: true } });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith({
      type: 'openclaw.lifecycle',
      sequence: 12,
      hasRun: true,
      hasMessage: false,
      hasSessionActivity: true,
    });
  });

  it('accepts the payload-free runtime lifecycle event', async () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);

    streams.output.emit('data', Buffer.concat([readyFrame(), runtimeEventFrame()]));

    expect(event).toHaveBeenCalledWith({ type: 'openclaw.runtime' });
  });

  it('accepts the public Matcha lifecycle event without private process fields', async () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);

    streams.output.emit('data', Buffer.concat([readyFrame(), matchaLifecycleEventFrame()]));

    expect(event).toHaveBeenCalledWith({
      type: 'matcha.lifecycle',
      lifecycle: 'running',
      ready: true,
      observedAtMs: 1_725_000_000_000,
    });
    expect(JSON.stringify(event.mock.calls)).not.toMatch(/pid|port|token|path|stderr/);
  });

  it('strictly decodes Matcha session activity and rejects private or malformed fields', () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);
    streams.output.emit('data', Buffer.concat([
      readyFrame(),
      frame({
        version: 1,
        type: 'event',
        event: {
          type: 'matcha.session.activity',
          routeKey: 'renderer-route:matcha',
          sequence: 7,
          activity: { kind: 'message', messageId: 'message-1', lifecycle: 'delta', textDelta: 'hello' },
        },
      }),
    ]));

    expect(event).toHaveBeenCalledWith({
      type: 'matcha.session.activity',
      routeKey: 'renderer-route:matcha',
      sequence: 7,
      activity: { kind: 'message', messageId: 'message-1', lifecycle: 'delta', textDelta: 'hello' },
    });

    for (const invalidActivity of [
      { kind: 'run', phase: 'done' },
      { kind: 'message', messageId: 'message-1', lifecycle: 'delta' },
      { kind: 'message', messageId: 'message-1', lifecycle: 'started', textDelta: 'unexpected' },
      { kind: 'tool', toolCallId: 'tool-1', phase: 'completed', rawPayload: 'secret' },
      { kind: 'approval', approvalId: 'approval-1', phase: 'requested' },
      { kind: 'approval', approvalId: 'approval-1', phase: 'requested', optionIds: ['option-1', 'option-1'] },
      { kind: 'approval', approvalId: 'approval-1', phase: 'requested', optionIds: Array.from({ length: 33 }, (_, index) => `option-${index}`) },
      { kind: 'approval', approvalId: 'approval-1', phase: 'resolved', optionIds: ['option-1'] },
      { kind: 'approval', approvalId: 'approval-1', phase: 'resolved', resolution: 'approved' },
      { kind: 'approval', approvalId: 'approval-1', phase: 'requested', optionIds: ['option-1'], resolution: 'approved' },
    ]) {
      const isolated = createClient();
      const isolatedEvent = vi.fn();
      isolated.client.onSafeEvent(isolatedEvent);
      isolated.streams.output.emit('data', readyFrame());
      isolated.streams.output.emit('data', frame({
        version: 1,
        type: 'event',
        event: {
          type: 'matcha.session.activity',
          routeKey: 'renderer-route:matcha',
          sequence: 7,
          activity: invalidActivity,
        },
      }));
      expect(isolatedEvent).not.toHaveBeenCalled();
      isolated.client.close();
    }
  });

  it('accepts a requested Matcha approval activity with no options', () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);

    streams.output.emit('data', Buffer.concat([
      readyFrame(),
      frame({
        version: 1,
        type: 'event',
        event: {
          type: 'matcha.session.activity',
          routeKey: 'renderer-route:matcha',
          sequence: 1,
          activity: { kind: 'approval', approvalId: 'approval-1', phase: 'requested', optionIds: [] },
        },
      }),
    ]));

    expect(event).toHaveBeenCalledWith({
      type: 'matcha.session.activity',
      routeKey: 'renderer-route:matcha',
      sequence: 1,
      activity: { kind: 'approval', approvalId: 'approval-1', phase: 'requested', optionIds: [] },
    });
    client.close();
  });

  it('strictly decodes OpenClaw message and tool session activity', () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);
    streams.output.emit('data', Buffer.concat([
      readyFrame(),
      frame({
        version: 1,
        type: 'event',
        event: {
          type: 'openclaw.session.activity',
          routeKey: 'renderer-route:openclaw',
          sequence: 8,
          activity: { kind: 'message', messageId: 'message-1', lifecycle: 'delta', textDelta: 'hello' },
        },
      }),
      frame({
        version: 1,
        type: 'event',
        event: {
          type: 'openclaw.session.activity',
          routeKey: 'renderer-route:openclaw',
          sequence: 9,
          activity: { kind: 'tool', toolId: 'tool-1', phase: 'updated', summary: 'running' },
        },
      }),
    ]));

    expect(event.mock.calls.map(([value]) => value)).toEqual([
      {
        type: 'openclaw.session.activity',
        routeKey: 'renderer-route:openclaw',
        sequence: 8,
        activity: { kind: 'message', messageId: 'message-1', lifecycle: 'delta', textDelta: 'hello' },
      },
      {
        type: 'openclaw.session.activity',
        routeKey: 'renderer-route:openclaw',
        sequence: 9,
        activity: { kind: 'tool', toolId: 'tool-1', phase: 'updated', summary: 'running' },
      },
    ]);

    for (const activity of [
      { kind: 'message', messageId: 'message-1', lifecycle: 'started', textDelta: 'unexpected' },
      { kind: 'tool', toolId: 'tool-1', phase: 'updated', summary: 'x'.repeat(257) },
      { kind: 'tool', toolId: 'tool-1', phase: 'unknown' },
      { kind: 'tool', toolId: 'tool-1', phase: 'updated', secret: 'must-not-pass' },
    ]) {
      const isolated = createClient();
      const isolatedEvent = vi.fn();
      isolated.client.onSafeEvent(isolatedEvent);
      isolated.streams.output.emit('data', readyFrame());
      isolated.streams.output.emit('data', frame({
        version: 1,
        type: 'event',
        event: {
          type: 'openclaw.session.activity',
          routeKey: 'renderer-route:openclaw',
          sequence: 1,
          activity,
        },
      }));
      expect(isolatedEvent).not.toHaveBeenCalled();
      isolated.client.close();
    }
  });

  it('strictly decodes OpenClaw session updates and normalizes omitted replace', () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);
    streams.output.emit('data', Buffer.concat([
      readyFrame(),
      frame({
        version: 1,
        type: 'event',
        event: {
          type: 'openclaw.session.update',
          routeKey: 'renderer-route:openclaw',
          kind: 'terminal',
          sequence: 7,
          text: 'done',
          terminal: 'completed',
        },
      }),
    ]));

    expect(event).toHaveBeenCalledWith({
      type: 'openclaw.session.update',
      routeKey: 'renderer-route:openclaw',
      kind: 'terminal',
      sequence: 7,
      text: 'done',
      replace: false,
      terminal: 'completed',
    });
  });

  it('rejects session updates with unknown fields, overlong values, or invalid enums', () => {
    const invalidEvents = [
      { type: 'openclaw.session.update', routeKey: 'renderer-route:r', kind: 'delta', sequence: 1, replace: false, extra: true },
      { type: 'openclaw.session.update', routeKey: 'renderer-route:r', kind: 'unknown', sequence: 1, replace: false },
      { type: 'openclaw.session.update', routeKey: 'renderer-route:r', kind: 'delta', sequence: Number.MAX_SAFE_INTEGER + 1, replace: false },
      { type: 'openclaw.session.update', routeKey: 'renderer-route:r', kind: 'delta', sequence: 1, replace: false, terminal: 'completed' },
      { type: 'openclaw.session.update', routeKey: 'renderer-route:r', kind: 'delta', sequence: 1, replace: false, text: 'x'.repeat(128 * 1024 + 1) },
      { type: 'openclaw.session.update', routeKey: 'renderer-route:r', kind: 'delta', sequence: 1, replace: false, stopReason: 'x'.repeat(257) },
    ];
    for (const invalidEvent of invalidEvents) {
      const { client, streams } = createClient();
      const event = vi.fn();
      client.onSafeEvent(event);
      streams.output.emit('data', readyFrame());
      streams.output.emit('data', frame({ version: 1, type: 'event', event: invalidEvent }));
      expect(event).not.toHaveBeenCalled();
      client.close();
    }
  });

  it('rejects session.delta on the safe event control wire', async () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);
    const command = client.command({ name: 'host.health' });

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', frame({
      version: 1,
      type: 'event',
      event: {
        type: 'session.delta',
        delta: {
          sessionKey: 'session-1',
          routeKey: 'renderer-route:bound',
          epoch: 1,
          seq: 1,
          cursor: 1,
          changes: [{ kind: 'runPhaseChanged', runId: 'run-1', phase: 'started' }],
        },
      },
    }));

    expect(event).not.toHaveBeenCalled();
    await expect(command).rejects.toMatchObject({
      kind: 'protocol-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
  });

  it('accepts all Cron terminal statuses while preserving only opaque correlation', async () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);

    const statuses = ['succeeded', 'failed', 'skipped', 'cancelled', 'outcome-unknown'] as const;
    streams.output.emit('data', Buffer.concat([
      readyFrame(),
      ...statuses.map((status) => frame({
        version: 1,
        type: 'event',
        event: {
          type: 'openclaw.cron.execution',
          jobId: 'cron.job-1:main',
          runId: 'run-1',
          status,
        },
      })),
    ]));

    expect(event).toHaveBeenCalledTimes(statuses.length);
    expect(event.mock.calls.map(([value]) => value)).toEqual(
      statuses.map((status) => ({
        type: 'openclaw.cron.execution',
        jobId: 'cron.job-1:main',
        runId: 'run-1',
        status,
      })),
    );
  });

  it('rejects Cron events with invalid identity, status, or extra native fields', async () => {
    const { client, streams } = createClient();
    const event = vi.fn();
    client.onSafeEvent(event);
    streams.output.emit('data', readyFrame());

    for (const invalid of [
      { type: 'openclaw.cron.execution', jobId: '', runId: 'run-1', status: 'succeeded' },
      { type: 'openclaw.cron.execution', jobId: 'cron/job-1', runId: 'run-1', status: 'succeeded' },
      { type: 'openclaw.cron.execution', jobId: 'cron-job-1', runId: 'run-1', status: 'success' },
      { type: 'openclaw.cron.execution', jobId: 'cron-job-1', runId: 'run-1', status: 'failed', payload: {} },
    ]) {
      streams.output.emit('data', frame({ version: 1, type: 'event', event: invalid }));
    }

    expect(event).not.toHaveBeenCalled();
  });

  it('writes the fixed read-only capability directory command', async () => {
    const { client, streams } = createClient();
    const outcome = client.command({ name: 'host.capabilities.list' });
    const outbound = outboundCommand(streams.writes[0]);

    expect(outbound.command).toEqual({ name: 'host.capabilities.list' });
    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, { capabilities: [] }));
    await expect(outcome).resolves.toEqual({ kind: 'succeeded', result: { capabilities: [] } });

    await expect(client.command({
      name: 'host.capabilities.list',
      input: {},
    } as never)).rejects.toMatchObject({
      kind: 'command-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(streams.writes).toHaveLength(1);
  });

  it('writes the exact read-only capability describe command and preserves the sealed outcome', async () => {
    const { client, streams } = createClient();
    const command = client.command({
      name: 'host.capabilities.describe',
      input: {
        id: 'scheduler.cron',
        scope: {
          kind: 'runtime-instance',
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
          },
        },
      },
    });
    const outbound = outboundCommand(streams.writes[0]);

    expect(outbound.command).toEqual({
      name: 'host.capabilities.describe',
      input: {
        id: 'scheduler.cron',
        scope: {
          kind: 'runtime-instance',
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
          },
        },
      },
    });
    expect(Object.keys(outbound.command as Record<string, unknown>).sort()).toEqual(['input', 'name']);
    expect(Object.keys((outbound.command as Record<string, unknown>).input as Record<string, unknown>).sort()).toEqual(['id', 'scope']);

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, { capability: { id: 'scheduler.cron' } }));
    await expect(command).resolves.toEqual({
      kind: 'succeeded',
      result: { capability: { id: 'scheduler.cron' } },
    });
  });

  it('rejects capability describe schema drift, invalid ids, and non-JSON scopes before writing', async () => {
    const { client, streams } = createClient();
    const validScope = { kind: 'app' };
    const invalidCommands = [
      {
        name: 'host.capabilities.describe',
        input: { id: 'scheduler.cron', scope: validScope },
        extra: true,
      },
      {
        name: 'host.capabilities.describe',
        input: { id: 'scheduler.cron', scope: validScope, extra: true },
      },
      { name: 'host.capabilities.describe', input: { id: '', scope: validScope } },
      { name: 'host.capabilities.describe', input: { id: '   ', scope: validScope } },
      { name: 'host.capabilities.describe', input: { id: 'scheduler\ncron', scope: validScope } },
      { name: 'host.capabilities.describe', input: { id: 'scheduler\u0000cron', scope: validScope } },
      { name: 'host.capabilities.describe', input: { id: 'scheduler.cron', scope: null } },
      { name: 'host.capabilities.describe', input: { id: 'scheduler.cron', scope: [] } },
      { name: 'host.capabilities.describe', input: { id: 'scheduler.cron', scope: 'app' } },
      { name: 'host.capabilities.describe', input: { id: 'scheduler.cron', scope: { kind: 'app', value: BigInt(1) } } },
    ];

    for (const invalidCommand of invalidCommands) {
      await expect(client.command(invalidCommand as never)).rejects.toMatchObject({
        kind: 'command-invalid',
        delivery: 'not-delivered',
      } satisfies Partial<RuntimeHostControlError>);
    }
    expect(streams.writes).toHaveLength(0);
  });

  it('writes the exact team runtime execute command and preserves the old envelope', async () => {
    const { client, streams } = createClient();
    const command = client.command({
      name: 'team.runtime.execute',
      input: {
        id: 'team.runtime',
        operationId: 'teams.list',
        scope: { kind: 'team', teamId: 'team-1' },
        target: { kind: 'team', id: 'team-1' },
        input: { includeArchived: false },
      },
    });
    const outbound = outboundCommand(streams.writes[0]);

    expect(outbound).toMatchObject({
      version: 1,
      type: 'command',
      command: {
        name: 'team.runtime.execute',
        input: {
          id: 'team.runtime',
          operationId: 'teams.list',
          scope: { kind: 'team', teamId: 'team-1' },
          target: { kind: 'team', id: 'team-1' },
          input: { includeArchived: false },
        },
      },
    });
    expect(Object.keys(outbound.command as Record<string, unknown>).sort()).toEqual(['input', 'name']);
    expect(Object.keys((outbound.command as Record<string, unknown>).input as Record<string, unknown>).sort()).toEqual([
      'id',
      'input',
      'operationId',
      'scope',
      'target',
    ]);
    expect(JSON.stringify(outbound)).not.toMatch(/method|route|payload/);

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, { accepted: true }));
    await expect(command).resolves.toEqual({ kind: 'succeeded', result: { accepted: true } });
  });

  it('accepts team runtime trace id as private control metadata', async () => {
    const { client, streams } = createClient();
    const traceId = 'session-trace:team-runtime:team.runList:trace-1';
    const command = client.command({
      name: 'team.runtime.execute',
      input: {
        id: 'team.runtime',
        operationId: 'teams.list',
        scope: { kind: 'team' },
        target: null,
        input: {},
        traceId,
      },
    });
    const outbound = outboundCommand(streams.writes[0]);

    expect((outbound.command as Record<string, unknown>).input).toMatchObject({ traceId });
    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, { accepted: true }));
    await expect(command).resolves.toEqual({ kind: 'succeeded', result: { accepted: true } });
  });

  it('rejects team runtime execute schema drift and non-JSON fields before writing', async () => {
    const { client, streams } = createClient();
    const validInput = {
      id: 'team.runtime',
      operationId: 'teams.list',
      scope: { kind: 'team' },
      target: null,
      input: {},
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidCommands = [
      { name: 'team.runtime.execute', input: validInput, extra: true },
      { name: 'team.runtime.execute', input: { ...validInput, extra: true } },
      { name: 'team.runtime.execute', input: { ...validInput, id: 'team.other' } },
      { name: 'team.runtime.execute', input: { ...validInput, id: '' } },
      { name: 'team.runtime.execute', input: { ...validInput, operationId: '' } },
      { name: 'team.runtime.execute', input: { ...validInput, operationId: BigInt(1) } },
      { name: 'team.runtime.execute', input: { ...validInput, scope: null } },
      { name: 'team.runtime.execute', input: { ...validInput, scope: { value: BigInt(1) } } },
      { name: 'team.runtime.execute', input: { ...validInput, target: BigInt(1) } },
      { name: 'team.runtime.execute', input: { ...validInput, target: cyclic } },
      { name: 'team.runtime.execute', input: { ...validInput, input: [] } },
      { name: 'team.runtime.execute', input: { ...validInput, input: { value: BigInt(1) } } },
      { name: 'team.runtime.execute', input: { ...validInput, traceId: '' } },
      { name: 'team.runtime.execute', input: { ...validInput, traceId: 'bad\ntrace' } },
      { name: 'team.runtime.execute', input: { ...validInput, traceId: 'x'.repeat(257) } },
    ];

    for (const invalidCommand of invalidCommands) {
      await expect(client.command(invalidCommand as never)).rejects.toMatchObject({
        kind: 'command-invalid',
        delivery: 'not-delivered',
      } satisfies Partial<RuntimeHostControlError>);
    }
    expect(streams.writes).toHaveLength(0);
  });

  it('classifies capability describe write failure, timeout, and disconnect as not delivered', async () => {
    const failedWrite = new ControlStreams();
    failedWrite.input.write = (chunk, callback) => {
      failedWrite.writes.push(Buffer.from(chunk));
      callback(new Error('simulated write failure'));
      return false;
    };
    const failedWriteClient = new RuntimeHostControlClient({
      stdin: failedWrite.input,
      stdout: failedWrite.output,
    });
    await expect(failedWriteClient.command({
      name: 'host.capabilities.describe',
      input: { id: 'scheduler.cron', scope: { kind: 'app' } },
    })).rejects.toMatchObject({
      kind: 'write-failed',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);

    vi.useFakeTimers();
    try {
      const timedOut = createClient({ defaultTimeoutMs: 10 });
      const timeoutCommand = timedOut.client.command({
        name: 'host.capabilities.describe',
        input: { id: 'scheduler.cron', scope: { kind: 'app' } },
      });
      const timeoutAssertion = expect(timeoutCommand).rejects.toMatchObject({
        kind: 'timeout-exceeded',
        delivery: 'not-delivered',
      } satisfies Partial<RuntimeHostControlError>);
      await vi.advanceTimersByTimeAsync(10);
      await timeoutAssertion;
    } finally {
      vi.useRealTimers();
    }

    const disconnected = createClient();
    const disconnectCommand = disconnected.client.command({
      name: 'host.capabilities.describe',
      input: { id: 'scheduler.cron', scope: { kind: 'app' } },
    });
    disconnected.streams.output.emit('close');
    await expect(disconnectCommand).rejects.toMatchObject({
      kind: 'disconnected',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
  });

  it('rejects removed private approval commands before writing a control frame', async () => {
    const { client, streams } = createClient();

    await expect(client.command({ name: 'openclaw.approvals.list' } as never)).rejects.toMatchObject({
      kind: 'command-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(streams.writes).toEqual([]);
  });

  it('rejects removed license receipt commands before writing a control frame', async () => {
    const { client, streams } = createClient();

    await expect(client.command({ name: 'license.receipt' } as never)).rejects.toMatchObject({
      kind: 'command-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(streams.writes).toEqual([]);
  });

  it('encodes Matcha lifecycle commands as exact name-only commands', async () => {
    const { client, streams } = createClient();
    const status = client.command({ name: 'matcha.lifecycle.status' });
    const start = client.command({ name: 'matcha.lifecycle.start' });
    const stop = client.command({ name: 'matcha.lifecycle.stop' });
    const restart = client.command({ name: 'matcha.lifecycle.restart' });
    const commands = streams.writes.map(outboundCommand);

    expect(commands.map(({ command }) => command)).toEqual([
      { name: 'matcha.lifecycle.status' },
      { name: 'matcha.lifecycle.start' },
      { name: 'matcha.lifecycle.stop' },
      { name: 'matcha.lifecycle.restart' },
    ]);
    for (const outbound of commands) {
      expect(Object.keys(outbound.command as Record<string, unknown>)).toEqual(['name']);
      expect(JSON.stringify(outbound.command)).not.toMatch(/input|method|route|pid|port|endpoint|token/);
    }

    streams.output.emit('data', readyFrame());
    for (const outbound of commands) {
      streams.output.emit('data', succeededOutcome(outbound.id, {}));
    }
    await expect(Promise.all([status, start, stop, restart])).resolves.toEqual([
      { kind: 'succeeded', result: {} },
      { kind: 'succeeded', result: {} },
      { kind: 'succeeded', result: {} },
      { kind: 'succeeded', result: {} },
    ]);
  });

  it('encodes OpenClaw environment status as an exact name-only command', async () => {
    const { client, streams } = createClient();
    const command = client.command({ name: 'openclaw.environment.status' });
    const outbound = outboundCommand(streams.writes[0]);

    expect(outbound.command).toEqual({ name: 'openclaw.environment.status' });
    expect(JSON.stringify(outbound.command)).not.toMatch(/input|method|route|path|port|endpoint|token/);

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, {}));
    await expect(command).resolves.toEqual({ kind: 'succeeded', result: {} });
  });

  it('encodes the direct toolchain prepare command without rebuilding job state', async () => {
    const { client, streams } = createClient();
    const prepare = client.command({ name: 'host.toolchain.prepare' });
    const [outbound] = streams.writes.map(outboundCommand);

    expect(outbound.command).toEqual({ name: 'host.toolchain.prepare' });
    expect(Object.keys(outbound.command as Record<string, unknown>)).toEqual(['name']);
    expect(JSON.stringify(outbound)).not.toMatch(/method|route|payload|native/);

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, { result: { outcome: 'installed' } }));

    await expect(prepare).resolves.toEqual({
      kind: 'succeeded',
      result: { result: { outcome: 'installed' } },
    });
  });

  it('rejects toolchain prepare input and extra fields before writing', async () => {
    const { client, streams } = createClient();
    const invalidCommands = [
      { name: 'host.toolchain.prepare', input: {} },
      { name: 'host.toolchain.prepare', extra: true },
    ];

    for (const command of invalidCommands) {
      await expect(client.command(command as never)).rejects.toMatchObject({
        kind: 'command-invalid',
        delivery: 'not-delivered',
      } satisfies Partial<RuntimeHostControlError>);
    }
    expect(streams.writes).toHaveLength(0);
  });

  it('classifies toolchain prepare write failure, timeout, and disconnect as unknown delivery', async () => {
    const failedWrite = new ControlStreams();
    failedWrite.input.write = (chunk, callback) => {
      failedWrite.writes.push(Buffer.from(chunk));
      callback(new Error('simulated write failure'));
      return false;
    };
    const failedWriteClient = new RuntimeHostControlClient({
      stdin: failedWrite.input,
      stdout: failedWrite.output,
    });

    await expect(failedWriteClient.command({ name: 'host.toolchain.prepare' })).rejects.toMatchObject({
      kind: 'write-failed',
      delivery: 'unknown-delivery',
      retryable: false,
    } satisfies Partial<RuntimeHostControlError>);

    vi.useFakeTimers();
    try {
      const timedOut = createClient({ defaultTimeoutMs: 10 });
      const prepare = timedOut.client.command({ name: 'host.toolchain.prepare' });
      const assertion = expect(prepare).rejects.toMatchObject({
        kind: 'timeout-exceeded',
        delivery: 'unknown-delivery',
      } satisfies Partial<RuntimeHostControlError>);
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    const disconnected = createClient();
    const prepare = disconnected.client.command({ name: 'host.toolchain.prepare' });
    disconnected.streams.output.emit('close');
    await expect(prepare).rejects.toMatchObject({
      kind: 'disconnected',
      delivery: 'unknown-delivery',
    } satisfies Partial<RuntimeHostControlError>);
  });

  it('encodes OpenClaw control readiness as an exact name-only command', async () => {
    const { client, streams } = createClient();
    const command = client.command({ name: 'openclaw.control.ready' });
    const outbound = outboundCommand(streams.writes[0]);

    expect(outbound.command).toEqual({ name: 'openclaw.control.ready' });
    expect(Object.keys(outbound.command as Record<string, unknown>)).toEqual(['name']);

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, {}));
    await expect(command).resolves.toEqual({ kind: 'succeeded', result: {} });
  });

  it('rejects removed public session queries before writing to private control', async () => {
    const { client, streams } = createClient();

    await expect(client.command({ name: 'openclaw.sessions.list' } as never)).rejects.toMatchObject({
      kind: 'command-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(streams.writes).toEqual([]);
  });

  it('preserves typed null command input fields without a generic payload channel', async () => {
    const { client, streams } = createClient();
    const command = client.command({
      name: 'openclaw.sessions.patch-model',
      input: { sessionKey: 'session-1', model: null },
    });
    const outbound = outboundCommand(streams.writes[0]);
    expect(outbound.command).toEqual({
      name: 'openclaw.sessions.patch-model',
      input: { sessionKey: 'session-1', model: null },
    });

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, {}));
    await expect(command).resolves.toEqual({ kind: 'succeeded', result: {} });
  });

  it('correlates concurrent command outcomes by id even when stdout reorders them', async () => {
    const { client, streams } = createClient();
    streams.output.emit('data', readyFrame());
    const first = client.command({ name: 'host.health' });
    const second = client.command({ name: 'host.health' });
    const firstId = outboundCommand(streams.writes[0]).id;
    const secondId = outboundCommand(streams.writes[1]).id;

    streams.output.emit('data', succeededOutcome(secondId, { command: 'second' }));
    streams.output.emit('data', succeededOutcome(firstId, { command: 'first' }));

    await expect(first).resolves.toEqual({ kind: 'succeeded', result: { command: 'first' } });
    await expect(second).resolves.toEqual({ kind: 'succeeded', result: { command: 'second' } });
  });

  it('requires the Rust-ready frame before dispatching outcomes or safe events', async () => {
    const outcome = createClient();
    const outcomeCommand = outcome.client.command({ name: 'host.health' });
    const outcomeId = outboundCommand(outcome.streams.writes[0]).id;
    outcome.streams.output.emit('data', succeededOutcome(outcomeId, {}));
    await expect(outcomeCommand).rejects.toMatchObject({
      kind: 'protocol-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);

    const event = createClient();
    const safeEvent = vi.fn();
    event.client.onSafeEvent(safeEvent);
    event.streams.output.emit('data', eventFrame());
    expect(safeEvent).not.toHaveBeenCalled();
    await expect(event.client.command({ name: 'host.health' })).rejects.toMatchObject({
      kind: 'disconnected',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
  });

  it('notifies ready and disconnect subscribers once, including late subscribers', () => {
    const { client, streams } = createClient();
    const ready = vi.fn();
    const disconnected = vi.fn();
    client.onReady(ready);
    client.onDisconnect(disconnected);

    streams.output.emit('data', readyFrame());
    streams.output.emit('close');
    streams.output.emit('end');
    client.close();

    expect(ready).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ kind: 'disconnected' }));

    const lateReady = vi.fn();
    const lateDisconnect = vi.fn();
    client.onReady(lateReady);
    client.onDisconnect(lateDisconnect);
    expect(lateReady).toHaveBeenCalledTimes(1);
    expect(lateDisconnect).toHaveBeenCalledTimes(1);

    const removeReady = client.onReady(vi.fn());
    const removeDisconnect = client.onDisconnect(vi.fn());
    expect(removeReady()).toBe(true);
    expect(removeDisconnect()).toBe(true);
  });

  it('enforces frozen one-to-120,000 ms timeout bounds before writing', async () => {
    expect(() => createClient({ defaultTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => createClient({ defaultTimeoutMs: 120_001 })).toThrow(RangeError);

    const { client, streams } = createClient();
    expect(() => client.command({ name: 'host.health' }, { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => client.command({ name: 'host.health' }, { timeoutMs: 120_001 })).toThrow(RangeError);

    const command = client.command({ name: 'host.health' }, { timeoutMs: 120_000 });
    const outbound = outboundCommand(streams.writes[0]);
    expect(outbound.timeoutMs).toBe(120_000);
    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(outbound.id, {}));
    await expect(command).resolves.toEqual({ kind: 'succeeded', result: {} });
  });

  it('rejects legacy HTTP, malformed, and unknown-field stdout messages', async () => {
    const invalidMessages = [
      { version: 2, type: 'ready' },
      { version: 1, type: 'ready', unexpected: true },
      { version: 1, type: 'ready', sessionList: {} },
      { version: 1, type: 'ready', sessionList: { endpoint: 'http://127.0.0.1:1/v1/sessions/list', credential: 'secret' } },
      { version: 1, type: 'ready', endpoint: 'http://127.0.0.1:1/v1/sessions/list' },
      { version: 1, type: 'response', id: 'command-1', response: {} },
      {
        version: 1,
        type: 'outcome',
        id: 'command-1',
        outcome: { kind: 'succeeded', result: {}, unexpected: true },
      },
      {
        version: 1,
        type: 'event',
        event: {
          type: 'openclaw.lifecycle',
          sequence: null,
          hasRun: true,
          hasMessage: false,
          hasSessionActivity: false,
          rawPayload: 'must-not-pass',
        },
      },
    ];

    for (const invalidMessage of invalidMessages) {
      const { client, streams } = createClient();
      const command = client.command({ name: 'host.health' });
      streams.output.emit('data', frame(invalidMessage));

      await expect(command).rejects.toMatchObject({
        kind: 'protocol-invalid',
        delivery: 'not-delivered',
      } satisfies Partial<RuntimeHostControlError>);
    }
  });

  it('rejects outcome IDs that the Rust control wire cannot decode', async () => {
    const { client, streams } = createClient();
    const command = client.command({ name: 'host.health' });
    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome('中'.repeat(65), {}));

    await expect(command).rejects.toMatchObject({
      kind: 'protocol-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
  });

  it('rejects malformed and oversized framing before buffering unbounded stdout', async () => {
    const malformed = createClient();
    const malformedCommand = malformed.client.command({ name: 'host.health' });
    malformed.streams.output.emit('data', Buffer.from([0, 0, 0, 1, 0xff]));
    await expect(malformedCommand).rejects.toMatchObject({
      kind: 'protocol-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);

    const oversized = createClient();
    const oversizedCommand = oversized.client.command({ name: 'host.health' });
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES + 1);
    oversized.streams.output.emit('data', oversizedHeader);
    await expect(oversizedCommand).rejects.toMatchObject({
      kind: 'protocol-invalid',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
  });

  it('returns distinguishable remote outcomes instead of HTTP status envelopes', async () => {
    const { client, streams } = createClient();
    const rejected = client.command({ name: 'openclaw.lifecycle.start' });
    const timedOut = client.command({ name: 'host.health' });
    const rejectedId = outboundCommand(streams.writes[0]).id;
    const timedOutId = outboundCommand(streams.writes[1]).id;

    streams.output.emit('data', readyFrame());
    streams.output.emit('data', frame({
      version: 1,
      type: 'outcome',
      id: rejectedId,
      outcome: {
        kind: 'rejected',
        error: { code: 'UNAVAILABLE', message: 'Runtime Host is unavailable.' },
      },
    }));
    streams.output.emit('data', frame({
      version: 1,
      type: 'outcome',
      id: timedOutId,
      outcome: { kind: 'timed-out' },
    }));

    await expect(rejected).resolves.toEqual({
      kind: 'rejected',
      error: { code: 'UNAVAILABLE', message: 'Runtime Host is unavailable.' },
    });
    await expect(timedOut).resolves.toEqual({ kind: 'timed-out' });
  });

  it('enforces pending capacity without dropping an admitted command', async () => {
    const { client, streams } = createClient({ maxPendingCommands: 1 });
    const first = client.command({ name: 'host.health' });
    const second = client.command({ name: 'host.health' });

    await expect(second).rejects.toMatchObject({
      kind: 'pending-capacity-exceeded',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(streams.writes).toHaveLength(1);

    const firstId = outboundCommand(streams.writes[0]).id;
    streams.output.emit('data', readyFrame());
    streams.output.emit('data', succeededOutcome(firstId, {}));
    await expect(first).resolves.toEqual({ kind: 'succeeded', result: {} });
  });

  it('rejects schema drift on exact Matcha lifecycle commands before writing', async () => {
    const { client, streams } = createClient();
    const schemaDrift = [
      { input: {} },
      { request: {} },
      { method: 'POST' },
      { route: '/matcha/lifecycle' },
      { pid: 1 },
      { port: 1 },
      { endpoint: 'http://127.0.0.1' },
      { token: 'must-not-frame' },
    ];

    for (const name of [
      'matcha.lifecycle.status',
      'matcha.lifecycle.start',
      'matcha.lifecycle.stop',
      'matcha.lifecycle.restart',
    ] as const) {
      for (const extraFields of schemaDrift) {
        await expect(client.command({ name, ...extraFields } as never)).rejects.toMatchObject({
          kind: 'command-invalid',
          delivery: 'not-delivered',
        } satisfies Partial<RuntimeHostControlError>);
      }
    }
    expect(streams.writes).toHaveLength(0);
  });

  it('rejects schema drift on exact OpenClaw control readiness before writing', async () => {
    const { client, streams } = createClient();
    const schemaDrift = [
      { input: {} },
      { request: {} },
      { method: 'POST' },
      { route: '/openclaw/control/ready' },
      { payload: {} },
      { endpoint: 'http://127.0.0.1' },
      { port: 1 },
      { token: 'must-not-frame' },
    ];

    for (const extraFields of schemaDrift) {
      await expect(client.command({ name: 'openclaw.control.ready', ...extraFields } as never)).rejects.toMatchObject({
        kind: 'command-invalid',
        delivery: 'not-delivered',
      } satisfies Partial<RuntimeHostControlError>);
    }
    expect(streams.writes).toHaveLength(0);
  });

  it('classifies OpenClaw control readiness write failure, timeout, and disconnect as not delivered', async () => {
    const failedWrite = new ControlStreams();
    failedWrite.input.write = (chunk, callback) => {
      failedWrite.writes.push(Buffer.from(chunk));
      callback(new Error('simulated write failure'));
      return false;
    };
    const failedWriteClient = new RuntimeHostControlClient({
      stdin: failedWrite.input,
      stdout: failedWrite.output,
    });
    await expect(failedWriteClient.command({ name: 'openclaw.control.ready' })).rejects.toMatchObject({
      kind: 'write-failed',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(failedWrite.writes).toHaveLength(1);

    vi.useFakeTimers();
    try {
      const timedOut = createClient({ defaultTimeoutMs: 10 });
      const timeoutCommand = timedOut.client.command({ name: 'openclaw.control.ready' });
      const timeoutAssertion = expect(timeoutCommand).rejects.toMatchObject({
        kind: 'timeout-exceeded',
        delivery: 'not-delivered',
      } satisfies Partial<RuntimeHostControlError>);
      await vi.advanceTimersByTimeAsync(10);
      await timeoutAssertion;
      expect(timedOut.streams.writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }

    const disconnected = createClient();
    const disconnectCommand = disconnected.client.command({ name: 'openclaw.control.ready' });
    disconnected.streams.output.emit('close');
    await expect(disconnectCommand).rejects.toMatchObject({
      kind: 'disconnected',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(disconnected.streams.writes).toHaveLength(1);
  });

  it('classifies attempted lifecycle mutation write failures and timeouts as unknown delivery', async () => {
    for (const name of [
      'matcha.lifecycle.start',
      'matcha.lifecycle.stop',
      'matcha.lifecycle.restart',
      'openclaw.lifecycle.start',
      'openclaw.lifecycle.stop',
      'openclaw.lifecycle.restart',
    ] as const) {
      const streams = new ControlStreams();
      streams.input.write = (chunk, callback) => {
        streams.writes.push(Buffer.from(chunk));
        callback(new Error('simulated write failure'));
        return false;
      };
      const client = new RuntimeHostControlClient({ stdin: streams.input, stdout: streams.output });

      await expect(client.command({ name })).rejects.toMatchObject({
        kind: 'write-failed',
        delivery: 'unknown-delivery',
        retryable: false,
      } satisfies Partial<RuntimeHostControlError>);
      expect(streams.writes).toHaveLength(1);
    }

    vi.useFakeTimers();
    try {
      for (const name of [
        'matcha.lifecycle.start',
        'matcha.lifecycle.stop',
        'matcha.lifecycle.restart',
        'openclaw.lifecycle.start',
        'openclaw.lifecycle.stop',
        'openclaw.lifecycle.restart',
      ] as const) {
        const { client, streams } = createClient({ defaultTimeoutMs: 10 });
        const command = client.command({ name });
        const assertion = expect(command).rejects.toMatchObject({
          kind: 'timeout-exceeded',
          delivery: 'unknown-delivery',
          retryable: false,
        } satisfies Partial<RuntimeHostControlError>);

        await vi.advanceTimersByTimeAsync(10);
        await assertion;
        expect(streams.writes).toHaveLength(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies lifecycle mutation disconnect as unknown delivery', async () => {
    for (const name of [
      'matcha.lifecycle.start',
      'matcha.lifecycle.stop',
      'matcha.lifecycle.restart',
      'openclaw.lifecycle.start',
      'openclaw.lifecycle.stop',
      'openclaw.lifecycle.restart',
    ] as const) {
      const { client, streams } = createClient();
      const command = client.command({ name });
      streams.output.emit('close');

      await expect(command).rejects.toMatchObject({
        kind: 'disconnected',
        delivery: 'unknown-delivery',
        retryable: false,
      } satisfies Partial<RuntimeHostControlError>);
      expect(streams.writes).toHaveLength(1);
    }
  });

  it('classifies non-mutating disconnect as not delivered and never forwards secret event fields', async () => {
    const { client, streams } = createClient();
    const command = client.command({ name: 'host.health' });
    streams.output.emit('close');

    await expect(command).rejects.toMatchObject({
      kind: 'disconnected',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);

    const second = createClient();
    const event = vi.fn();
    second.client.onSafeEvent(event);
    const sentinels = ['secret-sentinel-must-not-leak', 'native-session-identity-must-not-leak'];
    second.streams.output.emit('data', frame({
      version: 1,
      type: 'event',
      event: {
        type: 'openclaw.lifecycle',
        sequence: 1,
        hasRun: true,
        hasMessage: false,
        hasSessionActivity: true,
        secret: sentinels[0],
        sessionKey: sentinels[1],
      },
    }));

    expect(event).not.toHaveBeenCalled();
    for (const sentinel of sentinels) expect(JSON.stringify(event.mock.calls)).not.toContain(sentinel);
  });

  it('enforces the one MiB outbound frame limit before writing', async () => {
    const { client, streams } = createClient();
    const command = client.command({
      name: 'openclaw.skills.execute',
      input: { payload: 'a'.repeat(MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES) },
    });

    await expect(command).rejects.toMatchObject({
      kind: 'frame-too-large',
      delivery: 'not-delivered',
    } satisfies Partial<RuntimeHostControlError>);
    expect(streams.writes).toHaveLength(0);
  });
});
