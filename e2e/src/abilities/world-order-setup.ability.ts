import { Ability } from '@serenity-js/core';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

type Ref = { world: typeof world; id: string; revision: string };
type TaskContract = Ref & { scope: string; goal: string; budget: Record<string, unknown>; successOracle: unknown; requiredSuites: string[] };
type Definition = { reference: Ref; scope: string; body: { kind: string }; [key: string]: unknown };
type Port = { contract: { id: string }; direction: string; requestSchema: string; resultSchema: string };
type Lock = { world: typeof world; id: string; nodes: { slot: string; trust: string; implementation: unknown; ports: Port[] }[] };
type Scope = { world: typeof world; id: string; predicate: unknown };
type Description = { world: typeof world; status: string; incarnation: string; activeRelease: string; activeReleaseHead: unknown;
  editingContext: { world: typeof world; baseRelease: string; definitions: Definition[]; externalContracts: unknown[]; scopes: Scope[]; activationLock: Lock } };
type Change = { world: typeof world; id: string; revision: string; status: string; baseRelease: string; operations: unknown[]; evidence: unknown[]; cases: unknown[]; rationale: string };
type Candidate = { world: typeof world; id: string; changeSet: Change; origin: string; evidence: unknown[]; modelCalls: unknown[]; createdAt: string };
type Branch = { id: string; revision: string; baseRelease: string; basis: { activationLockId: string; overlay: unknown[]; [key: string]: unknown } };
type Context = { branch: Ref; task: TaskContract; strategies: Ref[]; policyEpoch: string; grantEpoch: string; toolLock: string; dataDigest: string };
type Failure = { code: string; stage: string; diagnosticId: string };
type Receipt = { accepted: { world: typeof world; operationId: string; incarnation: string; revision: string }; phase: string;
  progress: { stage: string }; disclosure: { kind: string }; effects: unknown[]; failure: Failure | null; result: { kind: string; result: unknown } | null };
type Observation = { ids: string[]; error?: string; dispose: () => void };
type WriteCustody = { kind: 'task' | 'propose' | 'validate'; operationId: string | null; status: Receipt | null; result: Receipt | null;
  outcome: 'pending' | 'confirmed' | 'unconfirmed-original-request-retained'; phase: string; observedOperationIds: string[]; observationError: string | null; errors: string[] };
type Locator = ReturnType<UseElectron['page']['locator']>;
const world = { tenantId: 'local', worldId: 'personal' };
const inputRoot = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21/w16-single-authoring-input-20261026-r1');
const custodyPath = resolve(inputRoot, '../world-order-execution-20261027-r1.dispatch.json');
type SetupCustody = { task: TaskContract; definitions: Definition[]; lockId: string; branches: Branch[]; operations: WriteCustody[] };
function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Order setup ${label} differs; preserve the original request, never resend`);
}

export class WorldOrderSetup extends Ability {
  private attempted = false;
  private phase = 'idle';
  private readonly operations: WriteCustody[] = [];
  private custody?: SetupCustody;
  private readonly result: Partial<{ task: TaskContract | null; candidate: Candidate; branch: Branch; context: Context; definitions: Definition[]; scope: Scope }> = {};
  constructor(private readonly electron: UseElectron) { super(); }
  private get workspace() { return this.electron.page.locator('main .world-workspace'); }
  private async read<T>(route: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${route}`, method: 'POST', timeoutMs: 10_000,
      body: route === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`Order setup ${kind}: transport=${reply.error.code}; no mutation replay`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: Failure };
    if (!reply.data.ok || reply.data.status !== 200 || body?.success !== true || body.data?.kind !== kind) {
      throw new Error(`Order setup ${kind}: code=${body?.error?.code ?? 'invalid-envelope'}; stage=${body?.error?.stage ?? 'read'}; diagnosticId=${body?.error?.diagnosticId ?? 'not-disclosed'}`);
    }
    return body.data.result;
  }
  private async catalog<T>(kind: string): Promise<T[]> {
    const items: T[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { items: T[]; nextCursor: string | null } = await this.read('query', kind, { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error(`Invalid ${kind} page`);
      items.push(...page.items); cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error(`Nonterminal ${kind} catalog`);
      if (cursor) cursors.add(cursor);
    } while (cursor !== null);
    return items;
  }
  private async saveCustody() {
    if (!this.custody) throw new Error('Order setup has no original request custody');
    const file = await open(custodyPath, 'r+');
    try { await file.truncate(0); await file.writeFile(JSON.stringify(this.custody, null, 2)); await file.sync(); }
    finally { await file.close(); }
  }
  private async write(button: Locator, kind: WriteCustody['kind'], incarnation: string) {
    if (this.operations.some(item => item.kind === kind || item.outcome !== 'confirmed')) throw new Error('Order setup retains a previous write; no replay');
    const custody: WriteCustody = { kind, operationId: null, status: null, result: null, outcome: 'pending', phase: 'observing-before-click', observedOperationIds: [], observationError: null, errors: [] };
    this.operations.push(custody); this.phase = kind;
    const handle = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
      const state: Observation = { ids: [], dispose: () => undefined };
      const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!record(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !record(value.payload)) return;
        const hint = value.payload;
        if (!record(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || value.eventName === 'world:resync-required' || hint.kind === 'resync_required') { state.error = 'World event continuity lost; no resend'; return; }
        if (!record(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) {
          if (state.ids.length) state.error = 'Ambiguous operation hints; no guessed identity or resend';
          else state.ids.push(hint.resource.id);
        }
      });
      return state;
    }, { world, incarnation });
    const errors: unknown[] = [];
    try {
      custody.phase = 'click-delivery-unknown';
      await this.saveCustody();
      await button.click({ timeout: 15_000 });
      const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 }); await ready.dispose();
      const observed = await handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
      custody.observedOperationIds = observed.ids; custody.observationError = observed.error ?? null;
      if (observed.ids.length === 1) custody.operationId = observed.ids[0];
      await this.saveCustody();
      if (observed.error || observed.ids.length !== 1) throw new Error(observed.error ?? 'No unique original operation; no resend');
      const operationId = observed.ids[0]; const key = { world, operationId }; const until = Date.now() + 45_000;
      let status: Receipt;
      do {
        status = await this.read<Receipt>('operation', 'status', key);
        custody.status = status; custody.phase = status.phase;
        exact([status.accepted.world, status.accepted.operationId, status.accepted.incarnation], [world, operationId, incarnation], 'status operation ownership');
        if (['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'retained', 'commit_indeterminate', 'effect_indeterminate'].includes(status.phase)) break;
        await setTimeout(100);
      } while (Date.now() < until);
      const result = await this.read<Receipt>('operation', 'result', key);
      custody.result = result; custody.phase = result.phase;
      if (result.result?.kind === 'candidate') this.result.candidate = result.result.result as Candidate;
      exact([result.accepted.world, result.accepted.operationId, result.accepted.incarnation], [world, operationId, incarnation], 'result operation ownership');
      if (status.phase !== 'completed' || status.failure !== null || result.phase !== 'completed' || result.disclosure.kind !== 'full' || result.failure !== null || result.result?.kind !== (kind === 'task' ? 'task' : 'candidate')
        || BigInt(result.accepted.revision) < BigInt(status.accepted.revision)) {
        const failure = result.failure ?? status.failure;
        throw new Error(`Order setup operation=${operationId}; phase=${result.phase}; code=${failure?.code ?? 'completion-unproved'}; stage=${failure?.stage ?? result.progress.stage}; diagnosticId=${failure?.diagnosticId ?? 'not-disclosed'}; no resend`);
      }
      exact(result.effects, [], 'pure operation effects');
      exact(await handle.evaluate(state => ({ ids: state.ids, error: state.error ?? null })), { ids: [operationId], error: null }, 'single operation throughout readback');
      custody.outcome = 'confirmed'; this.phase = `${kind}-confirmed`;
      return { kind, status, result };
    } catch (error) { custody.outcome = 'unconfirmed-original-request-retained'; custody.errors.push(error instanceof Error ? error.message : String(error)); errors.push(error); throw error; }
    finally {
      const count = errors.length;
      try {
        const observed = await handle.evaluate(state => ({ ids: [...state.ids], error: state.error ?? null }));
        custody.observedOperationIds = observed.ids; custody.observationError = observed.error;
        if (!custody.operationId && observed.ids.length === 1) custody.operationId = observed.ids[0];
      } catch (error) { errors.push(error); }
      try { await handle.evaluate(state => state.dispose()); } catch (error) { errors.push(error); }
      try { await handle.dispose(); } catch (error) { errors.push(error); }
      try { await this.saveCustody(); } catch (error) { errors.push(error); }
      if (errors.length > count) {
        custody.errors.push(...errors.slice(count).map(error => error instanceof Error ? error.message : String(error)));
        throw new AggregateError(errors, 'Order setup write/observer cleanup failed; no replay');
      }
    }
  }
  private checkBranch(branch: Branch, baseline: Description, lockId: string, overlay: unknown[]) {
    if (!branch.id || !/^[1-9]\d*$/.test(branch.revision)) throw new Error('Invalid public branch identity');
    exact(branch, { id: branch.id, revision: branch.revision, baseRelease: baseline.activeRelease, basis: {
      releaseId: baseline.activeRelease, activationLockId: lockId, overlay, sources: [], snapshots: [], readReceipts: [], assumptions: [], missingSources: [], replayability: 'complete',
    } }, 'complete pure-math branch');
  }
  async prepareTaskAndBranch(setup: { implementation: unknown; ports: unknown[]; lockId: string }) {
    if (this.attempted) throw new Error('Order setup already attempted; unresolved writes are never replayed');
    this.attempted = true; this.phase = 'preflight';
    const originals = await Promise.all(['task-contract.json', 'definitions.json'].map(name => readFile(resolve(inputRoot, name), 'utf8')));
    const original = JSON.parse(originals[0]) as TaskContract; const definitions = JSON.parse(originals[1]) as Definition[];
    this.result.definitions = definitions;
    const originalRef = { world, id: 'task:order-line-total:20261026:r1', revision: '1' };
    exact([original.world, original.id, original.revision, original.scope], [world, originalRef.id, '1', 'scope:personal:management'], 'original r1 identity');
    exact(await this.read('query', 'task_contract', originalRef), original, 'unchanged original r1 contract and Oracle');
    const baseline = await this.read<Description>('query', 'discover', { includeCapabilities: true });
    exact([baseline.world, baseline.status, baseline.editingContext?.world, baseline.editingContext?.baseRelease], [world, 'ready', world, baseline.activeRelease], 'ready editing basis');
    const lock = (await this.catalog<Lock>('bindings')).filter(item => item.id === setup.lockId);
    if (lock.length !== 1) throw new Error('Exact activated Oracle binding lock is not publicly readable');
    exact(lock[0].world, world, 'selected lock World');
    const nodes = lock[0].nodes.filter(node => node.slot === 'evaluation' && node.trust !== 'ordinary_guest' && isDeepStrictEqual(node.implementation, setup.implementation));
    if (nodes.length !== 1) throw new Error('No unique trusted evaluation node for the real implementation');
    exact(nodes[0].ports, setup.ports, 'actual evaluation node ports');
    const ports = nodes[0].ports.filter(port => port.direction === 'export' && port.contract.id === 'evaluation.evaluate');
    if (ports.length !== 1 || !ports[0].requestSchema || !ports[0].resultSchema) throw new Error('No unique evaluation export request/result schemas');
    const task: TaskContract = { ...original, id: 'task:order-line-total:20261027:execution-r1', requiredSuites: ['suite:order-line-total:20261027:execution-r1'],
      successOracle: { kind: 'program', implementation: setup.implementation, fixtureSchema: ports[0].requestSchema, resultSchema: ports[0].resultSchema } };
    const taskRef = { world, id: task.id, revision: task.revision };
    const stored = await this.read<TaskContract | null>('query', 'task_contract', taskRef);
    this.result.task = stored;
    if (stored !== null) exact(stored, task, 'complete existing execution Task');
    const scope = baseline.editingContext.scopes.find(item => item.id === task.scope);
    if (!scope) throw new Error('Real Task Scope is not readable'); this.result.scope = scope; exact(scope.world, world, 'real Scope World');
    exact(baseline.editingContext.externalContracts, [], 'empty external contracts');
    exact(definitions.map(item => [item.reference, item.body.kind]), [
      [{ world, id: 'function:order-line-total:20261026:r1', revision: '1' }, 'function'],
      [{ world, id: 'strategy:order-line-total:20261026:r1', revision: '1' }, 'strategy'],
    ], 'unchanged exact Function/Strategy references');
    for (const definition of definitions) {
      const previous = await this.read<Definition | null>('query', 'definition', { reference: definition.reference });
      if (previous !== null) exact(previous, definition, 'existing immutable definition content');
    }
    const overlay = definitions.map(definition => ({ kind: 'create_definition', definition }));
    const before = await this.catalog<Branch>('branches');
    try { this.custody = JSON.parse(await readFile(custodyPath, 'utf8')) as SetupCustody; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.custody) {
      exact([this.custody.task, this.custody.definitions, this.custody.lockId], [task, definitions, setup.lockId], 'original setup request binding');
      if (!Array.isArray(this.custody.branches) || !Array.isArray(this.custody.operations) || this.custody.operations.length > 3) throw new Error('Invalid retained setup custody');
      this.operations.push(...this.custody.operations); this.custody.operations = this.operations;
      exact(this.operations.map(item => item.kind), ['task', 'propose', 'validate'].slice(0, this.operations.length), 'ordered original setup writes');
      for (const operation of this.operations) {
        if (!operation.operationId) throw new Error('Original setup delivery remains unknown; no resend');
        const fresh = await this.read<Receipt>('operation', 'result', { world, operationId: operation.operationId });
        if (operation.outcome !== 'confirmed') throw new Error(`Original setup ${operation.kind} remains retained: ${fresh.phase}; no resend`);
        exact(fresh, operation.result, 'full fresh original setup result');
        exact([fresh.accepted.world, fresh.accepted.incarnation, fresh.accepted.operationId, fresh.phase, fresh.disclosure.kind, fresh.failure, fresh.effects],
          [world, baseline.incarnation, operation.operationId, 'completed', 'full', null, []], 'completed original setup ownership');
      }
    } else {
      if (stored !== null) throw new Error('Existing Task requires original setup custody; do not infer that no proposal was sent');
      this.custody = { task, definitions, lockId: setup.lockId, branches: before, operations: this.operations };
      const file = await open(custodyPath, 'wx');
      try { await file.writeFile(JSON.stringify(this.custody, null, 2)); await file.sync(); } finally { await file.close(); }
    }
    if (stored === null) {
      if (this.operations.length) throw new Error('Original completed Task is no longer publicly readable; no replay');
      await this.electron.page.locator('aside nav a[href="#/world/model"]').click();
      await this.workspace.locator('.world-heading [data-status="ready"]').waitFor({ state: 'visible', timeout: 15_000 });
      exact((await this.workspace.locator('.world-footer > span').innerText()).trim(), 'local / personal', 'normal UI selected World');
      await this.workspace.getByRole('tab', { name: /^(Version & compile baseline|版本与编译基线)$/, exact: true }).click();
      const version = this.workspace.getByRole('tabpanel', { name: /^(Version & compile baseline|版本与编译基线)$/, exact: true });
      await version.locator('summary').filter({ hasText: /^(Import a complete task contract|导入完整任务契约)$/ }).click();
      await version.getByLabel(/^(Complete task contract|完整任务契约)$/, { exact: true }).setInputFiles({ name: 'execution-task.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(task)) });
      await version.getByRole('button', { name: /^(Cancel contract import|取消契约导入)$/, exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      const registered = await this.write(version.getByRole('button', { name: /^(Register task|登记任务)$/, exact: true }), 'task', baseline.incarnation);
      exact(registered.result.result!.result, { reference: taskRef, scope: task.scope, goal: task.goal }, 'original registration result');
      this.result.task = await this.read<TaskContract>('query', 'task_contract', taskRef);
      exact(this.result.task, task, 'complete registered Task');
    }
    exact(this.operations[0]?.result?.result, { kind: 'task', result: { reference: taskRef, scope: task.scope, goal: task.goal } }, 'original Task registration');
    let proposal = this.operations.find(item => item.kind === 'propose')?.result;
    if (!proposal) {
      exact(before, this.custody.branches, 'unchanged branch catalog before the first proposal');
      if (baseline.editingContext.definitions.some(item => definitions.some(definition => definition.reference.id === item.reference.id))) throw new Error('Original definitions are already active; normal authoring cannot recreate them');
      await this.electron.page.locator('aside nav a[href="#/world/model"]').click();
      await this.workspace.getByRole('tab', { name: /^(Author definitions|手工建模)$/, exact: true }).click();
      const authoring = this.workspace.getByRole('tabpanel', { name: /^(Author definitions|手工建模)$/, exact: true });
      await authoring.getByRole('combobox', { name: /^(Business scope|业务范围)$/, exact: true }).selectOption(task.scope);
      const select = authoring.getByRole('combobox', { name: /^(Related task|关联任务)$/, exact: true }); const value = JSON.stringify([world, task.id, task.revision, task.scope]);
      await select.locator('option').filter({ hasText: ` · ${task.id} · ${task.revision}` }).waitFor({ state: 'attached', timeout: 15_000 }); await select.selectOption(value);
      await authoring.getByLabel(/^(Definition JSON file|定义 JSON 文件)$/, { exact: true }).setInputFiles(resolve(inputRoot, 'definitions.json'));
      const preview = authoring.locator('pre[aria-label]'); await preview.waitFor({ state: 'visible', timeout: 15_000 }); exact(JSON.parse(await preview.innerText()), definitions, 'normal definition import preview');
      const target = authoring.getByRole('combobox', { name: /^(Exact target binding lock|精确目标绑定锁)$/, exact: true });
      await target.locator('option').filter({ hasText: setup.lockId }).waitFor({ state: 'attached', timeout: 15_000 }); await target.selectOption(setup.lockId);
      exact(await authoring.getByRole('group', { name: /^(Target and external uses for this compilation|本次编译的目标与外部用途)$/, exact: true }).getByRole('button', { name: /^(Remove|移除)$/, exact: true }).count(), 0, 'empty normal UI external uses');
      await authoring.getByRole('button', { name: /^(Confirm compilation selection|确认本次编译选择)$/, exact: true }).click();
      await authoring.getByRole('button', { name: /^(Compilation selection confirmed|已确认本次编译选择)$/, exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      proposal = (await this.write(authoring.getByRole('button', { name: /^(Submit for review|送交审核)$/, exact: true }), 'propose', baseline.incarnation)).result;
    }
    const candidate = proposal.result!.result as Candidate;
    this.result.candidate = candidate;
    if (!candidate.id || !candidate.changeSet?.id || !candidate.createdAt) throw new Error('Proposal omitted real Candidate identity');
    exact(candidate, { world, id: candidate.id, origin: 'direct', evidence: [], modelCalls: [], createdAt: candidate.createdAt, changeSet: {
      world, id: candidate.changeSet.id, revision: '1', status: 'proposed', baseRelease: baseline.activeRelease, operations: overlay, evidence: [], cases: [], rationale: '直接提交的语义变更。',
    } }, 'complete proposed Candidate');
    const created = (await this.catalog<Branch>('branches')).filter(item => !this.custody!.branches.some(old => old.id === item.id));
    if (created.length !== 1) throw new Error('Original proposal has no unique new branch; no guessed identity');
    let branch = created[0]; this.result.branch = branch;
    let validation = this.operations.find(item => item.kind === 'validate')?.result;
    if (!validation) {
      exact(await this.read('query', 'change', { id: candidate.changeSet.id }), candidate.changeSet, 'exact proposed change');
      this.checkBranch(branch, baseline, baseline.editingContext.activationLock.id, overlay);
      await this.electron.page.locator('aside nav a[href="#/world/changes"]').click();
      await this.workspace.locator('.world-heading').getByRole('button', { name: /^(Refresh|刷新)$/, exact: true }).click();
      // Cards omit IDs and the old r1 has the same overlay. Opening details is read-only; validate only the exact returned change ID.
      const cards = this.workspace.locator('.world-catalog li > button').filter({ hasText: definitions[0].reference.id }).filter({ hasText: definitions[1].reference.id });
      await cards.first().waitFor({ state: 'visible', timeout: 15_000 });
      const changeId = this.workspace.locator('article.world-panel > header > div > span.font-mono'); let selected = false;
      for (let index = 0; index < await cards.count(); index++) {
        await cards.nth(index).click();
        if (await changeId.innerText() === candidate.changeSet.id) { selected = true; break; }
      }
      if (!selected) throw new Error('Exact original operation ChangeSet is not in the normal review queue; no validation sent');
      exact(await changeId.innerText(), candidate.changeSet.id, 'selected exact change');
      validation = (await this.write(this.workspace.getByRole('button', { name: /^(Validate this revision|验证此修订)$/, exact: true }), 'validate', baseline.incarnation)).result;
      const advanced = (await this.catalog<Branch>('branches')).filter(item => item.id === branch.id);
      if (advanced.length === 1) this.result.branch = advanced[0];
      if (advanced.length !== 1 || BigInt(advanced[0].revision) <= BigInt(branch.revision)) throw new Error('Original branch did not advance through validation'); branch = advanced[0];
    }
    const accepted = validation.result!.result as Candidate;
    exact(accepted, { ...candidate, changeSet: { ...candidate.changeSet, revision: '2', status: 'validated' } }, 'same complete Candidate after one validation');
    this.result.candidate = accepted;
    exact(await this.read('query', 'change', { id: accepted.changeSet.id }), accepted.changeSet, 'complete validated change');
    const context = await this.read<Context>('query', 'suite_creation_context', { world, id: branch.id, revision: branch.revision });
    this.result.context = context;
    this.checkBranch(branch, baseline, setup.lockId, overlay);
    exact(context.branch, { world, id: branch.id, revision: branch.revision }, 'real context branch'); exact(context.task, task, 'real context exact Task'); exact(context.toolLock, setup.lockId, 'real context tool lock');
    if (!/^\d+$/.test(context.policyEpoch) || !/^\d+$/.test(context.grantEpoch) || !/^sha256:[0-9a-f]{64}$/.test(context.dataDigest)
      || !context.strategies.some(reference => isDeepStrictEqual(reference, definitions[1].reference))) throw new Error('Context omitted real epochs/dataDigest/exact Strategy');
    for (const definition of definitions) exact(await this.read('query', 'definition', { reference: definition.reference }), definition, 'full durable immutable definition');
    exact(await this.read('query', 'task_contract', taskRef), task, 'final full execution Task'); exact(await this.read('query', 'task_contract', originalRef), original, 'original r1 remains unchanged');
    exact(await Promise.all(['task-contract.json', 'definitions.json'].map(name => readFile(resolve(inputRoot, name), 'utf8'))), originals, 'original input bytes');
    const current = await this.read<Description>('query', 'discover', { includeCapabilities: true });
    exact([current.world, current.status, current.incarnation, current.activeRelease, current.activeReleaseHead, current.editingContext],
      [world, 'ready', baseline.incarnation, baseline.activeRelease, baseline.activeReleaseHead, baseline.editingContext], 'active release and original editing context unchanged');
    this.phase = 'prepared';
    return this.evidence();
  }
  evidence() {
    return structuredClone({ ...this.result, phase: this.phase, attempted: this.attempted, operations: this.operations,
      retained: true, mayLeave: this.operations.every(item => item.outcome === 'confirmed') });
  }
}
