import { Ability } from '@serenity-js/core';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

type World = { tenantId: string; worldId: string };
type Reference = { world: World; id: string; revision: string };
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type Definition = { reference: Reference; body: { kind: string; body: Record<string, unknown> }; [key: string]: unknown };
type ValueType = { kind: string; maxItems?: number; maxLength?: number; typeId?: string; currency?: string; unit?: Json; calendar?: string; element?: ValueType; fields?: { name: string; valueType: ValueType; nullable: boolean; optional: boolean }[] };
type Value = { kind: string; value?: string | boolean; id?: string; amount?: string; currency?: string; unit?: Json; calendar?: string; milliseconds?: string; items?: Value[]; fields?: Record<string, Value> };
type Argument = { parameterId: string; value: Value };
type Contract = { parameters: { id: string; valueType: ValueType; nullable: boolean; optional: boolean }[]; targets: unknown[]; effects: Json[]; approval: string; idempotency: string; sourceOperation: { binding: Reference; resource: string; mutation: Json }; verifier: { query: { limit: number }; expected: Json; requireAuthoritative: boolean; maximumAttempts: number } };
type Target = { object: { world: World; id: string; typeId: string }; fields: Json[] };
type Input = {
  submittable: boolean; world: World;
  plan: { action: Definition; objectType: Definition; sourceBinding: Definition; target: Target; arguments: Argument[]; targets: { kind: 'object'; id: string }[]; approvalExpiresAt: string; idempotency: { kind: 'ui_generated_once' } } | null;
  effectAuthorization: { authorized: boolean; action: Reference; targets: unknown[]; arguments: Argument[]; effects: Json[]; sourceOperation: unknown; sourceId: string; maximumSubmissions: number; idempotency: { kind: 'ui_generated_once' } } | null;
  verifier: { independent: boolean; query: unknown; expected: Json; sourceIds: string[]; expectedRows: Json[] } | null;
};
type Description = { world: World; status: string; incarnation: string; activeRelease: string; editingContext: { activationLock: { id: string }; definitions: Definition[] } | null };
type Failure = { code: string; stage: string; diagnosticId: string };
type SourceReceipt = { id: string; intentId: string; sourceId: string; disposition: string; observedAt: string };
type ReadReceipt = { world: World; id: string; branchId: string | null; releaseId: string; activationLockId: string; queryDigest: string; requestedMode: { kind: string }; coverage: { complete: boolean; missingSources: unknown[]; missingFields: unknown[]; gapSources: unknown[] }; basis: { sourceId: string; guarantee: string; gap: unknown }[]; dirty: unknown[]; truncation: unknown; observedAt: string; actualDependencies: unknown[] };
type Status = { operationId: string; runId: string; phase: string; sourceReceipts: SourceReceipt[]; verifications: { id: string; intentId: string; verdict: string; readReceipt: ReadReceipt; verifiedAt: string }[]; failure: Failure | null; [key: string]: unknown };
type Proposal = { id: string; digest: string; request: unknown; preconditions: string[]; activationLockId: string; impact: { digest: string }; expiresAt: string; [key: string]: unknown };
type Approval = { approvalId: string; actionDigest: string; impactDigest: string; contract: Reference; expiresAt: string };
type Receipt = { accepted: { world: World; operationId: string; incarnation: string }; disclosure: { kind: string }; phase: string; progress: { runId: string | null }; result: { kind: string; result: unknown } | null; effects: SourceReceipt[]; failure: Failure | null };
type Command = 'proposal' | 'approval' | 'action';
type Custody = { kind: Command; operationId: string | null; outcome: string };
type Observation = { ids: string[]; error?: string; dispose(): void };
type Locator = ReturnType<UseElectron['page']['locator']>;
type FieldAction = { kind: 'fill' | 'select' | 'add'; name: string; value: string };
const world: World = { tenantId: 'local', worldId: 'personal' };
const terminal = ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'effect_indeterminate', 'commit_indeterminate', 'retained'];
function exact(actual: unknown, expected: unknown, label: string) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World actions ${label} differs from the exact public original`);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function requirePublic(value: unknown): void {
  if (typeof value === 'string' && /(?:postgres(?:ql)?:\/\/[^\s]*@|Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----)/i.test(value)) throw new Error('World action input must not contain credentials');
  if (Array.isArray(value)) { value.forEach(requirePublic); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/^(?:connectionString|password|apiKey|accessToken|refreshToken|privateKey|privateCause|stack|backtrace)$/i.test(key)) throw new Error('World actions accepts public input only');
    requirePublic(item);
  }
}
function reference(value: Reference, label: string) {
  if (!value || typeof value.id !== 'string' || !value.id.trim() || !/^[1-9]\d*$/.test(value.revision)) throw new Error(`Missing exact ${label} reference`);
  exact(value.world, world, `${label} World`);
}

export class WorldActions extends Ability {
  private input?: Input;
  private baseline?: Description;
  private fields: FieldAction[] = [];
  private proposal?: Proposal;
  private approval?: Approval;
  private status?: Status;
  private identity?: { world: World; proposalId: string; proposalDigest: string; idempotencyKey: string; approval: Approval };
  private basisId?: string;
  private readonly custody: Custody[] = [];
  private phase = 'idle';
  private blocker: string | null = null;
  private inputSha256: string | null = null;
  private verifiedReadId: string | null = null;
  private observation?: { read(): Promise<{ ids: string[]; error?: string }>; dispose(): Promise<void> };
  constructor(private readonly electron: UseElectron) { super(); }
  private get workspace() { return this.electron.page.locator('main .world-workspace'); }
  private get actions() { return this.workspace.getByRole('tabpanel', { name: /^(Business actions|业务操作)$/, exact: true }); }
  private contract() { return this.input!.plan!.action.body.body as unknown as Contract; }
  private async read<T>(endpoint: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${endpoint}`, method: 'POST', timeoutMs: 10_000,
      body: endpoint === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World actions ${kind}: transport=${reply.error.code}; original request retained`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: Failure };
    requirePublic(body);
    if (!body?.success || !reply.data.ok || reply.data.status !== 200 || body.data?.kind !== kind) {
      throw new Error(`World actions ${kind}: code=${body?.error?.code ?? 'invalid-public-result'}; stage=${body?.error?.stage ?? 'read'}; diagnosticId=${body?.error?.diagnosticId ?? 'not-disclosed'}; no mutation replayed`);
    }
    return body.data.result;
  }

  async prepare() {
    if (this.phase !== 'idle') throw new Error('World action input cannot be replaced or replayed in this worker');
    this.phase = 'preflight';
    try {
      const path = process.env.E2E_WORLD_ACTION_INPUT;
      if (!path?.trim()) throw new Error('E2E_WORLD_ACTION_INPUT is unbound: provide an explicit public scratch JSON with a legal action, target, parameters, one-shot effect authorization and independent Verifier; stopped before any proposal');
      const file = await realpath(resolve(repositoryRoot, path));
      const within = relative(await realpath(resolve(repositoryRoot, '.scratch')), file);
      if (!within || within.startsWith('..') || isAbsolute(within) || !file.endsWith('.json') || /(?:^|[\\/])(?:\.profiles?|secrets?)(?:[\\/]|$)/i.test(file)) throw new Error('World actions accepts only a public JSON within repository scratch, never Profile or secrets');
      const bytes = await readFile(file);
      this.inputSha256 = createHash('sha256').update(bytes).digest('hex');
      let input: Input;
      try { input = JSON.parse(bytes.toString('utf8')) as Input; }
      catch { throw new Error('World action public input is not valid JSON; contents are not disclosed'); }
      requirePublic(input);
      this.input = input;
      if (input?.submittable !== true || !input.plan || input.effectAuthorization?.authorized !== true || input.verifier?.independent !== true) throw new Error('World action binding remains false/null or lacks legal effect authorization/independent Verifier; unchanged input retained, stopped before any proposal');
      exact(input.world, world, 'input World');
      const plan = input.plan; const authority = input.effectAuthorization; const verifier = input.verifier;
      reference(plan.action.reference, 'Action'); reference(plan.objectType.reference, 'ObjectType'); reference(plan.sourceBinding.reference, 'SourceBinding');
      exact([plan.action.body.kind, plan.objectType.body.kind, plan.sourceBinding.body.kind], ['action_contract', 'object_type', 'source_binding'], 'complete definition kinds');
      exact(plan.target.object.world, world, 'target World');
      exact(plan.target.object.typeId, plan.objectType.reference.id, 'target type');
      if (typeof plan.target.object.id !== 'string' || !plan.target.object.id.trim() || !Array.isArray(plan.target.fields) || !Array.isArray(plan.arguments)) throw new Error('Exact target and parameter originals are missing');
      const contract = this.contract();
      if (!Array.isArray(contract.parameters) || !Array.isArray(contract.targets) || !contract.targets.length || !Array.isArray(contract.effects) || !contract.effects.length || contract.approval === 'none') throw new Error('D requires a real targeted effect and an in-app approval contract, not a read-only/no-approval substitute');
      exact(plan.idempotency, { kind: 'ui_generated_once' }, 'UI-owned idempotency allocation; no key injection');
      exact(authority, { authorized: true, action: plan.action.reference, targets: plan.targets, arguments: plan.arguments, effects: contract.effects,
        sourceOperation: contract.sourceOperation, sourceId: authority.sourceId, maximumSubmissions: 1, idempotency: plan.idempotency }, 'single-effect permission declaration (not server admission)');
      if (typeof authority.sourceId !== 'string' || !authority.sourceId.trim()) throw new Error('A legal Source identity is required');
      exact(contract.sourceOperation.binding, plan.sourceBinding.reference, 'Source operation binding');
      exact(plan.sourceBinding.body.body.sourceId, authority.sourceId, 'public Source identity');
      exact([verifier.query, verifier.expected], [contract.verifier.query, contract.verifier.expected], 'independent Verifier contract');
      if (!Array.isArray(verifier.sourceIds) || !verifier.sourceIds.length || new Set(verifier.sourceIds).size !== verifier.sourceIds.length || !verifier.sourceIds.every(id => typeof id === 'string' && id.trim()) || !Array.isArray(verifier.expectedRows) || !verifier.expectedRows.length) throw new Error('Independent public Verifier source identities and expected rows are unbound');
      if (!Number.isInteger(contract.verifier.query.limit) || contract.verifier.query.limit < 1 || contract.verifier.query.limit > 1000 || contract.verifier.maximumAttempts < 1) throw new Error('Invalid real Verifier limits');
      if (typeof plan.approvalExpiresAt !== 'string' || !Number.isFinite(Date.parse(plan.approvalExpiresAt)) || Date.parse(plan.approvalExpiresAt) <= Date.now()) throw new Error('A truthful future approval expiry is required; no expiry is fabricated');
      const names = new Set<string>();
      for (const parameter of contract.parameters) {
        if (names.has(parameter.id)) throw new Error('Duplicate action parameter declaration');
        names.add(parameter.id);
        const matches = plan.arguments.filter(argument => argument.parameterId === parameter.id);
        if (matches.length > 1 || (!parameter.optional && !matches.length)) throw new Error('Missing or repeated exact action argument');
        this.planValue(parameter.id, parameter.valueType, matches[0]?.value, parameter.nullable, parameter.optional);
      }
      if (plan.arguments.some(argument => !names.has(argument.parameterId))) throw new Error('Undeclared action argument');
      exact(plan.arguments.map(argument => argument.parameterId), contract.parameters.filter(parameter => plan.arguments.some(argument => argument.parameterId === parameter.id)).map(parameter => parameter.id), 'UI argument order');
      exact(plan.targets, [...new Set(plan.arguments.flatMap(argument => argument.value.kind === 'object' ? [argument.value.id] : []))].map(id => ({ kind: 'object', id })), 'actual UI target derivation');
      if (!plan.targets.some(target => target.id === plan.target.object.id)) throw new Error('The current object must be a declared action target');
      this.phase = 'input-bound';
    } catch (error) {
      this.phase = 'blocked-before-write';
      this.blocker = error instanceof Error ? error.message : 'Invalid public action input';
      throw error;
    }
    return this.evidence();
  }

  private planValue(name: string, type: ValueType, value: Value | undefined, nullable = false, optional = false, depth = 0): void {
    if (depth > 12 || !type || !['null', 'boolean', 'integer', 'decimal', 'money', 'quantity', 'text', 'timestamp', 'date', 'duration', 'object', 'relation', 'list', 'record'].includes(type.kind)) throw new Error('Action parameter exceeds the real form boundary');
    if (value === undefined) {
      if (!optional) throw new Error('Required action value is missing');
      this.fields.push({ kind: 'select', name: `${name}.mode`, value: 'omit' }); return;
    }
    if (nullable || optional) this.fields.push({ kind: 'select', name: `${name}.mode`, value: value.kind === 'null' && nullable ? 'null' : 'value' });
    if (value.kind === 'null' && nullable) { exact(value, { kind: 'null' }, 'explicit null argument'); return; }
    exact(value.kind, type.kind, 'argument type');
    if (type.kind === 'record') {
      if (!value.fields || !Array.isArray(type.fields) || Object.keys(value.fields).some(key => !type.fields!.some(field => field.name === key))) throw new Error('Invalid exact record argument');
      for (const field of type.fields) this.planValue(`${name}.${field.name}`, field.valueType, value.fields[field.name], field.nullable, field.optional, depth + 1);
      return;
    }
    if (type.kind === 'list') {
      if (!Array.isArray(value.items) || !type.element || value.items.length > Math.min(type.maxItems ?? 0, 100)) throw new Error('List argument exceeds the real UI limit');
      value.items.forEach((item, index) => { this.fields.push({ kind: 'add', name, value: '' }); this.planValue(`${name}.${index}`, type.element!, item, false, false, depth + 1); }); return;
    }
    if (type.kind === 'null') { exact(value, { kind: 'null' }, 'null argument'); return; }
    let text: string;
    switch (type.kind) {
      case 'boolean': if (typeof value.value !== 'boolean') throw new Error('Invalid boolean argument'); text = String(value.value); break;
      case 'object': case 'relation': if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('Missing subject identity'); text = value.id; break;
      case 'money': exact(value.currency, type.currency, 'money currency'); text = value.amount!; break;
      case 'quantity': exact(value.unit, type.unit, 'quantity unit'); text = value.amount!; break;
      case 'duration': text = value.milliseconds!; break;
      case 'date': exact(value.calendar, type.calendar, 'date calendar'); text = value.value as string; break;
      default: text = value.value as string;
    }
    if (typeof text !== 'string' || (type.kind === 'integer' && !/^-?(0|[1-9]\d*)$/.test(text)) || (type.kind === 'duration' && !/^(0|[1-9]\d*)$/.test(text))
      || (['money', 'quantity', 'decimal'].includes(type.kind) && !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text))
      || (type.kind === 'text' && text.length > (type.maxLength ?? 0)) || (type.kind === 'timestamp' && !Number.isFinite(Date.parse(text)))) throw new Error('Invalid exact scalar argument');
    if (type.kind === 'object' && text !== this.input!.plan!.target.object.id) throw new Error('Only the explicitly bound current object may be selected');
    this.fields.push({ kind: ['object', 'boolean'].includes(type.kind) ? 'select' : 'fill', name, value: text });
  }

  async inspectPrerequisites() {
    if (this.phase !== 'input-bound') throw new Error('No complete legal action input; no proposal permitted');
    const description = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact(description.world, world, 'discovered World');
    if (description.status !== 'ready' || !description.editingContext || !/^[1-9]\d*$/.test(description.incarnation)) throw new Error('The existing World is not ready');
    for (const original of [this.input!.plan!.action, this.input!.plan!.objectType, this.input!.plan!.sourceBinding]) {
      exact(await this.read('query', 'definition', { reference: original.reference }), original, 'complete immutable definition');
      exact(description.editingContext.definitions.find(item => isDeepStrictEqual(item.reference, original.reference)), original, 'active public definition');
    }
    const plan = this.input!.plan!;
    const prior = (await this.proposals()).filter(item => {
      const request = item.request as { world: World; action: Reference; arguments: Argument[]; targets: unknown[] };
      return isDeepStrictEqual([request.world, request.action, request.arguments, request.targets], [world, plan.action.reference, plan.arguments, plan.targets]);
    });
    if (prior.length) throw new Error('An exact prior proposal already exists for this one-shot input; retain its custody, do not invent a fresh idempotency key or replay the effect');
    this.baseline = description;
    this.phase = 'ready';
    return this.evidence();
  }

  private async open(details: Locator) { if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click(); }
  private async rendered(element: Locator, value: unknown): Promise<void> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      exact(await element.locator(':scope > dl > div > dt').allTextContents(), entries.map(([key]) => key), 'complete rendered record keys');
      for (let index = 0; index < entries.length; index++) await this.rendered(element.locator(':scope > dl > div > dd').nth(index), entries[index][1]);
    } else if (Array.isArray(value) && value.length) {
      exact(await element.locator(':scope > ol > li').count(), value.length, 'rendered array length');
      for (let index = 0; index < value.length; index++) await this.rendered(element.locator(':scope > ol > li').nth(index), value[index]);
    } else {
      const text = (await element.innerText()).trim();
      if (value == null ? !/^(Not set|未设置)$/.test(text) : Array.isArray(value) ? !/^(None|无)$/.test(text) : text !== String(value)) throw new Error('World action rendered record differs from its unchanged public original');
    }
  }
  private detail(summary: RegExp) { return this.actions.locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: summary }) }); }
  private async localDate(control: Locator, value: string) {
    const local = await this.electron.page.evaluate(value => { const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`; }, value);
    await control.fill(local);
    exact(await control.evaluate(element => new Date((element as HTMLInputElement).value).toISOString()), new Date(value).toISOString(), 'unchanged UI timestamp');
  }

  async chooseTarget() {
    if (this.phase !== 'ready') throw new Error('Target selection requires checked public prerequisites');
    const plan = this.input!.plan!;
    const data = this.workspace.getByRole('tabpanel', { name: /^(Browse data|数据浏览)$/, exact: true });
    await data.getByRole('button', { name: /^(Explore objects|探索对象)$/, exact: true }).click();
    const name = typeof plan.objectType.body.body.name === 'string' ? plan.objectType.body.body.name : plan.objectType.reference.id;
    await data.locator('.world-type-rail .world-type-button').filter({ hasText: name }).click();
    const target = data.locator('.world-object-main button[title]').filter({ hasText: plan.target.object.id });
    await target.waitFor({ state: 'visible', timeout: 15_000 });
    exact(await target.getAttribute('title'), plan.target.object.id, 'current UI object identity');
    await target.click();
    const document = data.locator('article.world-object-document');
    exact(await document.locator('header code[title]').getAttribute('title'), plan.target.object.id, 'selected current target');
    const details = document.locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(Read receipt and coverage|读取回执与覆盖范围)$/ }) });
    await this.open(details);
    const receiptId = (await details.locator(':scope > div > p').first().innerText()).trim();
    if (!receiptId) throw new Error('Real UI target read receipt is missing');
    const properties = plan.objectType.body.body.properties as Reference[];
    if (!Array.isArray(properties)) throw new Error('ObjectType omits its exact property declarations');
    const page = await this.read<{ objects: (Target & { receiptId: string })[]; receipt: ReadReceipt }>('query', 'objects', {
      world, branchId: null, releaseId: null, query: { root: { kind: 'objects', typeRef: plan.objectType.reference, symbol: 'item' }, parameters: [], limit: 100,
        output: properties.map(property => ({ name: property.id, expression: { kind: 'field', subject: 'item', property } })) },
      arguments: [], readMode: { kind: 'authoritative' }, validAt: null, knownAt: null, page: { limit: 100, cursor: null },
    });
    const actual = page.objects.find(item => item.object.id === plan.target.object.id);
    if (!actual) throw new Error('Exact current target is absent from the independently read first UI page; no substitute or target creation');
    exact({ object: actual.object, fields: actual.fields }, plan.target, 'complete public target original');
    this.checkRead(page.receipt, []);
    await document.getByRole('button', { name: /^(Business actions|业务操作)$/, exact: true }).click();
    await this.actions.waitFor({ state: 'visible', timeout: 15_000 });
    await this.actions.getByRole('button', { name: /^(Start an action|发起操作)$/, exact: true }).click();
    await this.actions.getByRole('combobox', { name: /^(Action|操作)$/, exact: true }).selectOption(plan.action.reference.id);
    const contract = this.detail(/^(Execution contract|执行契约)$/);
    await this.open(contract); await this.rendered(contract.locator(':scope > div'), this.contract());
    exact((await this.actions.locator('aside.world-detail-panel > section').first().locator('.world-panel-body > div > p.font-mono').allTextContents()).map(text => text.trim()), [receiptId], 'UI retains the actual current target basis');
    this.basisId = receiptId;
    for (const field of this.fields) {
      if (field.kind === 'add') await this.actions.locator(`input[name=${JSON.stringify(`${field.name}.count`)}]`).locator('..').getByRole('button', { name: /^(Add item|添加一项)$/, exact: true }).click();
      else {
        const control = this.actions.locator(`[name=${JSON.stringify(field.name)}]`);
        if (field.kind === 'select') await control.selectOption(field.value);
        else if (await control.getAttribute('type') === 'datetime-local') await this.localDate(control, field.value);
        else await control.fill(field.value);
      }
    }
    this.phase = 'configured';
    return this.evidence();
  }

  async arm(kind: Command) {
    const required = kind === 'proposal' ? 'configured' : kind === 'approval' ? 'proposal-confirmed' : 'approval-confirmed';
    if (this.phase !== required || this.custody.some(item => item.kind === kind || item.outcome !== 'confirmed') || this.observation) throw new Error('Refusing repeated or unresolved World action write');
    const current = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([current.world, current.status, current.incarnation, current.activeRelease, current.editingContext?.activationLock.id], [world, 'ready', this.baseline!.incarnation, this.baseline!.activeRelease, this.baseline!.editingContext!.activationLock.id], 'unchanged action execution basis');
    if (kind !== 'proposal' && (!this.proposal || Date.parse(this.proposal.expiresAt) <= Date.now())) throw new Error('Original proposal has expired; no replacement is generated');
    if (kind === 'approval' && Date.parse(this.input!.plan!.approvalExpiresAt) > Date.parse(this.proposal!.expiresAt)) throw new Error('Bound approval expiry exceeds the real proposal; no expiry is changed');
    if (kind === 'action' && (!this.approval || Date.parse(this.approval.expiresAt) <= Date.now())) throw new Error('Original approval is absent or expired');
    const handle = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
      const state: Observation = { ids: [], dispose: () => undefined };
      const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!record(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !record(value.payload)) return;
        const hint = value.payload;
        if (!record(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') { state.error = 'World action observer lost continuity; preserve original custody without replay'; return; }
        if (!record(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) { if (state.ids.length >= 8) state.error = 'Ambiguous World action operation hints'; else state.ids.push(hint.resource.id); }
      });
      return state;
    }, { world, incarnation: this.baseline!.incarnation });
    this.observation = { read: async () => {
      const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 });
      await ready.dispose(); return handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
    }, dispose: async () => {
      let failure: unknown;
      try { await handle.evaluate(state => state.dispose()); } catch (error) { failure = error; }
      try { await handle.dispose(); } catch (error) { throw new AggregateError(failure === undefined ? [error] : [failure, error], 'World action observer cleanup failed; original custody retained'); }
      if (failure !== undefined) throw failure;
    } };
    this.custody.push({ kind, operationId: null, outcome: 'unconfirmed-original-retained' });
    this.phase = `${kind}-unconfirmed`;
    return this.evidence();
  }

  async confirm(kind: Command) {
    const custody = this.custody.at(-1);
    if (!custody || custody.kind !== kind || custody.outcome === 'confirmed' || !this.observation) throw new Error('No original UI action command is in custody');
    const observed = await this.observation.read();
    if (observed.error) throw new Error(observed.error);
    if (observed.ids.length !== 1) throw new Error('World action hints are ambiguous; no OperationKey is guessed');
    custody.operationId = observed.ids[0];
    if (kind === 'action') await this.readIdentity(custody.operationId);
    const until = Date.now() + (kind === 'action' ? 60_000 : 30_000);
    let receipt: Receipt;
    do {
      receipt = await this.read<Receipt>('operation', 'result', { world, operationId: custody.operationId });
      exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, custody.operationId, this.baseline!.incarnation], 'original event OperationKey');
      if (receipt.failure || terminal.includes(receipt.phase)) break;
      await setTimeout(200);
    } while (Date.now() < until);
    if (receipt.phase !== 'completed' || receipt.disclosure.kind !== 'full' || receipt.failure || receipt.result?.kind !== kind) {
      custody.outcome = receipt.phase === 'failed' ? 'rejected-original-retained' : 'unconfirmed-original-retained';
      throw new Error(`World ${kind} not complete: operation=${custody.operationId}; phase=${receipt.phase}; disclosure=${receipt.disclosure.kind}; code=${receipt.failure?.code ?? 'not-disclosed'}; original custody retained, no resend/reconcile/compensation`);
    }
    if (kind === 'proposal') {
      const proposal = receipt.result.result as Proposal;
      exact(proposal.request, { world, action: this.input!.plan!.action.reference, arguments: this.input!.plan!.arguments, targets: this.input!.plan!.targets, basis: [this.basisId!], branchId: null }, 'whole proposed request');
      exact(proposal.activationLockId, this.baseline!.editingContext!.activationLock.id, 'proposal activation lock');
      if (!proposal.id || !proposal.digest || proposal.preconditions.some(value => value !== 'true')) throw new Error('Original proposal preconditions are false/unknown; no approval or execution permitted');
      exact((await this.proposals()).filter(item => item.id === proposal.id), [proposal], 'independent exact proposal readback');
      exact(receipt.effects, [], 'proposal has no Source effects');
      this.proposal = proposal;
    } else if (kind === 'approval') {
      const approval = receipt.result.result as Approval;
      exact(approval, { approvalId: approval.approvalId, actionDigest: this.proposal!.digest, impactDigest: this.proposal!.impact.digest, contract: this.input!.plan!.action.reference, expiresAt: new Date(this.input!.plan!.approvalExpiresAt).toISOString() }, 'whole original approval binding');
      if (!approval.approvalId) throw new Error('Missing real approval identity');
      exact(receipt.effects, [], 'approval has no Source effects');
      this.approval = approval;
    } else {
      const status = await this.read<Status>('query', 'action_status', { world, operationId: custody.operationId });
      exact(status, receipt.result.result, 'whole independent ActionStatus');
      exact([status.operationId, status.runId, status.phase, status.failure], [custody.operationId, receipt.progress.runId, 'completed', null], 'same completed action/run with no failure');
      if (!status.sourceReceipts.length || status.sourceReceipts.some(item => !item.id || !item.intentId || item.sourceId !== this.input!.effectAuthorization!.sourceId || !['accepted', 'applied'].includes(item.disposition))) throw new Error('Missing causal Source receipt or rejected/unknown effect; accepted alone is never completion');
      exact(receipt.effects, status.sourceReceipts, 'same Operation effect receipts');
      const intents = [...new Set(status.sourceReceipts.map(item => item.intentId))];
      if (intents.length !== 1 || !status.verifications.length) throw new Error('Single actual effect intent and independent verification are required');
      for (const verification of status.verifications) {
        exact([verification.intentId, verification.verdict], [intents[0], 'verified'], 'independent verdict for the same actual intent');
        if (!verification.id || Date.parse(verification.verifiedAt) < Math.min(...status.sourceReceipts.map(item => Date.parse(item.observedAt)))) throw new Error('Verification does not follow the observed effect');
        this.checkRead(verification.readReceipt, this.input!.verifier!.sourceIds);
        if (verification.readReceipt.id === this.basisId!) throw new Error('Target proposal basis is not an independent effect verification');
      }
      this.status = status;
    }
    const after = await this.observation.read();
    exact(after.ids, [custody.operationId], 'single command identity through exact receipt');
    if (after.error) throw new Error(after.error);
    await this.releaseObservation();
    custody.outcome = 'confirmed'; this.phase = `${kind}-confirmed`;
    return this.evidence();
  }

  private async proposals() {
    const items: Proposal[] = []; const seen = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { items: Proposal[]; nextCursor: string | null } = await this.read('query', 'action_proposals', { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error('Invalid public action proposal page');
      items.push(...page.items); cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Action proposal pagination did not terminate');
      if (cursor) seen.add(cursor);
    } while (cursor !== null);
    return items;
  }
  async reviewProposal() {
    if (!this.proposal) throw new Error('No confirmed exact proposal to review');
    const selected = this.actions.locator('aside.world-catalog li button').filter({ has: this.electron.page.locator('span').filter({ hasText: new RegExp(`^${this.proposal.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    if (await selected.getAttribute('aria-pressed') !== 'true') await selected.click();
    const details = this.detail(/^(View action details|查看操作内容)$/); await this.open(details);
    await this.rendered(details.locator(':scope > div'), { request: this.proposal.request, readDependencies: this.proposal.readDependencies, activationLockId: this.proposal.activationLockId });
    const impact = this.detail(/^(Impact|影响范围)$/); await this.open(impact); await this.rendered(impact.locator(':scope > div'), this.proposal.impact);
    await this.localDate(this.actions.locator('input[type="datetime-local"]'), this.input!.plan!.approvalExpiresAt);
    return this.evidence();
  }
  async reviewApproval() {
    if (!this.approval) throw new Error('No confirmed approval binding');
    const check = this.actions.getByRole('button', { name: /^(Check approval result|核对审批结果)$/, exact: true });
    if (await check.count()) await check.click();
    const approval = this.actions.locator('main.world-panel div').filter({ has: this.electron.page.locator(':scope > p[role="status"]') }).locator(':scope > details');
    await approval.locator(':scope > summary').waitFor({ state: 'visible', timeout: 15_000 });
    await this.open(approval); await this.rendered(approval.locator(':scope > div'), this.approval);
    return this.evidence();
  }
  private async readIdentity(operationId: string) {
    const block = this.actions.locator('aside.world-detail-panel div').filter({ has: this.electron.page.locator(':scope > h4').filter({ hasText: /^(Request and idempotency identity|请求与幂等标识)$/ }) });
    const details = block.locator(':scope > details');
    await details.locator(':scope > summary').waitFor({ state: 'visible', timeout: 15_000 }); await this.open(details);
    const root = details.locator(':scope > div');
    const key = (await root.locator(':scope > dl > div').filter({ has: this.electron.page.locator(':scope > dt').filter({ hasText: /^idempotencyKey$/ }) }).locator(':scope > dd').innerText()).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new Error('The original UI-generated idempotency identity is not publicly observable; no key is invented');
    const identity = { world, proposalId: this.proposal!.id, proposalDigest: this.proposal!.digest, idempotencyKey: key, approval: this.approval! };
    if (this.identity) exact(identity, this.identity, 'unchanged original idempotency identity');
    await this.rendered(root, identity); this.identity = identity;
    exact((await this.actions.locator('main.world-panel section button.break-all').allTextContents()).map(text => text.trim()), [operationId], 'UI receipt belongs to the original submission');
  }
  private checkRead(receipt: ReadReceipt, sourceIds: string[]) {
    exact([receipt.world, receipt.branchId, receipt.releaseId, receipt.activationLockId, receipt.requestedMode, receipt.coverage, receipt.dirty, receipt.truncation],
      [world, null, this.baseline!.activeRelease, this.baseline!.editingContext!.activationLock.id, { kind: 'authoritative' }, { ...receipt.coverage, complete: true, missingSources: [], missingFields: [], gapSources: [] }, [], null], 'complete authoritative independent read basis');
    if (!receipt.id || !receipt.actualDependencies.length || receipt.basis.some(item => item.guarantee !== 'authoritative' || item.gap !== null)) throw new Error('Independent read lacks real dependencies or authoritative Source proof');
    if (sourceIds.length) exact([...new Set(receipt.basis.map(item => item.sourceId))].sort(), [...sourceIds].sort(), 'exact independently authorized Verifier Sources');
  }
  async verifyResult() {
    if (this.phase !== 'action-confirmed' || !this.status || !this.identity) throw new Error('Only the same completed action can be independently verified');
    const verifier = this.input!.verifier!;
    const page = await this.read<{ rows: { items: Json[]; nextCursor: string | null }; receipt: ReadReceipt }>('query', 'objects', {
      world, branchId: null, releaseId: this.baseline!.activeRelease, query: verifier.query, arguments: this.input!.plan!.arguments,
      readMode: { kind: 'authoritative' }, validAt: null, knownAt: null, page: { limit: this.contract().verifier.query.limit, cursor: null },
    });
    this.checkRead(page.receipt, verifier.sourceIds);
    exact(page.receipt.queryDigest, digest(['world.query.v1', world, null, this.baseline!.activeRelease, verifier.query, this.input!.plan!.arguments, { kind: 'authoritative' }, null, null]), 'independent expected-result query and exact argument digest');
    exact(page.rows, { items: verifier.expectedRows, nextCursor: null }, 'independent public expected result, never copied from the observed output');
    if (this.status.verifications.some(item => item.readReceipt.id === page.receipt.id) || page.receipt.id === this.basisId!) throw new Error('Expected-result read must be independent of proposal and retained verification reads');
    await this.actions.getByRole('button', { name: /^(Refresh progress|刷新进度)$/, exact: true }).click();
    const receipts = this.actions.locator('aside.world-detail-panel').getByRole('button', { name: /^(Effect & verification receipts|效果与核验依据)$/, exact: true });
    await receipts.waitFor({ state: 'visible', timeout: 15_000 }); await receipts.click();
    const details = this.detail(/^(Advanced reconciliation & compensation|高级核对与补偿)$/); await this.open(details);
    await this.rendered(details.locator(':scope > div'), this.status);
    await this.readIdentity(this.status.operationId);
    if (await this.actions.getByRole('button', { name: /^(Submit proposal|提交提案)$/, exact: true }).isEnabled()) throw new Error('The same proposal remains executable; no second click is attempted');
    this.verifiedReadId = page.receipt.id; this.phase = 'verified';
    return this.evidence();
  }
  private async releaseObservation() { if (this.observation) { await this.observation.dispose(); this.observation = undefined; } }
  async preserve() {
    await this.releaseObservation();
    // Unknown/rejected requests stay on their original page. Never retry, reconcile, compensate or erase history.
    return this.evidence();
  }
  evidence() {
    return { phase: this.phase, blocker: this.blocker, inputSha256: this.inputSha256, custody: this.custody.map(item => ({ ...item })),
      proposalId: this.proposal?.id ?? null, operationId: this.status?.operationId ?? null, idempotencyKey: this.identity?.idempotencyKey ?? null, submission: this.identity ?? null,
      sourceReceipts: this.status?.sourceReceipts ?? [], verifications: this.status?.verifications ?? [], independentReadId: this.verifiedReadId,
      oneSubmission: this.custody.filter(item => item.kind === 'action').length === 1, complete: this.phase === 'verified',
      canLeave: this.phase === 'verified' && this.custody.every(item => item.outcome === 'confirmed') };
  }
}
