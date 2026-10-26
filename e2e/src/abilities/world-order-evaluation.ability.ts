import { Ability } from '@serenity-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type World = { tenantId: string; worldId: string };
type Ref = { world: World; id: string; revision: string };
type TestRef = { id: string; revision: string };
type Blob = { digest: string; byteSize: string };
type Arm = 'candidate' | 'tool_memory' | 'static_ontology' | 'append_only';
type Budget = { maxWallTime: string; maxSteps: string; maxSourceReads: string; maxRows: string; maxBytes: string; maxModelCalls: string; maxInputTokens: string; maxOutputTokens: string; maxCost: string | null; deadline: string | null };
type TaskContract = Ref & { scope: string; goal: string; inputType: Json; allowedEffects: string[]; hardConstraints: Json[]; stopConditions: Json[]; requiredSuites: string[]; budget: Budget; successOracle: Json };
type Definition = { reference: Ref; scope: string; validTime: Json; body: { kind: string; body: Json }; dependencies: Ref[]; previousRef?: Ref | null; lifecycle: Json; contentDigest: string; evidence: Json[] };
type Branch = { id: string; revision: string; baseRelease: string; basis: { releaseId: string; activationLockId: string; snapshots: Blob[]; readReceipts: Json[]; sources: Json[]; overlay: { kind: string; definition?: Definition }[]; assumptions: Json[]; replayability: string; missingSources: string[] } };
type Lock = { world: World; id: string; nodes: { slot: string; trust: string; implementation: Json }[] };
type SourceVersion = { reference: { world: World; sourceId: string; versionId: string }; blob: Blob };
type Templates = { world: World; definitionTemplates: Record<string, Definition>; planSelections: Selection[]; assembly: Record<string, { functionArguments: Json[] }> };
type Plan = { strategy: Ref; tools: Ref[]; definitions: Definition[]; scopes: { world: World; id: string; predicate: Json }[]; knowledge: { kind: string; snapshot?: { world: World; sourceId: string; versionId: string }; memoryFunction?: Ref; releaseId?: string; anchorRelease?: string; changes?: Json[] } };
type Conditions = { policyEpoch: string; grantEpoch: string; toolLock: string; dataDigest: string; modelBinding: Json; totalBudget: Budget; readMode: { kind: string }; validAt: string; knownAt: string };
type Context = { branch: Ref; task: TaskContract; strategies: Ref[]; policyEpoch: string; grantEpoch: string; toolLock: string; dataDigest: string };
type Case = { authorKey: string; split: 'train' | 'holdout'; protected: boolean; originFamily: string; fixture: { kind: 'record'; fields: { quantity: { kind: 'integer'; value: string }; unitPriceCents: { kind: 'integer'; value: string } } }; expected: { kind: 'function_integer'; functionId: string; functionRevision: string; value: string } };
type Authority = { bindings: { arm: { kind: Arm }; plan: Plan; conditions: Conditions; expectedFunction: Ref }[] };
type Input = { submittable: boolean; originalTask: Ref; cases: Case[]; runtimeBindings: { evaluationTask: Ref | null; arithmeticOracle: Json; branch: Ref | null; suite: Ref | null; testCaseReferences: Record<string, TestRef> | null; occurredAtByCase: Record<string, string> | null; trainingBefore: string | null; holdoutFrom: string | null; oracleAuthorityBinding: { authorityFile?: string; authoritySha256?: string; artifactDigest?: string } } };
type TestCase = Ref & { taskId: string; taskRevision: string; scope: string; fixture: Blob; expected: Blob; oracle: Json; originFamily: string; split: string; purpose: string; protected: boolean; occurredAt: string; evidence: Json[]; caseId: string | null; candidateId: string | null };
type Selection = { arm: { kind: Arm }; plan: { kind: 'strategy' | 'frozen'; reference: Ref | Plan } };
type Suite = { world: World; id: string; revision: string; taskId: string; taskRevision: string; tests: TestRef[]; protectedCounterexamples: TestRef[]; trainingBefore: string; holdoutFrom: string; arms: { kind: Arm }[]; plans: Selection[]; conditions: Conditions; acceptance: { kind: string }[]; frozenAt: string; frozenBy: string };
type EvaluationSummary = { world: World; id: string; candidateId: string; suiteId: string; suiteRevision: string; execution: string; verdict: string; assurance: string; usage: Json; completedAt: string | null };
type Report = { world: World; id: string; candidateId: string; suiteId: string; suiteRevision: string; basisDigest: string; execution: { kind: string }; verdict: string; assurance: string; completedAt: string | null; cases: { test: TestRef; arm: { kind: Arm }; execution: { kind: string }; oraclePassed: boolean | null; observed: Blob | null; usage: Json }[]; arms: { arm: { kind: Arm }; split: string; origin: string; success: string }[]; coverage: { tested: string; total: string; missingTests: TestRef[]; missingSources: string[]; assumptionsUsed: boolean }; usage: Json };
type Accepted = { world: World; operationId: string; revision: string; incarnation: string };
type Receipt = { accepted: Accepted; disclosure: { kind: string; withheld?: string[] }; phase: string; progress: { runId?: string | null }; result: { kind: string; result: unknown } | null; failure: { code: string; diagnosticId: string } | null; commit: Json; effects: Json[]; cancellation: Json; updatedAt: string };
type Custody = { kind: 'case' | 'suite' | 'evaluation'; attempt: number; operationId: string | null; runId: string | null; outcome: string };
type Submission = { inputBytes: string; input: Input; task: TaskContract; context: Context; branch: Branch; confirmedTests: TestCase[]; evidence: { preparedAt: string; inputSha256: string; originalSha256: string } } & (
  { stage: 'registration'; caseIndex: number }
  | { stage: 'suite'; caseIndex: null; authority: Authority; templatesSha256: string }
  | { stage: 'evaluation'; caseIndex: null; authority: Authority; templatesSha256: string; hostExecutionBinding: { preExecutionBranch: Branch; preExecutionBasisDigest: string } }
);
type RetainedSubmission = { custody: Custody; request: Submission; at: string; receipts: Receipt[] };
type Observation = { ids: string[]; error?: string; persisted?: Promise<void>; dispose: () => void };
type Page<T> = { items: T[]; nextCursor: string | null };
type Envelope = { success: boolean; data?: { kind: string; result: unknown }; error?: { code: string; stage: string; diagnosticId: string } };
type Locator = ReturnType<UseElectron['page']['locator']>;
const world: World = { tenantId: 'local', worldId: 'personal' };
const arms: Arm[] = ['candidate', 'tool_memory', 'static_ontology', 'append_only'];
const scratch = resolve(repositoryRoot, '.scratch');
const authorRoot = resolve(scratch, 'world-implementation-2026-10-21/world-order-evaluation-input-20261027-r1');
const custodyPath = resolve(authorRoot, 'world-order-evaluation.custody.jsonl');
const originalRoot = resolve(scratch, 'world-implementation-2026-10-21/w16-single-authoring-input-20261026-r1');
const executionTask: Ref = { world, id: 'task:order-line-total:20261027:execution-r1', revision: '1' };
const executionSuite: Ref = { world, id: 'suite:order-line-total:20261027:execution-r1', revision: '1' };
const oracleLockId = 'lock:order-line-total:20261027:execution-r1';
const oracleInstallId = 'install-9c1095da9df235f8eaf8be1701398f02686725aa6be31fe66e61c1459c3827ab';
const budgetLabels = [
  /^(Maximum time \(ms\)|最长时间（毫秒）)$/, /^(Processing steps|处理步骤)$/, /^(Source reads|来源读取次数)$/, /^(Maximum records|最大记录数)$/, /^(Bytes processed|处理字节数)$/, /^(Model calls|模型调用次数)$/, /^(Input tokens|输入 token)$/, /^(Output tokens|输出 token)$/,
];
function equal(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Order evaluation ${label} differs from its exact authorized public value`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Order evaluation ${label} must be an object`);
  return value as Record<string, unknown>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function blob(value: unknown): Blob { const bytes = Buffer.from(JSON.stringify(value)); return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteSize: String(bytes.length) }; }
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Missing truthful ${label}`);
  return new Date(value).toISOString().replace('Z', '000000Z');
}
function reference(value: unknown, label: string): asserts value is Ref {
  const ref = object(value, label);
  equal(ref.world, world, `${label} world`);
  if (typeof ref.id !== 'string' || !ref.id.trim() || typeof ref.revision !== 'string' || !/^[1-9]\d*$/.test(ref.revision)) throw new Error(`Invalid ${label} identity`);
}
function publicFile(path: string): string {
  const resolved = resolve(repositoryRoot, path);
  const within = relative(scratch, resolved);
  if (!within || within.startsWith('..') || isAbsolute(within) || !resolved.endsWith('.json') || /(?:^|[\\/])(?:\.profiles?|secrets?)(?:[\\/]|$)/i.test(resolved)) throw new Error('Order evaluation accepts only an explicit public scratch JSON input, never Profile or secrets');
  return resolved;
}

export class WorldOrderEvaluation extends Ability {
  private input?: Input;
  private authority?: Authority;
  private task?: TaskContract;
  private context?: Context;
  private original?: TaskContract;
  private definitions: Definition[] = [];
  private readonly tests: TestCase[] = [];
  private suite?: Suite;
  private readonly selectedPlans: { selection: Selection; definitions: Definition[] }[] = [];
  private preExecutionBranch?: Branch;
  private preExecutionBasisDigest: string | null = null;
  private postExecutionBranch?: Branch;
  private report?: Report;
  private phase = 'idle';
  private blocker: string | null = null;
  private custody: Custody[] = [];
  private custodyBlocked = false;
  private hintRecorderInstalled = false;
  private readonly hintBinding = `__orderEvaluationCustodyHint_${randomUUID().replaceAll('-', '')}`;
  private registrationsVerified = false;
  private inputBytes = '';
  private incarnation?: string;
  private observation?: { read: () => Promise<{ ids: string[]; error?: string }>; dispose: () => Promise<void> };
  private originalSha256 = '';
  private inputSha256 = '';
  private templatesSha256 = '';
  private preparedAt: string | null = null;
  private branch?: Branch;
  private lastReceipt?: Receipt;
  constructor(private readonly electron: UseElectron) { super(); }

  private get workspace() { return this.electron.page.locator('main .world-workspace'); }
  private get management() { return this.workspace.locator('section').filter({ has: this.electron.page.getByRole('heading', { name: /^(运行独立评测|Run an independent evaluation)$/, exact: true }) }); }
  private get registration() { return this.management.locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(登记测试与样本文件|Register a test and sample files)$/ }) }).first(); }
  private get freeze() { return this.management.locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(首次冻结评测套件|Freeze an evaluation suite for the first time)$/ }) }).first(); }

  private async read<T>(route: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${route}`, method: 'POST', timeoutMs: 10_000, body: route === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`Order evaluation ${kind} transport unavailable: ${reply.error.code}`);
    const body = reply.data.json as Envelope;
    if (!body?.success || reply.data.status !== 200 || !reply.data.ok || body.data?.kind !== kind) throw new Error(`Order evaluation ${kind}: ${body?.error?.code ?? 'invalid-envelope'} / ${body?.error?.stage ?? 'read'} / ${body?.error?.diagnosticId ?? 'not-disclosed'}`);
    return body.data.result as T;
  }
  private query<T>(kind: string, request: unknown): Promise<T> { return this.read<T>('query', kind, request); }
  private async catalog<T>(kind: string, request: object = {}): Promise<T[]> {
    const items: T[] = [];
    const cursors = new Set<string>();
    const identities = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Page<T> = await this.query(kind, { ...request, page: { limit: 100, cursor } });
      if (!page || !Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error(`Invalid complete ${kind} catalog`);
      for (const item of page.items) { const key = JSON.stringify(item); if (identities.has(key)) throw new Error(`Repeated ${kind} item`); identities.add(key); items.push(item); }
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error(`Nonterminal ${kind} pagination`);
      if (cursor) cursors.add(cursor);
    } while (cursor !== null);
    return items;
  }

  private appendCustody(stage: string, value: unknown): void {
    const entry = { stage, world, at: new Date().toISOString(), custody: this.custody.at(-1) ?? null, value };
    try {
      const file = openSync(custodyPath, 'a');
      try { writeFileSync(file, `${JSON.stringify(entry)}\n`); fsyncSync(file); } finally { closeSync(file); }
    } catch (error) { this.custodyBlocked = true; throw error; }
  }
  private async readExistingCustody(): Promise<RetainedSubmission[]> {
    let bytes: string;
    try { bytes = await readFile(custodyPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    this.custodyBlocked = true;
    if (!bytes || !bytes.endsWith('\n')) throw new Error('Existing order custody is empty or torn; no history rewrite or replay');
    const originals = new Map<number, Custody>();
    const requests = new Map<number, { request: Submission; at: string }>();
    const receipts: Receipt[] = [];
    for (const line of bytes.trimEnd().split('\n')) {
      const entry = object(JSON.parse(line), 'durable custody row'); equal(entry.world, world, 'durable custody World');
      equal(Object.keys(entry).sort(), ['stage', 'world', 'at', 'custody', 'value'].sort(), 'durable custody row schema');
      if (!['before-ui-mutation', 'operation-event', 'operation-status', 'operation-run', 'operation-result', 'confirmed', 'retained-status-readback', 'retained-result-readback'].includes(String(entry.stage))) throw new Error('Unknown custody stage; no migration or replay');
      const custody = entry.custody as Custody; const prior = custody && originals.get(custody.attempt);
      equal(Object.keys(object(custody, 'durable custody identity')).sort(), ['kind', 'attempt', 'operationId', 'runId', 'outcome'].sort(), 'durable original custody schema');
      if (!custody || !Number.isSafeInteger(custody.attempt) || custody.attempt < 1 || custody.attempt > 10 || !['case', 'suite', 'evaluation'].includes(custody.kind)) throw new Error('Invalid durable original request identity; no replay');
      if (prior) { equal(prior.kind, custody.kind, 'durable mutation kind'); if (prior.operationId) equal(custody.operationId, prior.operationId, 'durable original operation'); if (prior.runId) equal(custody.runId, prior.runId, 'durable original run'); }
      originals.set(custody.attempt, custody);
      if (entry.stage === 'before-ui-mutation') {
        if (requests.has(custody.attempt)) throw new Error('Repeated original submission in custody; no replay');
        const request = object(entry.value, 'original submission');
        const stage = custody.kind === 'case' ? 'registration' : custody.kind;
        equal(request.stage, stage, 'original submission stage; unknown schema cannot be replayed or migrated');
        equal(Object.keys(request).sort(), ['stage', 'inputBytes', 'input', 'caseIndex', 'task', 'context', 'branch', 'confirmedTests', 'evidence',
          ...(stage === 'registration' ? [] : ['authority', 'templatesSha256']), ...(stage === 'evaluation' ? ['hostExecutionBinding'] : [])].sort(), 'exact staged submission schema');
        equal(Object.keys(object(request.evidence, 'original submission evidence')).sort(), ['preparedAt', 'inputSha256', 'originalSha256'].sort(), 'exact original input evidence schema');
        requests.set(custody.attempt, { request: request as Submission, at: timestamp(entry.at, 'original submission time') });
      }
      if (entry.stage === 'operation-event') {
        const hint = object(entry.value, 'durable event');
        if (hint.error || !Array.isArray(hint.ids) || hint.ids.length !== 1) throw new Error('Retained operation observation is ambiguous; no replay');
      }
      if (entry.stage === 'operation-status' || entry.stage === 'operation-result') receipts.push(entry.value as Receipt);
      if (entry.stage === 'confirmed' || entry.stage === 'retained-status-readback' || entry.stage === 'retained-result-readback') receipts.push(object(entry.value, 'retained readback').receipt as Receipt);
    }
    this.custody = [...originals.values()];
    equal(this.custody.map(item => [item.attempt, item.kind]), ['case', 'case', 'case', 'case', 'case', 'case', 'case', 'case', 'suite', 'evaluation'].slice(0, this.custody.length).map((kind, index) => [index + 1, kind]), 'ordered original submissions');
    if (!this.custody.length) throw new Error('Existing custody has no original submission; no replay');
    return this.custody.map(custody => {
      const submission = requests.get(custody.attempt);
      if (!submission || !custody.operationId) throw new Error('Original submission or operationId is unknown; no resend');
      return { custody, ...submission, receipts: receipts.filter(receipt => receipt.accepted.operationId === custody.operationId) };
    });
  }

  private async reuseCompletedSubmissions(retained: RetainedSubmission[]) {
    const currentContext = this.context!; const currentBranch = this.branch!;
    for (const { custody, request, at, receipts } of retained) {
      equal(request.inputBytes, this.inputBytes, 'retained exact author bytes');
      equal(request.task, this.task, 'retained complete Task');
      equal(request.context.task, this.task, 'retained exact Task and independent Oracle');
      equal(request.context.toolLock, oracleLockId, 'retained original Oracle lock');
      equal(request.context.branch, { world, id: request.branch.id, revision: request.branch.revision }, 'original submission context branch');
      equal([request.branch.id, request.branch.baseRelease, request.branch.basis], [currentBranch.id, currentBranch.baseRelease, currentBranch.basis], 'same original branch identity and complete basis');
      if (BigInt(request.branch.revision) > BigInt(currentBranch.revision)) throw new Error('Original public branch revision regressed');
      if (request.stage !== 'registration') {
        if (this.suite) { equal(request.context, this.context, 'same original frozen suite context'); equal(request.branch, this.branch, 'same original suite execution branch'); }
        this.context = request.context; this.branch = request.branch;
        await this.prepareAuthority();
        equal(request.authority, this.authority, 'retained complete four-arm authority');
        equal(request.templatesSha256, this.templatesSha256, 'retained frozen templates fingerprint');
      }
      equal(request.evidence, { inputSha256: this.inputSha256, originalSha256: this.originalSha256, preparedAt: this.preparedAt }, 'retained exact input fingerprints and preparation time');
      equal(request.confirmedTests, this.tests, 'retained confirmed test prefix');
      const kind = custody.kind; const binding = request.input.runtimeBindings;
      const occurredAtByCase = Object.fromEntries(this.tests.map(test => [this.input!.cases.find(item => this.input!.runtimeBindings.testCaseReferences![item.authorKey].id === test.id)!.authorKey, test.occurredAt]));
      let trainingBefore = this.input!.runtimeBindings.trainingBefore; let holdoutFrom = this.input!.runtimeBindings.holdoutFrom;
      if (kind === 'case') {
        equal(request.caseIndex, this.tests.length, 'retained next case index');
        const item = this.input!.cases[this.tests.length];
        const occurredAt = timestamp(binding.occurredAtByCase?.[item.authorKey], 'retained first sample preparation');
        if (Date.parse(occurredAt) < Date.parse(this.preparedAt!) || Date.parse(occurredAt) > Date.parse(at) || new Date(occurredAt).getUTCMilliseconds() !== 0) throw new Error('Retained sample occurrence is not its truthful whole-second preparation');
        occurredAtByCase[item.authorKey] = occurredAt;
        if (this.tests.length === 4) {
          trainingBefore = timestamp(binding.trainingBefore, 'original training cutoff'); holdoutFrom = timestamp(binding.holdoutFrom, 'original Holdout start');
          if (trainingBefore !== holdoutFrom || Date.parse(holdoutFrom) > Date.parse(occurredAt) || this.tests.some(test => Date.parse(test.occurredAt) >= Date.parse(trainingBefore!))) throw new Error('Retained Holdout does not follow the four Train samples');
        }
      } else equal(request.caseIndex, null, 'retained non-case submission');
      equal(request.input, { ...this.input!, runtimeBindings: { ...this.input!.runtimeBindings, branch: request.context.branch, occurredAtByCase, trainingBefore, holdoutFrom } }, 'retained complete bound input');
      this.input = { ...request.input, runtimeBindings: { ...request.input.runtimeBindings, branch: this.context!.branch } };
      if (request.stage === 'evaluation') {
        this.preExecutionBranch = request.hostExecutionBinding.preExecutionBranch;
        this.preExecutionBasisDigest = request.hostExecutionBinding.preExecutionBasisDigest;
        equal(this.preExecutionBranch, request.branch, 'retained independently observed execution branch');
        equal(this.preExecutionBasisDigest, digest(request.branch.basis), 'retained independently digested execution basis');
      }
      const key = { world, operationId: custody.operationId };
      const status = await this.read<Receipt>('operation', 'status', key); this.appendCustody('retained-status-readback', { original: custody, receipt: status });
      const result = await this.read<Receipt>('operation', 'result', key); this.appendCustody('retained-result-readback', { original: custody, receipt: result });
      for (const receipt of [...receipts, status, result]) {
        equal(Object.keys(receipt).sort(), ['accepted', 'disclosure', 'phase', 'progress', 'result', 'failure', 'commit', 'effects', 'cancellation', 'updatedAt'].sort(), 'retained complete operation receipt schema');
        timestamp(receipt.updatedAt, 'retained operation update');
        equal([receipt.accepted.world, receipt.accepted.operationId], [world, custody.operationId], 'retained original operation identity');
        if (!/^[1-9]\d*$/.test(receipt.accepted.revision) || !/^[1-9]\d*$/.test(receipt.accepted.incarnation)) throw new Error('Invalid retained receipt revision or incarnation');
        equal(receipt.accepted.incarnation, result.accepted.incarnation, 'retained original incarnation');
        if (receipt.failure || !['accepted', 'admitted', 'running', 'waiting_approval', 'waiting_dependency', 'verifying', 'committing', 'draining', 'completed'].includes(receipt.phase)) throw new Error('Original operation failed or is indeterminate; retain failure without replay');
        if (receipt.progress.runId) equal(receipt.progress.runId, result.progress.runId, 'retained original run ownership');
        if (BigInt(receipt.accepted.revision) > BigInt(result.accepted.revision)) throw new Error('Retained original result regressed');
        if (receipt.phase === 'completed') equal(receipt, result, 'complete original completed receipt');
      }
      if (status.phase !== 'completed' || status.disclosure.kind !== 'full' || status.failure || result.phase !== 'completed' || result.disclosure.kind !== 'full' || result.failure || !result.result) throw new Error('Original operation is not completed/full; no new submission');
      equal(status, result, 'same complete original status and result');
      if (custody.runId) equal(custody.runId, result.progress.runId, 'durable original run');
      equal(result.result.kind, kind === 'case' ? 'test_case' : kind === 'suite' ? 'suite' : 'evaluation_summary', 'retained exact result kind');
      this.lastReceipt = result;
      if (kind === 'case') await this.readCase(result.result.result);
      if (kind === 'suite') await this.readSuite(result.result.result);
      if (kind === 'evaluation') await this.readReport(result.result.result as EvaluationSummary, result.progress.runId ?? null);
      custody.runId = result.progress.runId ?? null; custody.outcome = 'confirmed';
    }
    this.context = currentContext; this.branch = currentBranch;
    this.input!.runtimeBindings.branch = currentContext.branch;
    this.custodyBlocked = false;
  }

  async prepare(setup?: { task?: Ref; branch?: TestRef; context?: Context }) {
    if (this.phase !== 'idle') throw new Error('One owned order evaluation attempt only');
    this.phase = 'preflight';
    this.preparedAt = timestamp(new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), 'actual preparation start');
    try {
      const retained = await this.readExistingCustody();
      if (retained.length) this.preparedAt = timestamp(retained[0].request.evidence.preparedAt, 'original preparation start');
      const originalBytes = await readFile(resolve(originalRoot, 'task-contract.json'));
      this.original = JSON.parse(originalBytes.toString('utf8')) as TaskContract;
      this.original.budget = { ...this.original.budget, maxCost: this.original.budget.maxCost ?? null, deadline: this.original.budget.deadline ?? null };
      this.originalSha256 = createHash('sha256').update(originalBytes).digest('hex');
      equal(await this.query('task_contract', { world, id: this.original.id, revision: this.original.revision }), this.original, 'unchanged original r1 Task including field-Oracle pin');
      const bytes = await readFile(publicFile(process.env.E2E_WORLD_ORDER_EVALUATION_INPUT || resolve(authorRoot, 'mathematical-cases.json')));
      this.inputSha256 = createHash('sha256').update(bytes).digest('hex');
      this.inputBytes = bytes.toString('utf8');
      const input = JSON.parse(this.inputBytes) as Input;
      const authored = JSON.parse(await readFile(resolve(authorRoot, 'mathematical-cases.json'), 'utf8')) as Input;
      equal(input.originalTask, authored.originalTask, 'author original Task');
      equal(input.cases, authored.cases, 'immutable eight authored cases; no Holdout tuning');
      this.validateCases(input.cases);
      if (setup?.task) equal({ world: setup.task.world, id: setup.task.id, revision: setup.task.revision }, executionTask, 'setup exact execution Task');
      this.task = await this.query<TaskContract>('task_contract', executionTask);
      reference(this.task, 'real execution Task');
      for (const key of ['goal', 'inputType', 'hardConstraints', 'allowedEffects', 'stopConditions', 'scope', 'budget'] as const) equal(this.task[key], this.original[key], `arithmetic Task ${key}`);
      equal(this.task.requiredSuites, [executionSuite.id], 'exact execution required suite');
      const definitions = JSON.parse(await readFile(resolve(originalRoot, 'definitions.json'), 'utf8')) as Definition[];
      this.definitions = definitions;
      const branches = await this.catalog<Branch>('branches');
      const matched: { branch: Branch; context: Context }[] = [];
      for (const branch of branches.filter(item => item.basis.activationLockId === oracleLockId && isDeepStrictEqual(item.basis.overlay, definitions.map(definition => ({ kind: 'create_definition', definition })))
        && (!setup?.branch || (item.id === setup.branch.id && item.revision === setup.branch.revision)))) {
        const context = await this.query<Context>('suite_creation_context', { world, id: branch.id, revision: branch.revision });
        if (isDeepStrictEqual(context.task, this.task)) matched.push({ branch, context });
      }
      if (matched.length !== 1) throw new Error(`Expected one real execution Task/branch/context, found ${matched.length}; no new branch or historical reference is invented`);
      this.branch = matched[0].branch; this.context = matched[0].context;
      if (setup?.branch) equal(this.context.branch, { world, id: setup.branch.id, revision: setup.branch.revision }, 'setup exact public branch');
      if (setup?.context) equal(this.context, setup.context, 'setup complete public context');
      equal(this.context.toolLock, oracleLockId, 'actual branch Oracle lock');
      const existing = await this.catalog<{ reference: Ref }>('suites');
      const recorded = await this.catalog<TestRef>('test_cases', { task: executionTask });
      const testCaseReferences = Object.fromEntries(input.cases.map(item => [item.authorKey, { id: `test:order-line-total:20261027:execution-r1:${item.authorKey}`, revision: '1' }]));
      const oracle = object(this.task.successOracle, 'real independent Oracle');
      if (oracle.kind !== 'program') throw new Error('Execution Task does not pin an independent program Oracle');
      const implementation = object(oracle.implementation, 'real Oracle implementation');
      equal(implementation.installId, oracleInstallId, 'activated arithmetic Oracle install');
      this.input = { ...input, runtimeBindings: { evaluationTask: executionTask, branch: this.context.branch, suite: executionSuite, arithmeticOracle: this.task.successOracle,
        testCaseReferences, occurredAtByCase: {}, trainingBefore: null, holdoutFrom: null, oracleAuthorityBinding: { artifactDigest: String(implementation.artifactDigest) } } };
      await this.validateRegistrationContext();
      await this.reuseCompletedSubmissions(retained);
      const retainedTests = this.tests.map(test => ({ id: test.id, revision: test.revision }));
      const authoredTests = recorded.filter(test => Object.values(testCaseReferences).some(authored => authored.id === test.id));
      equal(authoredTests.length, retainedTests.length, 'public authored test count matches completed original submissions');
      for (const test of authoredTests) equal(test, retainedTests.find(retained => retained.id === test.id), 'public authored test exactly matches its completed original submission');
      equal(existing.filter(suite => suite.reference.id === executionSuite.id).map(suite => suite.reference), this.suite ? [executionSuite] : [], 'public suite exactly matches completed original freeze');
      this.phase = this.report ? 'report-confirmed' : this.suite ? 'suite-frozen' : this.tests.length ? 'cases' : 'ready';
    } catch (error) {
      this.phase = 'blocked-before-write';
      this.blocker = error instanceof Error ? error.message : 'Unknown preflight failure';
      throw error;
    }
    return this.evidence();
  }

  private validateCases(cases: Case[]) {
    if (!Array.isArray(cases) || cases.length !== 8 || cases.filter(item => item.split === 'train').length !== 4 || cases.filter(item => item.split === 'holdout').length !== 4) throw new Error('Expected four Train and four protected Holdout cases');
    const pairs = new Set<string>(); const families = new Set<string>(); const keys = new Set<string>();
    for (const item of cases) {
      equal(Object.keys(item.fixture.fields).sort(), ['quantity', 'unitPriceCents'], 'raw fixture fields');
      const quantity = item.fixture.fields.quantity; const price = item.fixture.fields.unitPriceCents;
      if (quantity.kind !== 'integer' || price.kind !== 'integer' || !/^[1-9]\d*$/.test(quantity.value) || !/^(0|[1-9]\d*)$/.test(price.value)) throw new Error('Invalid exact integer fixture');
      const q = BigInt(quantity.value); const p = BigInt(price.value);
      if (q > 1_000_000n || p > 1_000_000_000n || item.expected.value !== String(q * p) || item.expected.kind !== 'function_integer') throw new Error('Authored arithmetic violates independent integer specification');
      const pair = `${quantity.value}:${price.value}`;
      if (pairs.has(pair) || families.has(item.originFamily) || keys.has(item.authorKey) || (item.split === 'holdout' && !item.protected)) throw new Error('Train/Holdout overlap, repeated provenance or unprotected Holdout');
      pairs.add(pair); families.add(item.originFamily); keys.add(item.authorKey);
    }
  }

  private async validateRegistrationContext() {
    const context = this.context!; const binding = this.input!.runtimeBindings;
    const description = await this.query<{ world: World; status: string; incarnation: string; editingContext: { externalContracts: Json[]; scopes: Plan['scopes'] } }>('discover', { includeCapabilities: true });
    equal(description.world, world, 'discovered World');
    if (description.status !== 'ready' || !/^[1-9]\d*$/.test(description.incarnation)) throw new Error('World is not ready or omits its real incarnation');
    this.incarnation = description.incarnation;
    equal(description.editingContext?.externalContracts, [], 'real candidate compile context has no external Function/Source tool contracts');
    const oracle = object(this.task!.successOracle, 'OracleSpec');
    if (oracle.kind !== 'program') throw new Error('Independent arithmetic program Oracle required');
    const implementation = object(oracle.implementation, 'Oracle implementation');
    equal(implementation.artifactDigest, binding.oracleAuthorityBinding.artifactDigest, 'compiled authority artifact');
    const locks = (await this.catalog<Lock>('bindings')).filter(lock => lock.id === context.toolLock);
    if (locks.length !== 1) throw new Error('Exact branch evaluation lock is not uniquely public');
    equal(locks[0].world, world, 'branch binding lock World');
    equal(this.branch!.basis.activationLockId, locks[0].id, 'public branch exact binding lock');
    if (locks[0].nodes.filter(node => node.slot === 'evaluation' && node.trust !== 'ordinary_guest' && isDeepStrictEqual(node.implementation, oracle.implementation)).length !== 1) throw new Error('Independent Oracle is not uniquely bound in the actual branch lock; BindingHead activation does not require a new business Release');
    if (!description.editingContext.scopes.some(scope => scope.id === this.task!.scope)) throw new Error('Task full public Scope is missing');
    const strategy = this.definitions.find(definition => definition.body.kind === 'strategy');
    if (!strategy || !context.strategies.some(ref => isDeepStrictEqual(ref, strategy.reference))) throw new Error('Candidate strategy is not a real public context option');
    for (const definition of this.definitions) equal(await this.query('definition', { reference: definition.reference }), definition, 'public authored candidate definition');
    equal(await this.query('task_contract', executionTask), this.task, 'unchanged exact execution Task and Oracle');
    return description;
  }

  private async prepareAuthority() {
    if (this.authority) return this.validateAuthority();
    const memoryBytes = await readFile(resolve(authorRoot, 'tool-memory-train.json'));
    equal(JSON.parse(memoryBytes.toString('utf8')), { kind: 'integer', value: '5997' }, 'Train-only memory seed');
    const templatesBytes = await readFile(resolve(authorRoot, 'baseline-templates.json'));
    this.templatesSha256 = createHash('sha256').update(templatesBytes).digest('hex');
    const templates = JSON.parse(templatesBytes.toString('utf8')) as Templates;
    equal(templates.world, world, 'frozen templates World');
    const materials = await this.catalog<SourceVersion>('materials');
    const expectedMemory = { digest: `sha256:${createHash('sha256').update(memoryBytes).digest('hex')}`, byteSize: String(memoryBytes.length) };
    const memories = materials.filter(item => isDeepStrictEqual(item.blob, expectedMemory));
    if (memories.length !== 1) throw new Error(`Four-arm freeze requires one real Train-only SourceVersion matching exact blob ${expectedMemory.digest}/${expectedMemory.byteSize}; complete public catalog matches=${memories.length}; stopped before freeze upload/write`);
    equal(memories[0].reference.world, world, 'real memory SourceVersion World');
    const description = await this.validateRegistrationContext();
    const scopes = description.editingContext.scopes;
    const context = this.context!;
    const conditions: Conditions = { policyEpoch: context.policyEpoch, grantEpoch: context.grantEpoch, toolLock: context.toolLock, dataDigest: context.dataDigest,
      modelBinding: null, totalBudget: this.task!.budget, readMode: { kind: 'authoritative' }, validAt: this.preparedAt!, knownAt: this.preparedAt! };
    const strategy = this.definitions.find(definition => definition.body.kind === 'strategy')!;
    const expectedFunction = { world, id: this.input!.cases[0].expected.functionId, revision: this.input!.cases[0].expected.functionRevision };
    this.authority = { bindings: [{ arm: { kind: 'candidate' }, plan: { strategy: strategy.reference, definitions: this.definitions, tools: [], scopes, knowledge: { kind: 'candidate' } }, conditions, expectedFunction }] };
    for (const arm of arms.filter(kind => kind !== 'candidate')) {
      const selection = templates.planSelections.find(item => item.arm.kind === arm);
      if (!selection || selection.plan.kind !== 'frozen') throw new Error(`Missing frozen ${arm} author template`);
      const plan = structuredClone(selection.plan.reference) as Plan;
      const functionRef: Ref = { world, id: `function:order-line-total:20261027:execution-r1:${arm}`, revision: '1' };
      const strategyRef: Ref = { world, id: `strategy:order-line-total:20261027:execution-r1:${arm}`, revision: '1' };
      const functionDefinition = structuredClone(templates.definitionTemplates[arm === 'tool_memory' ? 'trainOnlyMemoryFunction' : 'parameterMultiplicationFunction']);
      const strategyDefinition = structuredClone(templates.definitionTemplates.singleFunctionStrategy);
      const assembly = templates.assembly[arm === 'tool_memory' ? 'toolMemory' : arm === 'static_ontology' ? 'staticOntology' : 'appendOnly'];
      const strategyBody = object(strategyDefinition.body.body, 'baseline Strategy body');
      const steps = strategyBody.steps as { operation: { function: Ref; arguments: Json[] } }[];
      if (!Array.isArray(steps) || steps.length !== 1) throw new Error('Baseline must retain its frozen single Function step');
      steps[0].operation.function = functionRef; steps[0].operation.arguments = assembly.functionArguments;
      for (const [definition, ref, dependencies] of [[functionDefinition, functionRef, []], [strategyDefinition, strategyRef, [functionRef]]] as [Definition, Ref, Ref[]][]) {
        definition.reference = ref; definition.validTime = { from: this.preparedAt, to: null }; definition.dependencies = dependencies;
        definition.contentDigest = digest(['world.definition.v1', ref, definition.scope, definition.validTime, definition.body, dependencies, definition.previousRef ?? null, definition.lifecycle]);
      }
      plan.strategy = strategyRef; plan.definitions = [functionDefinition, strategyDefinition]; plan.scopes = scopes;
      if (arm === 'tool_memory') plan.knowledge = { kind: arm, snapshot: memories[0].reference, memoryFunction: functionRef };
      this.authority.bindings.push({ arm: { kind: arm }, plan, conditions, expectedFunction });
    }
    await this.validateAuthority();
  }

  private async validateAuthority() {
    const context = this.context!; const authority = this.authority!;
    equal(authority.bindings.map(item => item.arm.kind).sort(), [...arms].sort(), 'four distinct authority arms');
    const candidate = authority.bindings.find(item => item.arm.kind === 'candidate')!;
    if (!context.strategies.some(ref => isDeepStrictEqual(ref, candidate.plan.strategy))) throw new Error('Candidate strategy is not a real public context option');
    const description = await this.validateRegistrationContext();
    for (const arm of authority.bindings) {
      equal(arm.conditions, candidate.conditions, 'identical four-arm conditions');
      equal(arm.conditions.totalBudget, this.task!.budget, 'zero model/source Task budget');
      equal(arm.conditions.readMode, { kind: 'authoritative' }, 'shared authoritative read mode');
      equal(arm.conditions.modelBinding, null, 'no native model or Holdout disclosure');
      for (const key of ['policyEpoch', 'grantEpoch', 'toolLock', 'dataDigest'] as const) equal(arm.conditions[key], context[key], `current context ${key}`);
      timestamp(arm.conditions.validAt, 'validAt'); timestamp(arm.conditions.knownAt, 'knownAt');
      reference(arm.plan.strategy, `${arm.arm.kind} Strategy`); reference(arm.expectedFunction, `${arm.arm.kind} expected Function`);
      equal(arm.expectedFunction, { world, id: this.input!.cases[0].expected.functionId, revision: this.input!.cases[0].expected.functionRevision }, 'all arms bound to the unchanged mathematical expected target');
      equal(arm.plan.tools, candidate.plan.tools, 'common tool closure');
      // This authored pure-math task has no external tools. Reject rather than silently author a different benchmark.
      equal(arm.plan.tools, [], 'pure-math empty external tool closure');
      const strategy = arm.plan.definitions.find(definition => isDeepStrictEqual(definition.reference, arm.plan.strategy));
      if (!strategy || strategy.body.kind !== 'strategy') throw new Error('Missing exact Strategy definition');
      if (arm.plan.definitions.length !== 2 || !arm.plan.definitions.some(definition => definition.body.kind === 'function')) throw new Error('Each pure-math plan must contain only its reachable Strategy and Function');
      for (const definition of arm.plan.definitions) {
        reference(definition.reference, 'plan definition');
        equal(definition.contentDigest, digest(['world.definition.v1', definition.reference, definition.scope, definition.validTime, definition.body, definition.dependencies, definition.previousRef ?? null, definition.lifecycle]), 'canonical definition digest');
        for (const dependency of definition.dependencies) if (!arm.plan.definitions.some(item => isDeepStrictEqual(item.reference, dependency))) throw new Error('FrozenPlan has an unclosed dependency');
        if (arm.arm.kind === 'candidate') equal(await this.query('definition', { reference: definition.reference }), definition, 'public candidate definition');
      }
      for (const scope of arm.plan.scopes) {
        equal(scope.world, world, 'complete Scope world');
        equal(description.editingContext.scopes.find(item => item.id === scope.id), scope, 'exact public complete Scope');
      }
      if (!arm.plan.scopes.some(scope => scope.id === this.task!.scope)) throw new Error('FrozenPlan missing the authorized full Scope');
      if (arm.arm.kind !== 'candidate') {
        equal(arm.plan.knowledge.kind, arm.arm.kind, 'baseline knowledge kind');
        if (arm.plan.definitions.some(definition => candidate.plan.definitions.some(item => isDeepStrictEqual(item.reference, definition.reference)))) throw new Error('Baseline aliases candidate definitions');
      }
    }
    const memory = authority.bindings.find(item => item.arm.kind === 'tool_memory')!.plan;
    if (!memory.knowledge.snapshot || !memory.knowledge.memoryFunction) throw new Error('ToolMemory requires a real registered Train-only SourceVersionRef');
    const source = await this.query<{ reference: unknown; blob: Blob }>('source_version', { reference: memory.knowledge.snapshot });
    equal(source.reference, memory.knowledge.snapshot, 'real Train-only memory source');
    const bytes = await readFile(resolve(authorRoot, 'tool-memory-train.json'));
    equal(source.blob, { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteSize: String(bytes.length) }, 'only approved Train seed bytes in memory');
    const constant = memory.definitions.find(item => isDeepStrictEqual(item.reference, memory.knowledge.memoryFunction));
    if (!constant) throw new Error('Memory Function not in frozen closure');
    const body = object(constant.body.body, 'memory function body');
    equal(body.parameters, [], 'constant memory no-argument function');
    equal(body.expression, { kind: 'literal', value: { kind: 'integer', value: '5997' } }, 'unchanged constant memory, not tuned on Holdout');
    const releases = await this.catalog<{ id: string }>('releases');
    for (const arm of authority.bindings.filter(item => item.arm.kind === 'static_ontology' || item.arm.kind === 'append_only')) {
      const release = arm.plan.knowledge.releaseId ?? arm.plan.knowledge.anchorRelease;
      if (!releases.some(item => item.id === release)) throw new Error('Baseline anchor release is not public');
      if (arm.arm.kind === 'append_only') equal(arm.plan.knowledge.changes, [], 'authored zero-delta append-only baseline, not evidence of improvement');
    }
  }

  private async open(details: Locator) { const summary = details.locator(':scope > summary'); if (await details.getAttribute('open') === null) await summary.click(); }
  private async observeCommand() {
    if (this.observation || !this.incarnation) throw new Error('An unresolved command already owns observation, or World incarnation is unavailable');
    if (!this.hintRecorderInstalled) {
      await this.electron.page.exposeBinding(this.hintBinding, (_source, hint: { ids: string[]; error?: string }) => {
        const custody = this.custody.at(-1);
        if (!custody) throw new Error('Operation event has no durable original request');
        if (!hint.error && hint.ids.length === 1 && (!custody.operationId || custody.operationId === hint.ids[0])) custody.operationId = hint.ids[0];
        this.appendCustody('operation-event', hint);
      });
      this.hintRecorderInstalled = true;
    }
    const handle = await this.electron.page.evaluateHandle(({ world, incarnation, hintBinding }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: {
        on(channel: string, listener: (value: unknown) => void): () => void;
      } } }).electron.ipcRenderer;
      const state: Observation = { ids: [], dispose: () => undefined };
      const persist = () => {
        const recorder = (window as unknown as Record<string, (hint: { ids: string[]; error?: string }) => Promise<void>>)[hintBinding];
        state.persisted = recorder({ ids: [...state.ids], error: state.error }).catch(() => { state.error = 'Original operation event could not be durably retained; no replay'; });
      };
      const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!record(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !record(value.payload)) return;
        const hint = value.payload;
        if (!record(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') {
          state.error = 'Original World event observation lost continuity; retain the original UI request, never resend'; persist(); return;
        }
        if (!record(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) {
          if (state.ids.length >= 8) state.error = 'Ambiguous operation hints; retain original request without replay';
          else state.ids.push(hint.resource.id);
          persist();
        }
      });
      return state;
    }, { world, incarnation: this.incarnation, hintBinding: this.hintBinding });
    this.observation = { read: async () => {
      const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 });
      await ready.dispose();
      return handle.evaluate(async state => { await state.persisted; return { ids: [...state.ids], error: state.error }; });
    }, dispose: async () => { await handle.evaluate(async state => { state.dispose(); await state.persisted; }); await handle.dispose(); } };
  }
  private async releaseObservation() {
    if (!this.observation) return;
    await this.observation.dispose();
    this.observation = undefined;
  }
  private async selectCatalog(select: Locator, first: RegExp, next: RegExp, value: string) {
    const firstButton = this.management.getByRole('button', { name: first, exact: true });
    if (await firstButton.isEnabled()) await firstButton.click();
    for (let page = 0; page < 100; page++) {
      await select.waitFor({ state: 'visible', timeout: 15_000 });
      await select.locator('option[value]:not([value=""])').first().waitFor({ state: 'attached', timeout: 15_000 });
      const option = select.locator('option');
      const values = await option.evaluateAll(items => items.map(item => (item as HTMLOptionElement).value));
      if (values.includes(value)) { await select.selectOption(value); return; }
      const nextButton = this.management.getByRole('button', { name: next, exact: true });
      if (!await nextButton.isEnabled()) throw new Error(`Real UI catalog does not expose the authorized option ${value}`);
      const before = await select.innerHTML(); await nextButton.click();
      await this.waitChanged(select, before);
    }
    throw new Error('UI catalog pagination did not terminate');
  }
  private async waitChanged(select: Locator, before: string) {
    const until = Date.now() + 15_000;
    while (Date.now() < until) { if (await select.innerHTML() !== before) return; await setTimeout(100); }
    throw new Error('UI catalog did not change after its real pagination action');
  }
  async chooseContext() {
    if (!['ready', 'cases', 'suite-frozen', 'report-confirmed'].includes(this.phase)) throw new Error('No validated order evaluation prerequisites');
    const branch = this.context!.branch;
    await this.selectCatalog(this.management.getByRole('combobox', { name: /^(Branch and revision|分支与修订)$/, exact: true }), /^(First branches|分支首页)$/, /^(Next branches|下一页分支)$/, `${branch.id}:${branch.revision}`);
    const advanced = this.management.getByRole('button', { name: /^(Manage suites and tests \(advanced\)|管理套件与测试（高级）)$/, exact: true });
    if (await advanced.count()) await advanced.click();
    await this.management.getByLabel(/^(Task business scope|任务所属业务范围)$/, { exact: true }).fill(this.task!.scope);
    await this.selectCatalog(this.management.getByRole('combobox', { name: /^(Registered task|已登记任务)$/, exact: true }), /^(First tasks|任务首页)$/, /^(Next tasks|下一页任务)$/, `${this.task!.id}:${this.task!.revision}`);
    await this.registration.locator(':scope > summary').waitFor({ state: 'visible', timeout: 15_000 });
    equal(await this.query('suite_creation_context', branch), this.context, 'context unchanged before first upload');
    return this.evidence();
  }
  async fillCase(index: number) {
    if (!this.input || !this.task || !['ready', 'cases'].includes(this.phase) || index !== this.tests.length) throw new Error('Case preparation is out of order or follows an unresolved write');
    const item = this.input.cases[index]; const binding = this.input.runtimeBindings;
    if (!item) throw new Error('Case index outside the fixed eight authored examples');
    if (binding.occurredAtByCase![item.authorKey]) throw new Error('Sample preparation already started; its first occurrence cannot be rewritten');
    if (item.split === 'holdout' && !binding.holdoutFrom) {
      const lastTrain = Math.max(...this.tests.filter(test => test.split === 'train').map(test => Date.parse(test.occurredAt)));
      if (this.tests.length !== 4) throw new Error('Holdout preparation requires the four confirmed Train registrations');
      // The normal datetime-local control has whole-second precision; wait for a real later second, never invent historical samples.
      if (Math.floor(Date.now() / 1000) * 1000 <= lastTrain) await setTimeout(lastTrain + 1000 - Date.now());
      binding.trainingBefore = binding.holdoutFrom = timestamp(new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), 'actual first Holdout preparation');
    }
    binding.occurredAtByCase![item.authorKey] = timestamp(new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), `${item.authorKey} first preparation`);
    // No existing test is selected until all eight new cases are registered: never inherit another origin family.
    await this.open(this.registration);
    await this.registration.getByLabel(/^(New test ID|新测试标识)$/, { exact: true }).fill(binding.testCaseReferences![item.authorKey].id);
    await this.registration.getByLabel(/^(Sample origin family|样本来源家族)$/, { exact: true }).fill(item.originFamily);
    await this.registration.getByRole('combobox', { name: /^(Test purpose|测试用途)$/, exact: true }).selectOption('regression');
    await this.registration.getByRole('combobox', { name: /^(Dataset split|数据划分)$/, exact: true }).selectOption(item.split);
    await this.localDate(this.registration.getByLabel(/^(Actual sample occurrence \(local time\)|样本实际发生时间（本地时间）)$/, { exact: true }), binding.occurredAtByCase![item.authorKey]);
    const files = this.registration.locator('input[type="file"]'); equal(await files.count(), 2, 'two real registration file controls');
    await files.nth(0).setInputFiles({ name: `${item.authorKey}.fixture.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(item.fixture)) });
    await files.nth(1).setInputFiles({ name: `${item.authorKey}.expected.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(item.expected)) });
    return this.evidence();
  }
  async arm(kind: 'case' | 'suite' | 'evaluation') {
    if (this.custodyBlocked || this.custody.some(item => item.outcome !== 'confirmed') || (kind === 'case' && this.tests.length >= 8) || (kind !== 'case' && !this.authority) || (kind === 'suite' && (this.tests.length !== 8 || !this.registrationsVerified || this.suite)) || (kind === 'evaluation' && (!this.suite || !this.preExecutionBranch || !this.preExecutionBasisDigest || this.custody.some(item => item.kind === 'evaluation')))) throw new Error('Refusing repeated or unresolved order evaluation mutation');
    const common = { inputBytes: this.inputBytes, input: this.input!, task: this.task!, context: this.context!, branch: this.branch!, confirmedTests: this.tests,
      evidence: { preparedAt: this.preparedAt!, inputSha256: this.inputSha256, originalSha256: this.originalSha256 } };
    const request: Submission = kind === 'case' ? { ...common, stage: 'registration', caseIndex: this.tests.length }
      : kind === 'suite' ? { ...common, stage: 'suite', caseIndex: null, authority: this.authority!, templatesSha256: this.templatesSha256 }
      : { ...common, stage: 'evaluation', caseIndex: null, authority: this.authority!, templatesSha256: this.templatesSha256,
        hostExecutionBinding: { preExecutionBranch: this.preExecutionBranch!, preExecutionBasisDigest: this.preExecutionBasisDigest! } };
    this.custody.push({ kind, attempt: this.custody.length + 1, operationId: null, runId: null, outcome: 'unconfirmed-original-request-retained' });
    this.phase = `${kind}-unconfirmed`;
    this.appendCustody('before-ui-mutation', request);
    await this.observeCommand();
    return this.evidence();
  }
  async confirm(kind: 'case' | 'suite' | 'evaluation') {
    const custody = this.custody.at(-1);
    if (!custody || custody.kind !== kind || custody.outcome === 'confirmed' || !this.observation) throw new Error('No owned original submission to observe');
    const until = Date.now() + (kind === 'evaluation' ? 180_000 : 45_000);
    let receipt: Receipt | undefined;
    let revision: bigint | undefined;
    while (Date.now() < until) {
      const observed = await this.observation.read();
      if (observed.error) throw new Error(observed.error);
      if (observed.ids.length !== 1 || (custody.operationId && custody.operationId !== observed.ids[0])) throw new Error('Original operation hints are ambiguous or changed; preserve original request custody without replay');
      custody.operationId = observed.ids[0];
      if (custody.operationId) {
        receipt = await this.read<Receipt>('operation', 'status', { world, operationId: custody.operationId });
        this.appendCustody('operation-status', receipt);
        equal(Object.keys(receipt).sort(), ['accepted', 'disclosure', 'phase', 'progress', 'result', 'failure', 'commit', 'effects', 'cancellation', 'updatedAt'].sort(), 'complete original operation receipt schema');
        timestamp(receipt.updatedAt, 'original operation update');
        if (!/^[1-9]\d*$/.test(receipt.accepted.revision) || !/^[1-9]\d*$/.test(receipt.accepted.incarnation)) throw new Error('Invalid original operation revision or incarnation');
        if (revision !== undefined && BigInt(receipt.accepted.revision) < revision) throw new Error('Original operation revision regressed');
        revision = BigInt(receipt.accepted.revision);
        equal(receipt.accepted.world, world, 'original operation World'); equal(receipt.accepted.operationId, custody.operationId, 'original event operation key');
        equal(receipt.accepted.incarnation, this.incarnation, 'original event incarnation');
        if (custody.runId) equal(receipt.progress.runId, custody.runId, 'original operation retains its run ownership');
        if (receipt.progress.runId && custody.runId !== receipt.progress.runId) { custody.runId = receipt.progress.runId; this.appendCustody('operation-run', receipt); }
        if (['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'retained', 'commit_indeterminate', 'effect_indeterminate'].includes(receipt.phase)) break;
      }
      await setTimeout(200);
    }
    if (!receipt || receipt.phase !== 'completed') throw new Error(`Order ${kind} not confirmed: operation=${custody.operationId ?? 'not-publicly-observable'}, phase=${receipt?.phase ?? 'delivery-unknown'}, code=${receipt?.failure?.code ?? 'not-disclosed'}; preserve exact original request, no resend/recovery/navigation`);
    if (receipt.disclosure.kind !== 'full' || receipt.failure || !receipt.result) throw new Error('Original completed status is withheld or failed; retain the request without replay');
    const result = await this.read<Receipt>('operation', 'result', { world, operationId: custody.operationId });
    this.appendCustody('operation-result', result);
    equal(result.accepted.world, world, 'result World'); equal(result.accepted.operationId, custody.operationId, 'result operation key');
    equal(result.accepted.incarnation, receipt.accepted.incarnation, 'result incarnation');
    if (BigInt(result.accepted.revision) < BigInt(receipt.accepted.revision) || result.phase !== 'completed' || result.disclosure.kind !== 'full' || result.failure || !result.result) throw new Error('Original result is withheld, failed or regressed; not evidence of completion');
    equal(receipt, result, 'same complete original completed status and result');
    equal(result.result.kind, kind === 'case' ? 'test_case' : kind === 'suite' ? 'suite' : 'evaluation_summary', 'original result kind');
    this.lastReceipt = result;
    if (kind === 'case') await this.readCase(result.result.result);
    if (kind === 'suite') await this.readSuite(result.result.result);
    if (kind === 'evaluation') await this.readReport(result.result.result as EvaluationSummary, custody.runId);
    const observed = await this.observation.read();
    if (observed.error) throw new Error(observed.error);
    equal(observed.ids, [custody.operationId], 'one original operation through exact result readback');
    await this.releaseObservation();
    custody.outcome = 'confirmed'; this.phase = kind === 'case' ? 'cases' : kind === 'suite' ? 'suite-frozen' : 'report-confirmed';
    this.appendCustody('confirmed', { receipt: result, tests: this.tests, evidence: this.evidence() });
    return this.evidence();
  }
  private async readCase(result: unknown) {
    const item = this.input!.cases[this.tests.length]; const binding = this.input!.runtimeBindings; const test = binding.testCaseReferences![item.authorKey];
    equal(result, { test }, 'registered exact TestRevision from original operation');
    const actual = await this.query<TestCase>('exact_test_case', test);
    equal(actual, this.expectedCase(this.tests.length), 'complete registered TestCase metadata and sealed fixture/expected digests');
    this.tests.push(actual);
  }
  private expectedCase(index: number): TestCase {
    const item = this.input!.cases[index]; const binding = this.input!.runtimeBindings; const test = binding.testCaseReferences![item.authorKey];
    return { world, ...test, taskId: this.task!.id, taskRevision: this.task!.revision, scope: this.task!.scope, oracle: this.task!.successOracle, originFamily: item.originFamily, evidence: [], caseId: null, candidateId: null, split: item.split, purpose: 'regression', protected: item.protected, occurredAt: timestamp(binding.occurredAtByCase![item.authorKey], 'case occurrence'), fixture: blob(item.fixture), expected: blob(item.expected) };
  }
  private validateRegistrationTimes() {
    if (this.tests.length !== 8) throw new Error('Time isolation requires all eight independently confirmed cases');
    const dates = this.input!.runtimeBindings;
    const trainingBefore = Date.parse(timestamp(dates.trainingBefore, 'actual training cutoff'));
    const holdoutFrom = Date.parse(timestamp(dates.holdoutFrom, 'actual Holdout start'));
    if (trainingBefore > holdoutFrom || this.tests.some(test => test.split === 'train' ? Date.parse(test.occurredAt) >= trainingBefore : Date.parse(test.occurredAt) < holdoutFrom)) throw new Error('Actual preparation times violate frozen Train/Holdout isolation');
  }
  async verifyRegistrations() {
    this.registrationsVerified = false;
    if (this.custodyBlocked || this.custody.some(item => item.outcome !== 'confirmed') || !['cases', 'suite-frozen', 'report-confirmed', 'report-rendered'].includes(this.phase)) throw new Error('Cannot verify registrations with unresolved original custody');
    const registrations = this.custody.filter(item => item.kind === 'case');
    equal(registrations.map(item => [item.attempt, item.outcome]), Array.from({ length: 8 }, (_, index) => [index + 1, 'confirmed']), 'eight ordered completed original registrations');
    if (registrations.some(item => !item.operationId) || new Set(registrations.map(item => item.operationId)).size !== 8) throw new Error('Eight distinct original registration operations are required');
    this.validateCases(this.input!.cases);
    this.validateRegistrationTimes();
    for (const [index, expected] of this.tests.entries()) {
      equal(expected, this.expectedCase(index), 'unchanged complete authored TestCase');
      equal(await this.query('exact_test_case', { id: expected.id, revision: expected.revision }), expected, 'final complete exact registered TestCase including Oracle and sealed blobs');
    }
    equal(await this.query('task_contract', executionTask), this.task, 'final exact execution Task and independent Oracle pin');
    equal(await this.query('task_contract', { world, id: this.original!.id, revision: this.original!.revision }), this.original, 'final unchanged original r1 Task and Oracle pin');
    this.registrationsVerified = true;
    return this.evidence();
  }
  private async localDate(control: Locator, value: string) {
    const local = await this.electron.page.evaluate(value => { const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${date.getSeconds() ? `:${pad(date.getSeconds())}` : ''}`; }, timestamp(value, 'UI local time'));
    if (new Date(value).getUTCMilliseconds() !== 0) throw new Error('UI datetime-local cannot preserve subsecond author time; request a truthful whole-second binding');
    await control.fill(local);
  }
  private async budget(form: Locator) {
    const details = form.locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(Processing limits|本次处理上限)$/ }) }).last();
    await this.open(details);
    const budget = this.task!.budget; const values = [budget.maxWallTime, budget.maxSteps, budget.maxSourceReads, budget.maxRows, budget.maxBytes, budget.maxModelCalls, budget.maxInputTokens, budget.maxOutputTokens];
    for (let index = 0; index < values.length; index++) await details.getByLabel(budgetLabels[index], { exact: true }).fill(values[index]);
  }
  async fillSuite() {
    if (this.phase !== 'cases' || this.tests.length !== 8) throw new Error('Freeze requires all eight independently confirmed cases');
    if (!this.registrationsVerified) throw new Error('Freeze requires the final complete eight-case registration readback');
    this.validateRegistrationTimes();
    const branches = (await this.catalog<Branch>('branches')).filter(branch => branch.id === this.branch!.id);
    if (branches.length !== 1) throw new Error('Freeze requires one exact current public branch');
    equal([branches[0].baseRelease, branches[0].basis], [this.branch!.baseRelease, this.branch!.basis], 'same original branch basis before first freeze');
    const branch = { world, id: branches[0].id, revision: branches[0].revision };
    const context = await this.query<Context>('suite_creation_context', branch);
    equal(context.branch, branch, 'current exact freeze branch');
    equal(context.task, this.task, 'current exact freeze Task and independent Oracle');
    equal(context.toolLock, oracleLockId, 'current exact freeze Oracle lock');
    this.branch = branches[0]; this.context = context; this.input!.runtimeBindings.branch = branch;
    await this.prepareAuthority();
    await this.management.getByRole('button', { name: /^(Refresh catalog|刷新目录)$/, exact: true }).click();
    await this.chooseContext();
    await this.open(this.freeze);
    await this.freeze.getByRole('combobox', { name: /^(Suite required by the task|任务要求的套件)$/, exact: true }).selectOption(this.input!.runtimeBindings.suite!.id);
    const candidate = this.authority!.bindings.find(item => item.arm.kind === 'candidate')!.plan.strategy;
    await this.freeze.getByRole('combobox', { name: /^(Evaluation arm · Candidate|评测组 · 候选方案)$/, exact: true }).selectOption(`${candidate.id}:${candidate.revision}`);
    const files = this.freeze.locator('input[type="file"]'); equal(await files.count(), 3, 'three real baseline FrozenPlan inputs');
    for (const [index, arm] of (['tool_memory', 'static_ontology', 'append_only'] as const).entries()) {
      const plan = this.authority!.bindings.find(item => item.arm.kind === arm)!.plan;
      await files.nth(index).setInputFiles({ name: `${arm}.frozen-plan.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan)) });
    }
    for (const test of this.tests) {
      const first = this.management.getByRole('button', { name: /^(First tests|测试首页)$/, exact: true }); if (await first.isEnabled()) await first.click();
      for (let page = 0; page < 100; page++) {
        const button = this.management.getByRole('button', { name: test.id, exact: true });
        if (await button.count() === 1) { await button.click(); break; }
        const next = this.management.getByRole('button', { name: /^(Next tests|下一页测试)$/, exact: true });
        if (!await next.isEnabled() || page === 99) throw new Error('Registered exact test not reachable through real UI pagination');
        const table = this.management.locator('table').first(); const before = await table.innerHTML(); await next.click(); await this.waitChanged(table, before);
      }
      await this.management.locator('summary').filter({ hasText: new RegExp(`^(?:Test details · |测试详情 · )${test.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} / ${test.revision}$`) }).waitFor({ state: 'visible', timeout: 15_000 });
      await this.management.getByRole('button', { name: /^(Add the currently loaded test|加入当前已读取测试)$/, exact: true }).click({ timeout: 15_000 });
    }
    const binding = this.input!.runtimeBindings; const conditions = this.authority!.bindings[0].conditions;
    await this.freeze.getByLabel(/^(Training sample cutoff \(with time zone\)|训练样本截止时间（带时区）)$/, { exact: true }).fill(binding.trainingBefore!);
    await this.freeze.getByLabel(/^(Holdout sample start \(with time zone\)|留出样本起始时间（带时区）)$/, { exact: true }).fill(binding.holdoutFrom!);
    await this.freeze.getByRole('combobox', { name: /^(Shared read mode for all arms|各评测组共同读取模式)$/, exact: true }).selectOption('authoritative');
    await this.localDate(this.freeze.getByLabel(/^(Valid time \(local time\)|有效时间（本地时间）)$/, { exact: true }), conditions.validAt);
    await this.localDate(this.freeze.getByLabel(/^(Known time \(local time\)|已知时间（本地时间）)$/, { exact: true }), conditions.knownAt);
    await this.freeze.getByRole('button', { name: /^(Add criterion|添加判据)$/, exact: true }).click();
    await this.freeze.getByRole('combobox', { name: /^(Criterion type|判据类型)$/, exact: true }).selectOption('no_dangerous_effect');
    await this.budget(this.freeze);
    equal(await this.query('suite_creation_context', this.context!.branch), this.context, 'unchanged freeze context after registration');
    return this.evidence();
  }
  private async readSuite(result: unknown) {
    const reference = this.input!.runtimeBindings.suite!; equal(result, { suite: reference }, 'frozen exact suite from original operation');
    const suite = await this.query<Suite>('frozen_suite', reference);
    const plans: Selection[] = arms.map(kind => { const binding = this.authority!.bindings.find(item => item.arm.kind === kind)!; return { arm: { kind }, plan: kind === 'candidate' ? { kind: 'strategy', reference: binding.plan.strategy } : { kind: 'frozen', reference: binding.plan } }; });
    const { frozenAt, frozenBy, ...contract } = suite;
    timestamp(frozenAt, 'actual suite freeze'); if (typeof frozenBy !== 'string' || !frozenBy) throw new Error('Frozen suite omitted actual actor');
    equal(contract, { ...reference, taskId: this.task!.id, taskRevision: this.task!.revision, tests: this.tests.map(test => ({ id: test.id, revision: test.revision })), protectedCounterexamples: [], trainingBefore: timestamp(this.input!.runtimeBindings.trainingBefore, 'training cutoff'), holdoutFrom: timestamp(this.input!.runtimeBindings.holdoutFrom, 'holdout start'), arms: arms.map(kind => ({ kind })), plans, conditions: this.authority!.bindings[0].conditions, acceptance: [{ kind: 'no_dangerous_effect' }] }, 'complete first frozen four-arm Suite');
    this.suite = suite;
    for (const selection of suite.plans) {
      const binding = this.authority!.bindings.find(item => item.arm.kind === selection.arm.kind)!;
      const definitions: Definition[] = [];
      for (const expected of binding.plan.definitions) {
        const definition = selection.plan.kind === 'strategy' ? await this.query<Definition>('definition', { reference: expected.reference }) : (selection.plan.reference as Plan).definitions.find(item => isDeepStrictEqual(item.reference, expected.reference));
        equal(definition, expected, `${selection.arm.kind} complete selected definition at suite freeze`);
        definitions.push(definition!);
      }
      this.selectedPlans.push({ selection, definitions });
    }
  }
  async fillEvaluation() {
    if (this.phase !== 'suite-frozen') throw new Error('Evaluation requires the exact confirmed frozen suite');
    equal(await this.query('suite_creation_context', this.context!.branch), this.context, 'current exact execution context');
    for (const key of ['policyEpoch', 'grantEpoch', 'toolLock', 'dataDigest'] as const) equal(this.suite!.conditions[key], this.context![key], `original frozen suite still has current ${key}`);
    await this.validateAuthority();
    await this.management.getByRole('button', { name: /^(Refresh catalog|刷新目录)$/, exact: true }).click();
    const suite = this.input!.runtimeBindings.suite!;
    await this.selectCatalog(this.management.getByRole('combobox', { name: /^(Frozen suite and revision|冻结套件与修订)$/, exact: true }), /^(First suites|套件首页)$/, /^(Next suites|下一页套件)$/, `${suite.id}:${suite.revision}`);
    const form = this.management.locator('form').first();
    const execution = form.locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(Execution budget|执行预算)$/ }) }); await this.open(execution);
    await this.budget(form);
    equal(await this.query('task_contract', { world, id: this.original!.id, revision: this.original!.revision }), this.original, 'original r1 still unchanged before execution');
    equal(await this.query('frozen_suite', suite), this.suite, 'same immutable suite before one execution');
    const branches = (await this.catalog<Branch>('branches')).filter(branch => branch.id === this.context!.branch.id);
    if (branches.length !== 1) throw new Error('Execution requires one exact public branch');
    equal(branches[0], this.branch, 'same complete public branch and original basis immediately before execution');
    this.preExecutionBranch = branches[0];
    this.preExecutionBasisDigest = digest(branches[0].basis);
    return this.evidence();
  }
  private async readReport(summary: EvaluationSummary, runId: string | null) {
    const suite = this.suite!;
    if (!runId || typeof runId !== 'string' || !runId.trim()) throw new Error('Original evaluation operation does not disclose runId; cannot prove run ownership');
    object(summary, 'original operation evaluation summary');
    equal(summary.world, world, 'original summary World'); equal([summary.suiteId, summary.suiteRevision], [suite.id, suite.revision], 'original summary exact suite revision');
    if (typeof summary.id !== 'string' || !summary.id.trim()) throw new Error('Original evaluation summary omitted the real report identity');
    const report = await this.query<Report>('evaluation', { id: summary.id });
    equal(summary, { world: report.world, id: report.id, candidateId: report.candidateId, suiteId: report.suiteId, suiteRevision: report.suiteRevision,
      execution: report.execution.kind, verdict: report.verdict, assurance: report.assurance, usage: report.usage, completedAt: report.completedAt }, 'all public summary fields exactly project the full report');
    equal(report.world, world, 'report World'); equal([report.suiteId, report.suiteRevision], [suite.id, suite.revision], 'report exact suite revision');
    if (!report.id || !report.candidateId || !report.basisDigest) throw new Error('Report omitted real evaluation/candidate/basis identity');
    if (!this.preExecutionBranch || !this.preExecutionBasisDigest) throw new Error('Report has no independently observed pre-execution public branch basis');
    equal(report.basisDigest, this.preExecutionBasisDigest, 'report exact independent pre-execution complete BranchBasis digest');
    equal(report.execution.kind, 'completed', 'report execution completion, not verdict laundering');
    equal(report.coverage, { tested: '8', total: '8', missingTests: [], missingSources: [], assumptionsUsed: false }, 'eight tests covered by every arm');
    equal(report.cases.length, 32, 'four-arm eight-case cross product');
    const identities = new Set<string>();
    for (const evaluation of report.cases) {
      const test = this.tests.find(item => isDeepStrictEqual({ id: item.id, revision: item.revision }, evaluation.test));
      if (!test || !arms.includes(evaluation.arm.kind)) throw new Error('Report contains a foreign test or arm');
      const identity = `${evaluation.arm.kind}:${test.id}:${test.revision}`; if (identities.has(identity)) throw new Error('Repeated report case/arm'); identities.add(identity);
      equal(evaluation.execution.kind, 'completed', 'real case execution');
      if (!evaluation.observed || typeof evaluation.observed.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evaluation.observed.digest)) throw new Error('Case has no actual sealed observed output');
      const authored = this.input!.cases.find(item => this.input!.runtimeBindings.testCaseReferences![item.authorKey].id === test.id)!;
      equal(evaluation.oraclePassed, evaluation.arm.kind === 'tool_memory' ? authored.expected.value === '5997' : true, 'independent Oracle result, preserving all seven constant-memory failures');
    }
    for (const arm of arms) for (const split of ['train', 'holdout']) {
      const cases = report.cases.filter(item => item.arm.kind === arm && this.tests.find(test => test.id === item.test.id)?.split === split);
      equal(cases.length, 4, `${arm} ${split} coverage`);
      if (!report.arms.some(item => item.arm.kind === arm && item.split === split)) throw new Error('Report omitted split-specific arm metrics');
    }
    // The report has no Task/branch/run fields: identity comes from this original test_branch receipt and exact suite, never fabricated report properties.
    equal(this.lastReceipt!.progress.runId, runId, 'original operation runId');
    equal(await this.query('task_contract', { world, id: suite.taskId, revision: suite.taskRevision }), this.task, 'report/suite exact arithmetic Task');
    // begin_testing advances the current revision; the public catalog observation is not the private execution's Testing revision.
    const branches = (await this.catalog<Branch>('branches')).filter(branch => branch.id === this.preExecutionBranch!.id);
    if (branches.length !== 1) throw new Error('Original evaluated branch is not uniquely public after execution');
    const current = branches[0];
    reference({ world, id: current.id, revision: current.revision }, 'post-execution current branch');
    if (BigInt(current.revision) < BigInt(this.preExecutionBranch.revision)) throw new Error('Original public branch revision regressed after execution');
    equal(current.baseRelease, this.preExecutionBranch.baseRelease, 'original evaluated branch base Release');
    equal(current.basis, this.preExecutionBranch.basis, 'original complete evaluated branch basis unchanged after execution');
    this.postExecutionBranch = current;
    equal(await this.query('task_contract', { world, id: this.original!.id, revision: this.original!.revision }), this.original, 'original field-Oracle Task unchanged after evaluation');
    this.report = report;
  }
  async showReport() {
    if (this.phase !== 'report-confirmed' || !this.report) throw new Error('Only the original completed report may be opened');
    await this.workspace.getByRole('button', { name: /^(Hide evaluation actions|收起评测操作)$/, exact: true }).click();
    const button = this.workspace.locator('button').filter({ has: this.electron.page.locator('span').filter({ hasText: this.report.id }) });
    if (await button.count() !== 1) throw new Error('Exact original report is not reachable in the current UI report catalog; no fabricated DOM or substitute report');
    await button.click();
    const article = this.workspace.locator('article.world-document'); await article.waitFor({ state: 'visible', timeout: 15_000 });
    await this.open(article.locator('details').last());
    const text = await article.innerText();
    for (const value of [this.report.id, this.report.candidateId, this.report.suiteId, this.report.suiteRevision, ...this.tests.map(test => test.id)]) if (!text.includes(value)) throw new Error('Rendered report omitted its exact identity or a registered case');
    const rows = article.locator('table').nth(3).locator('tbody tr'); equal(await rows.count(), 32, 'UI report all actual case/arm rows');
    this.phase = 'report-rendered'; return this.evidence();
  }
  evidence() {
    const planWitnesses = this.authority?.bindings.map(binding => {
      const selected = this.selectedPlans.find(item => item.selection.arm.kind === binding.arm.kind);
      const definitions = selected?.definitions ?? binding.plan.definitions;
      const owner = definitions.find(definition => isDeepStrictEqual(definition.reference, binding.plan.strategy))!;
      const selection = selected?.selection.plan ?? (binding.arm.kind === 'candidate' ? { kind: 'strategy', reference: binding.plan.strategy } : { kind: 'frozen', reference: binding.plan });
      return { suite: this.input!.runtimeBindings.suite, arm: binding.arm, selection, plan: binding.plan, conditions: binding.conditions,
        identitySource: selected ? 'public FrozenSuite selection and exact public candidate or frozen inline definitions' : 'consumer preflight assembly; not yet confirmed by suite freeze',
        consumerStaticIdentityChecked: Boolean(selected),
        executionPlanDigest: binding.arm.kind === 'candidate' ? digest(['world.strategy.execution-plan.v1', owner.reference, owner.contentDigest, owner.body]) : digest(['world.frozen-strategy.execution-plan.v1', selection.reference, binding.conditions]),
        frozenArmDigest: digest(['world.frozen-arm.v1', selection, binding.conditions]), definitions,
        expectedTarget: binding.expectedFunction, oracleFunctionIdentityProven: false };
    }) ?? [];
    const execution = this.custody.find(item => item.kind === 'evaluation');
    return { phase: this.phase, blocker: this.blocker, world, custodyPath, custodyBlocked: this.custodyBlocked, inputSha256: this.inputSha256, originalSha256: this.originalSha256, templatesSha256: this.templatesSha256,
      preparedAt: this.preparedAt, provenance: 'synthetic mathematical examples; occurredAt records first UI preparation, not real order observations',
      runtimeBindings: this.input?.runtimeBindings ?? null, planWitnesses, oracleFunctionIdentityProven: false,
      independentMathematicalOracle: { method: 'consumer BigInt multiplication over frozen authored fixture integers; distinct from Host Oracle verdicts', cases: this.input?.cases ?? [] },
      hostExecutionBinding: { source: 'original UI operation status/result, exact public report/suite and independently digested public branch basis; observed bytes/rawTrace not publicly read',
        operationId: execution?.operationId ?? null, runId: execution?.runId ?? null, report: this.report ?? null,
        preExecutionBranch: this.preExecutionBranch ?? null, preExecutionBasisDigest: this.preExecutionBasisDigest,
        postExecutionCurrentBranch: this.postExecutionBranch ?? null, testingBranchRevision: null, observedBytesRead: false, rawTraceFieldsVerified: false },
      task: this.task ? { world, id: this.task.id, revision: this.task.revision } : null, branch: this.context?.branch ?? null,
      suite: this.suite ? { world, id: this.suite.id, revision: this.suite.revision } : null, frozenSuite: this.suite ?? null, suiteDigest: this.suite ? digest(this.suite) : null,
      reportId: this.report?.id ?? null, candidateId: this.report?.candidateId ?? null, registered: this.tests.length, registrationsVerified: this.registrationsVerified,
      train: this.tests.filter(test => test.split === 'train').length, holdout: this.tests.filter(test => test.split === 'holdout').length,
      memoryFailures: this.report?.cases.filter(item => item.arm.kind === 'tool_memory' && item.oraclePassed === false).length ?? 0,
      custody: this.custody.map(item => ({ ...item })), mayLeave: !this.custodyBlocked && this.custody.every(item => item.outcome === 'confirmed'), baselineEffectProven: false };
  }
  async preserve() {
    // Disposing a read-only listener never clears or retries the production request/operation custody.
    await this.releaseObservation();
    // No deletes, aborts, retries, grants, installs or recovery: unresolved original production custody stays on its original scene.
    if (!this.evidence().mayLeave) return this.evidence();
    if (this.original) equal(await this.query('task_contract', { world, id: this.original.id, revision: this.original.revision }), this.original, 'cleanup preserves original r1 Task');
    return this.evidence();
  }
}
