import type {
  RemoteFleetCommandRecord,
  RemoteFleetCommandState,
} from './remote-fleet-model';

export type RemoteFleetCommandQueue = ReadonlyMap<string, RemoteFleetCommandRecord>;
export type MutableRemoteFleetCommandQueue = Map<string, RemoteFleetCommandRecord>;

type ActiveRemoteFleetCommandState = Extract<
  RemoteFleetCommandState,
  { readonly reason: 'queued' | 'running' }
>;

export type EnqueueCommandResult =
  | {
      readonly resultType: 'enqueued';
      readonly reason: 'command-added';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly command: RemoteFleetCommandRecord;
    }
  | {
      readonly resultType: 'deduplicated';
      readonly reason: 'idempotency-key-already-exists';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly command: RemoteFleetCommandRecord;
      readonly duplicateCommand: RemoteFleetCommandRecord;
    }
  | {
      readonly resultType: 'rejected';
      readonly reason: 'missing-idempotency-key' | 'command-id-already-exists' | 'command-is-not-queued';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly command: RemoteFleetCommandRecord;
    };

export type RemoteFleetCommandTransitionResult =
  | {
      readonly resultType: 'transitioned';
      readonly reason:
        | 'queued-command-started'
        | 'running-command-succeeded'
        | 'running-command-failed'
        | 'running-command-retry-queued'
        | 'queued-command-cancelled'
        | 'running-command-cancelled'
        | 'queued-command-timed-out'
        | 'running-command-timed-out';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly command: RemoteFleetCommandRecord;
    }
  | {
      readonly resultType: 'unchanged';
      readonly reason:
        | 'command-already-running'
        | 'command-already-succeeded'
        | 'command-already-failed'
        | 'command-already-cancelled'
        | 'command-already-timed-out';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly command: RemoteFleetCommandRecord;
    }
  | {
      readonly resultType: 'notFound';
      readonly reason: 'command-not-found';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly commandId: string;
    }
  | {
      readonly resultType: 'rejected';
      readonly reason: 'invalid-transition' | 'invalid-timeout-ms';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly command: RemoteFleetCommandRecord;
    };

export type RemoteFleetCommandRetryDecision =
  | { readonly retryType: 'fail' }
  | { readonly retryType: 'retry'; readonly queuedAt?: string };

export type ReapTimedOutCommandsResult =
  | {
      readonly resultType: 'reaped';
      readonly reason: 'active-commands-timed-out';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly timedOutCommands: readonly RemoteFleetCommandRecord[];
    }
  | {
      readonly resultType: 'unchanged';
      readonly reason: 'no-active-command-timed-out';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly timedOutCommands: readonly RemoteFleetCommandRecord[];
    }
  | {
      readonly resultType: 'rejected';
      readonly reason: 'invalid-now' | 'invalid-timeout-ms';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly timedOutCommands: readonly RemoteFleetCommandRecord[];
    };

export type DedupeByIdempotencyKeyResult =
  | {
      readonly resultType: 'unchanged';
      readonly reason: 'no-duplicate-idempotency-keys';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly duplicateCommands: readonly RemoteFleetCommandRecord[];
    }
  | {
      readonly resultType: 'deduplicated';
      readonly reason: 'duplicate-idempotency-keys-removed';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly duplicateCommands: readonly RemoteFleetCommandRecord[];
    }
  | {
      readonly resultType: 'rejected';
      readonly reason: 'missing-idempotency-key';
      readonly commands: MutableRemoteFleetCommandQueue;
      readonly duplicateCommands: readonly RemoteFleetCommandRecord[];
    };

export function enqueue(
  commands: RemoteFleetCommandQueue,
  command: RemoteFleetCommandRecord,
): EnqueueCommandResult {
  const clonedCommands = cloneCommandQueue(commands);

  if (!hasIdempotencyKey(command)) {
    return { resultType: 'rejected', reason: 'missing-idempotency-key', commands: clonedCommands, command };
  }

  if (command.state.reason !== 'queued') {
    return { resultType: 'rejected', reason: 'command-is-not-queued', commands: clonedCommands, command };
  }

  const duplicateCommand = findCommandByIdempotencyKey(commands, command.idempotencyKey);
  if (duplicateCommand) {
    return {
      resultType: 'deduplicated',
      reason: 'idempotency-key-already-exists',
      commands: clonedCommands,
      command: duplicateCommand,
      duplicateCommand: command,
    };
  }

  if (commands.has(command.id)) {
    return { resultType: 'rejected', reason: 'command-id-already-exists', commands: clonedCommands, command };
  }

  clonedCommands.set(command.id, command);
  return { resultType: 'enqueued', reason: 'command-added', commands: clonedCommands, command };
}

export function markRunning(
  commands: RemoteFleetCommandQueue,
  input: { readonly commandId: string; readonly now: string },
): RemoteFleetCommandTransitionResult {
  const command = commands.get(input.commandId);
  if (!command) {
    return commandNotFound(commands, input.commandId);
  }

  if (command.state.reason === 'running') {
    return commandUnchanged(commands, command, 'command-already-running');
  }

  if (command.state.reason !== 'queued') {
    return invalidTransition(commands, command);
  }

  return transitionCommand(commands, {
    ...command,
    state: { reason: 'running', startedAt: input.now },
    updatedAt: input.now,
  }, 'queued-command-started');
}

export function markSucceeded(
  commands: RemoteFleetCommandQueue,
  input: { readonly commandId: string; readonly now: string },
): RemoteFleetCommandTransitionResult {
  const command = commands.get(input.commandId);
  if (!command) {
    return commandNotFound(commands, input.commandId);
  }

  if (command.state.reason === 'succeeded') {
    return commandUnchanged(commands, command, 'command-already-succeeded');
  }

  if (command.state.reason !== 'running') {
    return invalidTransition(commands, command);
  }

  return transitionCommand(commands, {
    ...command,
    state: { reason: 'succeeded', completedAt: input.now },
    updatedAt: input.now,
  }, 'running-command-succeeded');
}

export function markFailed(
  commands: RemoteFleetCommandQueue,
  input: {
    readonly commandId: string;
    readonly now: string;
    readonly message: string;
    readonly retry?: RemoteFleetCommandRetryDecision;
  },
): RemoteFleetCommandTransitionResult {
  const command = commands.get(input.commandId);
  if (!command) {
    return commandNotFound(commands, input.commandId);
  }

  if (command.state.reason === 'failed') {
    return commandUnchanged(commands, command, 'command-already-failed');
  }

  if (command.state.reason !== 'running') {
    return invalidTransition(commands, command);
  }

  if (input.retry?.retryType === 'retry') {
    return transitionCommand(commands, {
      ...command,
      state: { reason: 'queued', queuedAt: input.retry.queuedAt ?? input.now },
      updatedAt: input.now,
      message: input.message,
    }, 'running-command-retry-queued');
  }

  return transitionCommand(commands, {
    ...command,
    state: { reason: 'failed', completedAt: input.now, message: input.message },
    updatedAt: input.now,
    message: input.message,
  }, 'running-command-failed');
}

export function markTimedOut(
  commands: RemoteFleetCommandQueue,
  input: { readonly commandId: string; readonly now: string; readonly timeoutMs: number },
): RemoteFleetCommandTransitionResult {
  const command = commands.get(input.commandId);
  if (!command) {
    return commandNotFound(commands, input.commandId);
  }

  if (!isValidTimeoutMs(input.timeoutMs)) {
    return { resultType: 'rejected', reason: 'invalid-timeout-ms', commands: cloneCommandQueue(commands), command };
  }

  if (command.state.reason === 'timed-out') {
    return commandUnchanged(commands, command, 'command-already-timed-out');
  }

  if (!isActiveCommandState(command.state)) {
    return invalidTransition(commands, command);
  }

  return transitionCommand(commands, {
    ...command,
    state: { reason: 'timed-out', completedAt: input.now, timeoutMs: input.timeoutMs },
    updatedAt: input.now,
  }, command.state.reason === 'queued' ? 'queued-command-timed-out' : 'running-command-timed-out');
}

export function cancel(
  commands: RemoteFleetCommandQueue,
  input: { readonly commandId: string; readonly now: string; readonly message?: string },
): RemoteFleetCommandTransitionResult {
  const command = commands.get(input.commandId);
  if (!command) {
    return commandNotFound(commands, input.commandId);
  }

  if (command.state.reason === 'cancelled') {
    return commandUnchanged(commands, command, 'command-already-cancelled');
  }

  if (!isActiveCommandState(command.state)) {
    return invalidTransition(commands, command);
  }

  return transitionCommand(commands, {
    ...command,
    state: { reason: 'cancelled', completedAt: input.now, ...(input.message ? { message: input.message } : {}) },
    updatedAt: input.now,
    ...(input.message ? { message: input.message } : {}),
  }, command.state.reason === 'queued' ? 'queued-command-cancelled' : 'running-command-cancelled');
}

export function reapTimedOut(
  commands: RemoteFleetCommandQueue,
  input: { readonly now: string; readonly timeoutMs: number },
): ReapTimedOutCommandsResult {
  const clonedCommands = cloneCommandQueue(commands);
  const nowMs = Date.parse(input.now);

  if (!Number.isFinite(nowMs)) {
    return { resultType: 'rejected', reason: 'invalid-now', commands: clonedCommands, timedOutCommands: [] };
  }

  if (!isValidTimeoutMs(input.timeoutMs)) {
    return { resultType: 'rejected', reason: 'invalid-timeout-ms', commands: clonedCommands, timedOutCommands: [] };
  }

  const timedOutCommands: RemoteFleetCommandRecord[] = [];
  for (const command of commands.values()) {
    if (!isCommandTimedOut(command, nowMs, input.timeoutMs)) {
      continue;
    }

    const timedOutCommand: RemoteFleetCommandRecord = {
      ...command,
      state: { reason: 'timed-out', completedAt: input.now, timeoutMs: input.timeoutMs },
      updatedAt: input.now,
    };
    clonedCommands.set(timedOutCommand.id, timedOutCommand);
    timedOutCommands.push(timedOutCommand);
  }

  if (timedOutCommands.length === 0) {
    return {
      resultType: 'unchanged',
      reason: 'no-active-command-timed-out',
      commands: clonedCommands,
      timedOutCommands,
    };
  }

  return {
    resultType: 'reaped',
    reason: 'active-commands-timed-out',
    commands: clonedCommands,
    timedOutCommands,
  };
}

export function dedupeByIdempotencyKey(commands: RemoteFleetCommandQueue): DedupeByIdempotencyKeyResult {
  const clonedCommands = cloneCommandQueue(commands);
  const retainedCommandsByIdempotencyKey = new Map<string, RemoteFleetCommandRecord>();
  const duplicateCommands: RemoteFleetCommandRecord[] = [];

  for (const command of commands.values()) {
    if (!hasIdempotencyKey(command)) {
      return {
        resultType: 'rejected',
        reason: 'missing-idempotency-key',
        commands: clonedCommands,
        duplicateCommands,
      };
    }

    if (retainedCommandsByIdempotencyKey.has(command.idempotencyKey)) {
      duplicateCommands.push(command);
      continue;
    }

    retainedCommandsByIdempotencyKey.set(command.idempotencyKey, command);
  }

  if (duplicateCommands.length === 0) {
    return {
      resultType: 'unchanged',
      reason: 'no-duplicate-idempotency-keys',
      commands: clonedCommands,
      duplicateCommands,
    };
  }

  return {
    resultType: 'deduplicated',
    reason: 'duplicate-idempotency-keys-removed',
    commands: new Map(Array.from(retainedCommandsByIdempotencyKey.values()).map((command) => [command.id, command])),
    duplicateCommands,
  };
}

function cloneCommandQueue(commands: RemoteFleetCommandQueue): MutableRemoteFleetCommandQueue {
  return new Map(commands);
}

function findCommandByIdempotencyKey(
  commands: RemoteFleetCommandQueue,
  idempotencyKey: string,
): RemoteFleetCommandRecord | null {
  for (const command of commands.values()) {
    if (command.idempotencyKey === idempotencyKey) {
      return command;
    }
  }
  return null;
}

function hasIdempotencyKey(command: RemoteFleetCommandRecord): boolean {
  return command.idempotencyKey.trim().length > 0;
}

function commandNotFound(
  commands: RemoteFleetCommandQueue,
  commandId: string,
): RemoteFleetCommandTransitionResult {
  return {
    resultType: 'notFound',
    reason: 'command-not-found',
    commands: cloneCommandQueue(commands),
    commandId,
  };
}

function commandUnchanged(
  commands: RemoteFleetCommandQueue,
  command: RemoteFleetCommandRecord,
  reason: Extract<RemoteFleetCommandTransitionResult, { readonly resultType: 'unchanged' }>['reason'],
): RemoteFleetCommandTransitionResult {
  return { resultType: 'unchanged', reason, commands: cloneCommandQueue(commands), command };
}

function invalidTransition(
  commands: RemoteFleetCommandQueue,
  command: RemoteFleetCommandRecord,
): RemoteFleetCommandTransitionResult {
  return { resultType: 'rejected', reason: 'invalid-transition', commands: cloneCommandQueue(commands), command };
}

function transitionCommand(
  commands: RemoteFleetCommandQueue,
  command: RemoteFleetCommandRecord,
  reason: Extract<RemoteFleetCommandTransitionResult, { readonly resultType: 'transitioned' }>['reason'],
): RemoteFleetCommandTransitionResult {
  const nextCommands = cloneCommandQueue(commands);
  nextCommands.set(command.id, command);
  return { resultType: 'transitioned', reason, commands: nextCommands, command };
}

function isActiveCommandState(state: RemoteFleetCommandState): state is ActiveRemoteFleetCommandState {
  return state.reason === 'queued' || state.reason === 'running';
}

function isCommandTimedOut(
  command: RemoteFleetCommandRecord,
  nowMs: number,
  timeoutMs: number,
): boolean {
  if (!isActiveCommandState(command.state)) {
    return false;
  }

  const activeSince = command.state.reason === 'queued'
    ? command.state.queuedAt
    : command.state.startedAt;
  const activeSinceMs = Date.parse(activeSince);
  return Number.isFinite(activeSinceMs) && activeSinceMs + timeoutMs <= nowMs;
}

function isValidTimeoutMs(timeoutMs: number): boolean {
  return Number.isFinite(timeoutMs) && timeoutMs >= 0;
}
