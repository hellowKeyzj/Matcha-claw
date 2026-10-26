import { Ability } from '@serenity-js/core';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { licensedProfileRoot, repositoryRoot } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

type WorldRef = { tenantId: string; worldId: string };
type SourceRef = { world: WorldRef; sourceId: string; versionId: string };
type DraftRef = { world: WorldRef; runId: string; stepId: string; revision: string };
type Anchor = { kind: string; start?: string; end?: string };
type Coverage = { status: string; anchor: Anchor | null; reason?: { kind: string } };
type Evidence = { reference: { id: string }; locator: { sourceVersion: SourceRef; parseArtifactId: string | null; anchor: Anchor } };
type Source = { reference: SourceRef; blob: { digest: string; byteSize: string }; mediaType: string;
  access: { policyId: string; revision: string }; retention: { policyId: string; revision: string } };
type Artifact = { id: string; sourceVersion: SourceRef; world: WorldRef; blocks: Array<{ text: string }>; coverage: Coverage[];
  sourceMap: Array<{ anchor: Anchor; target: { kind: string; tableId?: string; row?: number; column?: number } }>;
  tables: Array<{ id: string; cells: Array<{ row: number; column: number; raw: string | null; value: unknown }> }>; metadata: Record<string, string> };
type Draft = {
  reference: DraftRef; baseRelease: string; scope: string; sourceVersions: SourceRef[]; parseArtifacts: string[];
  batch: { candidates: Array<{ id: string; world: WorldRef; origin: string; modelCalls: string[]; evidence: Evidence[]; changeSet: { operations: unknown[] } }>;
    evidence: Evidence[]; coverage: Coverage[]; observations: Array<{ origin: { kind: string; runId: string; modelCallId: string | null } }>; readNeeds: unknown[] };
};
type Receipt = {
  accepted: { world: WorldRef; operationId: string; incarnation: string }; phase: string; disclosure: { kind: string };
  progress: { runId: string | null; stage: string }; failure: { code: string; stage: string; diagnosticId: string; details: unknown } | null;
  result: { kind: string; result: { sourceVersions: SourceRef[]; parseArtifacts: string[]; drafts: DraftRef[]; candidates: string[] } } | null;
};
const world = { tenantId: 'local', worldId: 'personal' };
const name = 'world-a-materials-acceptance-20261024.txt';
const originalDigest = 'sha256:afed7c5521a17a16c678179b1cfc91182a26fda5a6e02072eb5e975370c399e4';
const budgetValues = ['90000', '100', '1', '1000', '1048576', '1', '16000', '8000'];
const orderInput = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21/world-order-evaluation-input-20261027-r1');
const materials = {
  reimbursement: { path: resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21/w07-materials-acceptance-20261024-93b', name), name,
    digest: originalDigest, byteSize: '93', mediaType: 'text/plain' },
  order: { path: resolve(orderInput, 'tool-memory-train.json'), name: 'tool-memory-train.json',
    digest: 'sha256:296608598081023969767712633ae0c06e9ffea3670f1803e108db3f767992da', byteSize: '43', mediaType: 'application/json' },
};
type MaterialKind = keyof typeof materials;
type ChatRouting = { revision: number; primary: { accountId: string; modelId: string } };
type Custody = {
  phase: string; world: WorldRef; profile: string; input: typeof materials.order; incarnation: string;
  active: { activeRelease: string; activeReleaseHead: unknown }; session: string[]; policy: { scope: string; access: string; retention: string };
  operationId: string | null; transferId: string | null; receipt: Receipt | null; chatRouting: ChatRouting;
};
type PublicFailure = { code: string; stage: string; message: string; diagnosticId: string; details: unknown; recovery: unknown };
type RejectionBasis = {
  world: WorldRef; status: string; incarnation: string; activeRelease: string; activeReleaseHead: unknown;
  task: unknown; catalog: Source[];
};
type RejectionObservation = {
  requestId: string | null; identity: Record<string, unknown> | null; failure: Record<string, unknown> | null;
  name: string; received: string | null; total: string | null; pending: boolean; incomplete: boolean; accepted: boolean;
};
type RejectionCustody = {
  attempt: 1; input: { name: string; mediaType: string; utf8: string; base64: string; digest: string; byteSize: string };
  basis: RejectionBasis; policy: { scope: string; access: string; retention: string }; budget: typeof rejectionBudget;
  previousRequestId: string | null; previousTransferId: string | null; transferId?: string; observation?: RejectionObservation;
  receipt?: { world: WorldRef; requestId: string; failure: PublicFailure }; upload?: unknown; operationId?: string;
  operationReads?: unknown[]; readback?: RejectionBasis;
};
const rejectionBudget = { maxWallTime: '90000', maxSteps: '100', maxSourceReads: '1', maxRows: '1000', maxBytes: '1048576',
  maxModelCalls: '0', maxInputTokens: '16000', maxOutputTokens: '8000' };
const rejectionTask = { world, id: 'task:order-line-total:20261026:r1', revision: '1' };
const rejectionCustodyPath = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21/world-upload-rejection-20261028-r1.custody.jsonl');

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World materials ${label} differs; keep original identities and do not resubmit`);
}
function isOriginalTextAnchor(anchor: Anchor | null, byteSize = '93'): boolean {
  return !!anchor && anchor.kind === 'text' && /^\d+$/.test(anchor.start ?? '') && /^\d+$/.test(anchor.end ?? '')
    && BigInt(anchor.start!) < BigInt(anchor.end!) && BigInt(anchor.end!) <= BigInt(byteSize);
}

export class WorldMaterials extends Ability {
  private original?: Buffer;
  private active?: { activeRelease: string; activeReleaseHead: unknown };
  private session: string[] = [];
  private attempted = false;
  private operationId?: string;
  private receipt?: Receipt;
  private source?: Source;
  private artifact?: Artifact;
  private draft?: Draft;
  private policy?: { scope: string; access: string; retention: string };
  private kind: MaterialKind = 'reimbursement';
  private incarnation?: string;
  private custodyPath?: string;
  private custody?: Custody;
  private chatRouting?: ChatRouting;
  private importRequestId?: string;
  private previousImportRequestId?: string;
  private rejection?: RejectionCustody;
  constructor(private readonly electron: UseElectron) { super(); }

  private async readChatRouting(): Promise<ChatRouting> {
    const reply = await this.electron.fetchHostApi({ path: '/api/provider-routing', method: 'GET', timeoutMs: 10_000 });
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) throw new Error('Public chat model routing is unreadable; no provider or model is selected by E2E');
    const body = reply.data.json as { routing: { revision: number; routes: Array<{ capability: string; primary: { accountId: string; modelId: string } }> } | null };
    const chat = body.routing?.routes.filter(route => route.capability === 'chat');
    if (chat?.length !== 1 || !chat[0]!.primary.accountId || !chat[0]!.primary.modelId) throw new Error('Existing default chat primary model is required');
    return { revision: body.routing!.revision, primary: chat[0]!.primary };
  }

  private async appendCustody(phase: string, create = false): Promise<void> {
    if (!this.custodyPath || !this.custody) return;
    this.custody.phase = phase;
    const file = await open(this.custodyPath, create ? 'wx' : 'a');
    const errors: unknown[] = [];
    try { await file.writeFile(`${JSON.stringify(this.custody)}\n`); await file.sync(); } catch (error) { errors.push(error); }
    try { await file.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Original materials custody write or close failed; no resend');
  }
  private async retainUploadIdentity(): Promise<string | undefined> {
    const ids = await this.electron.page.locator('main .world-workspace [role="tabpanel"] aside section:nth-child(2) .font-mono').allTextContents();
    if (!ids.length) return undefined;
    if (ids.length !== 1 || !ids[0]?.trim()) throw new Error('Original upload identity is ambiguous; no resend');
    const transferId = ids[0].trim();
    if (this.custody) {
      if (this.custody.transferId !== null) requireEqual(transferId, this.custody.transferId, 'retained original transfer identity');
      if (this.custody.transferId === null) {
        this.custody.transferId = transferId;
        await this.appendCustody('original-upload-observed');
      }
    }
    return transferId;
  }
  private async assertUploadDelivery(): Promise<void> {
    const panel = this.electron.page.getByRole('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true });
    const results = await panel.getByRole('region', { name: /^(Upload progress|上传进度)$/, exact: true }).evaluateAll(elements => elements.map(element => {
      const field = (record: Element | null, key: string) => Array.from(record?.children ?? [])
        .find(row => row.querySelector(':scope > dt')?.textContent?.trim() === key)?.querySelector(':scope > dd') ?? null;
      const identity = element.querySelector(':scope > div > dl');
      const scope = field(identity, 'world')?.querySelector('dl') ?? null;
      const alert = element.querySelector('[role="alert"]');
      const failure = alert?.querySelector('details > dl') ?? null;
      const details = field(failure, 'details')?.querySelector('dl') ?? null;
      return {
        requestId: element.getAttribute('data-material-import-request'),
        world: { tenantId: field(scope, 'tenantId')?.textContent?.trim(), worldId: field(scope, 'worldId')?.textContent?.trim() },
        pending: Array.from(element.querySelectorAll('[role="status"]')).some(status => /^(The result is unconfirmed\. Continue checking the original request\.|结果待核对，请使用原请求继续核对。)$/.test(status.textContent?.trim() ?? '')),
        incomplete: Array.from(element.querySelectorAll('span')).some(span => /^(Incomplete; check the receipt|未完成，请核对回执)$/.test(span.textContent?.trim() ?? '')),
        failure: alert ? {
          code: field(failure, 'code')?.textContent?.trim(), stage: field(failure, 'stage')?.textContent?.trim(),
          diagnosticId: field(failure, 'diagnosticId')?.textContent?.trim(), details: { kind: field(details, 'kind')?.textContent?.trim() },
          message: (alert.querySelector(':scope > p')?.textContent?.trim() ?? '').slice(0, 500),
        } : null,
      };
    }));
    if (!results.length) return;
    requireEqual(results.length, 1, 'single upload result');
    const result = results[0]!;
    if (result.requestId && result.requestId === this.previousImportRequestId) return;
    if (result.requestId) {
      requireEqual(result.world, world, 'import request World');
      if (this.importRequestId) requireEqual(result.requestId, this.importRequestId, 'same original import request');
      this.importRequestId = result.requestId;
      if (result.pending) throw new Error(`Original materials import ${result.requestId} remains unknown; preserve original custody without resubmission or deletion`);
      if (result.failure) {
        if (!result.failure.code || !result.failure.stage || !result.failure.diagnosticId || !result.failure.details.kind) {
          throw new Error('Original import failure diagnostic is incomplete; no business rejection is proved');
        }
        const outcome = result.failure.details.kind === 'transport' ? 'transport failed; business rejection is unproved' : 'rejected';
        throw new Error(`Original materials import ${result.requestId} ${outcome}: ${JSON.stringify(result.failure)}; preserve original custody without resubmission or deletion`);
      }
    } else if (result.pending) {
      throw new Error('Original upload remains unconfirmed before import submission; no business rejection is proved; preserve custody without resubmission or deletion');
    }
    if (result.incomplete) throw new Error('Original upload or import did not complete without a corresponding import failure; no business rejection is proved; preserve custody without resubmission or deletion');
  }
  private async exactCatalog(): Promise<Source[]> {
    const matches: Source[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page = await this.read('query', 'materials', { page: { limit: 100, cursor } }) as { items: Source[]; nextCursor: string | null };
      if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('Incomplete public materials catalog');
      matches.push(...page.items.filter(source => isDeepStrictEqual(source.blob, { digest: materials[this.kind].digest, byteSize: materials[this.kind].byteSize })));
      cursor = page.nextCursor;
      if (cursor !== null && (cursors.has(cursor) || !cursor)) throw new Error('Public materials catalog cursor did not advance');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    return matches;
  }

  private async read(endpoint: 'query' | 'operation', kind: string, request: unknown, responseKind = kind): Promise<unknown> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${endpoint}`, method: 'POST', timeoutMs: 10_000,
      body: endpoint === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World materials ${kind} transport failed: ${reply.error.code}; no mutation is retried`);
    const body = reply.data.json as { success?: boolean; data?: { kind: string; result: unknown }; error?: { code: string; stage: string; diagnosticId: string } };
    if (reply.data.status !== 200 || !reply.data.ok || body?.success !== true || body.data?.kind !== responseKind) {
      throw new Error(`World materials ${kind} read failed: HTTP ${reply.data.status}; ${JSON.stringify(body?.error ?? null)}`);
    }
    return body.data.result;
  }

  private sessionSelect() {
    return this.electron.page.getByRole('region', { name: /^(Processing records|处理记录)$/, exact: true })
      .getByRole('combobox', { name: /^(Records from this session|本次会话记录)$/, exact: true });
  }
  private async sessionIds(): Promise<string[]> {
    return this.sessionSelect().locator('option[value]:not([value=""])').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value));
  }
  async prepare(kind: MaterialKind = 'reimbursement') {
    if (this.original || this.attempted) throw new Error('An original materials attempt already exists; no second upload is allowed');
    this.kind = kind; const input = materials[kind];
    this.original = await readFile(input.path);
    requireEqual(String(this.original.length), input.byteSize, 'original byte size');
    requireEqual(`sha256:${createHash('sha256').update(this.original).digest('hex')}`, input.digest, 'author original digest');
    this.session = await this.sessionIds();
    const description = await this.read('query', 'discover', { includeCapabilities: false }) as { world: WorldRef; status: string; incarnation: string; activeRelease: string; activeReleaseHead: unknown };
    requireEqual(description.world, world, 'ready World');
    requireEqual(description.status, 'ready', 'ready status');
    this.active = { activeRelease: description.activeRelease, activeReleaseHead: description.activeReleaseHead };
    this.incarnation = description.incarnation;
    if (kind === 'order') {
      requireEqual(resolve(this.electron.profileRoot), resolve(licensedProfileRoot), 'dedicated licensed profile');
      requireEqual(JSON.parse(this.original.toString('utf8')), { kind: 'integer', value: '5997' }, 'unchanged JSON value');
      const guard = process.env.E2E_WORLD_MATERIALS_PACKAGE_RECEIPT?.trim();
      if (!guard) throw new Error('E2E_WORLD_MATERIALS_PACKAGE_RECEIPT must identify the signed guard.json file');
      this.custodyPath = resolve(dirname(resolve(guard)), 'world-order-materials.custody.jsonl');
      this.chatRouting = await this.readChatRouting();
      let history: string | undefined;
      try { history = await readFile(this.custodyPath, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (history !== undefined) {
        const records = history.trim().split('\n').map(line => JSON.parse(line) as Custody);
        const first = records[0]; this.custody = records.at(-1);
        if (!first || !this.custody) throw new Error('Original import custody is empty; no replay');
        for (const record of records) {
          requireEqual([record.world, record.profile, record.input, record.incarnation, record.session, record.policy, record.active, record.chatRouting],
            [world, resolve(licensedProfileRoot), materials.order, first.incarnation, first.session, first.policy, first.active, first.chatRouting], 'append-only original custody binding');
          if (record.operationId !== null) requireEqual(record.operationId, this.custody.operationId, 'retained original operation identity');
        }
        this.operationId = this.custody.operationId ?? undefined;
        if (!this.operationId) throw new Error('Original import delivery has no confirmed operation identity; no resend');
        requireEqual(description.incarnation, first.incarnation, 'same retained import incarnation');
        this.incarnation = first.incarnation; this.active = first.active; this.policy = first.policy; this.chatRouting = first.chatRouting; this.attempted = true;
        // Read the original receipt before looking at any current catalog or attempting UI restoration.
        await this.readOperation();
        return { existing: true };
      }
      const matches = await this.exactCatalog();
      if (matches.length) throw new Error(`Public catalog already has ${matches.length} exact43B source(s), but no original operation custody; read-only stop, no import`);
    }
    return { existing: false };
  }

  async selectPolicies(): Promise<void> {
    const panel = this.electron.page.getByRole('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true });
    const selected: string[] = [];
    for (const label of [/^(Business scope|业务范围)$/, /^(Access policy|访问策略)$/, /^(Retention policy|保留策略)$/]) {
      const select = panel.getByRole('combobox', { name: label, exact: true });
      const option = select.locator('option[value]:not([value=""]):not(:disabled)').first();
      const value = await option.getAttribute('value');
      if (!value) throw new Error('World materials requires an existing authorized scope/access/retention option; no authority is created');
      await select.selectOption(value);
      selected.push(value);
    }
    this.policy = { scope: selected[0]!, access: selected[1]!, retention: selected[2]! };
  }

  async upload(): Promise<void> {
    if (!this.original || !this.active || !this.policy || this.attempted) throw new Error('Original material upload is unprepared or already attempted');
    const panel = this.electron.page.getByRole('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true });
    const labels = [/^(Maximum time \(ms\)|最长时间（毫秒）)$/, /^(Processing steps|处理步骤)$/, /^(Source reads|来源读取次数)$/,
      /^(Maximum records|最大记录数)$/, /^(Bytes processed|处理字节数)$/, /^(Model calls|模型调用次数)$/,
      /^(Input tokens|输入 token)$/, /^(Output tokens|输出 token)$/];
    requireEqual(await Promise.all(labels.map(label => panel.getByRole('textbox', { name: label, exact: true }).inputValue())), budgetValues, 'finite UI budget');
    const previous = await panel.getByRole('region', { name: /^(Upload progress|上传进度)$/, exact: true })
      .evaluateAll(elements => elements.map(element => element.getAttribute('data-material-import-request')));
    if (previous.length > 1) throw new Error('Original upload result is ambiguous; no upload is submitted');
    this.previousImportRequestId = previous[0] ?? undefined;
    this.attempted = true;
    const input = materials[this.kind];
    if (this.kind === 'reimbursement') {
      await panel.locator('input[type="file"]').setInputFiles({ name: input.name, mimeType: input.mediaType, buffer: this.original });
      return;
    }
    this.custody = { phase: 'input-delivery-unknown', world, profile: resolve(licensedProfileRoot), input: materials.order,
      incarnation: this.incarnation!, active: this.active, session: this.session, policy: this.policy, operationId: null, transferId: null, receipt: null, chatRouting: this.chatRouting! };
    await this.appendCustody('input-delivery-unknown', true);
    const observation = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const state = { ids: [] as string[], error: '', dispose: () => undefined as void };
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (event: unknown) => void): () => void } } }).electron.ipcRenderer;
      state.dispose = ipc.on('host:event', event => {
        const envelope = event as { eventName?: string; payload?: { world?: WorldRef; incarnation?: string; resource?: { kind: string; id: string } } };
        const hint = envelope?.payload;
        if (!['world:changed', 'world:resync-required'].includes(envelope?.eventName ?? '') || hint?.world?.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || envelope.eventName === 'world:resync-required') { state.error = 'World event continuity lost'; return; }
        if (hint.resource?.kind === 'operation' && !state.ids.includes(hint.resource.id)) state.ids.push(hint.resource.id);
        if (state.ids.length > 1) state.error = 'Ambiguous original operation hints';
      });
      return state;
    }, { world, incarnation: this.incarnation });
    const errors: unknown[] = [];
    try {
      await panel.locator('input[type="file"]').setInputFiles({ name: input.name, mimeType: input.mediaType, buffer: this.original });
      const until = Date.now() + 30_000;
      while (true) {
        await this.retainUploadIdentity();
        const observed = await observation.evaluate(state => ({ ids: state.ids, error: state.error }));
        if (observed.ids.length === 1 && !this.operationId) {
          this.operationId = observed.ids[0];
          this.custody.operationId = this.operationId!;
          await this.appendCustody('original-operation-observed');
        }
        await this.assertUploadDelivery();
        if (observed.error) throw new Error(`${observed.error}; no resend`);
        if (observed.ids.length === 1) break;
        if (Date.now() >= until) throw new Error('Original import operation was not observed within 30 seconds; preserve custody, no resend');
        await setTimeout(100);
      }
    } catch (error) { errors.push(error); }
    finally {
      try { await this.retainUploadIdentity(); } catch (error) { errors.push(error); }
      try {
        const observed = await observation.evaluate(state => ({ ids: state.ids, error: state.error }));
        if (observed.ids.length === 1 && !observed.error) this.operationId = observed.ids[0];
        this.custody.operationId = this.operationId ?? null;
        await this.appendCustody(observed.error || (this.operationId ? 'original-operation-observed' : 'delivery-unknown'));
      } catch (error) { errors.push(error); }
      try { await observation.evaluate(state => state.dispose()); } catch (error) { errors.push(error); }
      try { await observation.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Original JSON import or observer cleanup failed; append-only custody retained, no resend');
  }

  async readRetainedOrderUpload() {
    requireEqual(resolve(this.electron.profileRoot), resolve(licensedProfileRoot), 'dedicated licensed profile');
    const guard = process.env.E2E_WORLD_MATERIALS_PACKAGE_RECEIPT?.trim();
    if (!guard) throw new Error('Original signed package guard is required for upload readback');
    const history = await readFile(resolve(dirname(resolve(guard)), 'world-order-materials.custody.jsonl'), 'utf8');
    const records = history.trim().split('\n').map(line => JSON.parse(line) as Custody);
    const first = records[0];
    if (!first || !history.endsWith('\n')) throw new Error('Complete original import custody is required');
    for (const record of records) {
      requireEqual([record.world, record.profile, record.input, record.incarnation, record.active],
        [world, resolve(licensedProfileRoot), materials.order, first.incarnation, first.active], 'original upload custody');
      requireEqual(record.operationId, null, 'unconfirmed original import identity');
    }
    const before = await this.read('query', 'discover', { includeCapabilities: false }) as {
      world: WorldRef; status: string; incarnation: string; activeRelease: string; activeReleaseHead: unknown;
    };
    requireEqual([before.world, before.status, before.incarnation, before.activeRelease, before.activeReleaseHead],
      [world, 'ready', first.incarnation, first.active.activeRelease, first.active.activeReleaseHead], 'original upload World basis');
    // Exact upload ID observed in the original failed attempt's World UI trace.
    const transferId = 'upload-3b2b56699340123024f1b1bde1d1ec8628dfb9f6890a7cfd1c94f6d763b28a16';
    const upload = await this.read('query', 'upload_status', { transferId }, 'upload') as {
      transferId: string; received: string; state: { kind: string; blob?: { digest: string; byteSize: string } };
    };
    requireEqual(upload.transferId, transferId, 'original trace upload identity');
    requireEqual(upload.received, materials.order.byteSize, 'original upload received bytes');
    requireEqual(upload.state, { kind: 'sealed', blob: { digest: materials.order.digest, byteSize: materials.order.byteSize } }, 'original upload sealed content');
    const after = await this.read('query', 'discover', { includeCapabilities: false }) as typeof before;
    requireEqual([after.world, after.status, after.incarnation, after.activeRelease, after.activeReleaseHead],
      [before.world, before.status, before.incarnation, before.activeRelease, before.activeReleaseHead], 'unchanged upload readback basis');
    return { transferId, sealed: true, byteSize: upload.received, digest: upload.state.blob!.digest, importAcceptanceProved: false };
  }

  async readUpload() {
    if (!this.attempted) throw new Error('No material upload attempt exists');
    const transferId = await this.retainUploadIdentity();
    await this.assertUploadDelivery();
    if (!transferId) throw new Error('Original upload identity is not visible; preserve unknown custody, do not retry or delete');
    const upload = await this.read('query', 'upload_status', { transferId }, 'upload') as {
      transferId: string; received: string; state: { kind: string; blob?: { digest: string; byteSize: string } };
    };
    requireEqual(upload.transferId, transferId, 'same upload transfer');
    const input = materials[this.kind];
    requireEqual(upload.received, input.byteSize, 'uploaded byte count');
    requireEqual(upload.state, { kind: 'sealed', blob: { digest: input.digest, byteSize: input.byteSize } }, 'sealed original bytes');
    if (this.custody && this.operationId) {
      this.custody.transferId = transferId;
      const original = await this.read('operation', 'result', { world, operationId: this.operationId }) as Receipt;
      requireEqual([original.accepted.world, original.accepted.operationId, original.accepted.incarnation], [world, this.operationId, this.incarnation], 'same upload operation receipt');
      this.custody.receipt = original;
      await this.appendCustody('sealed-upload-original-receipt');
    }
    await this.assertUploadDelivery();
    const panel = this.electron.page.getByRole('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true });
    const result = panel.getByRole('region', { name: /^(Upload progress|上传进度)$/, exact: true });
    if (!this.importRequestId || await result.getAttribute('data-material-import-request') !== this.importRequestId
      || !await result.getByText(/^(Materials uploaded; import accepted|资料已上传，导入已受理)$/, { exact: true }).count()) {
      throw new Error(`Original materials upload ${transferId} is sealed but import acceptance is unconfirmed; preserved without resubmission or deletion`);
    }
    return { transferId, sealed: true, byteSize: input.byteSize, digest: input.digest };
  }

  async selectOperation(): Promise<void> {
    const ids = await this.sessionIds();
    if (this.custody && this.operationId) {
      if (ids.includes(this.operationId)) await this.sessionSelect().selectOption(this.operationId);
      else {
        const records = this.electron.page.getByRole('region', { name: /^(Processing records|处理记录)$/, exact: true });
        const history = records.locator('details').filter({ has: this.electron.page.getByRole('textbox', { name: /^(Operation ID|处理编号)$/, exact: true }) });
        if (await history.getAttribute('open') === null) await history.locator(':scope > summary').click();
        await history.getByRole('textbox', { name: /^(Operation ID|处理编号)$/, exact: true }).fill(this.operationId);
        await history.getByRole('button', { name: /^(Look up|查询)$/, exact: true }).click();
      }
      return;
    }
    const added = ids.filter(id => !this.session.includes(id));
    if (added.length !== 1) throw new Error(`Expected exactly one original import operation, found ${added.length}; no new request is sent`);
    this.operationId = added[0];
    await this.sessionSelect().selectOption(this.operationId!);
  }
  async readOperation() {
    if (!this.operationId) throw new Error('No owned material operation identity');
    const receipt = await this.read('operation', 'result', { world, operationId: this.operationId }) as Receipt;
    requireEqual(receipt.accepted.world, world, 'operation World');
    requireEqual(receipt.accepted.operationId, this.operationId, 'original operation');
    this.receipt = receipt;
    if (this.custody) {
      requireEqual(receipt.accepted.incarnation, this.incarnation, 'original operation incarnation');
      if (this.custody.receipt?.phase === 'completed') requireEqual(receipt, this.custody.receipt, 'original confirmed receipt');
      this.custody.receipt = receipt;
      await this.appendCustody('original-operation-readback');
    }
    if (receipt.phase !== 'completed' || receipt.failure) {
      throw new Error(`Original materials operation ${this.operationId}: ${receipt.phase}; stage=${receipt.progress.stage}; ${JSON.stringify(receipt.failure)}; preserved without resume or resubmission`);
    }
    requireEqual(receipt.disclosure.kind, 'full', 'full material result');
    requireEqual(receipt.result?.kind, 'materials', 'material operation result');
    const result = receipt.result!.result;
    requireEqual([result.sourceVersions.length, result.parseArtifacts.length, result.drafts.length], [1, 1, 1], 'single original source/artifact/draft');
    requireEqual(result.candidates, [], 'no Task or compile submission');
    await this.appendCustody('operation-confirmed');
    return { operationId: this.operationId, phase: receipt.phase, sourceCount: result.sourceVersions.length,
      artifactCount: result.parseArtifacts.length, draftCount: result.drafts.length };
  }

  async readParse() {
    const result = this.receipt?.result?.result;
    if (!result || !this.original) throw new Error('Completed original materials receipt required before parse readback');
    const source = await this.read('query', 'source_version', { reference: result.sourceVersions[0] }) as Source;
    requireEqual(source.reference, result.sourceVersions[0], 'source version');
    requireEqual(source.reference.world, world, 'source World');
    const input = materials[this.kind];
    requireEqual(source.blob, { digest: input.digest, byteSize: input.byteSize }, 'original content');
    requireEqual(source.mediaType, input.mediaType, 'original source media type');
    requireEqual(`${source.access.policyId}:${source.access.revision}`, this.policy?.access, 'selected existing access policy');
    requireEqual(`${source.retention.policyId}:${source.retention.revision}`, this.policy?.retention, 'selected existing retention policy');
    const artifact = await this.read('query', 'parse_artifact', { id: result.parseArtifacts[0] }) as Artifact;
    requireEqual(artifact.world, world, 'parse World');
    requireEqual(artifact.id, result.parseArtifacts[0], 'parse artifact');
    requireEqual(artifact.sourceVersion, source.reference, 'parse original source');
    requireEqual(artifact.blocks.map(block => block.text).join('\n').trim(), this.original.toString('utf8').trim(), 'complete parsed original text');
    if (!artifact.coverage.length || artifact.coverage.some(item => item.status !== 'processed' || !isOriginalTextAnchor(item.anchor, input.byteSize))
      || !artifact.sourceMap.length || artifact.sourceMap.some(item => !isOriginalTextAnchor(item.anchor, input.byteSize))) {
      throw new Error('Original text parsing requires processed coverage and real UTF-8 source anchors, not merely a seal receipt');
    }
    if (this.kind === 'order') {
      requireEqual(artifact.coverage, [{ anchor: { kind: 'text', start: '0', end: '43' }, status: 'processed', reason: { kind: 'parsed' } }], 'complete JSON parse coverage');
      requireEqual([artifact.metadata['column.1'], artifact.metadata['column.2']], ['kind', 'value'], 'JSON field columns');
      requireEqual(artifact.tables.length, 1, 'single JSON table');
      const table = artifact.tables[0]!;
      requireEqual(table.cells.map(cell => [cell.row, cell.column, cell.raw, cell.value]),
        [[1, 1, '"integer"', { kind: 'text', value: 'integer' }], [1, 2, '"5997"', { kind: 'text', value: '5997' }]], 'actual JSON string cells');
      for (const cell of table.cells) {
        const maps = artifact.sourceMap.filter(entry => entry.target.kind === 'cell' && entry.target.tableId === table.id
          && entry.target.row === cell.row && entry.target.column === cell.column);
        requireEqual(maps.length, 1, 'exact JSON cell source map');
        requireEqual(this.original.subarray(Number(maps[0]!.anchor.start), Number(maps[0]!.anchor.end)).toString('utf8'), cell.raw, 'original JSON cell token');
      }
    }
    this.source = source; this.artifact = artifact;
    return { exactOriginal: true, covered: true, sourceValue: JSON.stringify(source.reference), artifactId: artifact.id,
      versionId: source.reference.versionId, digest: source.blob.digest };
  }

  private async assertReleaseUnchanged(): Promise<void> {
    const description = await this.read('query', 'discover', { includeCapabilities: false }) as { activeRelease: string; activeReleaseHead: unknown };
    requireEqual({ activeRelease: description.activeRelease, activeReleaseHead: description.activeReleaseHead }, this.active, 'unchanged active release');
  }
  async readDraft() {
    const reference = this.receipt?.result?.result.drafts[0];
    if (!reference || !this.source || !this.artifact) throw new Error('Original source and parse proof required before draft readback');
    const draft = await this.read('query', 'material_draft', reference) as Draft;
    requireEqual(draft.reference, reference, 'exact persisted draft revision');
    requireEqual(draft.reference.world, world, 'draft World');
    requireEqual(draft.reference.runId, this.receipt!.progress.runId, 'completed extraction run');
    requireEqual(draft.sourceVersions, [this.source.reference], 'draft original source');
    requireEqual(draft.parseArtifacts, [this.artifact.id], 'draft original parser');
    requireEqual(draft.baseRelease, this.active!.activeRelease, 'draft baseline');
    requireEqual(draft.scope, this.policy?.scope, 'selected existing material scope');
    const batch = draft.batch;
    if (this.kind === 'reimbursement' && !batch.candidates.length) throw new Error('Completed import has no persistent extraction candidate; upload/seal is not World A completion');
    for (const candidate of batch.candidates) {
      requireEqual(candidate.world, world, 'candidate World');
      requireEqual(candidate.origin, 'extraction', 'real extraction origin');
      if (!candidate.id || !candidate.modelCalls.length || !candidate.evidence.length || !candidate.changeSet.operations.length) {
        throw new Error('Persistent candidate lacks semantic operations, original evidence or real Generation model-call identity');
      }
    }
    const calls = new Set(batch.candidates.flatMap(candidate => candidate.modelCalls));
    if (this.kind === 'order') for (const observation of batch.observations) {
      requireEqual([observation.origin.kind, observation.origin.runId], ['extraction', draft.reference.runId], 'same-run extraction observation');
      if (!observation.origin.modelCallId) throw new Error('Extraction observation has no real model call identity');
      calls.add(observation.origin.modelCallId);
    }
    if (this.kind === 'reimbursement' || calls.size > 0) requireEqual(calls.size, 1, 'single budgeted Generation identity');
    const evidence = [...batch.evidence, ...batch.candidates.flatMap(candidate => candidate.evidence)];
    if ((this.kind === 'reimbursement' && !evidence.length) || evidence.some(item => !isDeepStrictEqual(item.locator.sourceVersion, this.source!.reference)
      || item.locator.parseArtifactId !== this.artifact!.id || !isOriginalTextAnchor(item.locator.anchor, materials[this.kind].byteSize))) {
      throw new Error('Candidate evidence must point to the exact original source, parse artifact and real UTF-8 text range');
    }
    for (const clause of this.kind === 'reimbursement' ? this.original!.toString('utf8').trim().split(/\r?\n/).slice(1) : []) {
      if (!evidence.some(item => this.original!.subarray(Number(item.locator.anchor.start), Number(item.locator.anchor.end)).toString('utf8').includes(clause))) {
        throw new Error('Original business clause has no supporting candidate evidence at its real source byte range');
      }
    }
    if (!batch.coverage.length || batch.coverage.some(item => item.status !== 'processed' || !isOriginalTextAnchor(item.anchor, materials[this.kind].byteSize))) {
      throw new Error('Extraction/alignment requires processed original-source location coverage');
    }
    requireEqual(batch.readNeeds, [], 'no unresolved source reads');
    await this.assertReleaseUnchanged();
    this.draft = draft;
    return { candidates: batch.candidates.length, modelCalls: calls.size, evidence: evidence.length,
      coverage: batch.coverage.length, readNeeds: batch.readNeeds.length, activeReleaseUnchanged: true };
  }

  async readOrderSource() {
    if (this.kind !== 'order' || !this.source || !this.artifact || !this.draft || !this.receipt) throw new Error('Completed original JSON import, parse and aligned draft are required');
    const matches = await this.exactCatalog();
    requireEqual(matches.length, 1, 'unique exact43B in complete public catalog');
    requireEqual(matches[0], this.source, 'catalog exact source from original operation');
    requireEqual(await this.read('query', 'source_version', { reference: this.source.reference }), this.source, 'whole exact public source version');
    const currentRouting = await this.readChatRouting();
    requireEqual(currentRouting, this.chatRouting, 'unchanged public default chat routing');
    await this.appendCustody('exact-source-confirmed');
    return { exactSourceVersion: this.source.reference, byteSize: this.source.blob.byteSize, digest: this.source.blob.digest,
      catalogMatches: matches.length, operationId: this.operationId!, complete: true, candidates: this.draft.batch.candidates.length,
      chatRouting: currentRouting, generationReceiptPubliclyVisible: false };
  }

  private async appendRejectionCustody(phase: string, create = false): Promise<void> {
    const file = await open(rejectionCustodyPath, create ? 'wx' : 'a');
    const errors: unknown[] = [];
    try { await file.writeFile(`${JSON.stringify({ phase, ...this.rejection })}\n`); await file.sync(); } catch (error) { errors.push(error); }
    try { await file.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Upload rejection custody failed; preserve this attempt without resubmission');
  }

  private async rejectionBasis(): Promise<RejectionBasis> {
    const description = await this.read('query', 'discover', { includeCapabilities: false }) as RejectionBasis;
    requireEqual([description.world, description.status], [world, 'ready'], 'rejection World basis');
    const task = await this.read('query', 'task_contract', rejectionTask) as { world: WorldRef; id: string; revision: string } | null;
    if (!task) throw new Error('Original order Task is required; no Task is created or authorized');
    requireEqual([task.world, task.id, task.revision], [world, rejectionTask.id, rejectionTask.revision], 'original order Task identity');
    const catalog: Source[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page = await this.read('query', 'materials', { page: { limit: 100, cursor } }) as { items: Source[]; nextCursor: string | null };
      if (!Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('Incomplete rejection materials catalog');
      catalog.push(...page.items);
      cursor = page.nextCursor;
      if (cursor !== null && (!cursor || cursors.has(cursor))) throw new Error('Rejection materials catalog cursor did not advance');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    requireEqual(new Set(catalog.map(source => JSON.stringify(source.reference))).size, catalog.length, 'complete unique materials catalog');
    return { world: description.world, status: description.status, incarnation: description.incarnation, activeRelease: description.activeRelease,
      activeReleaseHead: description.activeReleaseHead, task, catalog };
  }

  private async rejectionObservation(): Promise<RejectionObservation | undefined> {
    const panel = this.electron.page.getByRole('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true });
    const results = await panel.getByRole('region', { name: /^(Upload progress|上传进度)$/, exact: true }).evaluateAll(elements => elements.map(element => {
      // This Failure contains nested records and string leaves, exactly as FixedRecord renders them.
      const record = (dl: Element | null): Record<string, unknown> | null => dl ? Object.fromEntries(Array.from(dl.children).map(row => {
        const value = row.querySelector(':scope > dd');
        const nested = value?.querySelector(':scope > dl') ?? null;
        return [row.querySelector(':scope > dt')?.textContent?.trim() ?? '', nested ? record(nested) : value?.textContent?.trim()];
      })) : null;
      const status = element.querySelector(':scope > [role="status"]');
      const progress = status?.querySelector('progress');
      return {
        requestId: element.getAttribute('data-material-import-request'), identity: record(element.querySelector(':scope > div > dl')),
        failure: record(element.querySelector('[role="alert"] details > dl')),
        name: status?.querySelector(':scope > span')?.firstChild?.textContent?.trim() ?? '',
        received: progress?.getAttribute('value') ?? null, total: progress?.getAttribute('max') ?? null,
        pending: Array.from(element.querySelectorAll('[role="status"]')).some(item => /^(The result is unconfirmed\. Continue checking the original request\.|结果待核对，请使用原请求继续核对。)$/.test(item.textContent?.trim() ?? '')),
        incomplete: Array.from(element.querySelectorAll('span')).some(item => /^(Incomplete; check the receipt|未完成，请核对回执)$/.test(item.textContent?.trim() ?? '')),
        accepted: Array.from(element.querySelectorAll('span')).some(item => /^(Materials uploaded; import accepted|资料已上传，导入已受理)$/.test(item.textContent?.trim() ?? '')),
      };
    }));
    if (results.length > 1) throw new Error('Ambiguous public upload rejection regions; no resend');
    return results[0];
  }

  async uploadZeroModelRejection(): Promise<void> {
    if (this.rejection || this.attempted || this.original || !this.policy) throw new Error('Zero-model rejection is unprepared or already attempted; no resend');
    const utf8 = '上传拒绝 2026-10-28 r1\n';
    const bytes = Buffer.from(utf8, 'utf8');
    const input = { name: 'world-upload-rejection-20261028-r1.txt', mediaType: 'text/plain', utf8, base64: bytes.toString('base64'),
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteSize: String(bytes.length) };
    const previous = await this.rejectionObservation();
    const previousTransferId = await this.retainUploadIdentity();
    const basis = await this.rejectionBasis();
    if (basis.catalog.some(source => source.blob.digest === input.digest)) throw new Error('Synthetic rejection material already exists; no upload');
    this.rejection = { attempt: 1, input, basis, policy: { ...this.policy }, budget: rejectionBudget,
      previousRequestId: previous?.requestId ?? null, previousTransferId: previousTransferId ?? null };
    this.attempted = true;
    // wx + sync precedes the only file input action; an existing/unknown attempt can never be retried by a fresh run.
    await this.appendRejectionCustody('input-delivery-unknown', true);
    try {
      await this.electron.page.getByRole('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true })
        .locator('input[type="file"]').setInputFiles({ name: input.name, mimeType: input.mediaType, buffer: bytes });
      const until = Date.now() + 30_000;
      while (true) {
        const observation = await this.rejectionObservation();
        const transferId = await this.retainUploadIdentity();
        if (!isDeepStrictEqual([observation, transferId], [this.rejection.observation, this.rejection.transferId])) {
          this.rejection.observation = observation; this.rejection.transferId = transferId;
          await this.appendRejectionCustody('public-upload-observed');
        }
        if (observation?.requestId && observation.requestId !== this.rejection.previousRequestId && observation.failure) return;
        if (observation?.name === input.name && (observation.pending || observation.accepted || observation.incomplete)) {
          throw new Error('This upload is unknown, accepted or incomplete without its own business Failure; preserve custody, no resend');
        }
        if (Date.now() >= until) throw new Error('No same-request public rejection within 30 seconds; preserve unknown custody, no resend');
        await setTimeout(100);
      }
    } catch (error) {
      try { await this.appendRejectionCustody('unconfirmed-or-failed-no-resend'); }
      catch (custodyError) { throw new AggregateError([error, custodyError], 'Upload rejection and custody both failed; no resend'); }
      throw error;
    }
  }

  async readZeroModelRejection(refreshed = false) {
    const custody = this.rejection;
    if (!custody) throw new Error('No zero-model rejection attempt exists');
    const observation = await this.rejectionObservation();
    const transferId = await this.retainUploadIdentity();
    custody.observation = observation;
    if (refreshed) requireEqual(transferId, custody.transferId, 'refresh retained same rejection transfer');
    if (transferId) custody.transferId = transferId;
    await this.appendRejectionCustody(refreshed ? 'refresh-public-observed' : 'rejection-public-observed');
    if (!observation?.requestId || observation.requestId === custody.previousRequestId || !observation.failure
      || !transferId || transferId === custody.previousTransferId) throw new Error('A fresh same-request rejection and transfer are required; no resend');
    requireEqual(observation.identity, { world, requestId: observation.requestId }, 'public rejection World/requestId');
    requireEqual([observation.name, observation.received, observation.total, observation.pending, observation.incomplete, observation.accepted],
      [custody.input.name, custody.input.byteSize, custody.input.byteSize, false, true, false], 'rejected input, not import acceptance or unknown');
    const failure = observation.failure as PublicFailure;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(failure.diagnosticId ?? '')) throw new Error('Public rejection diagnosticId is missing');
    requireEqual(failure, { code: 'world.material.failed', stage: 'parse', message: '资料处理失败。', diagnosticId: failure.diagnosticId,
      details: { kind: 'operation', failure: { kind: 'material', failure: { kind: 'input_invalid' } } }, recovery: { kind: 'refresh' } }, 'complete business_input_invalid Failure, not transport');
    const receipt = { world, requestId: observation.requestId, failure };
    if (refreshed) requireEqual(receipt, custody.receipt, 'refresh retained identical World/requestId/full Failure');
    else custody.receipt = receipt;
    const upload = await this.read('query', 'upload_status', { transferId }, 'upload') as {
      transferId: string; received: string; state: { kind: string; blob?: { digest: string; byteSize: string } };
    };
    custody.upload = upload;
    await this.appendRejectionCustody('sealed-transfer-read');
    requireEqual([upload.transferId, upload.received, upload.state], [transferId, custody.input.byteSize,
      { kind: 'sealed', blob: { digest: custody.input.digest, byteSize: custody.input.byteSize } }], 'same rejection sealed synthetic bytes');
    // Current Rust ledger::operation_id oracle, not a public requestId lookup contract.
    const operationId = `operation-${createHash('sha256').update(JSON.stringify(['world.operation.v1', world, receipt.requestId, 'materials.import'])).digest('hex')}`;
    custody.operationId = operationId; custody.operationReads = [];
    for (const kind of ['status', 'result']) {
      const reply = await this.electron.fetchHostApi({ path: '/api/world/operation', method: 'POST', timeoutMs: 10_000,
        body: { kind, request: { world, operationId } } });
      if (!reply.ok) throw new Error(`Rejection operation ${kind} transport failed; absence is unproved`);
      const body = reply.data.json as { success: boolean; error?: PublicFailure };
      custody.operationReads.push({ kind, status: reply.data.status, body });
      await this.appendRejectionCustody(`operation-${kind}-read`);
      const missing = body?.error;
      if (reply.data.ok || reply.data.status !== 422 || body?.success !== false || !missing?.diagnosticId) throw new Error('Rejection operation absence is unproved');
      requireEqual(missing, { code: 'world.operation_not_found', stage: 'read', message: '操作不存在或当前不可访问。', diagnosticId: missing.diagnosticId,
        details: { kind: 'not_found' }, recovery: { kind: 'none' } }, 'no native acceptance for this import request');
    }
    custody.readback = await this.rejectionBasis();
    await this.appendRejectionCustody(refreshed ? 'refresh-readback' : 'rejection-readback');
    requireEqual(custody.readback, custody.basis, 'unchanged incarnation/original Task/active release/complete materials catalog');
    await this.appendRejectionCustody(refreshed ? 'refresh-rejection-confirmed' : 'business-rejection-confirmed');
    return { ...receipt, transferId, digest: custody.input.digest, byteSize: custody.input.byteSize, sealed: true,
      outcome: 'business_input_invalid', operationAccepted: false, taskUnchanged: true, activeReleaseUnchanged: true, catalogUnchanged: true };
  }

  async readRefresh() {
    if (!this.source || !this.artifact || !this.draft || !this.receipt || !this.operationId) throw new Error('No completed original draft to refresh');
    requireEqual(await this.read('query', 'source_version', { reference: this.source.reference }), this.source, 'refreshed whole source');
    requireEqual(await this.read('query', 'parse_artifact', { id: this.artifact.id }), this.artifact, 'refreshed whole parse');
    requireEqual(await this.read('query', 'material_draft', this.draft.reference), this.draft, 'refreshed whole candidate draft and evidence');
    requireEqual(await this.read('operation', 'result', { world, operationId: this.operationId }), this.receipt, 'refreshed same final receipt');
    await this.assertReleaseUnchanged();
    return { exact: true, activeReleaseUnchanged: true };
  }
}
