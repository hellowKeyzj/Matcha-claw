import { Ability } from '@serenity-js/core';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { licensedProfileRoot, repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

const world = { tenantId: 'local', worldId: 'personal' };
const inputPath = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21/order-activation-access-20261027-r1.json');
const inputSha256 = '1b247f41a6519e28e64b9c60f8861d9b92e47a95be1539d2068d900fdb3c3037';
const materialsInputPath = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21/order-materials-execution-access-20261028-r1.json');
const materialsInputSha256 = 'ef02a23ea070cd42a0a3d11919373be6a7a2a1d55189d13dee0473634e6079be';
type Grant = { world: typeof world; commitId: string; id: string; actor: { kind: string; id: string }; access: { resources: unknown[]; fields: unknown[]; modes: string[]; scope: string; validTime: null }[]; labels: string[]; effects: string[]; expiresAt: string };
type Receipt = { world: typeof world; commitId: string; committedAt: string; revisions: unknown[]; outboxIds: unknown[]; fence: { world: typeof world; domain: string; epoch: string } };
type Custody = { inputSha256: string; commitId: string; grantId: string; phase: string; receipt?: Receipt };
type MaterialsContext = {
  world: typeof world; status: string; incarnation: string; activeRelease: string | null; activeReleaseHead: unknown;
  editingContext: { world: typeof world; definitions: unknown[]; activationLock: { world: typeof world; nodes: unknown[] } } | null;
  materialScopes: unknown[]; packages?: PublicPackage[];
};
type PublicPackage = { installId: string; revision: string; packageDigest: string; manifest: { identity: { id: string; version: string }; provides: unknown[] } };
type Ref = { world: typeof world; id: string; revision: string };
type Definition = { reference: Ref; scope: string; body: { kind: string }; evidence: unknown[] };
type TaskContract = Ref & { scope: string; goal: string; inputType: unknown; hardConstraints: unknown[]; allowedEffects: string[]; stopConditions: unknown[]; budget: unknown; requiredSuites: string[]; successOracle: { kind: string; implementation: unknown } };
type Branch = { id: string; revision: string; baseRelease: string; basis: { releaseId: string; activationLockId: string; overlay: unknown[]; sources: unknown[]; snapshots: unknown[]; readReceipts: unknown[]; assumptions: unknown[]; missingSources: unknown[]; replayability: string } };
type Context = { branch: Ref; task: TaskContract; strategies: Ref[]; policyEpoch: string; grantEpoch: string; toolLock: string; dataDigest: string };
type Lock = { world: typeof world; id: string; nodes: { id: string; bindingId: string; slot: string; trust: string; implementation: { installId: string }; state: { root: { world: typeof world; id: string } } | null }[]; edges: { consumer: string; provider: string }[]; compositions: { bindingId: string; nodes: string[] }[]; trustedRoots: string[] };
type PreparedGrant = { inputPath: string; inputSha256: string; input: Grant; phase: string; receipt?: Receipt };
type Change = { world: typeof world; id: string; revision: string; status: string; baseRelease: string; operations: unknown[]; evidence: unknown[]; cases: unknown[]; rationale: string };
type Candidate = { world: typeof world; id: string; changeSet: Change; origin: string; evidence: unknown[]; modelCalls: unknown[]; createdAt: string };
type OperationReceipt = { accepted: { world: typeof world; operationId: string; incarnation: string; revision: string }; phase: string; disclosure: { kind: string }; effects: unknown[]; failure: unknown; result: { kind: string; result: Candidate } | null };
type ChangeSetAccess = { change: Change; branch: Branch; context?: Context; operations: { kind: string; operationId: string; receipt: OperationReceipt }[]; input: Grant };
type ExecutionAccess = {
  world: typeof world; arms: string[]; inputs: { inputPath: string; inputSha256: string }[];
  actors: Grant['actor'][]; authored: { task: Ref; suite: Ref; definitions: Ref[]; strategies: Ref[]; tests: { id: string; revision: string }[] };
  description?: MaterialsContext; packages?: PublicPackage[]; branches?: Branch[]; bindings?: Lock[];
  task?: TaskContract | null; matched?: { branch: Branch; context: Context }[]; changes?: unknown[];
  memory?: unknown[]; missing: string[]; grants: PreparedGrant[]; executionReady: false;
  resultAccess: { phase: 'deferred-until-real-results'; evaluationId: null; caseIds: string[]; required: string[] };
};
const executionTask = { world, id: 'task:order-line-total:20261027:execution-r1', revision: '1' };
const executionSuite = { world, id: 'suite:order-line-total:20261027:execution-r1', revision: '1' };
const oracleLockId = 'lock:order-line-total:20261027:execution-r1';
const oracleInstallId = 'install-9c1095da9df235f8eaf8be1701398f02686725aa6be31fe66e61c1459c3827ab';

export class WorldOrderAccess extends Ability {
  private phase = 'idle';
  private receipt?: Receipt;
  private diagnostics: string[] = [];
  private inputPath = inputPath;
  private inputSha256 = inputSha256;
  private materialsContext?: MaterialsContext;
  private executionAccess?: ExecutionAccess;
  private changeSetAccess?: ChangeSetAccess;
  constructor(private readonly electron: UseElectron) { super(); }
  private get workspace() { return this.electron.page.locator('main .world-workspace'); }
  private get panel() { return this.workspace.locator('section.world-panel').filter({ has: this.electron.page.getByRole('heading', { name: /^(World 权限|World permissions)$/, exact: true }) }); }

  private verifyReceipt(value: Receipt, input: Grant) {
    if (!value || !isDeepStrictEqual(value.world, world) || value.commitId !== input.commitId || !isDeepStrictEqual(value.revisions, []) || !isDeepStrictEqual(value.outboxIds, [])
      || !isDeepStrictEqual(value.fence?.world, world) || value.fence.domain !== 'authorization' || !/^[1-9]\d*$/.test(value.fence.epoch) || !Number.isFinite(Date.parse(value.committedAt))) throw new Error('Grant lacks the original complete authorization CommitReceipt; no retry');
  }

  private async readGrant(inputPath: string, inputSha256: string) {
    if (this.phase !== 'idle' || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) throw new Error('Order grant requires a single explicit attempt in the dedicated licensed profile');
    this.phase = 'preflight'; this.inputPath = inputPath; this.inputSha256 = inputSha256;
    const bytes = await readFile(inputPath);
    if (createHash('sha256').update(bytes).digest('hex') !== inputSha256) throw new Error('Exact authorized order grant changed; no submission');
    return JSON.parse(bytes.toString('utf8')) as Grant;
  }

  async grantActivation() {
    const input = await this.readGrant(inputPath, inputSha256);
    if (!isDeepStrictEqual(input.world, world) || !isDeepStrictEqual(input.actor, { kind: 'human', id: 'human:personal-desktop' })
      || input.access.length !== 1 || !isDeepStrictEqual(input.access[0], {
        resources: [{ kind: 'binding', id: 'order-evaluation' }, { kind: 'package', id: 'install-9c1095da9df235f8eaf8be1701398f02686725aa6be31fe66e61c1459c3827ab' }, { kind: 'head', channel: 'lock:order-line-total:20261027:execution-r1' }],
        fields: [], modes: ['manage', 'publish'], scope: 'scope:personal:management', validTime: null,
      }) || input.labels.length || input.effects.length || input.expiresAt !== '2026-10-28T23:59:59.000000000Z') throw new Error('Order grant exceeds its exact activation resources or bounded lifetime');
    return this.confirmGrant(input);
  }

  async grantMaterialsExecution() {
    const input = await this.readGrant(materialsInputPath, materialsInputSha256);
    if (!isDeepStrictEqual(input, {
      world, commitId: 'commit:order-materials-execution:20261028:a00e5515-312c-4fb0-bd79-c02efaf86707',
      id: 'grant:order-materials-execution:20261028:35d58489-b516-4bed-8839-6ebacec173ea',
      actor: { kind: 'human', id: 'human:personal-desktop' },
      access: [{
        resources: [{ kind: 'source', id: '5d4968662317e6c8394eb37a0b8e29c1e4df0169a78aa2d013baa7f51a2a7bcd' }],
        fields: [], modes: ['read', 'write', 'execute'], scope: 'scope:personal:management', validTime: null,
      }],
      labels: [], effects: ['probabilistic'], expiresAt: '2026-10-28T23:59:59.000000000Z',
    })) throw new Error('Order materials grant exceeds its exact Source, read/write/execute, probabilistic effect or bounded lifetime');
    await this.confirmGrant(input);
    const description = await this.query<MaterialsContext>('discover', { includeCapabilities: true });
    const { editingContext } = description;
    if (!isDeepStrictEqual(description.world, world) || description.status !== 'ready' || !editingContext
      || !isDeepStrictEqual(editingContext.world, world) || !isDeepStrictEqual(editingContext.activationLock?.world, world)
      || !Array.isArray(editingContext.definitions) || !Array.isArray(editingContext.activationLock.nodes) || !Array.isArray(description.materialScopes)) {
      throw new Error('Confirmed materials grant has no exact ready public editing context; retain the original receipt without resend');
    }
    this.materialsContext = { world: description.world, status: description.status, incarnation: description.incarnation,
      activeRelease: description.activeRelease, activeReleaseHead: description.activeReleaseHead, editingContext, materialScopes: description.materialScopes };
    const packages: PublicPackage[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { items: (PublicPackage & { world: typeof world })[]; nextCursor: string | null } = await this.query('packages', { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error('Invalid public materials package page');
      for (const item of page.items) {
        if (!isDeepStrictEqual(item.world, world) || packages.some(previous => previous.installId === item.installId)) throw new Error('Public materials package inventory has a foreign World or repeated installation');
        packages.push({ installId: item.installId, revision: item.revision, packageDigest: item.packageDigest,
          manifest: { identity: { id: item.manifest.identity.id, version: item.manifest.identity.version }, provides: item.manifest.provides } });
      }
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Public materials package inventory did not terminate');
      if (cursor) cursors.add(cursor);
    } while (cursor !== null);
    this.materialsContext.packages = packages;
    return this.evidence();
  }

  async grantFourArmExecution() {
    if (this.phase !== 'idle' || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) throw new Error('Four-arm grants require one explicit attempt in the dedicated licensed profile');
    this.phase = 'execution-access-preflight';
    const root = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21');
    const files = [
      ['world-personal-initial-20261024-729e3bf4.json', '01cc457d115887cbd6ecadaf3b8ac54dedff144c5474ed2d8ee80c9643aee72a'],
      ['eval-admin-ready-20261026-4e92d6a1/evaluation-admin.json', 'b987c9a5beb0e909198c2cb77bb6357be5bd8f2c0df7b85dcca515badd453d05'],
      ['w16-single-authoring-input-20261026-r1/task-contract.json', 'a974fc03507597b65ad607d4a53eb5575952aaea8ef429fd23ad7b8f156dc74f'],
      ['w16-single-authoring-input-20261026-r1/definitions.json', 'a4f52a40f83354ff4b00885192e99a004312e40cac6a8f6dcfd4f7ea3ce090e3'],
      ['world-order-evaluation-input-20261027-r1/mathematical-cases.json', '33cfadf8c096c872848e94a02a2f2056c4a5f663299fb9a66ebf9d5e4fc97c20'],
      ['world-order-evaluation-input-20261027-r1/baseline-templates.json', '7443e045199767464da9bc38a4a1dc22b128f1f4cc3051825659d7f9c440d721'],
      ['world-order-evaluation-input-20261027-r1/tool-memory-train.json', '296608598081023969767712633ae0c06e9ffea3670f1803e108db3f767992da'],
    ];
    const bytes = await Promise.all(files.map(async ([name, sha256]) => {
      const value = await readFile(resolve(root, name));
      if (createHash('sha256').update(value).digest('hex') !== sha256) throw new Error(`Four-arm exact public input changed: ${name}; no grant submission`);
      return value;
    }));
    const initial = JSON.parse(bytes[0].toString('utf8')) as { world: typeof world; principals: { issuer: string; subject: string; actor: Grant['actor'] }[] };
    const admin = JSON.parse(bytes[1].toString('utf8')) as { world: typeof world; evaluation: { execution: { issuer: string; subject: string }; oracle: { issuer: string; subject: string } }; principals: { issuer: string; subject: string; actor: Grant['actor'] }[] };
    const human = { kind: 'human', id: 'human:personal-desktop' }; const service = { kind: 'service', id: 'actor:eval-admin-ready-20261026-4e92d6a1:execution' };
    if (!isDeepStrictEqual(initial.world, world) || !isDeepStrictEqual(admin.world, world)
      || !isDeepStrictEqual(admin.evaluation.execution, { issuer: 'world.evaluation.local', subject: 'execution:eval-admin-ready-20261026-4e92d6a1' })
      || !isDeepStrictEqual(admin.evaluation.oracle, { issuer: 'electron-main', subject: 'electron-main-local' })
      || admin.principals.filter(item => isDeepStrictEqual({ issuer: item.issuer, subject: item.subject }, admin.evaluation.execution) && isDeepStrictEqual(item.actor, service)).length !== 1
      || initial.principals.filter(item => isDeepStrictEqual({ issuer: item.issuer, subject: item.subject }, admin.evaluation.oracle) && isDeepStrictEqual(item.actor, human)).length !== 1) throw new Error('Four-arm typed principals lack their exact public administrator identity proof');
    const original = JSON.parse(bytes[2].toString('utf8')) as TaskContract;
    const definitions = JSON.parse(bytes[3].toString('utf8')) as Definition[];
    const cases = JSON.parse(bytes[4].toString('utf8')) as { originalTask: Ref; cases: { authorKey: string; split: string; protected: boolean }[] };
    const templates = JSON.parse(bytes[5].toString('utf8')) as { world: typeof world; planSelections: { arm: { kind: string } }[] };
    const arms = ['candidate', 'tool_memory', 'static_ontology', 'append_only'];
    if (!isDeepStrictEqual(cases.originalTask, { world, id: original.id, revision: original.revision }) || cases.cases.length !== 8
      || cases.cases.filter(item => item.split === 'train').length !== 4 || cases.cases.filter(item => item.split === 'holdout' && item.protected).length !== 4
      || new Set(cases.cases.map(item => item.authorKey)).size !== 8 || !isDeepStrictEqual(templates.world, world)
      || !isDeepStrictEqual(templates.planSelections.map(item => item.arm.kind).sort(), arms.slice(1).sort())
      || definitions.length !== 2 || !isDeepStrictEqual(definitions.map(item => item.body.kind), ['function', 'strategy'])
      || definitions.some(item => !isDeepStrictEqual(item.reference.world, world) || item.scope !== original.scope || item.evidence.length)) throw new Error('Four-arm exact Task/definition/eight-case inputs are incomplete; no reduced-arm grant');
    const baselineDefinitions = arms.slice(1).flatMap(arm => ['function', 'strategy'].map(kind => ({ world, id: `${kind}:order-line-total:20261027:execution-r1:${arm}`, revision: '1' })));
    const allDefinitions = [...definitions.map(item => item.reference), ...baselineDefinitions];
    const strategies = [definitions[1].reference, ...baselineDefinitions.filter(item => item.id.startsWith('strategy:'))];
    const tests = cases.cases.map(item => ({ id: `test:order-line-total:20261027:execution-r1:${item.authorKey}`, revision: '1' }));
    const access: ExecutionAccess = this.executionAccess = {
      world, arms, inputs: files.map(([name, sha256]) => ({ inputPath: resolve(root, name), inputSha256: sha256 })), actors: [service, human],
      authored: { task: executionTask, suite: executionSuite, definitions: allDefinitions, strategies, tests }, missing: [], grants: [], executionReady: false,
      resultAccess: { phase: 'deferred-until-real-results', evaluationId: null, caseIds: [], required: ['manage exact Evaluation', 'manage exact Suite', 'read exact result Cases and their actual Evidence/Source impacts'] },
    } satisfies ExecutionAccess;
    const description = await this.query<MaterialsContext>('discover', { includeCapabilities: true }); access.description = description;
    if (!isDeepStrictEqual(description.world, world) || description.status !== 'ready' || !/^[1-9]\d*$/.test(description.incarnation)
      || !description.editingContext || !isDeepStrictEqual(description.editingContext.world, world) || !isDeepStrictEqual(description.editingContext.activationLock.world, world)
      || !Array.isArray(description.editingContext.definitions) || !Array.isArray(description.materialScopes)) throw new Error('Four-arm public World context is not exactly ready');
    if (!isDeepStrictEqual(await this.query('task_contract', { world, id: original.id, revision: original.revision }), original)) throw new Error('Original order Task changed; no grant submission');
    const packages = await this.catalog<PublicPackage & { world: typeof world }>('packages');
    if (packages.some(item => !isDeepStrictEqual(item.world, world))) throw new Error('Four-arm public package inventory contains a foreign World');
    access.packages = packages.map(item => ({ installId: item.installId, revision: item.revision, packageDigest: item.packageDigest,
      manifest: { identity: item.manifest.identity, provides: item.manifest.provides } }));
    const task = await this.query<TaskContract | null>('task_contract', executionTask); access.task = task;
    if (task) {
      if (!isDeepStrictEqual([task.world, task.id, task.revision, task.requiredSuites], [world, executionTask.id, executionTask.revision, [executionSuite.id]])) throw new Error('Public execution Task identity differs from the original lawful input');
      for (const key of ['goal', 'inputType', 'hardConstraints', 'allowedEffects', 'stopConditions', 'scope', 'budget'] as const) if (!isDeepStrictEqual(task[key], original[key])) throw new Error(`Four-arm execution Task ${key} changed`);
    } else access.missing.push('Exact execution Task has not been registered; only its lawful author ref is granted');
    const branches = await this.catalog<Branch>('branches'); access.branches = branches;
    const overlay = definitions.map(definition => ({ kind: 'create_definition', definition }));
    const matched: { branch: Branch; context: Context }[] = []; access.matched = matched;
    for (const branch of branches.filter(item => item.basis.activationLockId === oracleLockId && isDeepStrictEqual(item.basis.overlay, overlay))) {
      const context = await this.query<Context>('suite_creation_context', { world, id: branch.id, revision: branch.revision });
      if (!task || !isDeepStrictEqual(context.task, task)) continue;
      if (!branch.id || !/^[1-9]\d*$/.test(branch.revision) || !isDeepStrictEqual(context.branch, { world, id: branch.id, revision: branch.revision })
        || context.toolLock !== oracleLockId || !context.strategies.some(item => isDeepStrictEqual(item, definitions[1].reference))
        || !isDeepStrictEqual(branch.basis, { releaseId: branch.baseRelease, activationLockId: oracleLockId, overlay, sources: [], snapshots: [], readReceipts: [], assumptions: [], missingSources: [], replayability: 'complete' })) throw new Error('Public arithmetic branch/context differs from the exact pure-math basis');
      matched.push({ branch, context });
    }
    if (matched.length > 1) throw new Error('Multiple real execution Task/overlay/Oracle branches; do not guess or grant all branches');
    if (!matched.length) access.missing.push('No unique real execution branch; no Branch or ChangeSet identity is invented');
    const bindings = await this.catalog<Lock>('bindings'); access.bindings = bindings;
    if (bindings.some(item => !isDeepStrictEqual(item.world, world))) throw new Error('Four-arm public binding inventory contains a foreign World');
    const locks = bindings.filter(item => item.id === oracleLockId);
    if (locks.length > 1) throw new Error('Repeated exact Oracle lock');
    const caller: Grant['access'] = []; const execution: Grant['access'] = [];
    const add = (target: Grant['access'], resources: unknown[], modes: string[]) => { if (resources.length) target.push({ resources, fields: [], modes, scope: original.scope, validTime: null }); };
    const resource = (kind: string, id: string) => ({ kind, id });
    add(execution, allDefinitions.map(item => resource('definition', item.id)), ['read']);
    add(execution, strategies.map(item => resource('definition', item.id)), ['execute']);
    add(caller, [resource('task', executionTask.id)], ['read', 'manage']);
    add(caller, [resource('suite', executionSuite.id)], ['read', 'manage']);
    add(caller, tests.map(item => resource('test_case', item.id)), ['manage']);
    add(caller, definitions.map(item => resource('definition', item.reference.id)), ['read', 'write']);
    add(caller, baselineDefinitions.map(item => resource('definition', item.id)), ['read']);
    add(caller, [resource('package', oracleInstallId), resource('binding', 'order-evaluation')], ['read']);
    const oracleBindings = new Set(['order-evaluation']);
    if (locks.length === 1 && task) {
      const lock = locks[0];
      const nodes = lock.nodes.filter(item => item.slot === 'evaluation' && item.bindingId === 'order-evaluation' && item.implementation.installId === oracleInstallId
        && task.successOracle.kind === 'program' && isDeepStrictEqual(item.implementation, task.successOracle.implementation));
      if (nodes.length !== 1) throw new Error('Exact execution Oracle is not uniquely bound in the public lock');
      const pending = [nodes[0].id, ...lock.trustedRoots]; const selected = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!; if (selected.has(id)) continue;
        const node = lock.nodes.find(item => item.id === id);
        if (!node || node.trust === 'ordinary_guest') throw new Error('Oracle public closure is missing or untrusted');
        selected.add(id); oracleBindings.add(node.bindingId);
        const composition = lock.compositions.find(item => item.bindingId === node.bindingId);
        if (!composition) throw new Error('Oracle public closure omits its actual composition');
        pending.push(...composition.nodes, ...lock.edges.filter(item => item.consumer === id).map(item => item.provider));
        if (node.state) {
          if (!isDeepStrictEqual(node.state.root.world, world)) throw new Error('Oracle State root belongs to a foreign World');
          add(caller, [resource('state', node.state.root.id)], ['read']);
        }
      }
      add(caller, lock.nodes.flatMap(item => [resource('package', item.implementation.installId), resource('binding', item.bindingId)])
        .filter((item, index, items) => items.findIndex(other => isDeepStrictEqual(other, item)) === index), ['read']);
    } else access.missing.push('Oracle actual lock/Task closure is not yet available; only exact authored order-evaluation Binding is granted');
    add(caller, [...oracleBindings].map(id => resource('binding', id)), ['execute']);
    if (matched.length === 1) {
      const { branch } = matched[0];
      add(execution, [resource('branch', branch.id)], ['read']);
      add(caller, [resource('branch', branch.id)], ['read', 'write', 'execute']);
      const changes = await this.catalog<{ world: typeof world; id: string; baseRelease: string; operations: unknown[]; evidence: unknown[]; cases: unknown[] }>('changes');
      const exactChanges = changes.filter(item => item.baseRelease === branch.baseRelease && isDeepStrictEqual(item.operations, overlay)); access.changes = exactChanges;
      access.missing.push(`Public ChangeSets with the exact overlay/base=${exactChanges.length}, but BranchView has no ChangeSet owner link; none granted without original operation proof`);
    }
    const materials = await this.catalog<{ reference: { world: typeof world; sourceId: string; versionId: string }; blob: { digest: string; byteSize: string }; access: { labels: string[] } }>('materials');
    const memories = materials.filter(item => isDeepStrictEqual(item.blob, { digest: `sha256:${files[6][1]}`, byteSize: String(bytes[6].length) })); access.memory = memories;
    if (memories.some(item => !isDeepStrictEqual(item.reference.world, world))) throw new Error('Exact ToolMemory SourceVersion belongs to a foreign World');
    access.missing.push(`ToolMemory SourceVersion public exact-blob matches=${memories.length}; material policy impact requires separate exact authorization, no Source guessed or granted`);
    const identities = ['execution:7a66218c-794f-42de-8c76-12f4c1852894', 'desktop:caa9cc6a-50f5-4815-a60f-84479c58c274'];
    for (const [index, actor] of [service, human].entries()) {
      const input: Grant = { world, commitId: `commit:order-four-arm:${identities[index]}`, id: `grant:order-four-arm:${identities[index]}`, actor,
        access: index === 0 ? execution : caller, labels: [], effects: [], expiresAt: '2026-10-28T23:59:59.000000000Z' };
      if (!input.access.length || input.access.some(item => !item.resources.length || !item.modes.length)) throw new Error('Four-arm grant must contain only finite exact resources');
      const path = resolve(root, `order-four-arm-${index === 0 ? 'execution' : 'desktop'}-access-20261028-r1.json`);
      const text = JSON.stringify(input, null, 2); const sha256 = createHash('sha256').update(text).digest('hex');
      try { const file = await open(path, 'wx'); try { await file.writeFile(text); await file.sync(); } finally { await file.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if ((await readFile(path, 'utf8')) !== text) throw new Error('Original four-arm grant input differs from current context; retain it and do not replace or resend'); }
      access.grants.push({ inputPath: path, inputSha256: sha256, input, phase: 'prepared' });
    }
    for (const grant of access.grants) {
      this.inputPath = grant.inputPath; this.inputSha256 = grant.inputSha256; this.receipt = undefined;
      try { await this.confirmGrant(grant.input); }
      finally { grant.phase = this.phase; grant.receipt = this.receipt; }
    }
    this.phase = 'known-execution-grants-confirmed';
    return this.evidence();
  }

  async grantChangeSetExecution() {
    if (this.phase !== 'idle' || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) throw new Error('ChangeSet grant requires one explicit attempt in the dedicated licensed profile');
    this.phase = 'change-set-access-preflight';
    const root = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21');
    const exact = (actual: unknown, expected: unknown, label: string) => {
      if (!isDeepStrictEqual(actual, expected)) throw new Error(`Exact ChangeSet grant ${label} differs; no submission or resend`);
    };
    const initialBytes = await readFile(resolve(root, 'world-personal-initial-20261024-729e3bf4.json'));
    exact(createHash('sha256').update(initialBytes).digest('hex'), '01cc457d115887cbd6ecadaf3b8ac54dedff144c5474ed2d8ee80c9643aee72a', 'administrator input');
    const initial = JSON.parse(initialBytes.toString('utf8')) as { world: typeof world; principals: { issuer: string; subject: string; actor: Grant['actor'] }[] };
    const actor = { kind: 'human', id: 'human:personal-desktop' };
    exact(initial.world, world, 'administrator World');
    exact(initial.principals.filter(item => item.issuer === 'electron-main' && item.subject === 'electron-main-local').map(item => item.actor), [actor], 'typed caller identity');
    const definitionBytes = await readFile(resolve(root, 'w16-single-authoring-input-20261026-r1/definitions.json'));
    exact(createHash('sha256').update(definitionBytes).digest('hex'), 'a4f52a40f83354ff4b00885192e99a004312e40cac6a8f6dcfd4f7ea3ce090e3', 'original definition bytes');
    const definitions = JSON.parse(definitionBytes.toString('utf8')) as Definition[];
    const overlay = definitions.map(definition => ({ kind: 'create_definition', definition }));
    const retained = JSON.parse(await readFile(resolve(root, 'world-order-execution-20261027-r1.dispatch.json'), 'utf8')) as {
      task: TaskContract; definitions: Definition[]; lockId: string; branches: Branch[];
      operations: { kind: string; operationId: string; outcome: string; result: OperationReceipt }[];
    };
    exact([retained.task.world, retained.task.id, retained.task.revision, retained.task.scope, retained.definitions, retained.lockId],
      [world, executionTask.id, executionTask.revision, 'scope:personal:management', definitions, oracleLockId], 'original setup binding');
    exact(await this.query('task_contract', executionTask), retained.task, 'complete execution Task');
    exact(retained.operations.map(item => item.kind), ['task', 'propose', 'validate'], 'original operation order');
    const description = await this.query<MaterialsContext>('discover', { includeCapabilities: true });
    if (description.status !== 'ready' || !/^[1-9]\d*$/.test(description.incarnation)) throw new Error('ChangeSet grant requires a ready public World');
    exact(description.world, world, 'ready World');
    const expectedOperations = [
      ['propose', 'operation-bb65714240e4dd4ab102d5f5ec7a500666884b7da19ca428691e1784dde93632'],
      ['validate', 'operation-6804a5a4177948d115abb7f045a628a694cf0d0aec64a310010a1d6aff7a0b88'],
    ];
    const operations: ChangeSetAccess['operations'] = [];
    for (const [kind, operationId] of expectedOperations) {
      const original = retained.operations.find(item => item.kind === kind);
      if (!original || original.outcome !== 'confirmed') throw new Error('Original ChangeSet operation is unresolved; no grant');
      exact(original.operationId, operationId, 'original operation key');
      const result = original.result;
      exact([result.accepted.world, result.accepted.operationId, result.accepted.incarnation, result.phase, result.disclosure.kind, result.failure, result.effects, result.result?.kind],
        [world, operationId, description.incarnation, 'completed', 'full', null, [], 'candidate'], 'original completed operation ownership');
      if (!/^[1-9]\d*$/.test(result.accepted.revision)) throw new Error('Invalid original ChangeSet receipt revision');
      operations.push({ kind, operationId, receipt: result });
    }
    const proposed = operations[0].receipt.result!.result; const validated = operations[1].receipt.result!.result;
    const changeId = 'change-4c6bc4307890146754d99237b4ef7304d35c4e84f49460e9ae6febfc35501532';
    exact(proposed, { world, id: 'candidate-4c6bc4307890146754d99237b4ef7304d35c4e84f49460e9ae6febfc35501532', origin: 'direct', evidence: [], modelCalls: [], createdAt: proposed.createdAt,
      changeSet: { world, id: changeId, revision: '1', status: 'proposed', baseRelease: description.activeRelease, operations: overlay, evidence: [], cases: [], rationale: '直接提交的语义变更。' } }, 'complete proposed Candidate');
    exact(validated, { ...proposed, changeSet: { ...proposed.changeSet, revision: '2', status: 'validated' } }, 'same validated Candidate');
    const created = (await this.catalog<Branch>('branches')).filter(item => !retained.branches.some(before => before.id === item.id));
    if (created.length !== 1) throw new Error('Original proposal no longer has one exact new branch; no guessed ChangeSet grant');
    const branch = created[0];
    exact(branch, { id: 'branch-055ff1236ff5606feb3369378f2ba82de62defedcff1228d9f8cbc7b0af5cd7e', revision: branch.revision, baseRelease: proposed.changeSet.baseRelease,
      basis: { releaseId: proposed.changeSet.baseRelease, activationLockId: oracleLockId, overlay, sources: [], snapshots: [], readReceipts: [], assumptions: [], missingSources: [], replayability: 'complete' } }, 'original branch basis');
    const input: Grant = { world, commitId: 'commit:order-change-set:20261028:efcaa221-5227-43e0-a9c6-946921233dc5', id: 'grant:order-change-set:20261028:8883cb20-4af3-4c14-a3b6-4acf8647dc35', actor,
      access: [{ resources: [{ kind: 'change_set', id: changeId }], fields: [], modes: ['read', 'write'], scope: retained.task.scope, validTime: null }],
      labels: [], effects: [], expiresAt: '2026-10-28T23:59:59.000000000Z' };
    this.changeSetAccess = { change: validated.changeSet, branch, operations, input };
    this.inputPath = resolve(root, 'order-change-set-execution-access-20261028-r1.json');
    const text = JSON.stringify(input, null, 2); this.inputSha256 = createHash('sha256').update(text).digest('hex');
    try { const file = await open(this.inputPath, 'wx'); try { await file.writeFile(text); await file.sync(); } finally { await file.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; exact(await readFile(this.inputPath, 'utf8'), text, 'retained grant input'); }
    await this.confirmGrant(input);
    for (const operation of operations) {
      const key = { world, operationId: operation.operationId };
      const status = await this.query<OperationReceipt>('status', key, 'operation');
      const result = await this.query<OperationReceipt>('result', key, 'operation');
      exact(status, result, 'complete fresh original status/result'); exact(result, operation.receipt, 'complete fresh original receipt after exact read grant');
    }
    exact(await this.query('change', { id: changeId }), validated.changeSet, 'current complete ChangeSet after exact read grant');
    const context = await this.query<Context>('suite_creation_context', { world, id: branch.id, revision: branch.revision });
    exact([context.branch, context.task, context.toolLock], [{ world, id: branch.id, revision: branch.revision }, retained.task, oracleLockId], 'real branch context after exact read grant');
    this.changeSetAccess.context = context;
    return this.evidence();
  }

  private async catalog<T>(kind: string): Promise<T[]> {
    const items: T[] = []; const cursors = new Set<string>(); const identities = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { items: T[]; nextCursor: string | null } = await this.query(kind, { page: { limit: 100, cursor } });
      if (!page || !Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error(`Invalid public four-arm ${kind} page`);
      for (const item of page.items) { const key = JSON.stringify(item); if (identities.has(key)) throw new Error(`Repeated public four-arm ${kind} item`); identities.add(key); items.push(item); }
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error(`Public four-arm ${kind} catalog did not terminate`);
      if (cursor) cursors.add(cursor);
    } while (cursor !== null);
    return items;
  }

  private async query<T>(kind: string, request: unknown, route: 'query' | 'operation' = 'query'): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${route}`, method: 'POST', timeoutMs: 10_000, body: route === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`Order access ${kind}: transport=${reply.error.code}; original grant receipt retained, no resend`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: { code: string; stage: string; diagnosticId: string } };
    if (!reply.data.ok || reply.data.status !== 200 || body?.success !== true || body.data?.kind !== kind) {
      throw new Error(`Order access ${kind}: code=${body?.error?.code ?? 'invalid-envelope'}; stage=${body?.error?.stage ?? 'read'}; diagnosticId=${body?.error?.diagnosticId ?? 'not-disclosed'}; original grant receipt retained, no resend`);
    }
    return body.data.result;
  }

  private async confirmGrant(input: Grant) {
    const { inputPath, inputSha256 } = this;
    const custodyPath = inputPath.replace(/\.json$/, '.dispatch.json');
    if (Date.now() >= Date.parse(input.expiresAt)) throw new Error('Exact order grant expired; no submission or permission assumption');
    let previous: Custody | undefined;
    try { previous = JSON.parse(await readFile(custodyPath, 'utf8')) as Custody; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.inputSha256 !== inputSha256 || previous.commitId !== input.commitId || previous.grantId !== input.id || previous.phase !== 'confirmed' || !previous.receipt) throw new Error('Original grant attempt is unresolved; preserve custody and do not resubmit');
      this.verifyReceipt(previous.receipt, input); this.receipt = previous.receipt; this.phase = 'confirmed-original';
      return this.evidence();
    }
    await this.electron.page.getByRole('link', { name: /^(世界设置|World settings)$/, exact: true }).click();
    await this.workspace.getByRole('tab', { name: /^(存储与初始化|Storage and setup)$/, exact: true }).click();
    this.phase = 'selecting';
    await this.panel.getByRole('button', { name: /^(选择权限配置|Choose permission configuration)$/, exact: true }).click({ timeout: 15_000 });
    await this.electron.completeNativeFilePicker(inputPath, '导入管理员提供的增量授权');
    const preview = this.panel.getByTestId('world-access-preview');
    await preview.waitFor({ state: 'visible', timeout: 15_000 });
    if (!isDeepStrictEqual(JSON.parse(await preview.innerText()), input)) throw new Error('Main-prepared grant preview differs from exact original; do not confirm');
    this.phase = 'preview-verified';
    await this.panel.getByRole('button', { name: /^(确认|Confirm)$/, exact: true }).click({ timeout: 15_000 });
    const dialog = this.electron.page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    if (!isDeepStrictEqual(JSON.parse(await preview.innerText()), input)) throw new Error('Grant preview changed during application confirmation; do not submit');
    this.phase = 'submission-unconfirmed';
    const custody: Custody = { inputSha256, commitId: input.commitId, grantId: input.id, phase: this.phase };
    const file = await open(custodyPath, 'wx');
    try { await file.writeFile(JSON.stringify(custody, null, 2)); await file.sync(); } finally { await file.close(); }
    await dialog.getByRole('button', { name: /^(确认|Confirm)$/, exact: true }).click({ timeout: 15_000 });
    const until = Date.now() + 30_000;
    let confirmed = false;
    while (Date.now() < until) {
      const statuses = await this.panel.getByRole('status').allTextContents();
      const alerts = await this.panel.getByRole('alert').allTextContents();
      this.diagnostics = [...statuses, ...alerts];
      if (statuses.some(text => /^(权限提交已确认|Permission submission confirmed)$/.test(text))) { confirmed = true; break; }
      if (alerts.length || statuses.some(text => /unknown|unconfirmed|未知|未确认|未收到|不一致/i.test(text))) throw new Error(`Original grant has no confirmed receipt: ${JSON.stringify(this.diagnostics)}; preserve original identity, no resend`);
      await setTimeout(100);
    }
    if (!confirmed || await dialog.count() !== 0 || await this.panel.getByRole('alert').count() !== 0) throw new Error(`Grant confirmation did not settle: ${JSON.stringify(this.diagnostics)}; no retry`);
    const rows = await this.panel.locator('table tbody tr').allTextContents();
    if (!rows.some(row => row.includes(input.commitId)) || !rows.some(row => row.includes(input.id))) throw new Error('Grant UI receipt identity differs from the original request');
    const detail = this.panel.locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(原始提交回执|Original commit receipt)$/ }) });
    await detail.locator(':scope > summary').click();
    const value = await detail.locator('dl').first().evaluate(element => {
      const decode = (node: Element): unknown => {
        if (node.tagName === 'DL') return Object.fromEntries(Array.from(node.children).map(row => [row.querySelector(':scope > dt')!.textContent!, decode(row.querySelector(':scope > dd')!.firstElementChild!)]));
        if (node.tagName === 'OL') return Array.from(node.children).map(item => decode(item.firstElementChild!));
        const text = node.textContent;
        return text === 'None' || text === '无' ? [] : text === 'Not set' || text === '未设置' ? null : text;
      };
      return decode(element);
    }) as Receipt;
    this.verifyReceipt(value, input);
    this.receipt = value; this.phase = 'confirmed';
    await writeFile(custodyPath, JSON.stringify({ ...custody, phase: this.phase, receipt: value }, null, 2));
    return this.evidence();
  }

  evidence() {
    const { inputPath, inputSha256 } = this;
    return { phase: this.phase, world, inputPath, inputSha256, custodyPath: inputPath.replace(/\.json$/, '.dispatch.json'), receipt: this.receipt, diagnostics: this.diagnostics, materialsContext: this.materialsContext, executionAccess: this.executionAccess, changeSetAccess: this.changeSetAccess, retained: true };
  }
}
