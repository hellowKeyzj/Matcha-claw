import { describe, expect, it } from 'vitest';
import type { RemoteFleetCommandRecord } from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import {
  cancel,
  dedupeByIdempotencyKey,
  enqueue,
  markFailed,
  markRunning,
  markSucceeded,
  markTimedOut,
  reapTimedOut,
} from '../../runtime-host/application/remote-fleet/remote-fleet-command-queue';
import type {
  EnqueueCommandResult,
  RemoteFleetCommandTransitionResult,
} from '../../runtime-host/application/remote-fleet/remote-fleet-command-queue';

const queuedAt = '2026-07-06T10:00:00.000Z';
const runningAt = '2026-07-06T10:01:00.000Z';
const completedAt = '2026-07-06T10:02:00.000Z';

function queuedCommand(input: {
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly queuedAt?: string;
}): RemoteFleetCommandRecord {
  const createdAt = input.queuedAt ?? queuedAt;
  return {
    id: input.id,
    idempotencyKey: input.idempotencyKey ?? `idem:${input.id}`,
    command: 'install-agent',
    state: { reason: 'queued', queuedAt: createdAt },
    createdAt,
    updatedAt: createdAt,
  };
}

function runningCommand(input: {
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly startedAt?: string;
}): RemoteFleetCommandRecord {
  const startedAt = input.startedAt ?? runningAt;
  return {
    ...queuedCommand({ id: input.id, idempotencyKey: input.idempotencyKey }),
    state: { reason: 'running', startedAt },
    updatedAt: startedAt,
  };
}

function expectEnqueueResultType<T extends EnqueueCommandResult['resultType']>(
  result: EnqueueCommandResult,
  resultType: T,
): asserts result is Extract<EnqueueCommandResult, { readonly resultType: T }> {
  expect(result.resultType).toBe(resultType);
}

function expectTransitionResultType<T extends RemoteFleetCommandTransitionResult['resultType']>(
  result: RemoteFleetCommandTransitionResult,
  resultType: T,
): asserts result is Extract<RemoteFleetCommandTransitionResult, { readonly resultType: T }> {
  expect(result.resultType).toBe(resultType);
}

describe('Remote Fleet command queue helper', () => {
  it('enqueues queued commands without mutating the input queue', () => {
    const commands = new Map<string, RemoteFleetCommandRecord>();
    const command = queuedCommand({ id: 'cmd-1' });

    const result = enqueue(commands, command);

    expect(result.resultType).toBe('enqueued');
    expect(result.reason).toBe('command-added');
    expect(result.commands.get('cmd-1')).toBe(command);
    expect(commands.has('cmd-1')).toBe(false);
  });

  it('deduplicates enqueue requests by idempotency key', () => {
    const existingCommand = queuedCommand({ id: 'cmd-1', idempotencyKey: 'idem:install-node-a' });
    const duplicateCommand = queuedCommand({ id: 'cmd-2', idempotencyKey: 'idem:install-node-a' });
    const commands = new Map([[existingCommand.id, existingCommand]]);

    const result = enqueue(commands, duplicateCommand);

    expectEnqueueResultType(result, 'deduplicated');
    expect(result.reason).toBe('idempotency-key-already-exists');
    expect(result.command).toBe(existingCommand);
    expect(result.duplicateCommand).toBe(duplicateCommand);
    expect(result.commands.has('cmd-2')).toBe(false);
  });

  it('removes duplicate idempotency keys while keeping the first command', () => {
    const retainedCommand = queuedCommand({ id: 'cmd-1', idempotencyKey: 'idem:install-node-a' });
    const duplicateCommand = runningCommand({ id: 'cmd-2', idempotencyKey: 'idem:install-node-a' });
    const otherCommand = queuedCommand({ id: 'cmd-3', idempotencyKey: 'idem:install-node-b' });
    const commands = new Map([
      [retainedCommand.id, retainedCommand],
      [duplicateCommand.id, duplicateCommand],
      [otherCommand.id, otherCommand],
    ]);

    const result = dedupeByIdempotencyKey(commands);

    expect(result.resultType).toBe('deduplicated');
    expect(result.reason).toBe('duplicate-idempotency-keys-removed');
    expect(result.duplicateCommands).toEqual([duplicateCommand]);
    expect(Array.from(result.commands.keys())).toEqual(['cmd-1', 'cmd-3']);
    expect(commands.has('cmd-2')).toBe(true);
  });

  it('moves a queued command through running and succeeded states', () => {
    const command = queuedCommand({ id: 'cmd-1' });
    const commands = new Map([[command.id, command]]);

    const runningResult = markRunning(commands, { commandId: command.id, now: runningAt });
    expectTransitionResultType(runningResult, 'transitioned');
    expect(runningResult.reason).toBe('queued-command-started');
    expect(runningResult.command.state).toEqual({ reason: 'running', startedAt: runningAt });

    const succeededResult = markSucceeded(runningResult.commands, { commandId: command.id, now: completedAt });
    expectTransitionResultType(succeededResult, 'transitioned');
    expect(succeededResult.reason).toBe('running-command-succeeded');
    expect(succeededResult.command.state).toEqual({ reason: 'succeeded', completedAt });
  });

  it('can retry a failed running command by returning it to queued state', () => {
    const command = runningCommand({ id: 'cmd-1' });
    const commands = new Map([[command.id, command]]);

    const result = markFailed(commands, {
      commandId: command.id,
      now: completedAt,
      message: 'Remote agent was busy.',
      retry: { retryType: 'retry' },
    });

    expectTransitionResultType(result, 'transitioned');
    expect(result.reason).toBe('running-command-retry-queued');
    expect(result.command.state).toEqual({ reason: 'queued', queuedAt: completedAt });
    expect(result.command.message).toBe('Remote agent was busy.');
  });

  it('marks active commands as timed out explicitly', () => {
    const command = runningCommand({ id: 'cmd-1' });
    const commands = new Map([[command.id, command]]);

    const result = markTimedOut(commands, { commandId: command.id, now: completedAt, timeoutMs: 60_000 });

    expectTransitionResultType(result, 'transitioned');
    expect(result.reason).toBe('running-command-timed-out');
    expect(result.command.state).toEqual({ reason: 'timed-out', completedAt, timeoutMs: 60_000 });
  });

  it('reaps queued and running commands whose active window exceeded timeout', () => {
    const queuedTimedOutCommand = queuedCommand({ id: 'cmd-queued', queuedAt: '2026-07-06T09:59:00.000Z' });
    const runningTimedOutCommand = runningCommand({ id: 'cmd-running', startedAt: '2026-07-06T10:00:30.000Z' });
    const freshCommand = runningCommand({ id: 'cmd-fresh', startedAt: '2026-07-06T10:01:30.000Z' });
    const commands = new Map([
      [queuedTimedOutCommand.id, queuedTimedOutCommand],
      [runningTimedOutCommand.id, runningTimedOutCommand],
      [freshCommand.id, freshCommand],
    ]);

    const result = reapTimedOut(commands, { now: completedAt, timeoutMs: 60_000 });

    expect(result.resultType).toBe('reaped');
    expect(result.reason).toBe('active-commands-timed-out');
    expect(result.timedOutCommands.map((command) => command.id)).toEqual(['cmd-queued', 'cmd-running']);
    expect(result.commands.get('cmd-queued')?.state).toEqual({ reason: 'timed-out', completedAt, timeoutMs: 60_000 });
    expect(result.commands.get('cmd-running')?.state).toEqual({ reason: 'timed-out', completedAt, timeoutMs: 60_000 });
    expect(result.commands.get('cmd-fresh')?.state).toEqual(freshCommand.state);
  });

  it('cancels queued commands without cancelling terminal commands', () => {
    const command = queuedCommand({ id: 'cmd-1' });
    const commands = new Map([[command.id, command]]);

    const cancelResult = cancel(commands, { commandId: command.id, now: completedAt, message: 'User cancelled.' });
    expectTransitionResultType(cancelResult, 'transitioned');
    expect(cancelResult.reason).toBe('queued-command-cancelled');
    expect(cancelResult.command.state).toEqual({ reason: 'cancelled', completedAt, message: 'User cancelled.' });

    const terminalCancelResult = cancel(cancelResult.commands, { commandId: command.id, now: completedAt });
    expectTransitionResultType(terminalCancelResult, 'unchanged');
    expect(terminalCancelResult.reason).toBe('command-already-cancelled');
  });

  it('rejects invalid state transitions', () => {
    const queued = queuedCommand({ id: 'cmd-1' });
    const succeeded = {
      ...queued,
      state: { reason: 'succeeded', completedAt } as const,
      updatedAt: completedAt,
    };
    const commands = new Map([[succeeded.id, succeeded]]);

    const result = markRunning(commands, { commandId: succeeded.id, now: runningAt });

    expectTransitionResultType(result, 'rejected');
    expect(result.reason).toBe('invalid-transition');
    expect(result.command).toBe(succeeded);
    expect(result.commands.get(succeeded.id)).toBe(succeeded);
  });
});
