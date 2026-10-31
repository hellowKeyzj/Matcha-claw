import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

type WorldRef = { tenantId: string; worldId: string };
type Reference = { world: WorldRef; id: string; revision: string };
type Failure = { code: string; stage: string; message: string; diagnosticId: string; details: unknown; recovery: { kind: string } };
type Envelope = { success: true; data: { kind: string; result: unknown } } | { success: false; error: Failure };
type CatalogKind = 'definitions' | 'materials' | 'connections' | 'action_proposals' | 'changes' | 'evaluations';
type CatalogEntry = {
  reference?: Reference & { sourceId?: string; versionId?: string }; world?: WorldRef;
  id?: string; revision?: string; name?: string; configured?: boolean;
  body?: { kind: string; body: { name?: string } }; rationale?: string; status?: string;
};
type WirePage<T> = { items: T[]; nextCursor: string | null };
type TaskContract = Reference & { scope: string; goal: string; budget: Record<string, string | null> };
type TaskSummary = { reference: Reference; scope: string; goal: string };
type Description = { world: WorldRef; status: string; activeRelease: string; activeReleaseHead: unknown; incarnation: string;
  editingContext?: { activationLock: { id: string; nodes: { slot: string }[] }; scopes: { id: string; world: WorldRef }[] } };
type CurrentPrerequisites = { world: WorldRef; status: string; activeRelease: string; activeReleaseHead: unknown; incarnation: string; activationLock: string;
  scopes: string[]; slots: string[]; catalogs: Record<string, number>; catalogEntries: Record<string, unknown[]>; tasks: TaskSummary[];
  packages: unknown[]; trustPolicy: unknown; unchanged: boolean };
type Receipt = {
  accepted: { world: WorldRef; operationId: string; revision: string; incarnation: string };
  disclosure: { kind: 'full' | 'summary'; withheld?: string[] }; phase: string;
  progress: { stage: string; completed: string; total: string | null };
  result: unknown; failure: unknown; commit: unknown; effects: unknown[]; cancellation: string; updatedAt: string;
};
const world = { tenantId: 'local', worldId: 'personal' };
const kinds: CatalogKind[] = ['definitions', 'materials', 'connections', 'action_proposals', 'changes', 'evaluations'];
const taskId = 'manual-noop-prefix-20261025-81b7c54e';
const changeId = 'change-100cf29ebf3bf59fa41e7977463e6a95160d76661ee940e37532bd1a4d438519';

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World workspace ${label} differs from the exact public contract`);
}
function safeFailure(label: string, status: number, failure: Failure): Error {
  return new Error(`${label}: HTTP ${status}; code=${failure.code}; stage=${failure.stage}; diagnosticId=${failure.diagnosticId}`);
}
function assertPublic(value: unknown): void {
  if (typeof value === 'string' && /(?:postgres(?:ql)?:\/\/[^\s]*@|Bearer\s+\S+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/i.test(value)) {
    throw new Error('World public projection contains a credential-shaped value');
  }
  if (Array.isArray(value)) { value.forEach(assertPublic); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/^(?:connectionString|password|apiKey|accessToken|refreshToken|privateKey|privateCause|cause|stack|backtrace)$/i.test(key)) {
      throw new Error('World public projection contains a private diagnostic or credential field');
    }
    assertPublic(item);
  }
}

export class WorldWorkspace extends Ability {
  private original?: { task: TaskContract; change: unknown; release: unknown };
  private catalog?: Record<CatalogKind, CatalogEntry[]>;
  private rounds = 0;
  private taskPages: WirePage<TaskSummary>[] = [];
  private taskPageIndex = 0;
  constructor(private readonly electron: UseElectron) { super(); }

  async selectAccessibleWorld(): Promise<void> {
    const list = this.electron.page.locator('main .world-workspace').getByRole('list', { name: /^(Accessible worlds|可访问的世界)$/, exact: true });
    const buttons = list.getByRole('button');
    await buttons.first().waitFor({ state: 'visible' });
    if (await buttons.count() !== 1) throw new Error('World E2E requires one explicitly accessible World; no identity was guessed');
    const selected = buttons.first();
    const identity = await selected.locator(':scope > span').allTextContents();
    if (identity.length !== 2 || identity.some(value => !value.trim())) throw new Error('Accessible World has no complete public identity');
    this.currentWorld = { tenantId: identity[1].trim(), worldId: identity[0].trim() };
    await selected.click();
  }

  private currentWorld?: WorldRef;
  private get selectedWorld(): WorldRef {
    if (!this.currentWorld) throw new Error('Select the actual accessible World before public readback');
    return this.currentWorld;
  }

  private async read(endpoint: 'query' | 'operation', kind: string, request: unknown) {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${endpoint}`, method: 'POST', timeoutMs: 10_000,
      body: endpoint === 'query' ? { world: this.selectedWorld, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World ${kind} transport failed: ${reply.error.code}`);
    const body = reply.data.json as Envelope;
    if (!body || typeof body.success !== 'boolean') throw new Error(`World ${kind} returned no typed envelope`);
    assertPublic(body);
    if (!body.success) {
      if (!body.error?.code || !body.error.stage || !body.error.diagnosticId) throw new Error(`World ${kind} returned an incomplete safe failure`);
      return { status: reply.data.status, failure: body.error };
    }
    if (reply.data.status !== 200 || !reply.data.ok || body.data?.kind !== kind) throw new Error(`World ${kind} returned a mismatched success`);
    return { status: reply.data.status, value: body.data.result };
  }

  private async query<T>(kind: string, request: unknown): Promise<T> {
    const reply = await this.read('query', kind, request);
    if (reply.failure) throw safeFailure(`World ${kind}`, reply.status, reply.failure);
    return reply.value as T;
  }

  private async pages<T>(kind: string, request: object): Promise<WirePage<T>[]> {
    const pages: WirePage<T>[] = [];
    const cursors = new Set<string>();
    const entries = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: WirePage<T> = await this.query<WirePage<T>>(kind, { ...request, page: { limit: 100, cursor } });
      if (!page || !Array.isArray(page.items) || page.items.length > 100
        || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) {
        throw new Error(`World ${kind} returned an invalid page or omitted terminal cursor`);
      }
      for (const item of page.items) {
        const key = JSON.stringify(item);
        if (entries.has(key)) throw new Error(`World ${kind} repeated an entry across pages`);
        entries.add(key);
      }
      pages.push(page);
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || pages.length >= 1000)) throw new Error(`World ${kind} cursor did not terminate within the read bound`);
      if (cursor) cursors.add(cursor);
    } while (cursor !== null);
    return pages;
  }

  private async catalogs() {
    // All six first requests start together; pagination is independent within each directory.
    const results = await Promise.all(kinds.map(async kind => [kind,
      (await this.pages<CatalogEntry>(kind, kind === 'definitions' ? { kind: null } : {})).flatMap(page => page.items),
    ] as const));
    const catalog = Object.fromEntries(results) as Record<CatalogKind, CatalogEntry[]>;
    for (const kind of kinds) for (const item of catalog[kind]) {
      if (item.world) requireEqual(item.world, world, `${kind} World`);
      if (item.reference?.world) requireEqual(item.reference.world, world, `${kind} reference World`);
      const identity = kind === 'materials' ? item.reference?.versionId
        : kind === 'definitions' ? item.reference?.id : item.id;
      if (typeof identity !== 'string' || !identity) throw new Error(`World ${kind} contains an unidentifiable entry`);
    }
    return catalog;
  }

  async readCatalogRound(round: number) {
    if (round === 1) this.rounds = 0;
    if (round !== this.rounds + 1) throw new Error('World concurrent catalog rounds must run once in order');
    this.catalog = await this.catalogs();
    this.rounds = round;
    const c = this.catalog;
    return { rounds: round, complete: true,
      definitions: c.definitions.map(item => `${item.body?.body.name ?? item.reference!.id} · ${item.reference!.id} / ${item.reference!.revision}`),
      materials: c.materials.map(item => item.reference!.versionId!),
      connections: c.connections.map(item => ({ name: item.name!, configured: item.configured! })),
      proposals: c.action_proposals.map(item => item.id!),
      actions: c.definitions.filter(item => item.body?.kind === 'action_contract').map(item => item.body!.body.name ?? item.reference!.id),
      pending: c.changes.filter(item => ['proposed', 'validated', 'testing', 'ready'].includes(item.status!)).map(item => item.rationale!),
      evaluations: c.evaluations.map(item => item.id!),
    };
  }

  async inspectCurrentPrerequisites(): Promise<CurrentPrerequisites> {
    const before = await this.query<Description>('discover', { includeCapabilities: true });
    requireEqual(before.world, this.selectedWorld, 'selected World');
    if (before.status !== 'ready' || !before.activeRelease || !before.activeReleaseHead || !before.editingContext) {
      throw new Error('Current World has no complete ready editing context');
    }
    const context = before.editingContext;
    for (const scope of context.scopes) requireEqual(scope.world, this.selectedWorld, 'current scope World');
    const [catalogs, packages, trustPolicy, tasks] = await Promise.all([
      Promise.all(kinds.map(async kind => [kind, (await this.pages(kind, kind === 'definitions' ? { kind: null } : {})).flatMap(page => page.items)] as const)),
      this.pages('packages', {}).then(pages => pages.flatMap(page => page.items)),
      this.query('package_trust_policy', {}),
      Promise.all(context.scopes.map(scope => this.pages<TaskSummary>('tasks', { scope: scope.id })))
        .then(scopes => scopes.flat().flatMap(page => page.items)),
    ]);
    const after = await this.query<Description>('discover', { includeCapabilities: true });
    requireEqual(after, before, 'current prerequisites unchanged by inspection');
    return { world: before.world, status: before.status, activeRelease: before.activeRelease,
      activeReleaseHead: before.activeReleaseHead, incarnation: before.incarnation,
      activationLock: context.activationLock.id, scopes: context.scopes.map(scope => scope.id),
      slots: context.activationLock.nodes.map(node => node.slot), catalogEntries: Object.fromEntries(catalogs),
      catalogs: Object.fromEntries(catalogs.map(([kind, entries]) => [kind, entries.length])),
      tasks, packages, trustPolicy, unchanged: true };
  }

  async rememberOriginal() {
    requireEqual(this.selectedWorld, world, 'historical Task and NoOp World; no cross-World replay');
    const input = JSON.parse(await readFile(resolve(repositoryRoot,
      '.scratch/world-implementation-2026-10-21/s06-task-noop-input-20261025-81b7c54e/task.ready.json'), 'utf8')) as TaskContract;
    const saved = JSON.parse(await readFile(resolve(repositoryRoot,
      '.scratch/e2e-acceptance-2026-10-24-world-setup-all-1793042620406930300/result.json'), 'utf8')) as { noOp: { change: object } };
    const task = await this.query<TaskContract>('task_contract', { world, id: taskId, revision: '1' });
    requireEqual(task, { ...input, budget: { maxCost: null, deadline: null, ...input.budget } }, 'original full Task');
    if (task.id !== taskId || task.scope !== 'scope:personal:management' || task.budget.maxModelCalls !== '0' || task.budget.maxSourceReads !== '0') {
      throw new Error('World workspace requires the original zero-model/zero-Source Task; no registration is attempted');
    }
    const change = await this.query<{ revision: string; status: string }>('change', { id: changeId });
    const validated = { ...saved.noOp.change, revision: '2', status: 'validated' };
    if (!isDeepStrictEqual(change, saved.noOp.change) && !isDeepStrictEqual(change, validated)) throw new Error('The original full NoOp has changed beyond its two proven review states');
    const description = await this.query<Description>('discover', { includeCapabilities: false });
    requireEqual(description.world, world, 'ready World');
    if (description.status !== 'ready' || !description.activeReleaseHead) throw new Error('World workspace requires a real ready World and release head');
    this.original = { task, change, release: [description.activeRelease, description.activeReleaseHead, description.incarnation] };
    return { exact: true, taskId, scope: task.scope };
  }

  async confirmOriginal() {
    if (!this.original) throw new Error('World original readback was not captured for this case');
    const task = await this.query('task_contract', { world, id: taskId, revision: '1' });
    const change = await this.query('change', { id: changeId });
    const description = await this.query<Description>('discover', { includeCapabilities: false });
    requireEqual(task, this.original.task, 'unchanged full Task');
    requireEqual(change, this.original.change, 'unchanged full NoOp');
    requireEqual([description.activeRelease, description.activeReleaseHead, description.incarnation], this.original.release, 'unchanged active release');
    requireEqual(description.world, world, 'unchanged World');
    if (description.status !== 'ready') throw new Error('World did not remain ready');
    return { task: true, noOp: true, activeRelease: true };
  }

  async inspectObjectsDecodeFailures() {
    const root = { kind: 'union', inputs: [] };
    const parameter = { id: 'quantity', valueType: { kind: 'integer' }, nullable: false, optional: false };
    const argument = { parameterId: 'quantity', value: { kind: 'integer', value: '3' } };
    const request = { world, branchId: null, releaseId: null, query: { root, parameters: [], output: [], limit: 1 },
      arguments: [], readMode: { kind: 'authoritative' }, validAt: null, knownAt: null, page: { limit: 1, cursor: null } };
    // Earlier field errors deliberately precede this empty Union; no dataset, Source or runtime slot is needed.
    const cases: Array<{ label: string; field: string; reason: 'invalid_value' | 'missing_field'; patch: object }> = [
      { label: 'zero page limit', field: 'page.limit', reason: 'invalid_value', patch: { page: { limit: 0, cursor: null } } },
      { label: 'empty Union', field: 'query.root.inputs', reason: 'invalid_value', patch: {} },
      { label: 'empty Aggregate', field: 'query.root.aggregates', reason: 'invalid_value',
        patch: { query: { ...request.query, root: { kind: 'aggregate', input: root, groupBy: [], aggregates: [] } } } },
      { label: 'empty Project', field: 'query.root.columns', reason: 'invalid_value',
        patch: { query: { ...request.query, root: { kind: 'project', input: root, columns: [] } } } },
      { label: 'duplicate parameter', field: 'query.parameters', reason: 'invalid_value',
        patch: { query: { ...request.query, parameters: [parameter, parameter] } } },
      { label: 'missing required argument', field: 'arguments', reason: 'missing_field',
        patch: { query: { ...request.query, parameters: [parameter] } } },
      { label: 'unexpected argument', field: 'arguments.parameterId', reason: 'invalid_value', patch: { arguments: [argument] } },
      { label: 'duplicate argument', field: 'arguments', reason: 'invalid_value',
        patch: { query: { ...request.query, parameters: [parameter] }, arguments: [argument, argument] } },
    ];
    const diagnostics = new Set<string>();
    for (const entry of cases) {
      const reply = await this.read('query', 'objects', { ...request, ...entry.patch });
      if (!reply.failure) throw new Error(`World objects ${entry.label} unexpectedly succeeded`);
      const failure = reply.failure;
      if (reply.status !== 400) throw safeFailure(`World objects ${entry.label}`, reply.status, failure);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(failure.diagnosticId)
        || diagnostics.has(failure.diagnosticId)) throw new Error(`World objects ${entry.label} has no fresh UUID diagnostic`);
      requireEqual(failure, { code: 'world.invalid_query', stage: 'decode', message: '查询输入无效。', diagnosticId: failure.diagnosticId,
        details: { kind: 'input', failure: { kind: entry.reason, field: entry.field.split('.') } }, recovery: { kind: 'none' } },
      `objects ${entry.label} safe failure`);
      diagnostics.add(failure.diagnosticId);
    }
    return { cases: cases.map(entry => entry.label), publicOnly: true };
  }

  async prepareTaskReading() {
    if (!this.original) throw new Error('Read the original Task before preparing management inspection');
    const task = this.original.task;
    const pages = await this.pages<TaskSummary>('tasks', { scope: task.scope });
    for (const item of pages.flatMap(page => page.items)) {
      requireEqual(item.reference.world, world, 'Task list World');
      if (item.scope !== task.scope) throw new Error('Task list scope differs');
    }
    const index = pages.findIndex(page => page.items.some(item => item.reference.id === taskId && item.reference.revision === '1'));
    if (index < 0) throw new Error('Original Task is absent from the complete authorized scope directory');
    this.taskPages = pages;
    this.taskPageIndex = index;
    const reference = pages[index].items.find(item => item.reference.id === taskId && item.reference.revision === '1')!.reference;
    const abstractions = await this.query<WirePage<{ id: string; revision: string; world: WorldRef; taskId: string; taskRevision: string }>>('abstractions', { task: reference, page: { limit: 100, cursor: null } });
    for (const item of abstractions.items) {
      requireEqual(item.world, world, 'abstraction World');
      if (item.taskId !== taskId || item.taskRevision !== '1') throw new Error('Task abstraction reference differs');
    }
    const tests = await this.read('query', 'test_cases', { task: reference, page: { limit: 100, cursor: null } });
    let evaluation: 'available' | 'not-configured';
    let testReferences: Array<{ id: string; revision: string }> = [];
    let error = '';
    if (tests.failure) {
      if (tests.status !== 503 || tests.failure.code !== 'world.evaluation_not_configured' || tests.failure.stage !== 'admission'
        || !isDeepStrictEqual(tests.failure.details, { kind: 'not_configured' }) || tests.failure.recovery.kind !== 'none') {
        throw safeFailure('World test_cases', tests.status, tests.failure);
      }
      evaluation = 'not-configured'; error = tests.failure.message;
    } else {
      evaluation = 'available';
      const page = tests.value as WirePage<{ id: string; revision: string }>;
      if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('World test_cases returned no typed page');
      testReferences = page.items;
      await Promise.all(testReferences.map(async reference => {
        const exact = await this.query<Reference & { taskId: string; taskRevision: string }>('exact_test_case', reference);
        requireEqual(exact.world, world, 'test World');
        if (exact.id !== reference.id || exact.revision !== reference.revision || exact.taskId !== taskId || exact.taskRevision !== '1') throw new Error('Exact test reference differs');
      }));
    }
    return { scope: task.scope, taskValue: JSON.stringify(reference), authoringValue: JSON.stringify([world, taskId, '1', task.scope]),
      first: pages[0].items.map(item => [item.reference.id, item.reference.revision, item.goal, item.scope].join(' ')),
      following: pages.slice(1, index + 1).map(page => ({ rows: page.items.map(item => [item.reference.id, item.reference.revision, item.goal, item.scope].join(' ')),
        options: page.items.map(item => JSON.stringify([world, item.reference.id, item.reference.revision, item.scope])) })),
      firstOptions: pages[0].items.map(item => JSON.stringify([world, item.reference.id, item.reference.revision, item.scope])),
      evaluation, error, abstractions: abstractions.items.map(item => JSON.stringify([item.id, item.revision])),
      tests: testReferences.map(item => JSON.stringify([item.id, item.revision])) };
  }

  async reachOriginalTask(surface: 'management' | 'authoring') {
    if (!this.taskPages.length) throw new Error('Read the complete Task directory before paging its UI');
    const workspace = this.electron.page.locator('main .world-workspace');
    const panel = workspace.getByRole('tabpanel', { name: surface === 'management'
      ? /^(Version & compile baseline|版本与编译基线)$/ : /^(Author definitions|手工建模)$/, exact: true });
    const next = panel.getByRole('button', { name: /^(Next page|下一页)$/, exact: true });
    for (let index = 0; index <= this.taskPageIndex; index++) {
      if (index) { await next.waitFor({ state: 'visible' }); if (!await next.isEnabled()) throw new Error('Task UI omitted a required next page'); await next.click(); }
      const expected = this.taskPages[index].items;
      if (surface === 'management') {
        const rows = panel.locator('section:has(> header > h2) > .world-table tbody tr');
        await this.electron.page.waitForFunction(expected => {
          const rows = Array.from(document.querySelectorAll('[role="tabpanel"] section:has(> header > h2) > .world-table tbody tr'));
          return JSON.stringify(rows.map(row => Array.from(row.querySelectorAll('td')).map(cell => cell.textContent?.trim() ?? ''))) === JSON.stringify(expected);
        }, expected.map(item => [item.reference.id, item.reference.revision, item.goal, item.scope]));
        const cells = await rows.evaluateAll(elements => elements.map(row => Array.from(row.querySelectorAll('td')).map(cell => cell.textContent?.trim() ?? '')));
        requireEqual(cells, expected.map(item => [item.reference.id, item.reference.revision, item.goal, item.scope]), 'Task management page');
      } else {
        const options = panel.getByRole('combobox', { name: /^(Related task|关联任务)$/, exact: true }).locator('option[value]:not([value=""])');
        await options.first().waitFor({ state: 'attached' });
        // The normal file control is disabled for the whole scope/page read, so it is the UI's settled marker.
        await panel.locator('input[type="file"]').waitFor({ state: 'visible' });
        await this.electron.page.waitForFunction(expected => {
          const panel = Array.from(document.querySelectorAll('[role="tabpanel"]')).find(item => /^(Author definitions|手工建模)$/.test(item.getAttribute('aria-labelledby')
            ? document.getElementById(item.getAttribute('aria-labelledby')!)?.textContent ?? '' : ''));
          const task = Array.from(panel?.querySelectorAll('label') ?? []).find(item => /^(Related task|关联任务)$/.test(item.querySelector('span')?.textContent ?? ''));
          const values = Array.from(task?.querySelectorAll('option[value]:not([value=""])') ?? []).map(item => (item as HTMLOptionElement).value);
          return Boolean(panel?.querySelector('input[type="file"]:enabled')) && JSON.stringify(values) === JSON.stringify(expected);
        }, expected.map(item => JSON.stringify([world, item.reference.id, item.reference.revision, item.scope])));
        const values = await options.evaluateAll(elements => elements.map(item => (item as HTMLOptionElement).value));
        requireEqual(values, expected.map(item => JSON.stringify([world, item.reference.id, item.reference.revision, item.scope])), 'Task authoring page');
      }
    }
  }

  async confirmTaskRendering() {
    if (!this.original) throw new Error('No original Task for UI comparison');
    const details = this.electron.page.locator('main .world-workspace details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(Full task contract|完整任务契约)$/ }) }).last();
    const exact = await details.locator(':scope > div').evaluate((root, expected) => {
      const matches = (node: Element, value: unknown): boolean => {
        if (value === null || value === undefined) return /^(Not set|未设置)$/.test(node.textContent?.trim() ?? '');
        if (Array.isArray(value)) {
          if (!value.length) return /^(None|无)$/.test(node.textContent?.trim() ?? '');
          const children = Array.from(node.querySelectorAll(':scope > ol > li'));
          return children.length === value.length && children.every((child, index) => matches(child, value[index]));
        }
        if (typeof value === 'object') {
          const children = Array.from(node.querySelectorAll(':scope > dl > div'));
          return children.length === Object.keys(value).length && children.every(child => {
            const key = child.querySelector(':scope > dt')?.textContent;
            const content = child.querySelector(':scope > dd');
            return key !== null && key !== undefined && Object.hasOwn(value, key) && Boolean(content) && matches(content!, (value as Record<string, unknown>)[key]);
          });
        }
        return node.textContent?.trim() === String(value);
      };
      return matches(root, expected);
    }, this.original.task);
    if (!exact) throw new Error('Rendered full Task differs from the exact original contract, including budget and oracle');
    return true;
  }

  async prepareOperations() {
    const options = this.electron.page.locator('main .world-workspace').getByRole('combobox', { name: /^(Records from this session|本次会话记录)$/ }).locator('option[value]:not([value=""])');
    const ids = await options.evaluateAll(elements => elements.map(element => (element as HTMLOptionElement).value));
    if (new Set(ids).size !== ids.length || ids.some(id => !id.trim())) throw new Error('Session operations contain invalid identities');
    return { ids, first: ids[0] ?? '', missing: `operation:e2e-missing:${randomUUID()}` };
  }

  async inspectOperation(id: string) {
    const receipts: Receipt[] = [];
    for (const kind of ['status', 'result'] as const) {
      const response = await this.read('operation', kind, { world, operationId: id });
      if (response.failure) throw safeFailure(`World operation ${kind}`, response.status, response.failure);
      const receipt = response.value as Receipt;
      requireEqual(Object.keys(receipt).sort(), ['accepted', 'disclosure', 'phase', 'progress', 'result', 'failure', 'commit', 'effects', 'cancellation', 'updatedAt'].sort(), 'public receipt fields');
      requireEqual(receipt.accepted.world, world, 'receipt World');
      if (receipt.accepted.operationId !== id || !/^[1-9]\d*$/.test(receipt.accepted.revision) || !/^[1-9]\d*$/.test(receipt.accepted.incarnation)
        || !['full', 'summary'].includes(receipt.disclosure.kind) || !Array.isArray(receipt.effects)) throw new Error('Operation receipt identity or disclosure differs');
      if (['commit_indeterminate', 'effect_indeterminate'].includes(receipt.phase)) {
        const failure = receipt.failure as Failure | null;
        throw new Error(`World operation ${id}: phase=${receipt.phase}; code=${failure?.code ?? 'not-disclosed'}; stage=${failure?.stage ?? 'not-disclosed'}; diagnosticId=${failure?.diagnosticId ?? 'not-disclosed'}; no retry is attempted`);
      }
      if (receipt.disclosure.kind === 'summary') {
        const withheld = receipt.disclosure.withheld;
        if (!Array.isArray(withheld) || withheld.some(item => !['progress_counts', 'result_details', 'failure_details', 'effects', 'committed_revisions'].includes(item))) throw new Error('Unknown operation withholding contract');
        if (withheld.includes('effects')) requireEqual(receipt.effects, [], 'withheld effects projection, not evidence of no effects');
        if (withheld.includes('progress_counts')) requireEqual([receipt.progress.completed, receipt.progress.total], ['0', null], 'withheld counts projection, not actual zero work');
      }
      receipts.push(receipt);
    }
    if (BigInt(receipts[1].accepted.revision) < BigInt(receipts[0].accepted.revision)) throw new Error('Operation result revision regressed');
    const trace = this.electron.page.locator('main .world-workspace aside[aria-labelledby="world-operation-trace"]');
    requireEqual(await trace.locator('.world-panel-body > p.font-mono').innerText(), id, 'selected UI OperationKey');
    requireEqual(await trace.locator('.world-status[data-status]').getAttribute('data-status'), receipts[1].phase, 'selected UI receipt phase');
    assertPublic(await this.electron.page.locator('main .world-workspace').getByRole('region', { name: /^(Processing records|处理记录)$/, exact: true }).innerText());
    return { id, phase: receipts[1].phase, publicOnly: true };
  }

  async inspectMissingOperation(id: string) {
    for (const kind of ['status', 'result'] as const) {
      const response = await this.read('operation', kind, { world, operationId: id });
      if (!response.failure) throw new Error('An invented OperationKey unexpectedly returned a receipt');
      const failure = response.failure;
      if (response.status !== 422 || failure.code !== 'world.operation_not_found' || failure.stage !== 'read'
        || failure.message !== '操作不存在或当前不可访问。' || !isDeepStrictEqual(failure.details, { kind: 'not_found' })
        || !isDeepStrictEqual(failure.recovery, { kind: 'none' })) throw safeFailure(`World missing operation ${kind}`, response.status, failure);
    }
    return { id, code: 'world.operation_not_found', stage: 'read', status: 422, message: '操作不存在或当前不可访问。', publicOnly: true };
  }
}
