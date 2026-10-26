import { Ability } from '@serenity-js/core';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

const inputDirectory = resolve(repositoryRoot,
  '.scratch/world-implementation-2026-10-21/w16-single-authoring-input-20261026-r1');
const world = { tenantId: 'local', worldId: 'personal' };
type Reference = { world: typeof world; id: string; revision: string };
type OrderTask = Reference & { scope: string; budget: Record<string, unknown> };
type Definition = { reference: Reference; body: { kind: string }; [key: string]: unknown };
type Change = {
  world: typeof world; id: string; revision: string; status: string; baseRelease: string; operations: unknown[];
  evidence: unknown[]; cases: unknown[]; rationale: string;
};
type Candidate = { world: typeof world; id: string; changeSet: Change; origin: string; evidence: unknown[]; modelCalls: unknown[]; createdAt: string };
type Lock = { id: string; world: typeof world; nodes: unknown[] };
type Description = {
  world: typeof world; status: string; incarnation: string; activeRelease: string;
  activeReleaseHead: { world: typeof world; releaseId: string } | null;
  editingContext: { world: typeof world; baseRelease: string; definitions: Definition[]; externalContracts: unknown[]; scopes: { id: string }[]; activationLock: Lock } | null;
};
type Branch = {
  id: string; revision: string; baseRelease: string;
  basis: { releaseId: string; activationLockId: string; overlay: unknown[]; sources: unknown[]; snapshots: unknown[]; readReceipts: unknown[]; assumptions: unknown[]; missingSources: unknown[]; replayability: string };
};
type StructuralRecord = { world: typeof world; changeId: string; branchId: string; firstRun: string };
type Observation = { kind: 'proposed' | 'validated'; ids: string[]; error?: string; dispose: () => void };
type Failure = { code: string; stage: string; diagnosticId: string };
type Receipt = {
  accepted: { world: typeof world; operationId: string; incarnation: string }; phase: string;
  disclosure: { kind: string; withheld?: string[] }; effects: unknown[]; failure?: Failure | null;
  result?: { kind: string; result: unknown } | null;
};

function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World order ${label} differs from the unchanged original`);
}

export class WorldCompilation extends Ability {
  private registrationAttempted = false;
  private proposalAttempted = false;
  private validationAttempted = false;
  private baseline?: Description;
  private branchesBefore: Branch[] = [];
  private proposed?: { candidate: Candidate; branch: Branch };
  private structuralMode?: 'submit' | 'resume';
  private structuralRecord?: StructuralRecord;
  private resumeSnapshot?: { description: Description; change: Change | null; branch: Branch };
  private observation?: { kind: 'proposed' | 'validated'; read: () => Promise<{ ids: string[]; error?: string }>; dispose: () => Promise<void> };
  constructor(private readonly electron: UseElectron) { super(); }

  private async read<T>(endpoint: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${endpoint}`, method: 'POST', timeoutMs: 10_000,
      body: endpoint === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World order ${kind}: transport=${reply.error.code}; no mutation is replayed`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: Failure };
    if (!body || typeof body.success !== 'boolean') throw new Error(`World order ${kind}: invalid public envelope`);
    if (!body.success) {
      throw new Error(`World order ${kind}: HTTP ${reply.data.status}; code=${body.error?.code}; stage=${body.error?.stage}; diagnosticId=${body.error?.diagnosticId}`);
    }
    if (!reply.data.ok || reply.data.status !== 200 || body.data?.kind !== kind) throw new Error(`World order ${kind}: mismatched public result`);
    return body.data.result;
  }

  private async originalTask(): Promise<OrderTask> {
    const { task } = await this.readOriginalInputs();
    const original = task as OrderTask;
    exact([original.world, original.id, original.revision, original.scope],
      [world, 'task:order-line-total:20261026:r1', '1', 'scope:personal:management'], 'Task identity');
    return { ...original, budget: { maxCost: null, deadline: null, ...original.budget } };
  }

  async inspectTask() {
    const original = await this.originalTask();
    const stored = await this.read<OrderTask | null>('query', 'task_contract', { world, id: original.id, revision: original.revision });
    if (stored !== null) exact(stored, original, 'full Task contract, including Oracle pin and budget');
    return { exists: stored !== null, exact: stored !== null,
      taskValue: JSON.stringify([world, original.id, original.revision, original.scope]) };
  }

  private scratchFile(path: string): string {
    const file = resolve(repositoryRoot, path);
    const local = relative(resolve(repositoryRoot, '.scratch'), file);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\') || !file.endsWith('.json')) {
      throw new Error('World order resume requires an explicit public JSON file inside repository .scratch');
    }
    return file;
  }

  async prepareStructure() {
    if (this.structuralMode) throw new Error('Order structural mode was already selected; no replacement or replay');
    const path = process.env.E2E_WORLD_ORDER_RECORD;
    if (path === undefined) {
      this.structuralMode = 'submit';
      return { mode: this.structuralMode };
    }
    if (!path.trim()) throw new Error('E2E_WORLD_ORDER_RECORD is empty; no fallback submission permitted');
    const record = JSON.parse(await readFile(this.scratchFile(path), 'utf8')) as StructuralRecord;
    if (!record || typeof record.changeId !== 'string' || !record.changeId.startsWith('change-')
      || typeof record.branchId !== 'string' || !record.branchId.startsWith('branch-')
      || typeof record.firstRun !== 'string' || !record.firstRun.trim()) throw new Error('Incomplete public order structural record; no identity guessed');
    exact(record, { world, changeId: record.changeId, branchId: record.branchId, firstRun: record.firstRun }, 'explicit structural record');
    const guard = JSON.parse(await readFile(this.scratchFile(record.firstRun), 'utf8')) as {
      passed?: boolean; selectedSuitePassed?: boolean; rootExitCode?: number; nativeShutdownProved?: boolean;
      forcedTermination?: boolean; testInputsUnchanged?: boolean; workerErrors?: unknown[];
      suiteStats?: { expected: number; skipped: number; unexpected: number; flaky: number };
    };
    if (!guard || guard.passed !== true || guard.selectedSuitePassed !== true || guard.rootExitCode !== 0
      || guard.nativeShutdownProved !== true || guard.forcedTermination !== false || guard.testInputsUnchanged !== true) {
      throw new Error('Original order run lacks complete successful process and native shutdown evidence; no fallback submission');
    }
    exact(guard.workerErrors, [], 'original run worker errors');
    exact(guard.suiteStats && [guard.suiteStats.expected, guard.suiteStats.skipped, guard.suiteStats.unexpected, guard.suiteStats.flaky],
      [1, 0, 0, 0], 'original single-case acceptance');
    this.structuralRecord = record;
    this.structuralMode = 'resume';
    return { mode: this.structuralMode };
  }

  async resumeStructure() {
    const record = this.structuralRecord;
    if (this.structuralMode !== 'resume' || !record) throw new Error('Read-only order resume requires its explicit public record');
    const baseline = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    const context = baseline.editingContext;
    exact([baseline.world, baseline.status, baseline.activeRelease, baseline.activeReleaseHead?.world, baseline.activeReleaseHead?.releaseId],
      [world, 'ready', 'release:personal:genesis', world, 'release:personal:genesis'], 'read-only active genesis head');
    if (!context || typeof context.activationLock.id !== 'string' || !context.activationLock.id) throw new Error('Unreadable original genesis editing context');
    exact([context.world, context.baseRelease, context.definitions, context.externalContracts, context.activationLock.world, context.activationLock.nodes],
      [world, baseline.activeRelease, [], [], world, []], 'empty unpublished genesis context');
    if (!context.scopes.some(scope => scope.id === 'scope:personal:management')) throw new Error('Original Task management scope is not readable');
    const releases = await this.list<{ id: string; previous: string | null; activationLockId: string }>('releases');
    exact(releases.map(release => [release.id, release.previous, release.activationLockId]),
      [[baseline.activeRelease, null, context.activationLock.id]], 'sole unchanged genesis release');
    const originals = JSON.parse((await this.readOriginalInputs()).definitions) as Definition[];
    const change = await this.read<Change | null>('query', 'change', { id: record.changeId });
    exact(change, { world, id: record.changeId, revision: '2', status: 'validated', baseRelease: baseline.activeRelease,
      operations: originals.map(definition => ({ kind: 'create_definition', definition })), evidence: [], cases: [], rationale: '直接提交的语义变更。' },
    'complete recorded r2 validated ChangeSet');
    const branches = (await this.list<Branch>('branches')).filter(branch => branch.id === record.branchId);
    if (branches.length !== 1 || !/^[1-9]\d*$/.test(branches[0].revision) || BigInt(branches[0].revision) <= 1n) {
      throw new Error('Explicit recorded branch is missing or has no validated revision; no alternative branch selected');
    }
    const branch = branches[0];
    exact(branch, { id: record.branchId, revision: branch.revision, baseRelease: baseline.activeRelease, basis: {
      releaseId: baseline.activeRelease, activationLockId: context.activationLock.id, overlay: change!.operations,
      sources: [], snapshots: [], readReceipts: [], assumptions: [], missingSources: [], replayability: 'complete',
    } }, 'complete explicitly recorded zero-Source BranchView');
    for (const original of originals) {
      exact(await this.read<Definition | null>('query', 'definition', { reference: original.reference }), original, 'resumed immutable definition');
    }
    exact((await this.inspectTask()).exact, true, 'resumed original Task including Oracle pin and budget');
    const current = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([current.world, current.status, current.incarnation, current.activeRelease, current.activeReleaseHead, current.editingContext],
      [world, 'ready', baseline.incarnation, baseline.activeRelease, baseline.activeReleaseHead, context], 'read-only resume leaves active genesis unchanged');
    const snapshot = { description: current, change, branch };
    if (this.resumeSnapshot) exact(snapshot, this.resumeSnapshot, 'unchanged recorded structure across normal UI review');
    else this.resumeSnapshot = snapshot;
    return { mode: 'resume', verification: 'persisted-structure-only', operationReceiptsRechecked: false, candidateRechecked: false,
      record, change, branch, activeReleaseHead: current.activeReleaseHead, exactDefinitions: true, exactTask: true, activeReleaseUnchanged: true };
  }

  async markRegistration(): Promise<void> {
    if (this.structuralMode === 'resume') throw new Error('Explicit structural resume is read-only; Task registration is forbidden');
    if (this.registrationAttempted) throw new Error('Original order Task registration was already attempted; unknown mutations are never replayed');
    if ((await this.inspectTask()).exists) throw new Error('Original order Task now exists; registration must not be repeated');
    this.registrationAttempted = true;
  }

  async inspectProposalPrerequisites(selectedLock: string) {
    const description = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact(description.world, world, 'discover World');
    const context = description.editingContext;
    if (description.status !== 'ready' || !context) return { status: 'blocked', reason: 'World is not ready or has no readable editing context; no proposal sent' };
    exact([context.world, context.baseRelease, context.activationLock.world, context.activationLock.id],
      [world, description.activeRelease, world, selectedLock], 'selected current proposal baseline');
    if (!context.scopes.some(scope => scope.id === 'scope:personal:management')) return { status: 'blocked', reason: 'Original management scope is not readable; no proposal sent' };
    // The short propose/validate path checks structure, not Schema execution. Its impact has Read/Write and no effects.
    if (context.definitions.some(definition => definition.body.kind === 'source_binding') || context.externalContracts.length) {
      return { status: 'blocked', reason: 'Baseline has Source bindings or external contracts outside this zero-Source structural proposal' };
    }
    if (!(await this.inspectTask()).exact) return { status: 'blocked', reason: 'The unchanged original Task is not registered; no proposal sent' };
    const originals = JSON.parse((await this.readOriginalInputs()).definitions) as Definition[];
    if (context.definitions.some(item => originals.some(original => original.reference.id === item.reference.id))) {
      return { status: 'blocked', reason: 'Order definitions already occur in the active baseline; no recreation or replacement permitted' };
    }
    const existing = await this.list<Change>('changes');
    if (existing.some(change => change.operations.some(operation => {
      const item = operation as { kind: string; definition?: Definition };
      return item.kind === 'create_definition' && originals.some(original => original.reference.id === item.definition?.reference.id);
    }))) return { status: 'blocked', reason: 'An original order-definition change already exists; no new proposal or unknown mutation replay permitted' };
    const releases = await this.list<{ id: string; previous: string | null }>('releases');
    if (releases.length !== 1 || releases[0].id !== context.baseRelease || releases[0].previous !== null) {
      return { status: 'blocked', reason: 'This zero-Source case requires the original genesis basis, not inherited Source/read obligations' };
    }
    this.branchesBefore = await this.list<Branch>('branches');
    this.baseline = description;
    return { status: 'ready', reason: 'Read/Write structural proposal only; no effects, Schema invocation or Execute requirement; server admission is authoritative' };
  }

  async markProposal(selectedLock: string): Promise<void> {
    if (this.structuralMode !== 'submit') throw new Error('Only explicit fresh structural mode may submit; resume is read-only');
    if (this.proposalAttempted) throw new Error('Order proposal was already attempted; no mutation is replayed');
    const prerequisites = await this.inspectProposalPrerequisites(selectedLock);
    if (prerequisites.status !== 'ready') throw new Error(prerequisites.reason);
    this.proposalAttempted = true;
    await this.observeCommand('proposed');
  }

  private async observeCommand(kind: 'proposed' | 'validated'): Promise<void> {
    if (this.observation) throw new Error('An unresolved original order command already has an observer; no replay');
    const handle = await this.electron.page.evaluateHandle(({ kind, world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: {
        on(channel: string, listener: (value: unknown) => void): () => void;
      } } }).electron.ipcRenderer;
      const state: Observation = { kind, ids: [], dispose: () => undefined };
      const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!record(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !record(value.payload)) return;
        const hint = value.payload;
        if (!record(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') {
          state.error = 'Original World event observation lost continuity; retain the original UI request, never resend'; return;
        }
        if (!record(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) {
          if (state.ids.length >= 8) state.error = 'Ambiguous operation hints; retain original request without replay';
          else state.ids.push(hint.resource.id);
        }
      });
      return state;
    }, { kind, world, incarnation: this.baseline!.incarnation });
    this.observation = { kind, read: async () => {
      const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 });
      await ready.dispose();
      return handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
    }, dispose: async () => { await handle.evaluate(state => state.dispose()); await handle.dispose(); } };
  }

  async releaseObservation(): Promise<void> {
    if (!this.observation) return;
    await this.observation.dispose();
    this.observation = undefined;
  }

  async confirmCommand(status: 'proposed' | 'validated') {
    if (this.observation?.kind !== status) throw new Error('No event observer for the single normal UI order command');
    const observed = await this.observation.read();
    if (observed.error) throw new Error(observed.error);
    if (observed.ids.length !== 1) throw new Error(`Order operation hints are ambiguous: ${observed.ids.join(',')}; no identity guessed or mutation replayed`);
    const id = observed.ids[0];
    const receipt = await this.read<Receipt>('operation', 'result', { world, operationId: id });
    exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, id, this.baseline!.incarnation], 'actual event OperationKey and incarnation');
    if (receipt.phase !== 'completed' || receipt.disclosure.kind !== 'full' || receipt.result?.kind !== 'candidate') {
      throw new Error(`Order operation=${id}; phase=${receipt.phase}; disclosure=${receipt.disclosure.kind}; code=${receipt.failure?.code}; stage=${receipt.failure?.stage}; diagnosticId=${receipt.failure?.diagnosticId}; retain same receipt, never resend`);
    }
    exact(receipt.effects, [], 'zero Source effect receipts');
    exact(receipt.failure, null, 'successful structural proposal receipt');
    const candidate = receipt.result.result as Candidate;
    const readback = await this.inspectChange(candidate, status);
    await this.releaseObservation();
    return { ...readback, operationId: id, operationKey: { world: receipt.accepted.world, operationId: receipt.accepted.operationId },
      accepted: receipt.accepted, disclosure: receipt.disclosure, failure: receipt.failure,
      phase: receipt.phase, resultKind: receipt.result.kind, effects: receipt.effects, candidate };
  }

  private async list<T>(kind: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: T[]; nextCursor?: string | null } = await this.read('query', kind, { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items)) throw new Error(`World order ${kind}: invalid public page`);
      items.push(...page.items);
      cursor = page.nextCursor ?? null;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error(`World order ${kind}: pagination did not terminate`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }

  async confirmOperation(id: string, kind: 'task') {
    const receipt = await this.read<Receipt>('operation', 'result', { world, operationId: id });
    exact(receipt.accepted.world, world, 'operation World');
    exact(receipt.accepted.operationId, id, 'original OperationKey');
    if (receipt.phase !== 'completed') throw new Error(`World order operation=${id}; phase=${receipt.phase}; code=${receipt.failure?.code ?? 'not-disclosed'}; stage=${receipt.failure?.stage ?? 'not-disclosed'}; diagnosticId=${receipt.failure?.diagnosticId ?? 'not-disclosed'}; no mutation replayed`);
    if (receipt.disclosure.kind !== 'full') throw new Error(`World order operation=${id}: result/effects disclosure is insufficient; no completion inferred`);
    exact(receipt.effects, [], 'zero Source effect receipts');
    if (receipt.result?.kind !== kind) throw new Error(`World order operation=${id}: expected ${kind} result, not merely accepted`);
    const task = await this.originalTask();
    const summary = receipt.result.result as { reference: Reference; scope: string; goal: unknown };
    exact(summary.reference, { world, id: task.id, revision: task.revision }, 'registered Task reference');
    exact(summary.scope, task.scope, 'registered Task scope');
    return { id, phase: receipt.phase, resultKind: kind, sourceEffects: 0 };
  }

  private async inspectChange(candidate: Candidate, status: 'proposed' | 'validated') {
    if (!this.baseline) throw new Error('No checked order proposal baseline');
    if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.createdAt !== 'string' || !candidate.createdAt
      || typeof candidate.changeSet.id !== 'string' || !candidate.changeSet.id || typeof candidate.changeSet.rationale !== 'string') {
      throw new Error('Incomplete direct Candidate; no identity inferred');
    }
    const originals = JSON.parse((await this.readOriginalInputs()).definitions) as Definition[];
    if (status === 'proposed') exact(candidate, {
      world, id: candidate.id, origin: 'direct', evidence: [], modelCalls: [], createdAt: candidate.createdAt,
      changeSet: { world, id: candidate.changeSet.id, revision: '1', status, baseRelease: this.baseline.activeRelease,
        operations: originals.map(definition => ({ kind: 'create_definition', definition })), evidence: [], cases: [], rationale: candidate.changeSet.rationale },
    }, 'complete direct proposed Candidate');
    else {
      if (!this.proposed) throw new Error('No original proposed order Candidate');
      exact(candidate, { ...this.proposed.candidate, changeSet: { ...this.proposed.candidate.changeSet,
        revision: String(BigInt(this.proposed.candidate.changeSet.revision) + 1n), status } }, 'complete original Candidate advanced only by validation');
    }
    const change = await this.read<Change | null>('query', 'change', { id: candidate.changeSet.id });
    exact(change, candidate.changeSet, 'complete independent ChangeSet readback');
    // BranchView exposes no candidateId/changeSetId/compile. Correlate only the unique exact overlay and actual new durable id.
    const branches = (await this.list<Branch>('branches')).filter(branch => branch.baseRelease === candidate.changeSet.baseRelease
      && isDeepStrictEqual(branch.basis.overlay, candidate.changeSet.operations));
    if (branches.length !== 1) throw new Error('Order change must match exactly one public branch overlay; no branch identity synthesized');
    const branch = branches[0];
    if (typeof branch.id !== 'string' || !branch.id || !/^[1-9]\d*$/.test(branch.revision)) throw new Error('Invalid public BranchView identity');
    exact(branch, { id: branch.id, revision: branch.revision, baseRelease: this.baseline.activeRelease, basis: {
      releaseId: this.baseline.activeRelease, activationLockId: this.baseline.editingContext!.activationLock.id,
      overlay: candidate.changeSet.operations, sources: [], snapshots: [], readReceipts: [], assumptions: [], missingSources: [], replayability: 'complete',
    } }, 'complete zero-Source public BranchView');
    if (status === 'proposed') {
      if (this.branchesBefore.some(previous => previous.id === branch.id)) throw new Error('Proposal reused a pre-existing branch; no new proposal success inferred');
      this.proposed = { candidate, branch };
    } else {
      exact(branch.id, this.proposed!.branch.id, 'same actual branch through validation');
      if (BigInt(branch.revision) <= BigInt(this.proposed!.branch.revision)) throw new Error('Validation did not advance the original branch revision');
    }
    for (const original of originals) {
      exact(await this.read<Definition | null>('query', 'definition', { reference: original.reference }), original, 'durable exact immutable definition');
    }
    exact((await this.inspectTask()).exact, true, 'original Task remains present with unchanged Oracle and budget');
    const current = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([current.world, current.status, current.incarnation, current.activeRelease, current.activeReleaseHead, current.editingContext],
      [world, 'ready', this.baseline.incarnation, this.baseline.activeRelease, this.baseline.activeReleaseHead, this.baseline.editingContext], 'unchanged unpublished active release and editing context');
    return { id: candidate.changeSet.id, revision: candidate.changeSet.revision, status, branchId: branch.id, branchRevision: branch.revision,
      exactDefinitions: true, activeReleaseUnchanged: true, modelCalls: candidate.modelCalls, sourceBasis: branch.basis.sources };
  }

  async markValidation(id: string): Promise<void> {
    if (this.structuralMode !== 'submit' || this.validationAttempted || !this.proposed || this.proposed.candidate.changeSet.id !== id) throw new Error('Only the exact newly proposed order revision may be validated once; no mutation replayed');
    await this.inspectChange(this.proposed.candidate, 'proposed');
    this.validationAttempted = true;
    await this.observeCommand('validated');
  }

  async readOriginalInputs() {
    const [task, definitions, input] = await Promise.all(
      ['task-contract.json', 'definitions.json', 'task-input.json'].map(name => readFile(resolve(inputDirectory, name), 'utf8')),
    );
    return { task: JSON.parse(task) as unknown, definitions, input: JSON.parse(input) as unknown };
  }

  async importTaskPreview(): Promise<void> {
    await this.electron.page.getByLabel(/^(Complete task contract|完整任务契约)$/, { exact: true })
      .setInputFiles(resolve(inputDirectory, 'task-contract.json'));
  }

  async importDefinitionsPreview(): Promise<void> {
    await this.electron.page.getByLabel(/^(Definition JSON file|定义 JSON 文件)$/, { exact: true })
      .setInputFiles(resolve(inputDirectory, 'definitions.json'));
  }
}
