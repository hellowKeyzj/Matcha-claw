import { availableParallelism } from 'node:os';
import type {
  AccessAdmission, AccessAdmitRequest, AccessCommand, AccessDiscoverRequest, AccessDiscovery,
  AccessResponse, AccessSnapshot,
} from '../../../src/types/resource-access';
import { admit, discover, snapshot } from './domain';
import { AccessError, failure, type FolderRegistration, type MemberCreation, type SharedFolderBinding } from './model';
import type { AccessStore } from './store';
import { parseAdmit, parseCommand, parseDiscover, parseFolderRegistration, parseMemberCreation } from './validation';

// Preserve the old Access owner's resident admission budget, not its worker machinery.
const MAX_PENDING = 192 + 3 * Math.max(1, availableParallelism() - 2);

export type AccessOwner = ReturnType<typeof createAccess>;

export function createAccess(options: { root: string }) {
  let store: Promise<AccessStore> | undefined;
  let operations = Promise.resolve();
  let pending = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const shutdown = new AbortController();
  const openStore = () => store ??= import('./store').then(({ AccessStore }) => AccessStore.open(options.root));

  function enqueue<T>(
    operation: (store: AccessStore) => T | Promise<T>,
    signal?: AbortSignal, kind: 'read' | 'mutation' = 'read',
  ): Promise<AccessResponse<T>> {
    if (closed || signal?.aborted || pending >= MAX_PENDING) return Promise.resolve(failure('unavailable'));
    const deadline = performance.now() + 10_000;
    const controller = new AbortController();
    const lifetime = signal ? AbortSignal.any([controller.signal, shutdown.signal, signal])
      : AbortSignal.any([controller.signal, shutdown.signal]);
    pending++;
    const work = operations.then(async (): Promise<AccessResponse<T>> => {
      // An admitted mutation is not rolled back just because its observer disconnected.
      if (kind !== 'mutation' && lifetime.aborted) return failure('unavailable');
      try {
        const database = await openStore();
        if (kind !== 'mutation' && (lifetime.aborted || performance.now() >= deadline)) return failure('unavailable');
        return { status: 200, body: await operation(database) };
      } catch (error) {
        return failure(error instanceof AccessError ? error.code : 'unavailable');
      }
    }).finally(() => { pending--; });
    // Reads, mutations and capability admission share one ordering boundary.
    operations = work.then(() => undefined, () => undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
      const aborted = () => resolve(failure(kind === 'mutation' ? 'outcome-unknown' : 'unavailable'));
      lifetime.addEventListener('abort', aborted, { once: true });
      if (lifetime.aborted) aborted();
      void work.then(resolve).finally(() => {
        clearTimeout(timer);
        lifetime.removeEventListener('abort', aborted);
      });
    });
  }

  function parse<T>(value: unknown, limit: number, decode: (value: unknown) => T): T {
    // Bound the wire size; the schema decoder returns a detached request for queueing.
    try {
      const json = JSON.stringify(value);
      if (json === undefined || Buffer.byteLength(json) > limit) throw new AccessError('invalid-request');
      return decode(value);
    } catch { throw new AccessError('invalid-request'); }
  }

  function withBody<T, R>(body: unknown, limit: number, decode: (value: unknown) => T,
    action: (value: T) => Promise<AccessResponse<R>>): Promise<AccessResponse<R>> {
    try { return action(parse(body, limit, decode)); }
    catch { return Promise.resolve(failure('invalid-request')); }
  }

  return {
    read(signal?: AbortSignal): Promise<AccessResponse<AccessSnapshot>> {
      return enqueue((database) => snapshot(database.read()), signal);
    },
    command(body: AccessCommand, signal?: AbortSignal): Promise<AccessResponse<AccessSnapshot>> {
      return withBody(body, 64 * 1024, parseCommand,
        (command) => enqueue((database) => snapshot(database.mutate(command)), signal, 'mutation'));
    },
    createMember(body: MemberCreation, signal?: AbortSignal): Promise<AccessResponse<AccessSnapshot>> {
      return withBody(body, 64 * 1024, parseMemberCreation,
        ({ expectedRevision, name, credential }) => enqueue((database) => snapshot(database.mutate({
          expectedRevision, change: { kind: 'member.create', name, credential },
        })), signal, 'mutation'));
    },
    folders(signal?: AbortSignal): Promise<AccessResponse<SharedFolderBinding[]>> {
      return enqueue((database) => database.read().facts.resources.flatMap((resource) => resource.folder ? [{ ...resource.folder }] : []), signal);
    },
    registerFolder(body: FolderRegistration, signal?: AbortSignal): Promise<AccessResponse<AccessSnapshot>> {
      return withBody(body, 256 * 1024, parseFolderRegistration,
        ({ expectedRevision, resources }) => enqueue((database) => snapshot(database.mutate({
          expectedRevision, change: { kind: 'resource.folder', resources },
        })), signal, 'mutation'));
    },
    discover(body: AccessDiscoverRequest, signal?: AbortSignal): Promise<AccessResponse<AccessDiscovery>> {
      return withBody(body, 16 * 1024, parseDiscover,
        (request) => enqueue((database) => discover(database.read().facts, request), signal));
    },
    admit(body: AccessAdmitRequest, signal?: AbortSignal): Promise<AccessResponse<AccessAdmission>> {
      return withBody(body, 16 * 1024, parseAdmit,
        (request) => enqueue((database) => admit(database.read().facts, request), signal));
    },
    close(): Promise<void> {
      closed = true;
      shutdown.abort();
      closing ??= operations.then(async () => {
        const database = await store?.catch(() => undefined);
        database?.close();
      }).catch((error) => { closing = undefined; throw error; });
      return closing;
    },
  };
}
