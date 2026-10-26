import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { dialog, type BrowserWindow, type IpcMainInvokeEvent, type OpenDialogReturnValue } from 'electron';
import type { CommitReceipt, FailureStage, WorldRef } from '../../../src/types/world';
import type {
  WorldEvaluationCommitResult, WorldEvaluationIdentity, WorldEvaluationIssue, WorldEvaluationPrepareResult,
  WorldEvaluationStatusResult, WorldEvaluationSummary,
} from '../../../src/types/world-evaluation';
import {
  isRuntimeHostControlCommand, RuntimeHostControlError, type RuntimeHostControlCommand,
  type RuntimeHostControlOutcome, type WorldEvaluationConfiguration,
} from '../runtime-host-delivery/control';
import { RuntimeHostLifecycleUnavailableError } from '../runtime-host-delivery/lifecycle-owner';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { parseWorldControlFailure } from './control-failure';
import {
  clearWorldEvaluationOriginal, readWorldEvaluationImport, readWorldEvaluationOriginal,
  saveWorldEvaluationOriginal, WorldEvaluationConfigurationError,
} from './evaluation-config';
import { isWorldRef } from './events';
import {
  trustedWorldWindow, worldPrivateAdmission, WorldPrivateAdmissionError, type WorldPrivateAdmissionDependencies,
} from './private-admission';
import type { WorldStorageControl } from './storage-transfer';

type MainReason = Extract<WorldEvaluationIssue, { source: 'main' }>['reason'];
type DocumentBinding = Readonly<{ assert: (event: IpcMainInvokeEvent) => void; dispose: () => void }>;
type Ticket = Readonly<{
  token: string; configuration: WorldEvaluationConfiguration; document: DocumentBinding;
  expiresAt: number; timer: ReturnType<typeof setTimeout>;
}>;
const TICKET_TTL_MS = 5 * 60 * 1000;
class WorldEvaluationImportError extends Error {
  constructor(readonly issue: WorldEvaluationIssue) { super(issue.code); }
}
export function worldEvaluationIssue(reason: MainReason, stage: FailureStage): WorldEvaluationIssue {
  return { source: 'main', reason, code: `world.evaluation.${reason.replaceAll('-', '_')}`, stage,
    diagnosticId: randomUUID(), recovery: { kind: 'none' }, details: { kind: 'internal_fault' } };
}

/** Full administrator input stays in Main/Host. A ticket is only local caller confirmation. */
export function createWorldEvaluationImport(
  control: Promise<WorldStorageControl>, signal: AbortSignal, deps: WorldPrivateAdmissionDependencies,
): Readonly<{
  prepare: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<WorldEvaluationPrepareResult>;
  commit: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<WorldEvaluationCommitResult>;
  status: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<WorldEvaluationStatusResult>;
  close: () => void;
}> {
  let ticket: Ticket | undefined;
  let closed = false;
  function release(): void {
    if (!ticket) return;
    clearTimeout(ticket.timer);
    ticket.document.dispose();
    ticket = undefined;
  }
  const abort = addAbortListener(signal, () => { closed = true; release(); });
  return { prepare, commit, status, close: () => { closed = true; release(); abort[Symbol.dispose](); } };

  async function prepare(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldEvaluationPrepareResult> {
    const world = intentWorld(args);
    if (!world) return { outcome: 'not-attempted', error: worldEvaluationIssue('invalid-request', 'decode') };
    let document: DocumentBinding | undefined;
    let issue = worldEvaluationIssue('configuration-unavailable', 'read');
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
      let input = await readWorldEvaluationOriginal(world);
      await admit();
      if (input === undefined) {
        const window = trustedWorldWindow(event, deps.getMainWindow);
        if (!window) throw new WorldPrivateAdmissionError('authorization-denied');
        const selected = await selectConfiguration(window, signal);
        await admit();
        if (selected.canceled) return { outcome: 'cancel' };
        if (selected.filePaths.length !== 1) throw new WorldEvaluationImportError(worldEvaluationIssue('invalid-request', 'decode'));
        input = await readWorldEvaluationImport(selected.filePaths[0]);
        await admit();
      }
      const command = { name: 'world.evaluation.install', input };
      if (!isRuntimeHostControlCommand(command) || command.name !== 'world.evaluation.install') {
        throw new WorldEvaluationImportError(worldEvaluationIssue('configuration-invalid', 'validate'));
      }
      const configuration = command.input;
      if (!sameWorld(configuration.world, world)) throw new WorldEvaluationImportError(worldEvaluationIssue('world-mismatch', 'validate'));
      issue = controlIssue('host-unavailable', 'UNAVAILABLE');
      const host = await control;
      await admit();
      const prepared = await readControlData(host, { name: 'world.evaluation.prepare', input: { world, configuration } });
      await admit();
      const summary = safeSummary(configuration);
      if (!isRecord(prepared) || !hasExactKeys(prepared, ['configuration', 'safeSummary'])
        || !isDeepStrictEqual(prepared.configuration, configuration) || !isDeepStrictEqual(prepared.safeSummary, summary)) {
        throw new WorldEvaluationImportError(controlIssue('protocol-invalid', 'CONTRACT_DATA'));
      }
      const token = randomUUID();
      const timer = setTimeout(() => { if (ticket?.token === token) release(); }, TICKET_TTL_MS);
      timer.unref();
      ticket = { token, configuration, document: boundDocument, expiresAt: Date.now() + TICKET_TTL_MS, timer };
      document = undefined;
      return { outcome: 'prepared', ticket: token, summary };
    } catch (error) {
      issue = importIssue(error, issue);
      return { outcome: 'not-attempted', error: issue };
    } finally { document?.dispose(); }
  }

  async function commit(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldEvaluationCommitResult> {
    if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], ['world', 'ticket', 'accept'])
      || !isWorldRef(args[0].world) || typeof args[0].ticket !== 'string' || typeof args[0].accept !== 'boolean') {
      return { outcome: 'not-attempted', error: worldEvaluationIssue('invalid-request', 'decode') };
    }
    const world = args[0].world;
    const token = args[0].ticket;
    const accept = args[0].accept;
    let consumed: Ticket | undefined;
    let dispatched: WorldEvaluationConfiguration | undefined;
    let issue = worldEvaluationIssue('ticket-invalid', 'admission');
    try {
      const callerAdmission = worldPrivateAdmission(event, signal, deps);
      await callerAdmission();
      if (closed) throw new WorldPrivateAdmissionError('authorization-denied');
      const current = ticket;
      if (!current || current.token !== token || !sameWorld(current.configuration.world, world)) {
        throw new WorldEvaluationImportError(worldEvaluationIssue('ticket-invalid', 'admission'));
      }
      current.document.assert(event);
      if (Date.now() >= current.expiresAt) {
        release();
        throw new WorldEvaluationImportError(worldEvaluationIssue('ticket-expired', 'admission'));
      }
      ticket = undefined;
      clearTimeout(current.timer);
      consumed = current;
      if (!accept) return { outcome: 'cancel' };
      const admit = async () => {
        await callerAdmission();
        if (closed) throw new WorldPrivateAdmissionError('authorization-denied');
        current.document.assert(event);
        if (Date.now() >= current.expiresAt) throw new WorldEvaluationImportError(worldEvaluationIssue('ticket-expired', 'admission'));
      };
      await admit();
      issue = controlIssue('host-unavailable', 'UNAVAILABLE');
      const host = await control;
      await admit();
      issue = worldEvaluationIssue('configuration-unavailable', 'commit');
      if (await saveWorldEvaluationOriginal(current.configuration, admit) === 'conflict') {
        throw new WorldEvaluationImportError(worldEvaluationIssue('configuration-conflict', 'validate'));
      }
      await admit();
      // No mutation can start until exact original custody is durably published.
      dispatched = current.configuration;
      const result = await installEvaluation(host, current.configuration);
      if (result.outcome === 'confirmed' || result.outcome === 'rejected') {
        // Cleanup is not the commit outcome; an I/O failure keeps recovery custody, never downgrades a receipt.
        await clearWorldEvaluationOriginal(current.configuration).catch(() => undefined);
      }
      return result;
    } catch (error) {
      if (dispatched) {
        const identity = identityOf(dispatched);
        return { ...identity, outcome: 'unknown', error: controlIssue('unknown-delivery', 'CONTRACT_DATA', identity) };
      }
      return { outcome: 'not-attempted', error: importIssue(error, issue) };
    } finally { consumed?.document.dispose(); }
  }

  async function status(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldEvaluationStatusResult> {
    const world = intentWorld(args);
    if (!world) return { outcome: 'unavailable', error: worldEvaluationIssue('invalid-request', 'decode') };
    let document: DocumentBinding | undefined;
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
      const host = await control;
      await admit();
      const data = await readControlData(host, { name: 'world.evaluation.status', input: { world } });
      await admit();
      if (!isRecord(data) || !hasExactKeys(data, ['world', 'configured', 'commitId']) || !isWorldRef(data.world)
        || !sameWorld(data.world, world) || typeof data.configured !== 'boolean'
        || (data.configured ? !identifier(data.commitId) : data.commitId !== null)) {
        throw new WorldEvaluationImportError(controlIssue('protocol-invalid', 'CONTRACT_DATA'));
      }
      // Read only the durable owner fact; unresolved original custody is not canonical status or rollback evidence.
      return { outcome: 'available', world: data.world, configured: data.configured, commitId: data.commitId as string | null };
    } catch (error) {
      return { outcome: 'unavailable', error: importIssue(error, controlIssue('host-unavailable', 'UNAVAILABLE')) };
    } finally { document?.dispose(); }
  }
}

async function installEvaluation(host: WorldStorageControl, input: WorldEvaluationConfiguration): Promise<WorldEvaluationCommitResult> {
  const identity = identityOf(input);
  let outcome: RuntimeHostControlOutcome;
  try { outcome = await host.command({ name: 'world.evaluation.install', input }); }
  catch (error) {
    if (error instanceof RuntimeHostControlError) {
      const issue = controlIssue(error.delivery, error.kind, identity);
      return error.delivery === 'not-delivered' ? { outcome: 'not-attempted', error: issue }
        : { ...identity, outcome: 'unknown', error: issue };
    }
    if (error instanceof RuntimeHostLifecycleUnavailableError) {
      return { outcome: 'not-attempted', error: controlIssue('host-unavailable', error.code) };
    }
    return { ...identity, outcome: 'unknown', error: controlIssue('unknown-delivery', 'UNAVAILABLE', identity) };
  }
  if (outcome.kind === 'rejected') return { ...identity, outcome: 'rejected', error: controlIssue('control-rejected', outcome.error.code) };
  if (outcome.kind === 'timed-out') return { ...identity, outcome: 'unknown', error: controlIssue('timed-out', 'TIMEOUT', identity) };
  const body = outcome.result;
  if (isRecord(body) && hasExactKeys(body, ['success', 'error']) && body.success === false) {
    const failure = parseWorldControlFailure(body.error);
    if (failure) return { ...identity, outcome: outcome.kind === 'unknown' ? 'unknown' : 'rejected',
      error: { source: 'world', reason: outcome.kind === 'unknown' ? 'outcome-unknown' : 'world-rejected', ...failure } };
  }
  if (outcome.kind === 'unknown') return { ...identity, outcome: 'unknown', error: controlIssue('outcome-unknown', 'CONTRACT_DATA', identity) };
  if (isRecord(body) && hasExactKeys(body, ['success', 'data']) && body.success === true && evaluationReceipt(body.data, identity)) {
    return { ...identity, outcome: 'confirmed', receipt: body.data };
  }
  return { ...identity, outcome: 'unknown', error: { ...worldEvaluationIssue('receipt-unconfirmed', 'verify'),
    recovery: { kind: 'read_commit', commitId: identity.commitId } } };
}

async function readControlData(host: WorldStorageControl, command: RuntimeHostControlCommand): Promise<unknown> {
  let outcome: RuntimeHostControlOutcome;
  try { outcome = await host.command(command); }
  catch (error) {
    if (error instanceof RuntimeHostControlError) throw new WorldEvaluationImportError(controlIssue(error.delivery, error.kind));
    throw error;
  }
  if (outcome.kind === 'rejected') throw new WorldEvaluationImportError(controlIssue('control-rejected', outcome.error.code));
  if (outcome.kind === 'timed-out') throw new WorldEvaluationImportError(controlIssue('timed-out', 'TIMEOUT'));
  const body = outcome.result;
  if (isRecord(body) && hasExactKeys(body, ['success', 'error']) && body.success === false) {
    const failure = parseWorldControlFailure(body.error);
    if (failure) throw new WorldEvaluationImportError({ source: 'world',
      reason: outcome.kind === 'unknown' ? 'outcome-unknown' : 'world-rejected', ...failure });
  }
  if (outcome.kind === 'unknown') throw new WorldEvaluationImportError(controlIssue('outcome-unknown', 'CONTRACT_DATA'));
  if (!isRecord(body) || !hasExactKeys(body, ['success', 'data']) || body.success !== true) {
    throw new WorldEvaluationImportError(controlIssue('protocol-invalid', 'CONTRACT_DATA'));
  }
  return body.data;
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

async function selectConfiguration(window: BrowserWindow, signal: AbortSignal): Promise<OpenDialogReturnValue> {
  let abort!: ReturnType<typeof addAbortListener>;
  const cancelled = new Promise<OpenDialogReturnValue>((resolve) => {
    abort = addAbortListener(signal, () => resolve({ canceled: true, filePaths: [] }));
  });
  try {
    return await Promise.race([cancelled, dialog.showOpenDialog(window, {
      title: '导入管理员提供的评测身份配置', properties: ['openFile'], filters: [{ name: 'World Evaluation Configuration', extensions: ['json'] }],
    })]);
  } finally { abort[Symbol.dispose](); }
}

function safeSummary(input: WorldEvaluationConfiguration): WorldEvaluationSummary {
  return { world: input.world, commitId: input.commitId, principalCount: input.principals.length, grantCount: input.grants.length,
    policyCount: input.policies.length, retentionPolicyCount: input.retentionPolicies.length,
    caseAccess: input.evaluation.caseAccess, caseRetention: input.evaluation.caseRetention };
}
function intentWorld(args: readonly unknown[]): WorldRef | undefined {
  return args.length === 1 && isRecord(args[0]) && hasExactKeys(args[0], ['world']) && isWorldRef(args[0].world) ? args[0].world : undefined;
}
function identityOf(input: WorldEvaluationConfiguration): WorldEvaluationIdentity { return { world: input.world, commitId: input.commitId }; }
function sameWorld(left: WorldRef, right: WorldRef): boolean { return left.tenantId === right.tenantId && left.worldId === right.worldId; }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value); }
function importIssue(error: unknown, fallback: WorldEvaluationIssue): WorldEvaluationIssue {
  if (error instanceof WorldEvaluationImportError) return error.issue;
  if (error instanceof WorldPrivateAdmissionError) return worldEvaluationIssue(error.reason, 'admission');
  if (error instanceof WorldEvaluationConfigurationError) return worldEvaluationIssue(error.reason === 'invalid' ? 'configuration-invalid' : 'configuration-unavailable', 'read');
  return fallback;
}
function controlIssue(
  reason: Extract<WorldEvaluationIssue, { source: 'control' }>['reason'], code: string, identity?: WorldEvaluationIdentity,
): WorldEvaluationIssue {
  return { source: 'control', reason, code: `world.evaluation.control.${code}`, stage: 'execute', diagnosticId: randomUUID(),
    recovery: identity ? { kind: 'read_commit', commitId: identity.commitId } : { kind: 'none' },
    details: { kind: 'transport', failure: code === 'frame-too-large' ? 'size_limit'
      : code === 'command-invalid' || code === 'protocol-invalid' || code === 'INVALID_INPUT' || code === 'CONTRACT_DATA' ? 'contract_data' : 'disconnected' } };
}
function evaluationReceipt(value: unknown, identity: WorldEvaluationIdentity): value is CommitReceipt {
  return isRecord(value) && hasExactKeys(value, ['world', 'commitId', 'committedAt', 'revisions', 'outboxIds', 'fence'])
    && isWorldRef(value.world) && sameWorld(value.world, identity.world) && value.commitId === identity.commitId
    && typeof value.committedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(value.committedAt)
    && Number.isFinite(Date.parse(value.committedAt))
    && Array.isArray(value.revisions) && value.revisions.length === 0 && Array.isArray(value.outboxIds) && value.outboxIds.length === 0
    && isRecord(value.fence) && hasExactKeys(value.fence, ['world', 'domain', 'epoch'])
    && isWorldRef(value.fence.world) && sameWorld(value.fence.world, identity.world) && value.fence.domain === 'authorization'
    && typeof value.fence.epoch === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value.fence.epoch)
    && BigInt(value.fence.epoch) <= 18_446_744_073_709_551_615n;
}
