import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dialog, type BrowserWindow, type IpcMainInvokeEvent, type OpenDialogReturnValue } from 'electron';
import type { CommitReceipt, FailureStage, WorldRef } from '../../../src/types/world';
import type { WorldAccessIdentity, WorldAccessImportResult, WorldAccessIssue, WorldAccessPrepareResult } from '../../../src/types/world-access';
import {
  isRuntimeHostControlCommand, MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES, RuntimeHostControlError,
  type RuntimeHostControlOutcome, type WorldAccessGrantRequest,
} from '../runtime-host-delivery/control';
import { RuntimeHostLifecycleUnavailableError } from '../runtime-host-delivery/lifecycle-owner';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { parseWorldControlFailure } from './control-failure';
import { isWorldRef } from './events';
import {
  trustedWorldWindow, worldPrivateAdmission, WorldPrivateAdmissionError, type WorldPrivateAdmissionDependencies,
} from './private-admission';
import type { WorldStorageControl } from './storage-transfer';

type MainReason = Extract<WorldAccessIssue, { source: 'main' }>['reason'];
type DocumentBinding = Readonly<{ assert: (event: IpcMainInvokeEvent) => void; dispose: () => void }>;
type Ticket = Readonly<{
  token: string; input: WorldAccessGrantRequest; document: DocumentBinding;
  expiresAt: number; timer: ReturnType<typeof setTimeout>;
}>;
const TICKET_TTL_MS = 5 * 60 * 1000;
class WorldAccessImportError extends Error {
  constructor(readonly issue: WorldAccessIssue) { super(issue.code); }
}
export function worldAccessIssue(reason: MainReason, stage: FailureStage): WorldAccessIssue {
  return { source: 'main', reason, code: `world.access.${reason.replaceAll('-', '_')}`, stage,
    diagnosticId: randomUUID(), recovery: { kind: 'none' }, details: { kind: 'internal_fault' } };
}

/** Only native-selected administrator input can reach the existing root-only grant control. */
export function createWorldAccessImport(
  control: Promise<WorldStorageControl>, signal: AbortSignal, deps: WorldPrivateAdmissionDependencies,
): Readonly<{
  prepare: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<WorldAccessPrepareResult>;
  commit: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<WorldAccessImportResult>;
  close: () => void;
}> {
  const originals = new Map<string, WorldAccessGrantRequest>();
  let ticket: Ticket | undefined;
  let closed = false;
  function release(): void {
    if (!ticket) return;
    clearTimeout(ticket.timer);
    ticket.document.dispose();
    ticket = undefined;
  }
  const abort = addAbortListener(signal, () => { closed = true; release(); });
  return { prepare, commit, close: () => { closed = true; release(); abort[Symbol.dispose](); } };

  async function prepare(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldAccessPrepareResult> {
    if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], ['world']) || !isWorldRef(args[0].world)) {
      return { outcome: 'not-attempted', error: worldAccessIssue('invalid-request', 'decode') };
    }
    const world = args[0].world;
    const worldKey = JSON.stringify([world.tenantId, world.worldId]);
    let document: DocumentBinding | undefined;
    let issue = worldAccessIssue('configuration-unavailable', 'read');
    try {
      document = bindDocument(event, deps);
      const boundDocument = document;
      const callerAdmission = worldPrivateAdmission(event, signal, deps);
      const admit = async () => {
        await callerAdmission();
        if (closed) throw new WorldPrivateAdmissionError('authorization-denied');
        boundDocument.assert(event);
      };
      await admit();
      release();
      const window = trustedWorldWindow(event, deps.getMainWindow);
      if (!window) throw new WorldPrivateAdmissionError('authorization-denied');
      const selected = await selectGrant(window, signal);
      await admit();
      if (selected.canceled) return { outcome: 'cancel' };
      if (selected.filePaths.length !== 1) throw new WorldAccessImportError(worldAccessIssue('invalid-request', 'decode'));
      const input = await readGrant(selected.filePaths[0]);
      await admit();
      issue = worldAccessIssue('configuration-invalid', 'validate');
      const command = { name: 'world.access.grant', input };
      if (!isRuntimeHostControlCommand(command) || command.name !== 'world.access.grant') {
        throw new WorldAccessImportError(worldAccessIssue('configuration-invalid', 'validate'));
      }
      if (!sameWorld(command.input.world, world)) throw new WorldAccessImportError(worldAccessIssue('world-mismatch', 'validate'));
      const original = originals.get(worldKey);
      if (original && !isDeepStrictEqual(original, command.input)) {
        throw new WorldAccessImportError(worldAccessIssue('configuration-invalid', 'validate'));
      }
      issue = controlIssue('host-unavailable', 'UNAVAILABLE');
      await control;
      await admit();
      const token = randomUUID();
      const timer = setTimeout(() => { if (ticket?.token === token) release(); }, TICKET_TTL_MS);
      timer.unref();
      ticket = { token, input: command.input, document: boundDocument, expiresAt: Date.now() + TICKET_TTL_MS, timer };
      document = undefined;
      return { outcome: 'prepared', ticket: token, summary: { world: command.input.world, commitId: command.input.commitId,
        grantId: command.input.id, preview: JSON.stringify(command.input, null, 2) } };
    } catch (error) {
      if (error instanceof WorldPrivateAdmissionError) issue = worldAccessIssue(error.reason, 'admission');
      else if (error instanceof WorldAccessImportError) issue = error.issue;
      return { outcome: 'not-attempted', error: issue };
    } finally { document?.dispose(); }
  }

  async function commit(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldAccessImportResult> {
    if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], ['world', 'ticket', 'accept'])
      || !isWorldRef(args[0].world) || typeof args[0].ticket !== 'string' || typeof args[0].accept !== 'boolean') {
      return { outcome: 'not-attempted', error: worldAccessIssue('invalid-request', 'decode') };
    }
    const world = args[0].world;
    const token = args[0].ticket;
    const accept = args[0].accept;
    const worldKey = JSON.stringify([world.tenantId, world.worldId]);
    let consumed: Ticket | undefined;
    let dispatched: WorldAccessGrantRequest | undefined;
    let issue = worldAccessIssue('ticket-invalid', 'admission');
    try {
      const callerAdmission = worldPrivateAdmission(event, signal, deps);
      await callerAdmission();
      if (closed) throw new WorldPrivateAdmissionError('authorization-denied');
      const current = ticket;
      if (!current || current.token !== token || !sameWorld(current.input.world, world)) {
        throw new WorldAccessImportError(worldAccessIssue('ticket-invalid', 'admission'));
      }
      current.document.assert(event);
      if (Date.now() >= current.expiresAt) {
        release();
        throw new WorldAccessImportError(worldAccessIssue('ticket-expired', 'admission'));
      }
      ticket = undefined;
      clearTimeout(current.timer);
      consumed = current;
      if (!accept) return { outcome: 'cancel' };
      const admit = async () => {
        await callerAdmission();
        if (closed) throw new WorldPrivateAdmissionError('authorization-denied');
        current.document.assert(event);
        if (Date.now() >= current.expiresAt) throw new WorldAccessImportError(worldAccessIssue('ticket-expired', 'admission'));
      };
      await admit();
      issue = controlIssue('host-unavailable', 'UNAVAILABLE');
      const host = await control;
      await admit();
      const command = { name: 'world.access.grant', input: current.input };
      if (!isRuntimeHostControlCommand(command) || command.name !== 'world.access.grant') {
        throw new WorldAccessImportError(worldAccessIssue('configuration-invalid', 'validate'));
      }
      if (originals.has(worldKey) && !isDeepStrictEqual(originals.get(worldKey), command.input)) {
        throw new WorldAccessImportError(worldAccessIssue('configuration-invalid', 'validate'));
      }
      // Keep the exact original before invoking the mutating control; a lost observer cannot replace it.
      originals.set(worldKey, command.input);
      dispatched = command.input;
      const result = await grantAccess(host, command.input);
      if (result.outcome === 'confirmed' || result.outcome === 'rejected') originals.delete(worldKey);
      return result;
    } catch (error) {
      if (dispatched) {
        const identity: WorldAccessIdentity = { world: dispatched.world, commitId: dispatched.commitId, grantId: dispatched.id };
        return { ...identity, outcome: 'unknown', error: controlIssue('unknown-delivery', 'CONTRACT_DATA', identity) };
      }
      if (error instanceof WorldPrivateAdmissionError) issue = worldAccessIssue(error.reason, 'admission');
      else if (error instanceof WorldAccessImportError) issue = error.issue;
      return { outcome: 'not-attempted', error: issue };
    } finally { consumed?.document.dispose(); }
  }
}

async function grantAccess(host: WorldStorageControl, input: WorldAccessGrantRequest): Promise<WorldAccessImportResult> {
  const identity: WorldAccessIdentity = { world: input.world, commitId: input.commitId, grantId: input.id };
  let outcome: RuntimeHostControlOutcome;
  try { outcome = await host.command({ name: 'world.access.grant', input }); }
  catch (error) {
    if (error instanceof RuntimeHostControlError) {
      const issue = controlIssue(error.delivery, error.kind, identity);
      return error.delivery === 'not-delivered' ? { outcome: 'not-attempted', error: issue }
        : { ...identity, outcome: 'unknown', error: issue };
    }
    if (error instanceof RuntimeHostLifecycleUnavailableError) {
      return { outcome: 'not-attempted', error: controlIssue('host-unavailable', error.code) };
    }
    // An exception after invoking a mutating command cannot prove that it was not delivered.
    return { ...identity, outcome: 'unknown', error: controlIssue('unknown-delivery', 'UNAVAILABLE', identity) };
  }
  if (outcome.kind === 'rejected') {
    return { ...identity, outcome: 'rejected', error: controlIssue('control-rejected', outcome.error.code) };
  }
  if (outcome.kind === 'timed-out') {
    return { ...identity, outcome: 'unknown', error: controlIssue('timed-out', 'TIMEOUT', identity) };
  }
  const body = outcome.result;
  if (isRecord(body) && hasExactKeys(body, ['success', 'error']) && body.success === false) {
    const failure = parseWorldControlFailure(body.error);
    if (failure) return { ...identity, outcome: outcome.kind === 'unknown' ? 'unknown' : 'rejected',
      error: { source: 'world', reason: outcome.kind === 'unknown' ? 'outcome-unknown' : 'world-rejected', ...failure } };
  }
  if (outcome.kind === 'unknown') {
    return { ...identity, outcome: 'unknown', error: controlIssue('outcome-unknown', 'CONTRACT_DATA', identity) };
  }
  if (isRecord(body) && hasExactKeys(body, ['success', 'data']) && body.success === true && grantReceipt(body.data, identity)) {
    return { ...identity, outcome: 'confirmed', receipt: body.data };
  }
  return { ...identity, outcome: 'unknown', error: { ...worldAccessIssue('receipt-unconfirmed', 'verify'),
    recovery: { kind: 'read_commit', commitId: identity.commitId } } };
}

function controlIssue(
  reason: Extract<WorldAccessIssue, { source: 'control' }>['reason'], code: string, identity?: WorldAccessIdentity,
): WorldAccessIssue {
  return { source: 'control', reason, code: `world.access.control.${code}`, stage: 'execute', diagnosticId: randomUUID(),
    recovery: identity ? { kind: 'read_commit', commitId: identity.commitId } : { kind: 'none' },
    details: { kind: 'transport', failure: code === 'frame-too-large' ? 'size_limit'
      : code === 'command-invalid' || code === 'protocol-invalid' || code === 'INVALID_INPUT' || code === 'CONTRACT_DATA' ? 'contract_data' : 'disconnected' } };
}

function bindDocument(event: IpcMainInvokeEvent, deps: WorldPrivateAdmissionDependencies): DocumentBinding {
  const window = trustedWorldWindow(event, deps.getMainWindow);
  const frame = event.senderFrame;
  if (!window || !frame || frame.isDestroyed()) throw new WorldPrivateAdmissionError('authorization-denied');
  const sender = event.sender;
  const frameToken = frame.frameToken;
  const processId = frame.processId;
  let live = true;
  const invalidate = () => { live = false; };
  const navigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => { if (details.isMainFrame) invalidate(); };
  sender.on('did-start-navigation', navigation);
  sender.on('destroyed', invalidate);
  sender.on('render-process-gone', invalidate);
  return {
    assert: (caller) => {
      if (!live || trustedWorldWindow(caller, deps.getMainWindow) !== window || caller.sender !== sender
        || caller.senderFrame !== frame || frame.isDestroyed() || sender.mainFrame !== frame
        || frame.frameToken !== frameToken || frame.processId !== processId) throw new WorldPrivateAdmissionError('authorization-denied');
    },
    dispose: () => {
      live = false;
      sender.removeListener('did-start-navigation', navigation);
      sender.removeListener('destroyed', invalidate);
      sender.removeListener('render-process-gone', invalidate);
    },
  };
}

async function readGrant(path: string): Promise<unknown> {
  let file;
  try { file = await open(path, 'r'); }
  catch { throw new WorldAccessImportError(worldAccessIssue('configuration-unavailable', 'read')); }
  try {
    if (!(await file.stat()).isFile()) throw new WorldAccessImportError(worldAccessIssue('configuration-invalid', 'read'));
    const bytes = Buffer.alloc(MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    try {
      if (size === 0 || size > MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES) throw new Error();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
    } catch { throw new WorldAccessImportError(worldAccessIssue('configuration-invalid', 'decode')); }
  } finally { await file.close(); }
}

async function selectGrant(window: BrowserWindow, signal: AbortSignal): Promise<OpenDialogReturnValue> {
  let abort!: ReturnType<typeof addAbortListener>;
  const cancelled = new Promise<OpenDialogReturnValue>((resolve) => {
    abort = addAbortListener(signal, () => resolve({ canceled: true, filePaths: [] }));
  });
  try {
    return await Promise.race([cancelled, dialog.showOpenDialog(window, {
      title: '导入管理员提供的增量授权', properties: ['openFile'], filters: [{ name: 'World GrantRequest', extensions: ['json'] }],
    })]);
  } finally { abort[Symbol.dispose](); }
}

function grantReceipt(value: unknown, identity: WorldAccessIdentity): value is CommitReceipt {
  return isRecord(value) && hasExactKeys(value, ['world', 'commitId', 'committedAt', 'revisions', 'outboxIds', 'fence'])
    && isWorldRef(value.world) && sameWorld(value.world, identity.world) && value.commitId === identity.commitId
    && typeof value.committedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(value.committedAt)
    && Number.isFinite(Date.parse(value.committedAt))
    // The existing grant owner only writes authorization rows, without resource revisions or outbox events.
    && Array.isArray(value.revisions) && value.revisions.length === 0 && Array.isArray(value.outboxIds) && value.outboxIds.length === 0
    && isRecord(value.fence) && hasExactKeys(value.fence, ['world', 'domain', 'epoch'])
    && isWorldRef(value.fence.world) && sameWorld(value.fence.world, identity.world) && value.fence.domain === 'authorization'
    && typeof value.fence.epoch === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value.fence.epoch)
    && BigInt(value.fence.epoch) <= 18_446_744_073_709_551_615n;
}
function sameWorld(left: WorldRef, right: WorldRef): boolean { return left.tenantId === right.tenantId && left.worldId === right.worldId; }
