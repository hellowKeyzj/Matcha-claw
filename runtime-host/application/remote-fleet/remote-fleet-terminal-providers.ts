import { EventEmitter } from 'node:events';
import type { RemoteFleetSecretResolveRequestInput } from './remote-fleet-secret-host-rpc';
import type { RemoteFleetTerminalSshEvent, RemoteFleetTerminalSshProvider } from './remote-fleet-terminal-ssh-provider';
import type {
  RemoteFleetTerminalProviderKind,
  RemoteFleetTerminalSessionTarget,
  RemoteFleetTerminalSize,
} from './remote-fleet-terminal-contracts';

export interface RemoteFleetTerminalSecretResolver {
  resolveSecret(input: RemoteFleetSecretResolveRequestInput):
    | Promise<{ readonly resultType: 'resolved'; readonly plaintextSecretValue: string } | { readonly resultType: 'notFound' | 'accessDenied' | 'unavailable' | 'invalidRequest' }>
    | { readonly resultType: 'resolved'; readonly plaintextSecretValue: string }
    | { readonly resultType: 'notFound' | 'accessDenied' | 'unavailable' | 'invalidRequest' };
}

export interface RemoteFleetTerminalOpenRequest extends RemoteFleetTerminalSessionTarget {
  readonly rows: number;
  readonly cols: number;
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
}

export interface RemoteFleetTerminalExitEvent {
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface RemoteFleetTerminalProviderStreamHandle {
  write(data: Uint8Array): void;
  resize(size: RemoteFleetTerminalSize): void;
  close(): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (event: RemoteFleetTerminalExitEvent) => void): void;
  onError(listener: (error: Error) => void): void;
  pause?(): void;
  resume?(): void;
}

export type RemoteFleetTerminalProviderOpenResult =
  | { readonly resultType: 'opened'; readonly handle: RemoteFleetTerminalProviderStreamHandle }
  | { readonly resultType: 'failed'; readonly message: string };

export interface RemoteFleetTerminalProvider {
  readonly providerKind: RemoteFleetTerminalProviderKind;
  open(input: RemoteFleetTerminalOpenRequest): Promise<RemoteFleetTerminalProviderOpenResult> | RemoteFleetTerminalProviderOpenResult;
}

export interface RemoteFleetTerminalProviderRegistry {
  getProvider(providerKind: RemoteFleetTerminalProviderKind): RemoteFleetTerminalProvider | undefined;
}

export function createRemoteFleetTerminalProviderRegistry(
  providers: readonly RemoteFleetTerminalProvider[],
): RemoteFleetTerminalProviderRegistry {
  const providersByKind = new Map<RemoteFleetTerminalProviderKind, RemoteFleetTerminalProvider>();
  for (const provider of providers) {
    providersByKind.set(provider.providerKind, provider);
  }
  return {
    getProvider(providerKind) {
      return providersByKind.get(providerKind);
    },
  };
}

export function adaptRemoteFleetSshTerminalProvider(provider: RemoteFleetTerminalSshProvider): RemoteFleetTerminalProvider {
  return {
    providerKind: provider.providerKind,
    async open(input) {
      if (!input.node) {
        return { resultType: 'failed', message: 'Remote Fleet SSH terminal provider requires node details.' };
      }
      const events = new EventEmitter();
      const result = await provider.openSession({
        terminalSessionId: input.session.id,
        node: input.node,
        rows: input.rows,
        cols: input.cols,
        onEvent: (event) => emitSshTerminalEvent(events, event),
      }, input.secretResolver ? { secretResolver: input.secretResolver } : undefined);
      if (result.resultType !== 'opened') {
        return { resultType: 'failed', message: result.message };
      }
      return {
        resultType: 'opened',
        handle: {
          write(data) {
            result.session.write(Buffer.from(data).toString('utf8'));
          },
          resize(size) {
            result.session.resize(size);
          },
          close() {
            result.session.close();
            events.removeAllListeners();
          },
          onData(listener) {
            events.on('data', listener);
          },
          onExit(listener) {
            events.on('exit', listener);
          },
          onError(listener) {
            events.on('error', listener);
          },
        },
      } satisfies RemoteFleetTerminalProviderOpenResult;
    },
  };
}

export function adaptRemoteFleetLegacyTerminalProvider(provider: {
  readonly providerKind: RemoteFleetTerminalProviderKind;
  openTerminal(input: { readonly node: { readonly id: string; readonly targetKind: string; readonly publicConfig: Readonly<Record<string, unknown>>; readonly secretRefs: Readonly<Record<string, unknown>> } }): Promise<unknown> | unknown;
}): RemoteFleetTerminalProvider {
  return {
    providerKind: provider.providerKind,
    async open(input) {
      const result = await provider.openTerminal({
        node: input.node ?? {
          id: input.session.nodeId,
          targetKind: input.session.targetKind,
          publicConfig: {},
          secretRefs: {},
        },
      });
      return adaptLegacyOpenResult(result);
    },
  };
}

function emitSshTerminalEvent(events: EventEmitter, event: RemoteFleetTerminalSshEvent): void {
  switch (event.type) {
    case 'data':
      events.emit('data', Buffer.from(event.data, 'utf8'));
      return;
    case 'error':
      events.emit('error', new Error(event.message));
      return;
    case 'exit':
      events.emit('exit', {
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.signal ? { signal: event.signal } : {}),
      } satisfies RemoteFleetTerminalExitEvent);
      return;
  }
}

function adaptLegacyOpenResult(result: unknown): RemoteFleetTerminalProviderOpenResult {
  if (!isRecord(result)) {
    return { resultType: 'failed', message: 'Remote Fleet terminal provider returned an invalid result.' };
  }
  if (result.resultType === 'failed') {
    return { resultType: 'failed', message: typeof result.message === 'string' ? result.message : 'Remote Fleet terminal provider failed to open a session.' };
  }
  if (result.resultType !== 'opened' || !isRecord(result.session)) {
    return { resultType: 'failed', message: 'Remote Fleet terminal provider did not open a session.' };
  }
  const session = result.session;
  if (typeof session.write !== 'function' || typeof session.resize !== 'function' || typeof session.close !== 'function') {
    return { resultType: 'failed', message: 'Remote Fleet terminal provider session is invalid.' };
  }
  const events = new EventEmitter();
  if (typeof session.onOutput === 'function') {
    session.onOutput((chunk: Uint8Array) => events.emit('data', chunk));
  }
  if (typeof session.onErrorOutput === 'function') {
    session.onErrorOutput((chunk: Uint8Array) => events.emit('data', chunk));
  }
  if (typeof session.onStatus === 'function') {
    session.onStatus((status: unknown) => {
      if (isRecord(status) && status.resultType === 'error' && typeof status.message === 'string') {
        events.emit('error', new Error(status.message));
      }
    });
  }
  if (typeof session.onClose === 'function') {
    session.onClose((event: unknown) => {
      const record = isRecord(event) ? event : {};
      events.emit('exit', {
        ...(typeof record.code === 'number' ? { exitCode: record.code } : {}),
        ...(typeof record.reason === 'string' ? { signal: record.reason } : {}),
      } satisfies RemoteFleetTerminalExitEvent);
    });
  }
  return {
    resultType: 'opened',
    handle: {
      write(data) {
        session.write(data);
      },
      resize(size) {
        session.resize(size);
      },
      close() {
        session.close();
      },
      onData(listener) {
        events.on('data', listener);
      },
      onExit(listener) {
        events.on('exit', listener);
      },
      onError(listener) {
        events.on('error', listener);
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
