import { Ability } from '@serenity-js/core';
import { open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

type World = { tenantId: string; worldId: string };
type Ref = { world: World; id: string; revision: string };
type Value = { kind: string; value?: string | boolean; id?: string; amount?: string; milliseconds?: string; items?: Value[]; fields?: Record<string, Value>; [key: string]: unknown };
type ValueType = { kind: string; typeId?: string; element?: ValueType; maxItems?: number; fields?: { name: string; valueType: ValueType; nullable: boolean; optional: boolean }[]; [key: string]: unknown };
type Expression = { kind: string; [key: string]: unknown };
type Argument = { parameterId: string; value: Value };
type Definition = { reference: Ref; contentDigest: string; dependencies: Ref[]; scope: string; body: { kind: string; body: {
  parameters: { id: string; valueType: ValueType; nullable: boolean; optional: boolean }[];
  effects: string[]; condition: Expression; conclusion: { kind: string; polarity: string; subject: Expression; property: Ref; value: Expression };
} } };
type Step = { entry: 'catalog' | 'candidate'; definition: Definition; arguments: Argument[]; property: Ref; value: Value };
type Mode = { kind: 'authoritative' } | { kind: 'projected'; maxLag: string } | { kind: 'after'; receiptId: string };
type Source = { evidence: Ref; version: { reference: { world: World; sourceId: string; versionId: string }; [key: string]: unknown };
  dependency: { kind: 'source'; binding: Ref; position: { sourceId: string; [key: string]: unknown } };
  parseArtifact?: { id: string; sourceVersion: unknown; [key: string]: unknown } };
type Binding = {
  schemaVersion: 1; world: World; releaseId: string; branch: Ref | null; scope: string;
  authorization: { declared: true; purpose: string };
  validTime: { from: string; to: string | null }; validAt: string; knownAt: string; readMode: Mode;
  subject: { id: string; type: Ref }; p: { property: Ref; value: Value; assertion: Ref };
  q: Step; r: Step; sources: Source[];
  unknown: { subjectId: string; arguments: Argument[]; pReason: string; qReason: string };
};
type Field = { property: Ref; cell: { kind: string; value?: Value; reason?: string }; evidence: Ref[]; dirty: { kind: string } };
type Readback = { object: { world: World; id: string; typeId: string }; fields: Field[]; receiptId: string };
type ReadReceipt = { id: string; world: World; releaseId: string; branchId?: string | null; requestedMode: Mode;
  observedAt: string; actualDependencies: unknown[]; basis: { sourceId: string; [key: string]: unknown }[];
  coverage: { complete: boolean; missingSources: string[]; gapSources: string[]; missingFields: string[] };
  dirty: unknown[]; truncation?: unknown; consistency: string };
type QueryPage = { objects: Readback[]; receipt: ReadReceipt; rows: { nextCursor?: string | null } };
type Description = { world: World; status: string; incarnation: string; activeRelease: string; activeReleaseHead?: { releaseId: string } };
type Branch = { id: string; revision: string; baseRelease: string; basis: { releaseId: string } };
type Failure = { code: string; stage: string; diagnosticId: string };
type Receipt = { accepted: { world: World; operationId: string; incarnation: string }; phase: string; updatedAt: string;
  disclosure: { kind: string }; failure?: Failure | null; effects: unknown[];
  result?: { kind: string; result: { status: string; assertion: Ref | null } } | null };
type Support = { reference: Ref; conclusion: Ref; rule: Ref; arguments: Argument[]; scope: string; validTime: Binding['validTime'];
  releaseId: string; branchId?: string | null; status: string; dirty: { kind: string }; premises: { kind: string; reference: unknown }[] };
type Explanation = { conclusion: Ref; revision: string; supports: Support[]; visibleEvidence: Ref[] };
type Stage = 'q' | 'r' | 'unknown';
type Observer = { ids: string[]; error?: string; dispose: () => void };

function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World PQR ${label} mismatch; no replacement input or mutation replay`);
}
function required(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`World PQR prerequisite: ${label}; no evaluation submitted`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown, label: string): number {
  required(typeof value === 'string' && Number.isFinite(Date.parse(value)), label);
  return Date.parse(value);
}
function reference(value: unknown, world: World, label: string): asserts value is Ref {
  required(record(value) && typeof value.id === 'string' && value.id.trim() && typeof value.revision === 'string' && value.revision.trim(), label);
  exact(value.world, world, `${label} World`);
}
function hasField(value: unknown, property: Ref, subject: string): boolean {
  if (Array.isArray(value)) return value.some(item => hasField(item, property, subject));
  if (!record(value)) return false;
  return value.kind === 'field' && value.subject === subject && isDeepStrictEqual(value.property, property)
    || Object.values(value).some(item => hasField(item, property, subject));
}
function hasCall(value: unknown): boolean {
  return Array.isArray(value) ? value.some(hasCall) : record(value)
    && (value.kind === 'call' || Object.values(value).some(hasCall));
}
function localTime(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}

export class WorldRules extends Ability {
  private binding?: Binding;
  private inputDigest?: string;
  private inputPath?: string;
  private inputText?: string;
  private baseline?: Description;
  private original?: { object: Readback; receipt: ReadReceipt };
  private unknownOriginal?: { object: Readback; receipt: ReadReceipt };
  private attempted = new Set<Stage>();
  private receipts: Partial<Record<Stage, Receipt>> = {};
  private observation?: { stage: Stage; read: () => Promise<{ ids: string[]; error?: string }>; dispose: () => Promise<void> };
  private operationId?: string;
  constructor(private readonly electron: UseElectron) { super(); }

  async loadBinding() {
    required(!this.binding, 'binding is one-shot for this scenario');
    const path = process.env.E2E_WORLD_RULE_INPUT;
    required(typeof path === 'string' && path.trim(), 'E2E_WORLD_RULE_INPUT must explicitly name an authored public .scratch JSON with canonical subjects, exact Rules/branch, source refs, times and authorization declaration');
    const file = await realpath(resolve(repositoryRoot, path));
    const local = relative(await realpath(resolve(repositoryRoot, '.scratch')), file);
    required(local && !isAbsolute(local) && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\')
      && file.endsWith('.json') && !/(?:^|[\\/])(?:\.profiles?|user-data|secrets?)(?:[\\/]|$)/i.test(local), 'binding must be a non-secret public JSON inside repository .scratch, never a Profile');
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { throw new Error('World PQR prerequisite: explicit authored binding is unreadable; no evaluation submitted', { cause: error }); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new Error('World PQR prerequisite: binding is not JSON; no evaluation submitted', { cause: error }); }
    required(record(parsed) && parsed.schemaVersion === 1, 'binding schemaVersion=1');
    required(parsed.execution === undefined || record(parsed.execution) && Object.keys(parsed.execution).length === 0,
      `original input already fences a UI submission; retain its execution/Operation IDs in ${file}, read those exact receipts only, never resubmit`);
    if (record(parsed.producer)) required(record(parsed.subject) && typeof parsed.subject.id === 'string'
      && typeof parsed.releaseId === 'string' && typeof parsed.knownAt === 'string' && Array.isArray(parsed.sources) && parsed.sources.length > 0,
    `source-backed preparation must first populate this original JSON via the normal World source connection → mapping/authority → sync UI: ${String(parsed.producer.sourceRows)}; use the actual SourceVersion, canonical business objects, P assertion, source position, exact model/branch and server knownAt; material parsing calls a model and is not this producer; no account/issuer substitution or identity/DB writes`);
    const b = parsed as unknown as Binding;
    exact(b.world, { tenantId: 'local', worldId: 'personal' }, 'normal workspace entry');
    required(typeof b.releaseId === 'string' && b.releaseId.trim() && typeof b.scope === 'string' && b.scope.trim(), 'explicit release and scope');
    required(Object.hasOwn(b, 'branch'), 'explicit exact branch or null for global, never implicit fallback');
    if (b.branch !== null) reference(b.branch, b.world, 'exact branch');
    required(record(b.authorization) && b.authorization.declared === true && typeof b.authorization.purpose === 'string' && b.authorization.purpose.trim(), 'author authorization declaration (not a server grant; server admission remains authoritative)');
    required(record(b.validTime) && Object.hasOwn(b.validTime, 'to'), 'explicit validTime with nullable end');
    const start = timestamp(b.validTime.from, 'validTime.from');
    const end = b.validTime.to === null ? Infinity : timestamp(b.validTime.to, 'validTime.to');
    const at = timestamp(b.validAt, 'validAt');
    const known = timestamp(b.knownAt, 'knownAt before derivation');
    required(start < end && at >= start && at < end && start <= Date.now() && Date.now() < end && known <= Date.now(), 'valid interval contains validAt and current Explain time; knownAt is an explicit historical source observation');
    required(record(b.readMode) && ['authoritative', 'projected', 'after'].includes(b.readMode.kind), 'explicit public readMode');
    if (b.readMode.kind === 'projected') required(typeof b.readMode.maxLag === 'string' && /^\d+$/.test(b.readMode.maxLag), 'projected maxLag');
    if (b.readMode.kind === 'after') required(typeof b.readMode.receiptId === 'string' && b.readMode.receiptId.trim(), 'after receiptId');
    required(record(b.subject) && typeof b.subject.id === 'string' && b.subject.id.trim(), 'existing canonical PQR subject');
    reference(b.subject.type, b.world, 'subject exact type');
    required(record(b.p) && record(b.p.value), 'original typed P');
    reference(b.p.property, b.world, 'P property'); reference(b.p.assertion, b.world, 'original P assertion');
    required(record(b.q) && record(b.r), 'both authored rule stages');
    this.validateStep(b, b.q, b.p.property, b.subject.id);
    this.validateStep(b, b.r, b.q.property, b.subject.id);
    required(new Set([b.p.property.id, b.q.property.id, b.r.property.id]).size === 3, 'three distinct P/Q/R properties');
    required(Array.isArray(b.sources) && b.sources.length > 0, 'original public SourceVersion/evidence/dependency bindings');
    for (const source of b.sources) {
      reference(source.evidence, b.world, 'original evidence');
      required(record(source.version) && record(source.version.reference), 'full original public SourceVersion');
      exact(source.version.reference.world, b.world, 'SourceVersion World');
      required(typeof source.version.reference.sourceId === 'string' && source.version.reference.sourceId.trim()
        && typeof source.version.reference.versionId === 'string' && source.version.reference.versionId.trim(), 'exact source and version');
      required(record(source.version.blob) && typeof source.version.blob.digest === 'string' && source.version.blob.digest.trim()
        && typeof source.version.mediaType === 'string', 'original source blob digest and mediaType');
      timestamp(source.version.capturedAt, 'source capturedAt');
      required(record(source.dependency) && source.dependency.kind === 'source' && record(source.dependency.position), 'source binding/position dependency');
      reference(source.dependency.binding, b.world, 'source binding');
      exact(source.dependency.position.sourceId, source.version.reference.sourceId, 'source position and original version sourceId');
      if (source.parseArtifact !== undefined) {
        required(record(source.parseArtifact) && typeof source.parseArtifact.id === 'string' && source.parseArtifact.id.trim(), 'exact optional parse artifact');
        exact(source.parseArtifact.sourceVersion, source.version.reference, 'parse artifact original version');
      }
    }
    required(record(b.unknown) && typeof b.unknown.subjectId === 'string' && b.unknown.subjectId.trim()
      && b.unknown.subjectId !== b.subject.id && typeof b.unknown.pReason === 'string' && b.unknown.pReason.trim()
      && typeof b.unknown.qReason === 'string' && b.unknown.qReason.trim(), 'independent existing unknown subject and explicit unknown reasons');
    this.validateStep(b, { ...b.q, arguments: b.unknown.arguments }, b.p.property, b.unknown.subjectId);
    this.binding = b;
    this.inputPath = file;
    this.inputText = text;
    this.inputDigest = createHash('sha256').update(text).digest('hex');
    return { binding: b, inputDigest: this.inputDigest };
  }

  private validateStep(b: Binding, step: Step, premise: Ref, subjectId: string): void {
    required(['catalog', 'candidate'].includes(step.entry) && record(step.definition), 'explicit normal Rule entry and complete original definition');
    const definition = step.definition;
    reference(definition.reference, b.world, 'exact Rule'); reference(step.property, b.world, 'conclusion property');
    required(typeof definition.contentDigest === 'string' && definition.contentDigest.trim()
      && record(definition.body) && definition.body.kind === 'rule' && record(definition.body.body), 'immutable Rule body and digest');
    const rule = definition.body.body;
    required(Array.isArray(rule.parameters) && Array.isArray(rule.effects) && Array.isArray(definition.dependencies)
      && rule.effects.every(effect => ['pure', 'source_read', 'clock_read'].includes(effect))
      && !hasCall(rule), 'no probabilistic/external-write effects or indirect function/model calls');
    required(Array.isArray(step.arguments) && step.arguments.length === rule.parameters.length, 'all exact Known rule arguments, preserving false/null');
    exact(step.arguments.map(argument => argument.parameterId), rule.parameters.map(parameter => parameter.id), 'ordered parameter identities');
    required(record(rule.conclusion) && rule.conclusion.kind === 'attribute' && rule.conclusion.polarity === 'positive'
      && record(rule.conclusion.subject) && rule.conclusion.subject.kind === 'parameter'
      && typeof rule.conclusion.subject.id === 'string', 'real attribute conclusion on an object parameter, never a fabricated subject');
    exact(rule.conclusion.property, step.property, 'authored conclusion property');
    const subject = rule.parameters.find(parameter => parameter.id === rule.conclusion.subject.id);
    required(subject && subject.valueType.kind === 'object' && subject.valueType.typeId === b.subject.type.id, 'typed canonical subject parameter');
    exact(step.arguments.find(argument => argument.parameterId === subject.id)?.value, { kind: 'object', id: subjectId }, 'canonical subject argument');
    required(hasField(rule.condition, premise, subject.id), 'condition must actually read the preceding P/Q field on that subject, not constant fake PQR');
    for (const [index, parameter] of rule.parameters.entries()) this.validateValue(parameter.valueType, step.arguments[index].value, parameter.nullable, 0);
    required(record(step.value) && typeof step.value.kind === 'string', 'typed expected conclusion value');
  }

  private validateValue(type: ValueType, value: Value, nullable: boolean, depth: number): void {
    required(depth <= 12 && record(type) && record(value), 'supported typed argument depth');
    if (value.kind === 'null') { required(nullable || type.kind === 'null', 'null only for an explicitly nullable parameter'); return; }
    required(value.kind === type.kind, 'argument Value kind matches its declared type');
    if (type.kind === 'record') {
      required(Array.isArray(type.fields) && record(value.fields), 'record fields');
      for (const field of type.fields) {
        const item = value.fields[field.name];
        if (item === undefined) required(field.optional, 'only optional nested fields may be omitted');
        else this.validateValue(field.valueType, item, field.nullable, depth + 1);
      }
      required(Object.keys(value.fields).every(name => type.fields!.some(field => field.name === name)), 'no undeclared record fields');
    } else if (type.kind === 'list') {
      required(type.element && Array.isArray(value.items) && value.items.length <= Math.min(type.maxItems ?? 0, 100), 'list fits the actual UI limit');
      for (const item of value.items) this.validateValue(type.element, item, false, depth + 1);
    } else if (type.kind === 'boolean') required(typeof value.value === 'boolean', 'boolean true/false, never truthy fallback');
    else if (type.kind === 'object' || type.kind === 'relation') required(typeof value.id === 'string' && value.id.trim(), 'canonical object/relation argument');
    else if (type.kind === 'money' || type.kind === 'quantity') required(typeof value.amount === 'string', 'typed amount');
    else if (type.kind === 'duration') required(typeof value.milliseconds === 'string', 'duration milliseconds');
    else required(typeof value.value === 'string', 'typed scalar value');
  }

  private current(): Binding { required(this.binding, 'authored binding loaded'); return this.binding; }

  private async retain(stage: Stage, observation: Record<string, unknown>): Promise<void> {
    required(this.inputPath && this.inputText, 'original input custody');
    const file = await open(this.inputPath, 'r+');
    try {
      exact(await file.readFile('utf8'), this.inputText, 'unchanged original input before retaining mutation custody');
      const input = JSON.parse(this.inputText);
      input.execution ??= {};
      input.execution[stage] = { ...input.execution[stage], ...observation };
      const text = `${JSON.stringify(input, null, 2)}\n`;
      const bytes = Buffer.from(text);
      const written = await file.write(bytes, 0, bytes.length, 0);
      required(written.bytesWritten === bytes.length, 'complete durable custody write; never resend after a partial write');
      await file.truncate(bytes.length);
      await file.sync();
      this.inputText = text;
    } finally { await file.close(); }
  }
  private async read<T>(endpoint: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${endpoint}`, method: 'POST', timeoutMs: 10_000,
      body: endpoint === 'query' ? { world: this.current().world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World PQR ${kind}: transport=${reply.error.code}; retain the same request without replay`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: Failure };
    if (!body || body.success !== true) throw new Error(`World PQR ${kind}: HTTP=${reply.data.status}; code=${body?.error?.code}; stage=${body?.error?.stage}; diagnosticId=${body?.error?.diagnosticId}; no mutation replay`);
    required(reply.data.ok && reply.data.status === 200 && body.data?.kind === kind, `public ${kind} result envelope`);
    return body.data.result;
  }

  async checkBasis(): Promise<void> {
    const b = this.current();
    const description = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([description.world, description.status], [b.world, 'ready'], 'ready World');
    if (this.baseline) exact([description.incarnation, description.activeRelease], [this.baseline.incarnation, this.baseline.activeRelease], 'unchanged incarnation and active release');
    else this.baseline = description;
    if (b.branch === null) exact(description.activeRelease, b.releaseId, 'explicit global release');
    else {
      let cursor: string | null = null;
      const seen = new Set<string>();
      let found: Branch | undefined;
      do {
        const page: { items: Branch[]; nextCursor?: string | null } = await this.read('query', 'branches', { page: { limit: 100, cursor } });
        for (const branch of page.items.filter(item => item.id === b.branch!.id)) { required(!found, 'unique exact branch'); found = branch; }
        cursor = page.nextCursor ?? null;
        required(!cursor || !seen.has(cursor) && seen.size < 100, 'terminating branch directory');
        if (cursor) seen.add(cursor);
      } while (cursor);
      required(found, 'explicit branch is publicly readable');
      exact([found.id, found.revision, found.baseRelease, found.basis.releaseId], [b.branch.id, b.branch.revision, b.releaseId, b.releaseId], 'exact branch revision/base release, no upgrade or global fallback');
    }
    for (const step of [b.q, b.r]) exact(await this.read('query', 'definition', { reference: step.definition.reference }), step.definition, 'full original immutable Rule');
  }

  private field(object: Readback, property: Ref): Field {
    const fields = object.fields.filter(field => isDeepStrictEqual(field.property, property));
    required(fields.length === 1, `one readable field ${property.id}`);
    exact(fields[0].dirty, { kind: 'clean' }, 'clean field');
    return fields[0];
  }

  private async objectAt(subjectId: string, knownAt: string) {
    const b = this.current();
    let cursor: string | null = null;
    const seen = new Set<string>();
    let found: { object: Readback; receipt: ReadReceipt } | undefined;
    do {
      const page: QueryPage = await this.read('query', 'objects', { world: b.world, releaseId: b.releaseId,
        ...(b.branch ? { branchId: b.branch.id } : {}), validAt: b.validAt, knownAt, readMode: b.readMode,
        query: { root: { kind: 'objects', typeRef: b.subject.type, symbol: 'item' }, parameters: [],
          output: [b.p.property, b.q.property, b.r.property].map((property, index) => ({ name: ['P', 'Q', 'R'][index], expression: { kind: 'field', subject: 'item', property } })), limit: 100 },
        arguments: [], page: { limit: 100, cursor } });
      exact([page.receipt.world, page.receipt.releaseId, page.receipt.branchId ?? null, page.receipt.requestedMode],
        [b.world, b.releaseId, b.branch?.id ?? null, b.readMode], 'object receipt World/release/branch/read mode');
      exact([page.receipt.coverage.complete, page.receipt.coverage.missingSources, page.receipt.coverage.gapSources, page.receipt.coverage.missingFields, page.receipt.dirty, page.receipt.truncation ?? null],
        [true, [], [], [], [], null], 'complete untruncated clean object read');
      exact(page.receipt.consistency, b.branch ? 'branch_assumptions' : 'recorded_replay', 'explicit bitemporal read consistency');
      for (const object of page.objects.filter(item => item.object.id === subjectId)) {
        required(!found, 'unique canonical object across public pages');
        exact(object.object, { world: b.world, id: subjectId, typeId: b.subject.type.id }, 'canonical object identity');
        exact(object.receiptId, page.receipt.id, 'object read receipt identity');
        found = { object, receipt: page.receipt };
      }
      cursor = page.rows.nextCursor ?? null;
      required(!cursor || !seen.has(cursor) && seen.size < 100, 'terminating object directory');
      if (cursor) seen.add(cursor);
    } while (cursor);
    required(found, 'existing readable canonical object; identity creation is forbidden');
    return found;
  }

  private async sources() {
    const b = this.current();
    const versions: unknown[] = [];
    const artifacts: unknown[] = [];
    for (const source of b.sources) {
      const version = await this.read('query', 'source_version', { reference: source.version.reference });
      exact(version, source.version, 'complete original public SourceVersion including blob/time/lineage'); versions.push(version);
      if (source.parseArtifact) {
        const artifact = await this.read('query', 'parse_artifact', { id: source.parseArtifact.id });
        exact(artifact, source.parseArtifact, 'complete original parse artifact/source map'); artifacts.push(artifact);
      }
    }
    return { versions, artifacts };
  }

  async prepare() {
    const b = this.current();
    await this.checkBasis();
    const sourceReadback = await this.sources();
    this.original = await this.objectAt(b.subject.id, b.knownAt);
    exact(this.field(this.original.object, b.p.property).cell, { kind: 'known', value: b.p.value }, 'original P at explicit valid/known time');
    required(this.field(this.original.object, b.q.property).cell.kind === 'unknown' && this.field(this.original.object, b.r.property).cell.kind === 'unknown', 'Q and R are initially unknown, not existing derivations or false');
    for (const source of b.sources) {
      required(this.field(this.original.object, b.p.property).evidence.some(item => isDeepStrictEqual(item, source.evidence)), 'original P contains exact source evidence');
      required(this.original.receipt.actualDependencies.some(item => isDeepStrictEqual(item, source.dependency)), 'original receipt contains exact source binding/position');
      required(this.original.receipt.basis.some(item => item.sourceId === source.version.reference.sourceId), 'original receipt includes the declared source basis');
    }
    required(this.original.receipt.actualDependencies.some(item => isDeepStrictEqual(item, { kind: 'assertion', reference: b.p.assertion })), 'original P assertion is a real read dependency');
    this.unknownOriginal = await this.objectAt(b.unknown.subjectId, b.knownAt);
    exact(this.field(this.unknownOriginal.object, b.p.property).cell, { kind: 'unknown', reason: b.unknown.pReason }, 'unknown P is not boolean false');
    exact(this.field(this.unknownOriginal.object, b.q.property).cell, { kind: 'unknown', reason: b.unknown.qReason }, 'unknown Q before evaluation');
    return { original: this.original, unknownOriginal: this.unknownOriginal, sourceReadback, inputDigest: this.inputDigest };
  }

  form(stage: Stage) {
    const b = this.current(); const step = stage === 'r' ? b.r : b.q;
    return { entry: step.entry, reference: step.definition.reference, target: b.branch ? 'branch' : 'global',
      branchValue: b.branch ? JSON.stringify([b.branch.id, b.branch.revision]) : '',
      request: { releaseId: b.releaseId, rule: step.definition.reference,
        arguments: stage === 'unknown' ? b.unknown.arguments : step.arguments, scope: b.scope, validTime: b.validTime,
        ...(b.branch ? { branch: b.branch } : {}) } };
  }

  async fillArguments(stage: Stage): Promise<void> {
    const b = this.current(); const step = stage === 'r' ? b.r : b.q;
    const section = this.electron.page.getByRole('region', { name: /^(Evaluate rule|执行规则)$/, exact: true });
    await section.getByRole('textbox', { name: /^(Scope|适用范围)$/, exact: true }).fill(b.scope);
    await section.getByLabel(/^(Valid from|有效时间起点)$/, { exact: true }).fill(localTime(b.validTime.from));
    if (b.validTime.to === null) await section.getByRole('checkbox', { name: /^(No end time|无结束时间)$/, exact: true }).check();
    else await section.getByLabel(/^(Valid until|有效时间终点)$/, { exact: true }).fill(localTime(b.validTime.to));
    const arguments_ = stage === 'unknown' ? b.unknown.arguments : step.arguments;
    const fill = async (name: string, type: ValueType, value: Value | undefined): Promise<void> => {
      const mode = section.locator(`select[name=${JSON.stringify(`${name}.mode`)}]`);
      if (await mode.count()) await mode.selectOption(value === undefined ? 'omit' : value.kind === 'null' ? 'null' : 'value');
      if (value === undefined || value.kind === 'null') return;
      if (type.kind === 'record') {
        for (const field of type.fields!) await fill(`${name}.${field.name}`, field.valueType, value.fields![field.name]);
      } else if (type.kind === 'list') {
        const fieldset = section.locator(`input[name=${JSON.stringify(`${name}.count`)}]`).locator('..');
        for (const [index, item] of value.items!.entries()) {
          await fieldset.getByRole('button', { name: /^(Add item|添加一项)$/, exact: true }).click();
          await fill(`${name}.${index}`, type.element!, item);
        }
      } else {
        const control = section.locator(`[name=${JSON.stringify(name)}]`);
        if (type.kind === 'boolean' || type.kind === 'object') await control.selectOption(type.kind === 'boolean' ? String(value.value) : value.id!);
        else await control.fill(type.kind === 'timestamp' ? localTime(String(value.value))
          : String(value.amount ?? value.milliseconds ?? value.id ?? value.value));
      }
    };
    for (const [index, parameter] of step.definition.body.body.parameters.entries()) await fill(`argument.${index}`, parameter.valueType, arguments_[index].value);
  }

  async selectExactBranch(): Promise<void> {
    const b = this.current(); required(b.branch, 'exact branch requested');
    const section = this.electron.page.getByRole('region', { name: /^(Evaluate rule|执行规则)$/, exact: true });
    const select = section.getByRole('combobox', { name: /^(Branch and revision|分支与修订)$/, exact: true });
    const key = JSON.stringify([b.branch.id, b.branch.revision]);
    for (let page = 0; page < 100; page++) {
      await select.waitFor({ state: 'visible' });
      const selectHandle = await select.elementHandle();
      required(selectHandle, 'visible normal branch control');
      try {
        const ready = await this.electron.page.waitForFunction(element => element instanceof HTMLSelectElement && !element.disabled, selectHandle, { timeout: 15_000 });
        await ready.dispose();
      } finally { await selectHandle.dispose(); }
      if (await select.locator(`option[value=${JSON.stringify(key)}]`).count() === 1) { await select.selectOption(key); return; }
      const next = section.getByRole('button', { name: /^(Next branches|下一页分支)$/, exact: true });
      required(await next.isEnabled(), 'exact branch revision must occur in normal UI directory; no replacement revision');
      const previous = await select.locator('option').allTextContents();
      await next.click();
      const nextHandle = await select.elementHandle();
      required(nextHandle, 'normal branch control after paging');
      try {
        const ready = await this.electron.page.waitForFunction(({ element, previous }) => element instanceof HTMLSelectElement && !element.disabled
          && JSON.stringify(Array.from(element.options, option => option.textContent)) !== JSON.stringify(previous),
        { element: nextHandle, previous }, { timeout: 15_000 });
        await ready.dispose();
      } finally { await nextHandle.dispose(); }
    }
    throw new Error('World PQR branch UI pagination exceeded its bound; no evaluation submitted');
  }

  async mark(stage: Stage): Promise<void> {
    required(this.original && this.unknownOriginal, 'complete source/subject/time/read-only preflight');
    required(!this.attempted.has(stage) && !this.observation, 'one UI request per stage; unknown mutations are never replayed');
    if (stage === 'r') required(this.receipts.q?.result?.result.status === 'valid', 'Q completed with an actual derived assertion');
    if (stage === 'unknown') required(this.receipts.r?.result?.result.status === 'valid', 'R completed before independent unknown control');
    await this.checkBasis();
    const b = this.current();
    required(Date.now() >= Date.parse(b.validTime.from) && (b.validTime.to === null || Date.now() < Date.parse(b.validTime.to)), 'valid interval remains current');
    await this.retain(stage, { attemptedAt: new Date().toISOString(), inputDigest: this.inputDigest,
      incarnation: this.baseline!.incarnation, request: this.form(stage).request });
    const handle = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
      const state: Observer = { ids: [], dispose: () => undefined };
      const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!isRecord(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !isRecord(value.payload)) return;
        const hint = value.payload;
        if (!isRecord(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') { state.error = 'World PQR event continuity lost; retain original request without replay'; return; }
        if (!isRecord(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) {
          if (state.ids.length >= 8) state.error = 'World PQR operation hints are ambiguous; no key guessed';
          else state.ids.push(hint.resource.id);
        }
      });
      return state;
    }, { world: b.world, incarnation: this.baseline!.incarnation });
    this.attempted.add(stage); this.operationId = undefined;
    this.observation = { stage, read: async () => {
      const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 });
      await ready.dispose(); return handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
    }, dispose: async () => { await handle.evaluate(state => state.dispose()); await handle.dispose(); } };
  }

  async captureOperation(stage: Stage) {
    required(this.observation?.stage === stage, 'owned event observer for original UI submission');
    const observed = await this.observation.read();
    await this.retain(stage, { observedAt: new Date().toISOString(), world: this.current().world, operationIds: observed.ids,
      ...(observed.error ? { observationError: observed.error } : {}) });
    if (observed.error) throw new Error(observed.error);
    if (observed.ids.length !== 1) throw new Error(`World PQR ambiguous Operation IDs=${observed.ids.join(',')}; no identity guessed or request resent`);
    this.operationId = observed.ids[0];
    return { world: this.current().world, operationId: this.operationId };
  }

  async confirm(stage: Stage) {
    required(this.operationId && this.observation?.stage === stage, 'exact original OperationKey');
    const observed = await this.observation.read();
    if (observed.error || observed.ids.length !== 1 || observed.ids[0] !== this.operationId) throw new Error(`World PQR operation observation changed: ${observed.error ?? observed.ids.join(',')}; preserve same key without replay`);
    const receipt = await this.read<Receipt>('operation', 'result', { world: this.current().world, operationId: this.operationId });
    await this.retain(stage, { receipt });
    exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [this.current().world, this.operationId, this.baseline!.incarnation], 'original OperationKey/incarnation');
    if (receipt.phase !== 'completed' || receipt.disclosure.kind !== 'full' || receipt.result?.kind !== 'rule_evaluated') {
      throw new Error(`World PQR operation=${this.operationId}; phase=${receipt.phase}; disclosure=${receipt.disclosure.kind}; code=${receipt.failure?.code}; stage=${receipt.failure?.stage}; diagnosticId=${receipt.failure?.diagnosticId}; retain same key, never resend/resume/cancel`);
    }
    exact(receipt.failure, null, 'successful rule failure field'); exact(receipt.effects, [], 'no external write effect receipts');
    if (stage === 'unknown') exact(receipt.result.result, { status: 'pending', assertion: null }, 'unknown remains pending, never invalid/false');
    else { exact(receipt.result.result.status, 'valid', 'actual derivation status'); reference(receipt.result.result.assertion, this.current().world, 'actual derived assertion'); }
    timestamp(receipt.updatedAt, 'actual server receipt known time');
    this.receipts[stage] = receipt;
    await this.releaseObservation();
    return receipt;
  }

  async verifyChain() {
    const b = this.current(); const q = this.receipts.q; const r = this.receipts.r; const unknown = this.receipts.unknown;
    required(q?.result?.result.assertion && r?.result?.result.assertion && unknown?.result, 'all three actual completed Operation receipts');
    await this.checkBasis();
    const final = await this.objectAt(b.subject.id, r.updatedAt);
    exact(this.field(final.object, b.p.property).cell, { kind: 'known', value: b.p.value }, 'P remains unchanged');
    exact(this.field(final.object, b.q.property).cell, { kind: 'known', value: b.q.value }, 'derived Q object field');
    exact(this.field(final.object, b.r.property).cell, { kind: 'known', value: b.r.value }, 'derived R object field');
    const historical = await this.objectAt(b.subject.id, b.knownAt);
    for (const property of [b.p.property, b.q.property, b.r.property]) exact(this.field(historical.object, property), this.field(this.original!.object, property), 'historical knownAt replay preserves original field/evidence/unknown');
    const unknownRead = await this.objectAt(b.unknown.subjectId, unknown.updatedAt);
    exact(this.field(unknownRead.object, b.p.property).cell, { kind: 'unknown', reason: b.unknown.pReason }, 'unknown P after evaluation');
    exact(this.field(unknownRead.object, b.q.property).cell, { kind: 'unknown', reason: b.unknown.qReason }, 'unknown Q after pending evaluation, not false');
    const sourceReadback = await this.sources();
    // Explain has no public branch field. Verify returned support ownership; never add a guessed envelope field or fall back to global.
    const explanation = await this.read<Explanation>('query', 'explain', { assertion: r.result.result.assertion, readMode: b.readMode });
    exact(explanation.conclusion, r.result.result.assertion, 'Explain root is actual R assertion');
    required(typeof explanation.revision === 'string' && explanation.revision.trim() && explanation.supports.length === 2, 'complete two-level rooted P→Q→R proof, not merely a nonempty support list');
    const supportFor = (step: Step, assertion: Ref): Support => {
      const matches = explanation.supports.filter(support => isDeepStrictEqual(support.conclusion, assertion) && isDeepStrictEqual(support.rule, step.definition.reference));
      required(matches.length === 1, 'one exact derived support at each level');
      const support = matches[0];
      exact([support.arguments, support.scope, support.validTime, support.releaseId, support.branchId ?? null, support.status, support.dirty],
        [step.arguments, b.scope, b.validTime, b.releaseId, b.branch?.id ?? null, 'valid', { kind: 'clean' }], 'full support arguments/scope/time/release/exact branch/status');
      reference(support.reference, b.world, 'real support reference');
      return support;
    };
    const qSupport = supportFor(b.q, q.result.result.assertion);
    const rSupport = supportFor(b.r, r.result.result.assertion);
    const depends = (support: Support, kind: string, reference_: unknown) => support.premises.some(premise =>
      premise.kind === kind && isDeepStrictEqual(premise.reference, reference_)
      || premise.kind === 'read' && isDeepStrictEqual(premise.reference, { kind, reference: reference_ }));
    required(depends(rSupport, 'assertion', q.result.result.assertion), 'R support actually depends on actual Q assertion');
    required(depends(qSupport, 'assertion', b.p.assertion), 'Q support actually depends on original source P assertion');
    for (const source of b.sources) {
      required(explanation.visibleEvidence.some(item => isDeepStrictEqual(item, source.evidence)), 'complete Explain contains original visible source evidence');
      required(depends(qSupport, 'evidence', source.evidence), 'Q support retains original source evidence premise');
      required(qSupport.premises.some(premise => premise.kind === 'read' && isDeepStrictEqual(premise.reference, source.dependency)), 'Q support retains exact original source read position');
    }
    await this.checkBasis();
    return { chainVerified: true, recordedReplayVerified: true, unknownRemainsUnknown: true,
      inputDigest: this.inputDigest, qOperation: q, rOperation: r, unknownOperation: unknown,
      original: this.original, final, historical, unknownRead, sourceReadback, explanation };
  }

  async releaseObservation(): Promise<void> {
    if (!this.observation) return;
    await this.observation.dispose(); this.observation = undefined;
  }
}
