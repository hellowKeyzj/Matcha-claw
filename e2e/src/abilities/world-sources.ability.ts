import { Ability } from '@serenity-js/core';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

type World = { tenantId: string; worldId: string };
type Reference = { world: World; id: string; revision: string };
type Definition<T> = { reference: Reference; body: { kind: string; body: T }; [key: string]: unknown };
type Connection = { id: string; revision: string; sourceId: string; name: string; connector: string; configured: boolean; capabilities: unknown };
type Position = { sourceId: string; incarnation: string; partition: string; format: string; cursor: string; transaction: string | null; eventIndex: string | null };
type Checkpoint = { binding: Reference; epoch: string; captured: Position | null; applied: Position | null; acknowledged: Position | null; projected: Position | null; gap: unknown };
type Schema = { reference: Reference; sourceId: string; incarnation: string; namespace: string; fields: unknown[]; keys: unknown[]; complete: boolean; observedAt: string };
type Mapping = { reference: Reference; schema: Reference; identityRule: Reference; typeRef: Reference; fields: { property: Reference }[]; [key: string]: unknown };
type Binding = { sourceId: string; connectionId: string; connectionRevision: string; connector: string; resource: string; namespace: string; incarnation: string; scope: string; schema: Reference; mapping: Reference; identityRule: Reference; authority: { revision: string }; mode: string; fieldModes: { fieldId: string; mode: string }[]; sync: { kind: string }; [key: string]: unknown };
type SourceInput = { connection: Connection; binding: Definition<Binding>; schema: Schema; mapping: Mapping; expectedPosition: Position; expectedSnapshot: string };
type ObjectResult = { object: { world: World; id: string; typeId: string }; fields: { property: Reference; cell: unknown; evidence: unknown[]; dirty: { kind: string } }[]; receiptId: string };
type Basis = { sourceId: string; incarnation: string; binding: Reference; mappingRevision: string; authorityRevision: string; schema: Reference; identityRule: Reference; position: Position | null; snapshot: string | null; guarantee: string; gap: unknown; [key: string]: unknown };
type ReadReceipt = { world: World; id: string; branchId: string | null; releaseId: string; activationLockId: string; requestedMode: unknown; basis: Basis[]; coverage: { complete: boolean; missingSources: string[]; missingFields: string[]; gapSources: string[] }; dirty: unknown[]; truncation: unknown; freshness: { sourceId: string; satisfied: boolean }[]; actualDependencies: { kind: string; binding?: Reference; position?: Position }[]; [key: string]: unknown };
type QueryPage = { rows: { items: unknown[]; nextCursor: string | null }; objects: ObjectResult[]; relations: unknown[]; receipt: ReadReceipt };
type RenderedRecord = { fields: [string, RenderedRecord][] } | { items: RenderedRecord[] } | { text: string };
type Description = { world: World; status: string; incarnation: string; activeRelease: string | null; activeReleaseHead: unknown; editingContext: { activationLock: { id: string }; scopes: { id: string }[] } | null };
type Operation = { accepted: { world: World; operationId: string; incarnation: string }; disclosure: { kind: string }; phase: string; result: { kind: string; result: unknown } | null; failure: { code: string; stage: string; diagnosticId: string } | null };
type Observation = { ids: string[]; error?: string; dispose: () => void };
type SetupEvent = { kind: 'header'; origin: string; baseline: Description; connector: string; providerValue: string; scope: string; schemas: unknown[] }
  | { kind: 'attempt'; stage: string }
  | { kind: 'operation'; stage: string; operationId: string }
  | { kind: 'confirmed'; stage: string; receipt: Operation; value: Connection | Schema }
  | { kind: 'failure'; stage: string; message: string };
type SetupHeader = Extract<SetupEvent, { kind: 'header' }>;
const setupRoot = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21');
const setupCustody = resolve(setupRoot, 'world-source-setup-20261028-r1.custody.jsonl');
const setupSources = [
  { name: 'world-pqr-observed-20261028-r1', resource: 'inspection_observed', field: 'strength', pointer: '/measuredStrength', type: 'integer', prefix: 'observed' },
  { name: 'world-pqr-unmeasured-20261028-r1', resource: 'inspection_unmeasured', field: 'batch_key', pointer: '/batchKey', type: 'text', prefix: 'unmeasured' },
] as const;
type Input = {
  world: World; scope: string;
  permissions: { sourceReadApproved: boolean; schemaDiscoveryApproved: boolean; synchronizationApproved: boolean };
  syncBinding: Reference; sources: SourceInput[];
  objectType: Definition<{ properties: Reference[] }>;
  expectedObjects: Omit<ObjectResult, 'receiptId'>[]; expectedRows: unknown[];
};

const world: World = { tenantId: 'local', worldId: 'personal' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World B ${label} differs from the explicitly bound public original; no mutation replayed`);
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`World B requires an explicit nonempty ${label}`);
}
function reference(value: unknown): asserts value is Reference {
  if (!record(value) || !record(value.world)) throw new Error('World B requires complete public references, never inferred IDs');
  exact(value.world, world, 'reference World');
  nonempty(value.id, 'reference ID');
  if (typeof value.revision !== 'string' || !/^[1-9]\d*$/.test(value.revision)) throw new Error('World B reference revision must be a positive decimal string');
}

export class WorldSources extends Ability {
  private input?: Input;
  private baseline?: Description;
  private beforeCheckpoint?: Checkpoint;
  private discovered?: Schema;
  private synchronized?: Checkpoint;
  private attempted = new Set<'discover' | 'sync'>();
  private observation?: { kind: 'discover' | 'sync'; read: () => Promise<{ ids: string[]; error?: string }>; dispose: () => Promise<void> };
  private uiObjectRows?: { id: string; cells: string[] }[];
  private setupStarted = false;
  private setupHeader?: SetupHeader;
  private setupEvents: SetupEvent[] = [];
  private setupStage = 'idle';
  constructor(private readonly electron: UseElectron) { super(); }

  private async appendSetup(event: SetupEvent): Promise<void> {
    const file = await open(setupCustody, 'a');
    try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); this.setupEvents.push(event); }
    finally { await file.close(); }
  }

  private async setupCurrent(): Promise<void> {
    if (!this.setupHeader) throw new Error('Source setup original baseline is missing');
    const current = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    const basis = (value: Description) => [value.world, value.status, value.incarnation, value.activeRelease, value.activeReleaseHead, value.editingContext?.activationLock.id];
    exact(basis(current), basis(this.setupHeader.baseline), 'source setup unchanged release and activation');
  }

  private async setupWrite(stage: string, click: (arm: () => Promise<void>) => Promise<void>): Promise<Operation> {
    this.setupStage = stage;
    await this.setupCurrent();
    const attempted = this.setupEvents.filter(event => event.kind === 'attempt' && event.stage === stage);
    const operations = this.setupEvents.filter((event): event is Extract<SetupEvent, { kind: 'operation' }> => event.kind === 'operation' && event.stage === stage);
    if (attempted.length > 1 || operations.length > 1) throw new Error(`Source setup ${stage}: ambiguous custody; no resend`);
    let id = operations[0]?.operationId;
    if (attempted.length && !id) throw new Error(`Source setup ${stage}: original delivery unknown without OperationKey; no resend`);
    if (!attempted.length) {
      if (id) throw new Error('Source setup original operation has no prior attempt');
      const handle = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
        const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
        const state: Observation = { ids: [], dispose: () => undefined };
        const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
        state.dispose = ipc.on('host:event', value => {
          if (!object(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !object(value.payload)) return;
          const hint = value.payload;
          if (!object(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
          if (hint.incarnation !== incarnation || hint.kind === 'resync_required') { state.error = 'Source setup event continuity lost'; return; }
          if (!object(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
          if (!state.ids.includes(hint.resource.id)) {
            if (state.ids.length) state.error = 'Source setup operation identity is ambiguous';
            else state.ids.push(hint.resource.id);
          }
        });
        return state;
      }, { world, incarnation: this.setupHeader!.baseline.incarnation });
      const failures: unknown[] = [];
      try {
        await click(() => this.appendSetup({ kind: 'attempt', stage }));
        const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 });
        await ready.dispose();
        const observed = await handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
        if (observed.ids.length === 1) {
          id = observed.ids[0];
          await this.appendSetup({ kind: 'operation', stage, operationId: id });
        }
        if (observed.error || !id) throw new Error(observed.error ?? 'Source setup original OperationKey unavailable; no resend');
      } catch (error) { failures.push(error); }
      finally {
        try {
          const observed = await handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
          if (!id && observed.ids.length === 1) {
            id = observed.ids[0]; await this.appendSetup({ kind: 'operation', stage, operationId: id });
          }
          if (observed.error && failures.length === 0) failures.push(new Error(observed.error));
        } catch (error) { failures.push(error); }
        try { await handle.evaluate(state => state.dispose()); } catch (error) { failures.push(error); }
        try { await handle.dispose(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, `Source setup ${stage} original failure retained without replay`);
    }
    nonempty(id, 'source setup original operation ID');
    const deadline = Date.now() + 30_000;
    let receipt: Operation;
    do {
      receipt = await this.read<Operation>('operation', 'result', { world, operationId: id });
      exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, id, this.setupHeader!.baseline.incarnation], 'source setup original operation');
      if (!['accepted', 'admitted', 'running', 'verifying', 'committing', 'draining'].includes(receipt.phase)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (receipt.phase !== 'completed' || receipt.disclosure.kind !== 'full' || receipt.failure !== null
      || receipt.result?.kind !== (stage.endsWith(':connection') ? 'connection' : 'schema')) {
      throw new Error(`Source setup operation=${id}; phase=${receipt.phase}; code=${receipt.failure?.code}; stage=${receipt.failure?.stage}; diagnosticId=${receipt.failure?.diagnosticId}; no resend`);
    }
    return receipt;
  }

  async setupConnections(): Promise<void> {
    if (this.setupStarted) throw new Error('Source setup was already started in this scenario');
    const supplied = process.env.E2E_WORLD_SOURCE_SETUP_BASE_URL;
    if (!supplied) throw new Error('Source setup requires the owned loopback business-material server URL');
    const url = new URL(supplied);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Source setup accepts only the explicit owned loopback origin without credentials or path');
    this.setupStarted = true;
    const schemas = await Promise.all(setupSources.map(async source => JSON.parse(await readFile(resolve(setupRoot, 'world-rules-input-20261028-r1', `${source.prefix}-schema.json`), 'utf8')) as unknown));
    const description = await this.read<Description>('query', 'discover', { includeCapabilities: true });
    exact([description.world, description.status], [world, 'ready'], 'source setup ready World');
    if (!description.activeRelease || !description.editingContext) throw new Error('Source setup needs the real active release');
    const packages = await this.list<{ installId: string; manifest: {
      artifacts: { id: string; runtime: string; entrypoint: { kind: string; registration?: string } }[];
      provides: { providerId: string; artifactId: string; slot: string; contracts: { id: string }[] }[];
    } }>('packages');
    const providers = packages.flatMap(item => item.manifest.provides.flatMap(provider => {
      const artifact = item.manifest.artifacts.find(artifact => artifact.id === provider.artifactId);
      return provider.slot === 'connector' && provider.contracts.some(contract => contract.id === 'source.read')
        && artifact?.runtime === 'native' && artifact.entrypoint.kind === 'native' && artifact.entrypoint.registration === 'source.http-json.v1'
        ? [{ installId: item.installId, ...provider }] : [];
    }));
    if (providers.length !== 1) throw new Error(`Source setup installed HTTP connector declarations=${providers.length}; exact matches=${JSON.stringify(providers)}; configuration is not discovery, no mutation attempted`);
    const provider = providers[0];
    const scope = 'scope:personal:management';
    exact(description.editingContext.scopes.filter(item => item.id === scope).length, 1, 'existing source management scope');
    const header: SetupHeader = { kind: 'header', origin: url.origin, baseline: description, connector: provider.providerId, providerValue: JSON.stringify([provider.installId, provider.providerId, provider.artifactId, 'connector']), scope, schemas };
    let retained: string | undefined;
    try { retained = await readFile(setupCustody, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (retained !== undefined) {
      if (!retained.endsWith('\n') || retained.length > 4_194_304) throw new Error('Source setup custody is torn or exceeds its bound');
      this.setupEvents = retained.trimEnd().split('\n').map(line => JSON.parse(line) as SetupEvent);
      const first = this.setupEvents[0];
      if (first?.kind !== 'header') throw new Error('Source setup original header unavailable');
      exact([first.origin, first.connector, first.providerValue, first.scope, first.schemas], [header.origin, header.connector, header.providerValue, header.scope, header.schemas], 'source setup exact retained input');
      this.setupHeader = first;
      await this.setupCurrent();
    } else {
      exact((await this.list<Connection>('connections')).filter(item => setupSources.some(source => source.name === item.name)), [], 'no existing setup-owned connection without original custody');
      const file = await open(setupCustody, 'wx');
      try { await file.writeFile(`${JSON.stringify(header)}\n`); await file.sync(); } finally { await file.close(); }
      this.setupEvents = [header]; this.setupHeader = header;
    }
    const workspace = this.electron.page.locator('main .world-workspace');
    const navigate = async () => {
      await this.electron.page.locator('aside nav a[href="#/world"]').click();
      await workspace.getByRole('tab', { name: /^(Data sources|资料来源)$/, exact: true }).click();
    };
    try {
      for (const source of setupSources) {
        const connectionStage = `${source.prefix}:connection`;
        const registered = await this.setupWrite(connectionStage, async arm => {
          await navigate();
          await workspace.getByRole('button', { name: /^(Connect a business system|连接业务系统)/ }).click();
          const form = workspace.locator('form.world-settings-layout');
          await form.getByLabel(/^(Business source type|业务源类型)$/, { exact: true }).selectOption('http_json');
          await form.getByLabel(/^(Connection name|连接名称)$/, { exact: true }).fill(source.name);
          await form.getByLabel(/^(Service URL|服务地址)$/, { exact: true }).fill(url.origin);
          await form.getByLabel(/^(Read path|读取路径)$/, { exact: true }).fill(`/${source.prefix}-rows.json`);
          await form.getByLabel(/^(Schema discovery path|结构发现路径)$/, { exact: true }).fill(`/${source.prefix}-schema.json`);
          await form.getByLabel(/^(Resource ID|资源标识)$/, { exact: true }).fill(source.resource);
          await form.getByLabel(/^(Unique field ID|唯一字段标识)$/, { exact: true }).fill(source.field);
          await form.getByLabel(/^(Unique field JSON pointer|唯一字段 JSON 指针)$/, { exact: true }).fill(source.pointer);
          await form.getByLabel(/^(Field type|字段类型)$/, { exact: true }).selectOption(source.type);
          await form.getByLabel(/^(Connector implementation|连接实现)$/, { exact: true }).selectOption(header.providerValue);
          await form.getByLabel(/^(Authorization scope|授权范围)$/, { exact: true }).selectOption(scope);
          await this.setupCurrent();
          await arm();
          await form.getByRole('button', { name: /^(Save business connection|保存业务连接)$/, exact: true }).click();
        });
        const ref = registered.result!.result as { connection: string; revision: string };
        nonempty(ref.connection, 'original configured connection ID'); exact(ref.revision, '1', 'new connection revision');
        const matches = (await this.list<Connection>('connections')).filter(item => item.id === ref.connection);
        exact(matches.length, 1, 'original configured connection public readback');
        const connection = matches[0]; nonempty(connection.sourceId, 'original source ID');
        exact([connection.id, connection.revision, connection.name, connection.connector, connection.configured], [ref.connection, '1', source.name, header.connector, true], 'saved real HTTP connection');
        const confirm = async (stage: string, receipt: Operation, value: Connection | Schema) => {
          const prior = this.setupEvents.filter((event): event is Extract<SetupEvent, { kind: 'confirmed' }> => event.kind === 'confirmed' && event.stage === stage);
          if (prior.length) exact(prior, [{ kind: 'confirmed', stage, receipt, value }], 'same completed original setup result');
          else await this.appendSetup({ kind: 'confirmed', stage, receipt, value });
        };
        await confirm(connectionStage, registered, connection);
        await this.setupCurrent();
      }
      this.setupStage = 'connections-confirmed';
    } catch (error) {
      await this.appendSetup({ kind: 'failure', stage: this.setupStage, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  setupEvidence() {
    return { phase: this.setupStage, confirmed: this.setupEvents.filter(event => event.kind === 'confirmed').length, custodyPath: setupCustody, changedRelease: false, synchronized: false };
  }

  async bindPublicInput() {
    if (this.input) throw new Error('World B input is already frozen for this scenario');
    const path = process.env.E2E_WORLD_SOURCES_INPUT;
    if (!path) throw new Error('World B prerequisite missing: E2E_WORLD_SOURCES_INPUT must bind an approved public .scratch JSON with exact real Sources, connections, scope, mappings and read permission; no external Source read or business write was attempted');
    const root = await realpath(resolve(repositoryRoot, '.scratch'));
    const file = await realpath(resolve(repositoryRoot, path));
    const local = relative(root, file);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\') || !file.endsWith('.json')) throw new Error('World B input must be an explicit public JSON inside repository .scratch');
    if ((await stat(file)).size > 1_048_576) throw new Error('World B public input exceeds the bounded contract');
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!record(value) || !record(value.permissions)
      || value.permissions.sourceReadApproved !== true || value.permissions.schemaDiscoveryApproved !== true
      || value.permissions.synchronizationApproved !== true) {
      throw new Error('World B prerequisite missing: real Source read, schema discovery and synchronization permission must each be explicitly true; existing false/null remains unchanged, no grants/trust/configuration are created');
    }
    exact(Object.keys(value).sort(), ['world', 'scope', 'permissions', 'syncBinding', 'sources', 'objectType', 'expectedObjects', 'expectedRows'].sort(), 'public input fields');
    exact(Object.keys(value.permissions).sort(), ['sourceReadApproved', 'schemaDiscoveryApproved', 'synchronizationApproved'].sort(), 'separate permission fields');
    exact(value.world, world, 'input World');
    nonempty(value.scope, 'scope');
    reference(value.syncBinding);
    if (!Array.isArray(value.sources) || value.sources.length < 2 || !record(value.objectType)
      || !Array.isArray(value.expectedObjects) || value.expectedObjects.length === 0 || !Array.isArray(value.expectedRows) || value.expectedRows.length === 0) throw new Error('World B requires a nonempty independent query oracle and at least two exact real Source inputs; an empty directory cannot pass');
    const input = value as unknown as Input;
    reference(input.objectType.reference);
    if (input.objectType.body?.kind !== 'object_type' || !Array.isArray(input.objectType.body.body.properties)) throw new Error('World B requires the exact active object-type definition');
    const ids = new Set<string>();
    for (const source of input.sources) {
      if (!record(source) || !record(source.connection) || !record(source.binding) || !record(source.binding.body)
        || !record(source.binding.body.body) || !record(source.schema) || !record(source.mapping) || !record(source.expectedPosition)) throw new Error('World B Source binding contract is incomplete');
      reference(source.binding.reference); reference(source.schema.reference); reference(source.mapping.reference);
      const binding = source.binding.body.body;
      exact(source.binding.body.kind, 'source_binding', 'SourceBinding kind');
      exact(Object.keys(source.connection).sort(), ['id', 'revision', 'sourceId', 'name', 'connector', 'configured', 'capabilities'].sort(), 'public connection fields without private configuration');
      exact([source.connection.id, source.connection.revision, source.connection.sourceId, source.connection.connector, source.connection.configured],
        [binding.connectionId, binding.connectionRevision, binding.sourceId, binding.connector, true], 'configured connection identity (not a probe or sync result)');
      nonempty(source.connection.name, 'connection display name'); nonempty(binding.resource, 'resource');
      exact(binding.scope, input.scope, 'Source scope');
      exact([binding.schema, binding.mapping, binding.identityRule], [source.schema.reference, source.mapping.reference, source.mapping.identityRule], 'schema, mapping and identity-rule references');
      exact(source.mapping.schema, source.schema.reference, 'mapping schema');
      exact(source.mapping.typeRef, input.objectType.reference, 'query target type');
      exact([source.schema.sourceId, source.schema.namespace, source.schema.incarnation, source.schema.complete], [binding.sourceId, binding.namespace, binding.incarnation, true], 'complete original Source schema');
      if (!Array.isArray(source.schema.fields) || source.schema.fields.length === 0 || !Array.isArray(source.schema.keys) || source.schema.keys.length === 0) throw new Error('World B needs real readable fields and explicit Source keys');
      exact([source.expectedPosition.sourceId, source.expectedPosition.incarnation], [binding.sourceId, binding.incarnation], 'original cursor identity');
      nonempty(source.expectedPosition.cursor, 'expected Source cursor'); nonempty(source.expectedSnapshot, 'expected Source snapshot');
      if (ids.has(binding.sourceId)) throw new Error('World B hybrid oracle must bind distinct real Sources');
      ids.add(binding.sourceId);
    }
    if (!input.sources.some(source => source.binding.body.body.mode === 'hybrid')) throw new Error('World B mixed-query input needs an actual hybrid binding, not two configured connections');
    if (input.sources.filter(source => isDeepStrictEqual(source.binding.reference, input.syncBinding)).length !== 1) throw new Error('World B syncBinding must select exactly one supplied Source; no first-item or ID guessing');
    const primary = input.sources.find(source => isDeepStrictEqual(source.binding.reference, input.syncBinding))!;
    exact(primary.binding.body.body.sync, { kind: 'on_demand' }, 'bounded one-shot sync policy; no continuous reader is started');
    for (const object of input.expectedObjects) {
      exact([object.object.world, object.object.typeId], [world, input.objectType.reference.id], 'independent object oracle identity');
      nonempty(object.object.id, 'expected object ID');
      if (!Array.isArray(object.fields) || object.fields.length === 0) throw new Error('World B object oracle must contain actual field results');
    }
    this.input = input;
    return { connectionName: primary.connection.name, bindingValue: JSON.stringify(primary.binding.reference), resource: primary.binding.body.body.resource,
      typeId: input.objectType.reference.id, objectId: input.expectedObjects[0].object.id, permissions: input.permissions, sourceCount: input.sources.length };
  }

  private required(): Input {
    if (!this.input) throw new Error('World B public Source input and permissions were not checked; no read or write permitted');
    return this.input;
  }
  private primary(): SourceInput {
    const input = this.required();
    return input.sources.find(source => isDeepStrictEqual(source.binding.reference, input.syncBinding))!;
  }
  private async read<T>(endpoint: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    if (!this.setupStarted) this.required();
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${endpoint}`, method: 'POST', timeoutMs: 10_000,
      body: endpoint === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World B ${kind}: transport=${reply.error.code}; no mutation replayed`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: { code: string; stage: string; diagnosticId: string } };
    if (!body || typeof body.success !== 'boolean') throw new Error(`World B ${kind}: invalid public envelope`);
    if (!body.success) throw new Error(`World B ${kind}: HTTP ${reply.data.status}; code=${body.error?.code}; stage=${body.error?.stage}; diagnosticId=${body.error?.diagnosticId}`);
    if (!reply.data.ok || reply.data.status !== 200 || body.data?.kind !== kind) throw new Error(`World B ${kind}: mismatched public result`);
    return body.data.result;
  }
  private async list<T>(kind: string): Promise<T[]> {
    const items: T[] = [], seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: T[]; nextCursor: string | null } = await this.read('query', kind, { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items)) throw new Error(`World B ${kind}: invalid page`);
      items.push(...page.items); cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error(`World B ${kind}: repeated or unbounded cursor`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }

  async inspectPrerequisites() {
    const input = this.required();
    const description = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([description.world, description.status], [world, 'ready'], 'ready existing World');
    if (!description.activeRelease || !description.editingContext || !description.editingContext.scopes.some(scope => scope.id === input.scope)) throw new Error('World B current public release/scope is unavailable; no installation, publication or permission expansion attempted');
    const connections = await this.list<Connection>('connections');
    const mappings = await this.list<Mapping>('mappings');
    for (const source of input.sources) {
      const matches = connections.filter(item => item.id === source.connection.id);
      exact(matches, [source.connection], 'entire exact public connection projection');
      exact(await this.read('query', 'definition', { reference: source.binding.reference }), source.binding, 'entire original published SourceBinding');
      exact(await this.read('query', 'source_schema', { sourceId: source.schema.sourceId }), source.schema, 'entire current original schema before discovery');
      exact(mappings.filter(mapping => isDeepStrictEqual(mapping.reference, source.mapping.reference)), [source.mapping], 'entire original mapping');
      exact(await this.read('query', 'capabilities', { id: source.connection.id }), source.connection.capabilities, 'actual connector capability probe, separate from configured=true');
    }
    exact(await this.read('query', 'definition', { reference: input.objectType.reference }), input.objectType, 'entire original object-type definition');
    this.baseline = description;
    this.beforeCheckpoint = await this.read<Checkpoint>('query', 'sync_status', { binding: input.syncBinding });
    exact(this.beforeCheckpoint.binding, input.syncBinding, 'baseline checkpoint binding');
    exact(this.beforeCheckpoint.gap, null, 'baseline has no Source gap');
    return { connectionExact: true, mappingExact: true, capabilitiesProbed: true, sourceCount: input.sources.length, schema: this.primary().schema, connection: this.primary().connection };
  }

  private async assertCurrent(): Promise<void> {
    if (!this.baseline) throw new Error('World B has no checked public baseline');
    const current = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([current.world, current.status, current.incarnation, current.activeRelease, current.activeReleaseHead],
      [world, 'ready', this.baseline.incarnation, this.baseline.activeRelease, this.baseline.activeReleaseHead], 'unchanged World incarnation and active release');
    const primary = this.primary();
    exact((await this.list<Connection>('connections')).filter(item => item.id === primary.connection.id), [primary.connection], 'unchanged exact connection');
    exact(await this.read('query', 'definition', { reference: primary.binding.reference }), primary.binding, 'unchanged original sync binding');
  }

  async markCommand(kind: 'discover' | 'sync'): Promise<void> {
    if (this.attempted.has(kind) || this.observation) throw new Error('World B command was already attempted or is unresolved; never replay or replace it');
    await this.assertCurrent();
    if (kind === 'sync' && !this.discovered) throw new Error('World B cannot substitute a saved configuration for a completed real schema probe');
    const handle = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
      const state: Observation = { ids: [], dispose: () => undefined };
      const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!object(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !object(value.payload)) return;
        const hint = value.payload;
        if (!object(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') { state.error = 'World B event continuity lost; retain original mutation without replay'; return; }
        if (!object(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) {
          if (state.ids.length >= 8) state.error = 'World B operation hints are ambiguous; no identity guessed';
          else state.ids.push(hint.resource.id);
        }
      });
      return state;
    }, { world, incarnation: this.baseline!.incarnation });
    this.attempted.add(kind);
    this.observation = { kind, read: async () => {
      const ready = await this.electron.page.waitForFunction(state => state.ids.length > 0 || Boolean(state.error), handle, { timeout: 15_000 });
      await ready.dispose();
      return handle.evaluate(state => ({ ids: [...state.ids], error: state.error }));
    }, dispose: async () => { try { await handle.evaluate(state => state.dispose()); } finally { await handle.dispose(); } } };
  }

  async confirmCommand(kind: 'discover' | 'sync') {
    if (this.observation?.kind !== kind) throw new Error('World B original command observer is missing');
    let observed: { ids: string[]; error?: string };
    try { observed = await this.observation.read(); }
    catch (error) {
      const alerts = await this.electron.page.locator('main .world-workspace [role="alert"]').allTextContents();
      throw new AggregateError([error], `World B original ${kind} did not yield a confirmable operation; alerts=${JSON.stringify(alerts)}; no replay or guessed identity`);
    }
    if (observed.error) throw new Error(observed.error);
    if (observed.ids.length !== 1) throw new Error(`World B requires exactly one observed OperationKey; found=${observed.ids.length}; no retry or guessed session key`);
    const id = observed.ids[0], deadline = Date.now() + 45_000;
    let receipt: Operation;
    do {
      receipt = await this.read<Operation>('operation', 'result', { world, operationId: id });
      exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, id, this.baseline!.incarnation], 'same actual OperationKey and incarnation');
      if (!['accepted', 'admitted', 'running', 'verifying', 'committing', 'draining'].includes(receipt.phase) || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (true);
    if (receipt.phase !== 'completed' || receipt.disclosure.kind !== 'full' || receipt.failure !== null || receipt.result?.kind !== (kind === 'discover' ? 'schema' : 'sync')) throw new Error(`World B operation=${id}; phase=${receipt.phase}; disclosure=${receipt.disclosure.kind}; code=${receipt.failure?.code}; stage=${receipt.failure?.stage}; diagnosticId=${receipt.failure?.diagnosticId}; original receipt retained, no resend/abort/rollback`);
    const primary = this.primary();
    if (kind === 'discover') {
      const schema = receipt.result.result as Schema;
      reference(schema.reference);
      exact([schema.reference.id, schema.reference.revision], [primary.schema.reference.id, String(BigInt(primary.schema.reference.revision) + 1n)], 'normal UI discovery next revision, not a fabricated schema identity');
      const { reference: originalReference, observedAt: originalTime, ...expected } = primary.schema;
      const { reference: actualReference, observedAt: actualTime, ...actual } = schema;
      exact(actual, expected, 'real probe fields, keys, source identity, completeness and namespace');
      nonempty(originalReference.id, 'original schema ID'); nonempty(originalTime, 'original schema timestamp');
      nonempty(actualReference.id, 'discovered schema ID'); nonempty(actualTime, 'actual schema observation time');
      exact(await this.read('query', 'source_schema', { sourceId: primary.connection.sourceId }), schema, 'complete independent same discovery readback');
      this.discovered = schema;
    } else {
      const result = receipt.result.result as { binding: Reference; checkpoint: Checkpoint };
      exact(result.binding, primary.binding.reference, 'sync result binding');
      this.checkCheckpoint(result.checkpoint);
      if (BigInt(result.checkpoint.epoch) <= BigInt(this.beforeCheckpoint!.epoch)) throw new Error('World B sync did not create a new checkpoint epoch; stale saved checkpoint cannot pass');
      exact(await this.read('query', 'sync_status', { binding: primary.binding.reference }), result.checkpoint, 'same completed sync checkpoint, not an old accepted/save receipt');
      this.synchronized = result.checkpoint;
    }
    await this.assertCurrent();
    await this.releaseOperationObservation();
    return { operationId: id, phase: receipt.phase, resultKind: receipt.result.kind, result: receipt.result.result, schema: this.discovered, checkpoint: this.synchronized, exactReadback: true };
  }

  private checkCheckpoint(checkpoint: Checkpoint): void {
    const primary = this.primary();
    exact(checkpoint.binding, primary.binding.reference, 'checkpoint exact binding');
    exact(checkpoint.gap, null, 'checkpoint has no gap');
    if (typeof checkpoint.epoch !== 'string' || !/^[1-9]\d*$/.test(checkpoint.epoch)) throw new Error('World B sync epoch is invalid');
    for (const frontier of ['captured', 'applied', 'projected', 'acknowledged'] as const) exact(checkpoint[frontier], primary.expectedPosition, `${frontier} reached the original real Source cursor`);
  }

  async readCheckpoint() {
    if (!this.synchronized) throw new Error('World B has no completed sync checkpoint');
    const checkpoint = await this.read<Checkpoint>('query', 'sync_status', { binding: this.required().syncBinding });
    exact(checkpoint, this.synchronized, 'UI checkpoint independent readback');
    return checkpoint;
  }

  private queryRequest(readMode: unknown) {
    const input = this.required();
    return { world, query: { root: { kind: 'objects', typeRef: input.objectType.reference, symbol: 'item' }, parameters: [], limit: 100,
      output: input.objectType.body.body.properties.map(property => ({ name: property.id, expression: { kind: 'field', subject: 'item', property } })) },
    arguments: [], readMode, page: { limit: 100 } };
  }
  async readUiObjectRows(): Promise<void> {
    if (!this.synchronized || this.uiObjectRows) throw new Error('World B requires a completed original sync and exactly one normal UI result capture');
    const rows = this.electron.page.locator('main .world-workspace .world-object-main .world-table tbody tr');
    this.uiObjectRows = await rows.evaluateAll(elements => elements.map(row => ({
      id: row.querySelector('td:first-child button')?.getAttribute('title') ?? '',
      cells: Array.from(row.querySelectorAll('td')).slice(1).map(cell => cell.textContent?.trim() ?? ''),
    })));
    exact(this.uiObjectRows.map(row => row.id), this.required().expectedObjects.map(item => item.object.id), 'all original UI object IDs, without local filtering');
    exact(await this.electron.page.getByRole('button', { name: /^(Next page|下一页)$/, exact: true }).count(), 0, 'UI query has no unverified continuation');
  }

  private async readUiReceipt(): Promise<{ receipt: ReadReceipt; id: string }> {
    const details = this.electron.page.locator('main .world-workspace article.world-object-document > details').filter({
      has: this.electron.page.locator('summary').filter({ hasText: /^(Read receipt and coverage|读取回执与覆盖范围)$/ }),
    });
    exact(await details.count(), 1, 'one normal UI read receipt');
    if (await details.getAttribute('open') === null) throw new Error('World B normal UI read receipt must be opened before readback');
    const id = (await details.locator(':scope > div > p').first().innerText()).trim();
    nonempty(id, 'same UI object receipt ID');
    const tree = await details.locator(':scope > div > dl').evaluate(element => {
      let count = 0;
      const read = (node: Element, depth: number): RenderedRecord => {
        if (++count > 4096 || depth >= 12) throw new Error('World B public receipt display exceeds its bounded complete-read depth');
        const child = node.matches('dl,ol') ? node : Array.from(node.children).find(item => item.matches('dl,ol'));
        if (child?.tagName === 'DL') return { fields: Array.from(child.children).map(item => {
          const key = item.querySelector(':scope > dt'), value = item.querySelector(':scope > dd');
          if (!key || !value) throw new Error('World B malformed public receipt record');
          return [key.textContent?.trim() ?? '', read(value, depth + 1)] as [string, RenderedRecord];
        }) };
        if (child?.tagName === 'OL') return { items: Array.from(child.children).map(item => read(item, depth + 1)) };
        return { text: node.textContent?.trim() ?? '' };
      };
      return read(element, 0);
    });
    const arrays = new Set(['basis', 'actualDependencies', 'dirty', 'missingSources', 'missingFields', 'gapSources', 'freshness', 'fieldDefinitions', 'fields', 'roles']);
    const nullable = new Set(['branchId', 'projectionGeneration', 'expiresAt', 'truncation', 'gap', 'position', 'snapshot', 'capturedAt', 'lastReconciledAt', 'lag', 'transaction', 'eventIndex']);
    const booleans = new Set(['complete', 'satisfied', 'nullable', 'optional']);
    const decode = (node: RenderedRecord, key: string): unknown => {
      if ('fields' in node) {
        if (new Set(node.fields.map(([name]) => name)).size !== node.fields.length) throw new Error('World B duplicate public receipt keys');
        return Object.fromEntries(node.fields.map(([name, value]) => [name, decode(value, name)]));
      }
      if ('items' in node) return node.items.map(item => decode(item, key));
      if (arrays.has(key) && /^(None|无)$/.test(node.text)) return [];
      if (nullable.has(key) && /^(Not set|未设置)$/.test(node.text)) return null;
      if (booleans.has(key)) {
        if (!['true', 'false'].includes(node.text)) throw new Error('World B invalid public receipt boolean');
        return node.text === 'true';
      }
      return node.text;
    };
    const receipt = decode(tree, '') as ReadReceipt;
    exact(Object.keys(receipt).sort(), ['world', 'id', 'branchId', 'releaseId', 'activationLockId', 'queryDigest', 'evaluatedScopeDigest', 'decisionId', 'policyEpoch', 'grantEpoch', 'observedAt', 'expiresAt', 'requestedMode', 'basis', 'projectionGeneration', 'actualDependencies', 'coverage', 'freshness', 'dirty', 'truncation', 'consistency'].sort(), 'complete original ReadReceipt public fields');
    exact(receipt.id, id, 'same original object and complete UI receipt ID');
    return { receipt, id };
  }

  private verifyQuery(page: QueryPage, mode: unknown): void {
    const input = this.required();
    this.verifyReceipt(page.receipt, mode);
    exact(page.rows.nextCursor, null, 'After query has no unverified continuation');
    exact(page.rows.items, input.expectedRows, 'independent complete After-read row oracle, not the original unexposed UI rows');
    exact(page.relations, [], 'object-only After query relations');
    exact(page.objects.map(({ object, fields }) => ({ object, fields })), input.expectedObjects, 'independent complete After-read object and field oracle');
    for (const object of page.objects) exact(object.receiptId, page.receipt.id, 'each After-read object uses its own independent receipt');
  }

  private verifyReceipt(receipt: ReadReceipt, mode: unknown): void {
    const input = this.required();
    exact([receipt.world, receipt.branchId, receipt.releaseId, receipt.activationLockId, receipt.requestedMode],
      [world, null, this.baseline!.activeRelease, this.baseline!.editingContext!.activationLock.id, mode], 'query World, active release, activation lock and requested mode');
    nonempty(receipt.id, 'actual query receipt ID');
    exact(receipt.coverage.complete, true, 'complete hybrid coverage');
    exact([receipt.coverage.missingSources, receipt.coverage.missingFields, receipt.coverage.gapSources, receipt.dirty, receipt.truncation], [[], [], [], [], null], 'no missing source/field, gap, dirty result or truncation');
    exact(receipt.basis.length, input.sources.length, 'all and only the original hybrid Sources');
    for (const source of input.sources) {
      const binding = source.binding.body.body;
      const matches = receipt.basis.filter(basis => isDeepStrictEqual(basis.binding, source.binding.reference));
      if (matches.length !== 1) throw new Error('World B query has an absent or ambiguous actual Source basis');
      const basis = matches[0];
      exact([basis.sourceId, basis.incarnation, basis.schema, basis.mappingRevision, basis.authorityRevision, basis.identityRule, basis.position, basis.snapshot, basis.gap],
        [binding.sourceId, binding.incarnation, binding.schema, binding.mapping.revision, binding.authority.revision, binding.identityRule, source.expectedPosition, source.expectedSnapshot, null], 'same real Source, scope-bound mapping, identity rule, cursor and snapshot');
      exact(basis.guarantee, 'authoritative', 'actual Source read guarantee');
      exact(receipt.freshness.filter(item => item.sourceId === binding.sourceId).map(item => item.satisfied), [true], 'actual Source freshness');
      if (!receipt.actualDependencies.some(dependency => dependency.kind === 'source' && isDeepStrictEqual(dependency.binding, source.binding.reference)
        && isDeepStrictEqual(dependency.position, source.expectedPosition))) throw new Error('World B query is missing its actual Source-position dependency');
    }
  }

  async confirmUiQuery() {
    if (!this.uiObjectRows) throw new Error('World B normal UI object rows were not captured; no backend request can replace them');
    const original = await this.readUiReceipt();
    this.verifyReceipt(original.receipt, { kind: 'authoritative' });
    const mode = { kind: 'after', receiptId: original.id };
    const readback = await this.read<QueryPage>('query', 'objects', this.queryRequest(mode));
    this.verifyQuery(readback, mode);
    if (readback.receipt.id === original.id) throw new Error('World B After read must have a separate receipt; never label it the original UI query');
    exact(readback.receipt.basis.map(({ observedAt, ...basis }) => {
      nonempty(observedAt, 'after-read observation timestamp'); return basis;
    }), original.receipt.basis.map(({ observedAt, ...basis }) => {
      nonempty(observedAt, 'UI observation timestamp'); return basis;
    }), 'After read preserves the original real cursor/snapshot basis');
    const display = (cell: unknown): string[] => {
      if (!record(cell)) throw new Error('World B invalid independent field cell');
      if (cell.kind === 'unknown') return ['Unknown', '未知'];
      if (cell.kind === 'conflicted') return ['Conflicting values', '存在冲突'];
      if (cell.kind === 'source_unavailable') return ['Source temporarily unavailable', '来源暂不可用'];
      if (cell.kind !== 'known' || !record(cell.value)) throw new Error('World B independent field cannot be rendered');
      if ('value' in cell.value) return [String(cell.value.value)];
      if (cell.value.kind === 'null') return ['Null', '空值'];
      return [JSON.stringify(cell.value)];
    };
    for (const [index, object] of readback.objects.entries()) {
      const row = this.uiObjectRows[index];
      exact(row.id, object.object.id, 'same actual original UI object and After-read identity');
      exact(row.cells.length, this.required().objectType.body.body.properties.length, 'all normal UI property columns');
      for (const [column, property] of this.required().objectType.body.body.properties.entries()) {
        const field = object.fields.find(field => isDeepStrictEqual(field.property, property));
        const allowed = field ? display(field.cell) : ['Not observed', '未观测'];
        if (!allowed.includes(row.cells[column])) throw new Error(`World B original UI field ${property.id} differs from the independent same-basis After read`);
      }
    }
    exact(await this.readUiReceipt(), original, 'normal UI still exposes the complete same original receipt after independent readback');
    await this.assertCurrent();
    return { receipt: original.receipt, objects: this.uiObjectRows, queryExact: true, sourceCount: original.receipt.basis.length,
      afterReceiptId: readback.receipt.id, originalReceiptId: original.id, originalCursor: this.synchronized!.projected, sameSnapshotBasis: true,
      uiRawRowsVerified: false, uiRawEvidenceVerified: false, afterRawPageVerified: true };
  }

  private async releaseOperationObservation(): Promise<void> {
    if (!this.observation) return;
    await this.observation.dispose(); this.observation = undefined;
  }
  async releaseObservations(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.releaseOperationObservation(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'World B read-only observation cleanup failed; original mutation identity/history were not changed');
  }
}
