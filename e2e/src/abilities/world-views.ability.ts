import { Ability } from '@serenity-js/core';
import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

type World = { tenantId: string; worldId: string };
type Ref = { world: World; id: string; revision: string };
type RecordValue = Record<string, unknown>;
type TaskContract = Ref & { scope: string; goal: string; inputType: RecordValue; allowedEffects: unknown[]; hardConstraints: unknown[]; stopConditions: unknown[]; requiredSuites: string[]; budget: RecordValue; successOracle: unknown };
type TaskSeed = Pick<TaskContract, 'goal' | 'inputType' | 'allowedEffects' | 'hardConstraints' | 'stopConditions' | 'requiredSuites' | 'budget'>;
type TaskSetupReceipt = Omit<Receipt, 'result'> & { result?: { kind: string; result: { reference: Ref; goal: string; scope: string } } | null };
type TaskAttempt = { kind: 'attempt'; schemaVersion: 1; seed: { path: string; sha256: string }; incarnation: string; request: { world: World; command: { kind: 'record_task'; request: TaskContract } }; expected: TaskContract };
type TaskSetupEvent = TaskAttempt | { kind: 'operation'; operationId: string } | { kind: 'receipt'; receipt: TaskSetupReceipt } | { kind: 'confirmed'; operationId: string; taskFile: string; task: TaskContract } | { kind: 'blocked'; message: string };
type Definition = { reference: Ref; body: { kind: string; body: RecordValue }; dependencies: Ref[]; evidence: Ref[] };
type Abstraction = Ref & { taskId: string; taskRevision: string; scope: string; baseRelease: string; branch?: { id: string } | null; originalDefinitions: Ref[]; strategy: Ref; guard: unknown; assumptions: unknown[]; preservedInvariants: unknown[]; readDependencies: unknown[]; slots: unknown[]; parameters: unknown[]; bindingMap: { bindings: { target: { kind: string; id?: string }; evidence: Ref[] }[] }; fallback: { kind: string }; assurance: string; forwardPlan: unknown[]; evaluationIds: string[] };
type TestCase = Ref & { taskId: string; taskRevision: string; scope: string; oracle: unknown };
type Field = { property: Ref; cell: { kind: string; [key: string]: unknown }; evidence: Ref[]; dirty: unknown };
type ObjectFact = { object: { id: string; typeId: string; world: World }; fields: Field[]; receiptId?: string };
type Facts = { objects: ObjectFact[]; relations: unknown[]; rows: unknown[]; definitions: Ref[]; actions: unknown[]; abstractions: unknown[]; untrustedMaterial: unknown[] };
type Arm = { abstraction: Abstraction; test: TestCase; facts: Facts; labels: string[]; truncation: unknown };
type Input = {
  world: World; taskFile: string; input: RecordValue; queryType: Ref;
  material: { rawFile: string; sourceVersion: { world: World; sourceId: string; versionId: string }; parseArtifactId: string; draft: { world: World; runId: string; stepId: string; revision: string }; evidence: Ref[] };
  guardFalse: Arm; guardUnknown: Arm;
  execution: { endpointId: string; sessionValue: string; selection: { kind: string; agentId: string; nativeSessionId: string; sessionKey?: string } };
};
type BindingLock = { world: World; id: string; nodes: { id: string; slot: string; trust: string; implementation: unknown; ports: { name: string; direction: string; contract: { id: string }; requestSchema: string; resultSchema: string }[] }[] };
type Description = { world: World; status: string; incarnation: string; activeRelease: string; activeReleaseHead: unknown; editingContext?: { scopes: { world: World; id: string }[]; externalContracts: unknown[]; definitions: Definition[]; activationLock: BindingLock } | null };
type Receipt = { accepted: { world: World; operationId: string; incarnation: string }; phase: string; disclosure: { kind: string }; effects: unknown[]; failure?: { code: string; stage: string; diagnosticId: string } | null; result?: { kind: string; result: { caseId: string; outcome: unknown } } | null };
type Observation = { ids: string[]; error?: string; dispose: () => void };
type WirePage<T> = { items: T[]; nextCursor?: string | null };
type Locator = ReturnType<UseElectron['page']['locator']>;
const world: World = { tenantId: 'local', worldId: 'personal' };

function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World F ${label} differs from its explicit public binding; no write or replay permitted`);
}
function record(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`World F missing ${label}`);
  return value as RecordValue;
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`World F missing ${label}; no identity, timestamp or digest is synthesized`);
}

export class WorldViews extends Ability {
  private input?: Input;
  private task?: TaskContract;
  private arm?: Arm;
  private purpose?: 'view' | 'false' | 'unknown';
  private baseline?: Description;
  private taskPages: WirePage<{ reference: Ref; goal: string; scope: string }>[] = [];
  private attempted = new Set<string>();
  private viewChecked = false;
  private ownsConfirmation = false;
  private observation?: { read: (wait?: boolean) => Promise<{ ids: string[]; error?: string }>; dispose: () => Promise<void> };
  private taskSetupJournal?: string;
  private taskSetupEvents: TaskSetupEvent[] = [];
  private taskSetupStarted = false;
  constructor(private readonly electron: UseElectron) { super(); }

  private async scratchFile(path: string): Promise<string> {
    text(path, 'public scratch path');
    const file = await realpath(resolve(repositoryRoot, path));
    const root = await realpath(resolve(repositoryRoot, '.scratch'));
    const local = relative(root, file);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('World F inputs must remain inside repository .scratch, including resolved symlinks');
    return file;
  }
  private async read<T>(endpoint: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${endpoint}`, method: 'POST', timeoutMs: 10_000,
      body: endpoint === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World F ${kind}: transport=${reply.error.code}; original request is never resent`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: { code: string; stage: string; diagnosticId: string } };
    if (!body || typeof body.success !== 'boolean') throw new Error(`World F ${kind}: invalid public envelope`);
    if (!body.success) throw new Error(`World F ${kind}: HTTP ${reply.data.status}; code=${body.error?.code}; stage=${body.error?.stage}; diagnosticId=${body.error?.diagnosticId}`);
    if (!reply.data.ok || reply.data.status !== 200 || body.data?.kind !== kind) throw new Error(`World F ${kind}: mismatched public response`);
    return body.data.result;
  }
  private async pages<T>(kind: string, request: RecordValue): Promise<WirePage<T>[]> {
    const pages: WirePage<T>[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: WirePage<T> = await this.read('query', kind, { ...request, page: { limit: 100, cursor } });
      if (!Array.isArray(page.items) || !(page.nextCursor == null || typeof page.nextCursor === 'string')) throw new Error(`World F ${kind}: invalid public page`);
      pages.push(page); cursor = page.nextCursor ?? null;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error(`World F ${kind}: pagination lost continuity`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return pages;
  }
  private resolution(): Locator {
    return this.electron.page.locator('main .world-workspace details').filter({ has: this.electron.page.locator(':scope > summary').filter({ hasText: /^(Task views and resolution|任务视图与解析)$/ }) });
  }

  private async appendTaskSetup(event: TaskSetupEvent): Promise<void> {
    if (!this.taskSetupJournal) throw new Error('World F Task setup has no owned custody');
    const file = await open(this.taskSetupJournal, 'a');
    try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); }
    finally { await file.close(); }
    this.taskSetupEvents.push(event);
  }
  private async retainTaskSetupOperation(): Promise<string | undefined> {
    const previous = this.taskSetupEvents.find((event): event is Extract<TaskSetupEvent, { kind: 'operation' }> => event.kind === 'operation');
    if (!this.observation) return previous?.operationId;
    const observed = await this.observation.read(false);
    if (observed.ids.length === 1 && !previous) await this.appendTaskSetup({ kind: 'operation', operationId: observed.ids[0] });
    if (observed.error) throw new Error(observed.error);
    if (observed.ids.length > 1) throw new Error('World F Task setup has ambiguous operation hints; no request is replayed');
    if (previous && observed.ids.length) exact(observed.ids, [previous.operationId], 'retained Task registration operation');
    return previous?.operationId ?? observed.ids[0];
  }
  async setupTask() {
    if (this.taskSetupStarted) throw new Error('World F Task setup is one-shot in this worker');
    this.taskSetupStarted = true;
    const seedPath = await this.scratchFile(process.env.E2E_WORLD_VIEW_TASK_SEED ?? '');
    const seedBytes = await readFile(seedPath);
    if (!seedPath.endsWith('.json') || seedBytes.length > 1_048_576) throw new Error('World F Task seed must be bounded public JSON');
    const seed = record(JSON.parse(seedBytes.toString('utf8')), 'new zero-effect Task form seed') as TaskSeed;
    exact(Object.keys(seed).sort(), ['goal', 'inputType', 'hardConstraints', 'stopConditions', 'allowedEffects', 'requiredSuites', 'budget'].sort(), 'Task seed fields without manufactured identities or Oracle');
    text(seed.goal, 'new business goal'); exact(seed.inputType, { kind: 'null' }, 'null Task input');
    exact([seed.hardConstraints, seed.stopConditions, seed.allowedEffects], [[], [], []], 'zero-effect Task constraints');
    if (!Array.isArray(seed.requiredSuites) || !seed.requiredSuites.length || seed.requiredSuites.some(id => typeof id !== 'string' || !id.trim()) || new Set(seed.requiredSuites).size !== seed.requiredSuites.length) throw new Error('World F Task needs explicit unique required suite IDs');
    const budgetKeys = ['maxWallTime', 'maxSteps', 'maxSourceReads', 'maxRows', 'maxBytes', 'maxModelCalls', 'maxInputTokens', 'maxOutputTokens'];
    record(seed.budget, 'zero-effect Task budget'); exact(Object.keys(seed.budget).sort(), [...budgetKeys].sort(), 'explicit Task budget fields');
    for (const key of budgetKeys) {
      if (typeof seed.budget[key] !== 'string' || !/^(0|[1-9]\d*)$/.test(seed.budget[key])) throw new Error(`World F Task budget ${key} is not canonical`);
    }
    for (const key of ['maxSourceReads', 'maxModelCalls', 'maxInputTokens', 'maxOutputTokens']) exact(seed.budget[key], '0', `Task ${key}`);
    for (const key of ['maxWallTime', 'maxSteps', 'maxRows', 'maxBytes']) if (BigInt(String(seed.budget[key])) <= 0n) throw new Error(`World F Task ${key} must be positive`);
    const custodyPath = process.env.E2E_WORLD_VIEW_TASK_CUSTODY ?? '';
    if (!isAbsolute(custodyPath) || !custodyPath.endsWith('.jsonl')) throw new Error('World F Task custody must name an absolute public .scratch JSONL file');
    const parent = await this.scratchFile(dirname(custodyPath));
    if (parent === dirname(seedPath) || /(?:^|[\\/])(?:\.profiles?|secrets?)(?:[\\/]|$)/i.test(parent)) throw new Error('World F Task custody must use an independent public evidence directory, never the material input directory or Profile');
    this.taskSetupJournal = resolve(parent, basename(custodyPath));
    let existing: string | undefined;
    try {
      const info = await stat(this.taskSetupJournal);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('World F Task custody is not bounded JSONL');
      exact(await realpath(this.taskSetupJournal), this.taskSetupJournal, 'Task custody is not redirected');
      existing = await readFile(this.taskSetupJournal, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      const basis = await this.read<Description>('query', 'discover', { includeCapabilities: false });
      exact([basis.world, basis.status], [world, 'ready'], 'ready World for Task registration');
      const seedFact = { path: seedPath, sha256: createHash('sha256').update(seedBytes).digest('hex') };
      let attempt: TaskAttempt;
      const deadline = Date.now() + 90_000;
      if (existing !== undefined) {
        if (!existing.endsWith('\n')) throw new Error('World F Task custody is truncated; no request is replayed');
        this.taskSetupEvents = existing.trimEnd().split('\n').map(line => JSON.parse(line) as TaskSetupEvent);
        if (this.taskSetupEvents[0]?.kind !== 'attempt' || this.taskSetupEvents.filter(event => event.kind === 'attempt').length !== 1
          || this.taskSetupEvents.filter(event => event.kind === 'operation').length !== 1
          || this.taskSetupEvents.some(event => !['attempt', 'operation', 'receipt', 'confirmed', 'blocked'].includes(event.kind))) throw new Error('World F Task custody has no single original operation identity; unknown delivery without ID is never resubmitted');
        attempt = this.taskSetupEvents[0];
        exact([attempt.schemaVersion, attempt.seed, attempt.request.world, attempt.request.command.kind, attempt.incarnation], [1, seedFact, world, 'record_task', basis.incarnation], 'original Task attempt custody');
        const requested = attempt.request.command.request;
        exact({ goal: requested.goal, inputType: requested.inputType, hardConstraints: requested.hardConstraints, stopConditions: requested.stopConditions, allowedEffects: requested.allowedEffects, requiredSuites: requested.requiredSuites,
          budget: { ...requested.budget, maxCost: requested.budget.maxCost ?? null, deadline: requested.budget.deadline ?? null } }, { ...seed, budget: { ...seed.budget, maxCost: null, deadline: null } }, 'retained original business request');
        exact(attempt.expected, { ...requested, budget: { ...requested.budget, maxCost: null, deadline: null } }, 'complete retained Task contract');
      } else {
        const context = basis.editingContext;
        if (!context) throw new Error('World F Task registration needs the actual active editing context');
        const panel = this.electron.page.locator('main .world-workspace').getByRole('tabpanel', { name: /^(Version & compile baseline|版本与编译基线)$/, exact: true });
        const form = panel.locator('section > form').filter({ has: this.electron.page.getByRole('button', { name: /^(Register task|登记任务)$/, exact: true }) });
        await form.waitFor({ state: 'visible', timeout: 15_000 });
        const taskScope = form.getByRole('combobox', { name: /^(Task scope|任务范围)$/, exact: true });
        const scopes = await taskScope.locator('option[value]:not([value=""])').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
        const scope = context.scopes.find(item => isDeepStrictEqual(item.world, world) && scopes.includes(item.id))?.id;
        if (!scope) throw new Error('World F Task has no existing authorized UI scope');
        await taskScope.selectOption(scope);
        const id = await form.getByRole('textbox', { name: /^(Task ID|任务标识)$/, exact: true }).inputValue();
        text(id, 'UI-generated new Task id');
        exact(await form.getByRole('textbox', { name: /^(Contract revision|契约修订)$/, exact: true }).inputValue(), '1', 'new Task revision');
        const locks = (await this.pages<BindingLock>('bindings', {})).flatMap(page => page.items).filter(lock => lock.id === 'lock:order-line-total:20261027:execution-r1');
        if (locks.length !== 1) throw new Error('World F Task needs the exact publicly readable existing Oracle lock; no activation or replacement is attempted');
        exact(locks[0].world, world, 'existing Oracle lock World');
        const nodes = locks[0].nodes.filter(node => node.slot === 'evaluation' && ['trusted_native', 'trusted_process', 'private_root'].includes(node.trust));
        if (nodes.length !== 1) throw new Error('World F Task needs one trusted evaluation node in the exact existing Oracle lock');
        const ports = nodes[0].ports.filter(port => port.direction === 'export' && port.contract.id === 'evaluation.evaluate');
        if (ports.length !== 1) throw new Error('World F Task needs one real evaluation.evaluate export, not a synthesized Oracle');
        record(nodes[0].implementation, 'existing evaluation implementation');
        text(ports[0].requestSchema, 'existing evaluation fixture schema'); text(ports[0].resultSchema, 'existing evaluation result schema');
        const request: TaskContract = { world, id, revision: '1', goal: seed.goal, inputType: seed.inputType, scope, hardConstraints: [], stopConditions: [], allowedEffects: [], requiredSuites: seed.requiredSuites,
          budget: { ...seed.budget, maxCost: null, deadline: null }, successOracle: { kind: 'program', implementation: nodes[0].implementation, fixtureSchema: ports[0].requestSchema, resultSchema: ports[0].resultSchema } };
        exact(await this.read('query', 'task_contract', { world, id, revision: '1' }), null, 'new UI Task id is absent before registration');
        const importFile = resolve(parent, 'task-contract.import.json');
        const importBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
        if (importBytes.length > 1_048_576) throw new Error('World F complete Task contract exceeds the normal import limit');
        const file = await open(importFile, 'wx');
        try { await file.writeFile(importBytes); await file.sync(); }
        finally { await file.close(); }
        const importer = form.locator('details').filter({ has: this.electron.page.locator(':scope > summary').filter({ hasText: /^(Import a complete task contract|导入完整任务契约)$/ }) });
        if (await importer.getAttribute('open') === null) await importer.locator(':scope > summary').click();
        await importer.getByLabel(/^(Complete task contract|完整任务契约)$/, { exact: true }).setInputFiles(importFile);
        const preview = form.locator('details').filter({ has: this.electron.page.locator(':scope > summary').filter({ hasText: /^(Contract details|契约详情)$/ }) }).locator(':scope > div > dl');
        await preview.waitFor({ state: 'visible', timeout: 15_000 });
        await this.rendered(preview, request);
        const current = await this.read<Description>('query', 'discover', { includeCapabilities: false });
        exact(current, basis, 'unchanged Task registration basis before the sole submission');
        exact(await this.electron.page.getByRole('dialog').count(), 0, 'clean Task registration boundary');
        if (await panel.getByRole('alert').count()) throw new Error('World F Task import has an explicit error before submission');
        const submit = form.getByRole('button', { name: /^(Register task|登记任务)$/, exact: true });
        if (!await submit.isEnabled()) throw new Error('World F Task registration is not currently available');
        attempt = { kind: 'attempt', schemaVersion: 1, seed: seedFact, incarnation: basis.incarnation, request: { world, command: { kind: 'record_task', request } }, expected: { ...request, budget: { ...request.budget, maxCost: null, deadline: null } } };
        await this.observeOperation(basis.incarnation);
        const journal = await open(this.taskSetupJournal, 'wx');
        try { await journal.writeFile(`${JSON.stringify(attempt)}\n`); await journal.sync(); }
        finally { await journal.close(); }
        this.taskSetupEvents.push(attempt);
        await submit.click({ timeout: 15_000 });
      }
      let id = await this.retainTaskSetupOperation();
      while (!id && Date.now() < deadline) { await delay(100); id = await this.retainTaskSetupOperation(); }
      if (!id) throw new Error('World F Task registration delivery is unknown without an original operation ID; retained attempt must never be resubmitted');
      let receipt: TaskSetupReceipt;
      do {
        receipt = await this.read<TaskSetupReceipt>('operation', 'result', { world, operationId: id });
        exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, id, attempt.incarnation], 'original Task operation identity');
        const prior = this.taskSetupEvents.filter((event): event is Extract<TaskSetupEvent, { kind: 'receipt' }> => event.kind === 'receipt').at(-1)?.receipt;
        if (!isDeepStrictEqual(prior, receipt)) await this.appendTaskSetup({ kind: 'receipt', receipt });
        if (receipt.phase === 'completed') break;
        if (!['accepted', 'admitted', 'running', 'verifying', 'committing', 'draining'].includes(receipt.phase) || Date.now() >= deadline) throw new Error(`World F Task operation=${id}; phase=${receipt.phase}; code=${receipt.failure?.code}; stage=${receipt.failure?.stage}; diagnosticId=${receipt.failure?.diagnosticId}; retained without replay`);
        await delay(200);
      } while (Date.now() < deadline);
      exact([receipt.phase, receipt.disclosure, receipt.failure, receipt.effects], ['completed', { kind: 'full' }, null, []], 'completed full zero-effect Task registration receipt');
      const task = attempt.expected;
      exact(receipt.result, { kind: 'task', result: { reference: { world, id: task.id, revision: task.revision }, goal: task.goal, scope: task.scope } }, 'receipt binds the complete requested Task identity');
      exact(await this.read('query', 'task_contract', { world, id: task.id, revision: task.revision }), task, 'complete registered Task including Oracle pin and budget');
      const taskFile = resolve(dirname(this.taskSetupJournal), 'task-contract.json');
      const confirmed = this.taskSetupEvents.find((event): event is Extract<TaskSetupEvent, { kind: 'confirmed' }> => event.kind === 'confirmed');
      if (confirmed) exact(confirmed, { kind: 'confirmed', operationId: id, taskFile, task }, 'original confirmed Task registration');
      try {
        const output = await open(taskFile, 'wx');
        try { await output.writeFile(`${JSON.stringify(task, null, 2)}\n`); await output.sync(); }
        finally { await output.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        exact(JSON.parse(await readFile(await this.scratchFile(taskFile), 'utf8')), task, 'unchanged retained Task contract file');
      }
      if (!confirmed) await this.appendTaskSetup({ kind: 'confirmed', operationId: id, taskFile, task });
      return { operationId: id, taskFile, custody: this.taskSetupJournal, phase: 'completed', fullContractMatched: true, allowedEffects: task.allowedEffects, reused: existing !== undefined };
    } catch (error) {
      const failures: unknown[] = [error];
      if (this.taskSetupEvents.length) {
        try { await this.retainTaskSetupOperation(); } catch (failure) { failures.push(failure); }
        try { await this.appendTaskSetup({ kind: 'blocked', message: error instanceof Error ? error.message : String(error) }); } catch (failure) { failures.push(failure); }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'World F Task setup retains the primary error and custody failures; no mutation is replayed');
      throw error;
    }
  }

  // E2E_WORLD_VIEWS_INPUT is an explicit public .scratch JSON manifest, never an authorization grant.
  // It binds the unchanged taskFile/input/queryType, original material bytes/source/parse/draft/evidence,
  // two complete persisted abstraction+test+facts arms, and an already existing native session selection.
  async prepare(purpose: 'view' | 'false' | 'unknown') {
    if (this.observation) throw new Error('World F unresolved previous observation; no new attempt');
    const path = process.env.E2E_WORLD_VIEWS_INPUT;
    if (!path?.trim()) throw new Error('World F unbound: E2E_WORLD_VIEWS_INPUT must name public .scratch JSON with an unchanged original Task, real material/object/Strategy/Test, guardFalse/guardUnknown stop abstractions and existing session; stopped before upload, write or execution');
    const file = await this.scratchFile(path);
    if (!file.endsWith('.json')) throw new Error('World F manifest must be an explicit public JSON file');
    const input = JSON.parse(await readFile(file, 'utf8')) as Input;
    record(input, 'input manifest'); exact(input.world, world, 'manifest World');
    const task = JSON.parse(await readFile(await this.scratchFile(input.taskFile), 'utf8')) as TaskContract;
    record(task, 'unchanged original Task'); exact(task.world, world, 'original Task World');
    text(task.id, 'Task id'); text(task.revision, 'Task revision'); text(task.scope, 'Task scope');
    exact(task.allowedEffects, [], 'zero permitted effects');
    for (const key of ['maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxSourceReads']) exact(task.budget[key], '0', `original Task ${key}; the consumer never rewrites its budget`);
    const arm = purpose === 'false' ? input.guardFalse : input.guardUnknown;
    record(arm, `${purpose} arm`); record(arm.facts, 'expected WorldView facts');
    const abstraction = arm.abstraction;
    record(abstraction, 'complete persisted abstraction');
    exact([abstraction.world, abstraction.taskId, abstraction.taskRevision, abstraction.scope], [world, task.id, task.revision, task.scope], 'abstraction Task and scope');
    exact(abstraction.fallback, { kind: 'stop' }, 'non-investigating stop fallback');
    if (!['heuristic', 'tested', 'guarded'].includes(abstraction.assurance)) throw new Error('World F consumes declared heuristic/tested/guarded only; no Hypothesis/Tested or UI declaration is promoted to Verified');
    if (!Array.isArray(arm.facts.objects) || !arm.facts.objects.length || !Array.isArray(arm.facts.rows) || !arm.facts.rows.length) throw new Error('World F requires non-empty real object facts and returned query rows');
    exact(arm.facts.relations, [], 'object-only consumer relation set'); exact(arm.facts.actions, [], 'zero-effect consumer actions');
    const fields = arm.facts.objects.flatMap(item => item.fields);
    if (!fields.some(field => field.cell.kind === 'known') || (purpose !== 'false' && !fields.some(field => field.cell.kind === 'unknown'))) throw new Error('World F requires explicit known facts and, for Context/unknown, a genuine unknown cell with its original reason');
    record(input.input, 'typed original task input'); record(input.material, 'original material binding');
    if (purpose !== 'view') {
      record(input.execution, 'existing native session binding'); record(input.execution.selection, 'existing native selection');
      text(input.execution.endpointId, 'existing runtime endpoint'); text(input.execution.sessionValue, 'existing session identity');
      text(input.execution.selection.agentId, 'existing native Agent'); text(input.execution.selection.nativeSessionId, 'existing native session id');
      if (!['openclaw', 'matcha_agent'].includes(input.execution.selection.kind)) throw new Error('World F requires a real existing supported native session, never an invented execution selection');
    }
    if (!Array.isArray(input.material.evidence) || !input.material.evidence.length) throw new Error('World F missing real material EvidenceRefs');
    if (!abstraction.bindingMap.bindings.some(binding => binding.target.kind === 'object' && arm.facts.objects.some(item => item.object.id === binding.target.id))) throw new Error('World F needs a persisted slot binding to a real returned object, never a canonical identity invented by E2E');
    exact(await this.read('query', 'task_contract', { world, id: task.id, revision: task.revision }), task, 'complete original Task including Oracle pin and budget');
    exact(await this.read('query', 'abstraction', { world, id: abstraction.id, revision: abstraction.revision }), abstraction, 'complete persisted abstraction');
    const test = arm.test;
    record(test, 'complete independent recorded test');
    exact([test.world, test.taskId, test.taskRevision, test.scope, test.oracle], [world, task.id, task.revision, task.scope, task.successOracle], 'independent test Task and original Oracle');
    exact(await this.read('query', 'exact_test_case', { id: test.id, revision: test.revision }), test, 'complete independent test revision');
    const baseline = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([baseline.world, baseline.status], [world, 'ready'], 'current ready World'); text(baseline.incarnation, 'current incarnation');
    const context = baseline.editingContext;
    if (!context) throw new Error('World F missing real active editing/Context binding; no installation, activation, trust or grant attempted');
    exact(context.externalContracts, [], 'no external tool contracts');
    if (context.definitions.some(definition => definition.body.kind === 'source_binding')) throw new Error('World F forbids external Source bindings before any query or execution');
    for (const slot of ['context', 'abstraction', 'evaluation']) if (!context.activationLock.nodes.some(node => node.slot === slot)) throw new Error(`World F missing active ${slot} binding; no authorization or package state is manufactured`);
    const definitions: Definition[] = [];
    const pending = [...abstraction.originalDefinitions];
    while (pending.length) {
      const reference = pending.shift()!;
      if (definitions.some(item => isDeepStrictEqual(item.reference, reference))) continue;
      if (definitions.length >= 100) throw new Error('World F exact definition closure exceeds the bounded consumer input');
      const definition = await this.read<Definition | null>('query', 'definition', { reference });
      if (!definition) throw new Error('World F missing exact Strategy/type dependency');
      exact(definition.reference, reference, 'exact definition reference');
      if (definition.body.kind === 'source_binding') throw new Error('World F selected closure contains an external Source binding');
      if (definition.body.kind === 'strategy') {
        const steps = definition.body.body.steps as { operation: { kind: string } }[];
        if (!Array.isArray(steps) || steps.some(step => !['function', 'stop'].includes(step.operation.kind))) throw new Error('World F only permits existing pure Function/stop Strategies; no Action, query or native investigation execution');
      }
      definitions.push(definition); pending.push(...definition.dependencies);
    }
    const strategy = definitions.find(item => isDeepStrictEqual(item.reference, abstraction.strategy));
    if (strategy?.body.kind !== 'strategy') throw new Error('World F abstraction does not bind a real exact Strategy');
    const type = definitions.find(item => isDeepStrictEqual(item.reference, input.queryType));
    if (type?.body.kind !== 'object_type') throw new Error('World F queryType must be a real object type in the exact original definition closure');
    await this.checkMaterial(input, arm, definitions);
    this.input = input; this.task = task; this.arm = arm; this.purpose = purpose; this.baseline = baseline; this.viewChecked = false;
    this.taskPages = await this.pages('tasks', { scope: task.scope });
    if (this.taskPages.flatMap(page => page.items).filter(item => isDeepStrictEqual(item.reference, { world, id: task.id, revision: task.revision })).length !== 1) throw new Error('World F exact original Task is absent or duplicated in its authorized directory');
    if (await this.electron.page.getByRole('dialog').count()) throw new Error('World F requires a clean UI confirmation boundary; no unrelated dialog is dismissed');
    return { purpose, scope: task.scope, taskValue: JSON.stringify({ world, id: task.id, revision: task.revision }),
      abstractionValue: JSON.stringify([abstraction.id, abstraction.revision]), queryValue: JSON.stringify(input.queryType), testValue: JSON.stringify([test.id, test.revision]),
      endpointId: input.execution?.endpointId, sessionValue: input.execution?.sessionValue,
      assurance: abstraction.assurance, fallback: abstraction.fallback, originalTaskUnchanged: true, rawEvidenceBound: true };
  }

  private async checkMaterial(input: Input, arm: Arm, definitions: Definition[]): Promise<void> {
    const material = input.material;
    exact(material.sourceVersion.world, world, 'original SourceVersion World'); exact(material.draft.world, world, 'original material draft World');
    const bytes = await readFile(await this.scratchFile(material.rawFile));
    const source = await this.read<{ reference: unknown; blob: unknown }>('query', 'source_version', { reference: material.sourceVersion });
    exact(source.reference, material.sourceVersion, 'real original SourceVersion');
    exact(source.blob, { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteSize: String(bytes.length) }, 'raw evidence exact bytes, not a guessed digest');
    const artifact = await this.read<{ world: World; id: string; sourceVersion: unknown; blocks: { text: string }[]; sourceMap: unknown[] }>('query', 'parse_artifact', { id: material.parseArtifactId });
    exact([artifact.world, artifact.id, artifact.sourceVersion], [world, material.parseArtifactId, material.sourceVersion], 'real parse provenance');
    exact(artifact.blocks.map(block => block.text).join('\n').trim(), bytes.toString('utf8').trim(), 'complete original UTF-8 evidence text');
    if (!artifact.sourceMap.length) throw new Error('World F original parse omits source anchors');
    const draft = await this.read<{ reference: unknown; sourceVersions: unknown[]; parseArtifacts: string[]; batch: { evidence: { reference: Ref; availability: string; status: string; locator: { sourceVersion: unknown; parseArtifactId?: string | null; anchor: unknown } }[] } }>('query', 'material_draft', material.draft);
    exact(draft.reference, material.draft, 'real material draft reference');
    if (!draft.sourceVersions.some(ref => isDeepStrictEqual(ref, material.sourceVersion)) || !draft.parseArtifacts.includes(material.parseArtifactId)) throw new Error('World F material draft does not retain the original source/parse chain');
    for (const ref of material.evidence) {
      const evidence = draft.batch.evidence.find(item => isDeepStrictEqual(item.reference, ref));
      if (!evidence || evidence.status !== 'active' || evidence.availability !== 'available') throw new Error('World F referenced evidence is absent, withdrawn or unavailable');
      exact([ref.world, evidence.locator.sourceVersion, evidence.locator.parseArtifactId], [world, material.sourceVersion, material.parseArtifactId], 'real evidence locator');
      if (!evidence.locator.anchor) throw new Error('World F evidence has no original source anchor');
    }
    const supported = (refs: Ref[]) => refs.some(ref => material.evidence.some(original => isDeepStrictEqual(ref, original)));
    if (!definitions.some(definition => definition.body.kind === 'strategy' && supported(definition.evidence))) throw new Error('World F exact Strategy has no reference to the bound raw evidence');
    for (const object of arm.facts.objects) {
      exact(object.object.world, world, 'real expected object World'); text(object.object.id, 'real expected object id');
      if (object.receiptId !== undefined) throw new Error('World F input must not guess a future read receipt id');
      for (const field of object.fields) if (field.cell.kind === 'known' && !supported(field.evidence)) throw new Error('World F known object fact is not supported by the original bound evidence');
    }
  }

  async reachTask(): Promise<void> {
    const task = this.task!;
    const index = this.taskPages.findIndex(page => page.items.some(item => item.reference.id === task.id && item.reference.revision === task.revision));
    const panel = this.electron.page.getByRole('tabpanel', { name: /^(Version & compile baseline|版本与编译基线)$/, exact: true });
    for (let page = 0; page <= index; page++) {
      if (page) await panel.getByRole('button', { name: /^(Next page|下一页)$/, exact: true }).click();
      const expected = this.taskPages[page].items.map(item => [item.reference.id, item.reference.revision, item.goal, item.scope]);
      const ready = await this.electron.page.waitForFunction(rows => JSON.stringify(Array.from(document.querySelectorAll('[role="tabpanel"] section:has(> header > h2) > .world-table tbody tr')).map(row => Array.from(row.querySelectorAll('td')).map(cell => cell.textContent?.trim() ?? ''))) === JSON.stringify(rows), expected, { timeout: 15_000 });
      await ready.dispose();
    }
  }
  async reachSelection(kind: 'abstraction' | 'test'): Promise<void> {
    const task = this.task!; const arm = this.arm!;
    const pages = await this.pages<{ id: string; revision: string }>(kind === 'abstraction' ? 'abstractions' : 'test_cases', { task: { world, id: task.id, revision: task.revision } });
    const selected = kind === 'abstraction' ? arm.abstraction : arm.test;
    const index = pages.findIndex(page => page.items.some(item => item.id === selected.id && item.revision === selected.revision));
    if (index < 0) throw new Error(`World F exact ${kind} is absent from the original Task directory`);
    const select = this.resolution().getByRole('combobox', { name: kind === 'abstraction' ? /^(Exact abstraction revision|精确抽象修订)$/ : /^(Independent recorded test revision|独立已登记测试修订)$/, exact: true });
    const button = select.locator('..').locator(kind === 'abstraction' ? 'xpath=following-sibling::div[1]' : 'xpath=following-sibling::button[1]');
    for (let page = 0; page < index; page++) {
      if (kind === 'abstraction') await button.getByRole('button', { name: /^(Load more|加载更多)$/, exact: true }).click();
      else await button.click();
      const expected = pages.slice(0, page + 2).flatMap(item => item.items).map(item => JSON.stringify([item.id, item.revision]));
      const ready = await this.electron.page.waitForFunction(({ kind, expected }) => {
        const label = Array.from(document.querySelectorAll('main .world-workspace label')).find(item => (kind === 'abstraction' ? /^(Exact abstraction revision|精确抽象修订)$/ : /^(Independent recorded test revision|独立已登记测试修订)$/).test(item.querySelector(':scope > span')?.textContent ?? ''));
        const select = label?.querySelector('select');
        return select && !select.disabled && JSON.stringify(Array.from(select.options).filter(option => option.value).map(option => option.value)) === JSON.stringify(expected);
      }, { kind, expected }, { timeout: 15_000 });
      await ready.dispose();
    }
    const options = await select.locator('option').evaluateAll(elements => elements.map(item => (item as HTMLOptionElement).value));
    if (!options.includes(JSON.stringify([selected.id, selected.revision]))) throw new Error(`World F normal UI did not expose its exact ${kind}; no substitute selected`);
  }

  private async rendered(container: Locator, expected: unknown): Promise<void> {
    const actual = await container.evaluate(element => {
      const read = (node: Element): unknown => {
        if (node.tagName === 'DL') return Object.fromEntries(Array.from(node.children).map(child => [child.querySelector(':scope > dt')!.textContent!.trim(), read(child.querySelector(':scope > dd')!)]));
        if (node.tagName === 'OL') return Array.from(node.children).map(read);
        const child = node.firstElementChild;
        return child ? read(child) : node.textContent?.trim() ?? '';
      };
      return read(element);
    });
    const matches = (actual: unknown, expected: unknown, depth = 0): boolean => {
      if (expected == null) return typeof actual === 'string' && /^(Not set|未设置)$/.test(actual);
      if (typeof expected !== 'object') return actual === String(expected).trim();
      if (depth >= 12) throw new Error('World F contract exceeds the public FixedRecord display depth; no hidden content is inferred');
      if (Array.isArray(expected)) return expected.length
        ? Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item, depth + 1))
        : typeof actual === 'string' && /^(None|无)$/.test(actual);
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
      const values = actual as RecordValue;
      return isDeepStrictEqual(Object.keys(values).sort(), Object.keys(expected).sort())
        && Object.entries(expected).every(([key, item]) => matches(values[key], item, depth + 1));
    };
    exact(matches(actual, expected), true, 'complete rendered public FixedRecord');
  }
  private details(names: string[]): Locator {
    return this.resolution().locator('details').filter({ has: this.electron.page.locator(':scope > summary').filter({ hasText: new RegExp(`^(${names.join('|')})$`) }) });
  }
  async inspectView() {
    const task = this.task!; const arm = this.arm!;
    const receiptPanel = this.details(['Read receipt and coverage', '读取回执与覆盖范围']);
    if (await receiptPanel.getAttribute('open') === null) await receiptPanel.locator(':scope > summary').click();
    const receipt = receiptPanel.locator(':scope > div > dl > div').filter({ has: this.electron.page.locator(':scope > dt').filter({ hasText: /^receipt$/ }) }).locator(':scope > dd');
    const leaf = async (key: string) => receipt.locator(':scope > dl > div').filter({ has: this.electron.page.locator(':scope > dt').filter({ hasText: new RegExp(`^${key}$`) }) }).locator(':scope > dd').innerText();
    const id = (await leaf('id')).trim(); text(id, 'actual UI read receipt id');
    await this.rendered(receipt.locator(':scope > dl > div').filter({ has: this.electron.page.locator(':scope > dt').filter({ hasText: /^world$/ }) }).locator(':scope > dd'), world);
    exact((await leaf('releaseId')).trim(), arm.abstraction.baseRelease, 'same abstraction read release');
    const branchField = receipt.locator(':scope > dl > div').filter({ has: this.electron.page.locator(':scope > dt').filter({ hasText: /^branchId$/ }) });
    const branch = await branchField.count() ? (await leaf('branchId')).trim() : null;
    exact(branch === null || /^(Not set|未设置)$/.test(branch) ? null : branch, arm.abstraction.branch?.id ?? null, 'same abstraction read branch');
    const receiptTree = await receipt.innerText();
    const reads = receiptPanel.locator(':scope > div > dl > div').filter({ has: this.electron.page.locator(':scope > dt').filter({ hasText: /^readReceipts$/ }) }).locator(':scope > dd > ol > li');
    exact(await reads.count(), 1, 'one Context committed-page receipt'); exact(await reads.first().innerText(), receiptTree, 'same complete receipt reused by Context, not a second query');
    const facts = this.details(['Facts and returned references', '事实与返回引用']);
    if (await facts.getAttribute('open') === null) await facts.locator(':scope > summary').click();
    await this.rendered(facts.locator(':scope > div'), { ...arm.facts, objects: arm.facts.objects.map(object => ({ ...object, receiptId: id })) });
    const view = this.resolution().locator('div').filter({ has: this.electron.page.locator(':scope > h4').filter({ hasText: /^WorldView$/ }) });
    await this.rendered(view.locator(':scope > dl'), { scope: task.scope, goal: task.goal, hardConstraints: task.hardConstraints, allowedEffects: task.allowedEffects, stopConditions: task.stopConditions, labels: arm.labels, truncation: arm.truncation });
    await this.rendered(this.details(['Full task contract', '完整任务契约']).locator(':scope > div'), task);
    await this.rendered(this.details(['Guard, invariants and dependencies', '守卫、不变量与依赖']).locator(':scope > div'), { guard: arm.abstraction.guard, assumptions: arm.abstraction.assumptions, preservedInvariants: arm.abstraction.preservedInvariants, readDependencies: arm.abstraction.readDependencies });
    await this.rendered(this.details(['Slots and concrete binding map', '槽位与具体绑定映射']).locator(':scope > div'), { slots: arm.abstraction.slots, parameters: arm.abstraction.parameters, bindingMap: arm.abstraction.bindingMap });
    await this.rendered(this.details(['Fallback and original definitions', '回退与原始定义']).locator(':scope > div'), { fallback: arm.abstraction.fallback, originalDefinitions: arm.abstraction.originalDefinitions, strategy: arm.abstraction.strategy, forwardPlan: arm.abstraction.forwardPlan, evaluationIds: arm.abstraction.evaluationIds });
    this.viewChecked = true;
    return { receiptId: id, rawEvidenceBound: true, exactFacts: true, unknowns: arm.facts.objects.flatMap(object => object.fields).filter(field => field.cell.kind === 'unknown').map(field => ({ property: field.property, cell: field.cell })), assurance: arm.abstraction.assurance, guardVerdict: 'not-yet-observed', fallback: arm.abstraction.fallback };
  }

  async fillInput(): Promise<void> {
    if (!this.viewChecked) throw new Error('World F exact actual WorldView must be checked before typed input');
    const fill = async (type: RecordValue, value: unknown, name: string, nullable = false, optional = false): Promise<void> => {
      const field = value === undefined ? undefined : record(value, `typed value ${name}`);
      const mode = this.resolution().locator(`[name=${JSON.stringify(`${name}.mode`)}]`);
      if (value === undefined) { if (!optional) throw new Error(`World F required input ${name} is absent`); await mode.selectOption('omit'); return; }
      if (field!.kind === 'null') { if (type.kind !== 'null') { if (!nullable) throw new Error(`World F ${name} is not nullable`); await mode.selectOption('null'); } return; }
      if (nullable || optional) await mode.selectOption('value');
      exact(field!.kind, type.kind, `input kind ${name}`);
      if (type.kind === 'record') {
        const fields = type.fields as { name: string; valueType: RecordValue; nullable: boolean; optional: boolean }[];
        const values = record(field!.fields, `input fields ${name}`);
        if (Object.keys(values).some(key => !fields.some(item => item.name === key))) throw new Error(`World F unexpected input field ${name}`);
        for (const item of fields) await fill(item.valueType, values[item.name], `${name}.${item.name}`, item.nullable, item.optional);
      } else if (type.kind === 'list') {
        const items = field!.items as unknown[]; if (!Array.isArray(items) || items.length > Math.min(Number(type.maxItems), 100)) throw new Error(`World F invalid input list ${name}`);
        const group = this.resolution().locator(`[name=${JSON.stringify(`${name}.count`)}]`).locator('..');
        for (const [index, item] of items.entries()) { await group.getByRole('button', { name: /^(Add item|添加一项)$/, exact: true }).click(); await fill(record(type.element, 'list element type'), item, `${name}.${index}`); }
      } else {
        const control = this.resolution().locator(`[name=${JSON.stringify(name)}]`);
        if (type.kind === 'boolean') { if (typeof field!.value !== 'boolean') throw new Error(`World F invalid boolean ${name}`); await control.selectOption(String(field!.value)); }
        else if (type.kind === 'object') { text(field!.id, `object input ${name}`); if (!this.arm!.facts.objects.some(object => object.object.id === field!.id && object.object.typeId === type.typeId)) throw new Error('World F object input is not a real returned compatible object'); await control.selectOption(field!.id); }
        else { const value = field![type.kind === 'relation' ? 'id' : type.kind === 'duration' ? 'milliseconds' : ['money', 'quantity'].includes(String(type.kind)) ? 'amount' : 'value']; if (typeof value !== 'string') throw new Error(`World F invalid scalar ${name}`); if (type.kind === 'timestamp') throw new Error('World F timestamp input needs an explicit timezone-preserving UI contract; stopped before submission'); await control.fill(value); }
      }
    };
    await fill(this.task!.inputType, this.input!.input, 'task.input');
  }
  async checkSession(): Promise<void> {
    const execution = this.input!.execution; record(execution, 'existing native session binding');
    text(execution.endpointId, 'existing runtime endpoint'); text(execution.sessionValue, 'existing native session identity');
    const identity = record(JSON.parse(execution.sessionValue), 'public native session identity');
    exact(identity.agentId, execution.selection.agentId, 'same native session Agent');
    const endpoint = record(identity.endpoint, 'native session endpoint'); exact(endpoint.kind, 'native-runtime', 'native endpoint kind'); exact(endpoint.runtimeInstanceId, 'local', 'local endpoint instance');
    exact(endpoint.runtimeAdapterId, execution.selection.kind === 'openclaw' ? 'openclaw' : 'matcha-agent', 'selected native adapter');
    if (!['openclaw', 'matcha_agent'].includes(execution.selection.kind)) throw new Error('World F unsupported native session kind');
    if (execution.selection.kind === 'openclaw') exact(identity.sessionKey, execution.selection.sessionKey, 'same OpenClaw session key');
    text(execution.selection.nativeSessionId, 'actual native session id');
    const session = this.resolution().getByRole('combobox', { name: /^(Existing native session|已有原生会话)$/, exact: true });
    const option = session.locator('option').filter({ hasText: new RegExp(`${execution.selection.agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ${execution.selection.nativeSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    exact(await option.count(), 1, 'unique existing native session'); exact(await option.getAttribute('value'), execution.sessionValue, 'actual catalog session identity');
  }
  async markResolution(): Promise<void> {
    if (!this.viewChecked || this.purpose === 'view' || !this.purpose || this.attempted.has(this.purpose) || this.observation) throw new Error('World F resolution must be one new confirmed guard case; no replay or automatic recovery');
    await this.unchanged();
    this.attempted.add(this.purpose); this.ownsConfirmation = true;
    await this.observeOperation(this.baseline!.incarnation);
  }
  private async observeOperation(incarnation: string): Promise<void> {
    if (this.observation) throw new Error('World F already owns an operation observer');
    const handle = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
      const state: Observation = { ids: [], dispose: () => undefined };
      const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!object(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !object(value.payload)) return;
        const hint = value.payload;
        if (!object(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') { state.error = 'World F original event continuity lost; preserve request without replay'; return; }
        if (!object(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) { if (state.ids.length >= 8) state.error = 'World F ambiguous operation hints; no identity inferred'; else state.ids.push(hint.resource.id); }
      });
      return state;
    }, { world, incarnation });
    this.observation = { read: async (wait = true) => {
      if (wait) { const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 }); await ready.dispose(); }
      return handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
    }, dispose: async () => { await handle.evaluate(state => state.dispose()); await handle.dispose(); } };
  }
  async inspectResolution(selectedOperation: string) {
    if (!this.observation || !this.purpose || this.purpose === 'view') throw new Error('World F no owned one-shot resolution observer');
    const observed = await this.observation.read();
    if (observed.error) throw new Error(observed.error);
    if (observed.ids.length !== 1) throw new Error(`World F ambiguous original operation hints count=${observed.ids.length}; no resubmission`);
    const id = observed.ids[0];
    exact(selectedOperation, id, 'UI selected operation is the same unique current command hint');
    const receipt = await this.read<Receipt>('operation', 'result', { world, operationId: id });
    exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, id, this.baseline!.incarnation], 'same exact OperationKey and incarnation');
    if (receipt.phase !== 'completed' || receipt.disclosure.kind !== 'full' || receipt.result?.kind !== 'resolution') throw new Error(`World F operation=${id}; phase=${receipt.phase}; disclosure=${receipt.disclosure.kind}; code=${receipt.failure?.code}; stage=${receipt.failure?.stage}; diagnosticId=${receipt.failure?.diagnosticId}; only this original receipt is read, never resumed or resent`);
    exact(receipt.effects, [], 'zero Source effects'); exact(receipt.failure, null, 'completed guard resolution failure envelope');
    text(receipt.result.result.caseId, 'real recorded case id');
    exact(receipt.result.result.outcome, { kind: 'inconclusive', reason: { kind: 'guard_not_satisfied', field: ['abstraction', 'guard'], truth: this.purpose } }, 'same-operation observed guard truth and stop result, not a displayed declaration');
    await this.unchanged();
    return { operationId: id, caseId: receipt.result.result.caseId, phase: receipt.phase, outcome: receipt.result.result.outcome, guard: this.purpose, fallback: 'stop', assurance: this.arm!.abstraction.assurance, verified: false, originalTaskUnchanged: true, effects: receipt.effects };
  }
  async unchanged() {
    if (!this.task || !this.baseline || !this.arm) throw new Error('World F no checked original contract');
    exact(await this.read('query', 'task_contract', { world, id: this.task.id, revision: this.task.revision }), this.task, 'unchanged complete Task/Oracle pin/budget');
    exact(await this.read('query', 'abstraction', { world, id: this.arm.abstraction.id, revision: this.arm.abstraction.revision }), this.arm.abstraction, 'unchanged exact abstraction');
    const current = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([current.world, current.status, current.incarnation, current.activeRelease, current.activeReleaseHead, current.editingContext], [world, 'ready', this.baseline.incarnation, this.baseline.activeRelease, this.baseline.activeReleaseHead, this.baseline.editingContext], 'unchanged active release and binding context');
    return { originalTaskUnchanged: true, originalAbstractionUnchanged: true, activeReleaseUnchanged: true };
  }
  async release(): Promise<void> {
    const failures: unknown[] = [];
    if (this.observation) { try { await this.observation.dispose(); this.observation = undefined; } catch (error) { failures.push(error); } }
    if (this.ownsConfirmation) {
      try {
        const dialogs = this.electron.page.getByRole('dialog');
        if (await dialogs.count() === 1) await dialogs.getByRole('button', { name: /^(Cancel|取消)$/, exact: true }).click();
        exact(await dialogs.count(), 0, 'owned confirmation closure'); this.ownsConfirmation = false;
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'World F owned observer/UI cleanup failed; original operation history is retained');
  }
}
