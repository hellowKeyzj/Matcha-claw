import { Ability } from '@serenity-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { appProjectRoot, electronMain, licensedProfileRoot, repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

type World = { tenantId: string; worldId: string };
type Failure = { code: string; stage: string; diagnosticId: string; details?: unknown; operationId?: string };
type Envelope = { success: true; data: { kind: string; result: unknown } } | { success: false; error: Failure };
type Contract = { id: string; version: string };
type Manifest = {
  identity: { id: string; publisher: string; version: string }; format: string;
  artifacts: { id: string; kind: string; runtime: string; digest: string; entrypoint: unknown }[];
  provides: { slot: string; providerId: string; artifactId: string; trust: string; contracts: Contract[] }[];
  requestedAccess: unknown[]; requires: unknown[]; state: unknown[];
  config: { fields: { name: string; valueType: { kind: string }; default?: unknown }[] };
};
type Installed = { world: World; installId: string; revision: string; packageDigest: string; transportDigest: string; manifest: Manifest; trust: { policyRevision: string; packageDigest: string } };
type Config = { installId: string; revision: string; digest: string; fields: { name: string; value: unknown }[] };
type Policy = { revision: string; trustedProcessDigests: string[]; trustedNativeDigests: string[]; trustedPublishers: unknown[]; unsignedWasm: unknown };
type Head = { world: World; channel: string; activationLockId: string; generation: string; revision: string };
type Node = { id: string; bindingId: string; slot: string; providerId: string; trust: string; required: boolean; state?: unknown; implementation: { installId: string; packageDigest: string; artifactId: string; artifactDigest: string; configDigest: string; entrypoint: unknown; contracts: Contract[]; dependencyLock: string }; ports: { name: string; direction: string; contract: Contract; requestSchema: string; resultSchema: string; required: boolean }[] };
type Graph = { world: World; id: string; digest: string; nodes: Node[]; edges: unknown[]; roots: string[]; trustedRoots: string[]; compositions: unknown[] };
type Plan = { graph: Graph; channels: { bindingId: string; channel: string }[]; heads: { world: World; channel: string; expected?: Head | null; replacement: string }[] };
type Description = { world: World; status: string; incarnation: string; activeRelease?: string | null; activeReleaseHead?: unknown };
type Receipt = { accepted: { world: World; operationId: string; incarnation: string; revision: string }; phase: string; disclosure: { kind: string }; progress: { stage: string }; commit: unknown; effects: unknown[]; failure?: Failure | null; result?: { kind: string; result: unknown } | null; updatedAt: string };
type Command = { kind: string; operationKey: { world: World; operationId: string } | null; outcome: string; receipt?: Receipt; uiAlerts?: string[]; uiRejection?: { text: string; diagnostic: string; details: unknown } };
type ResumeNote = { phase: string; operationKeys: NonNullable<Command['operationKey']>[]; commands: Command[]; retained: boolean };
type ActivationAuthorization = { world: World; commitId: string; committedAt: string; revisions: unknown[]; outboxIds: unknown[]; fence: { world: World; domain: string; epoch: string } };
type ActivationContinuation = { activationEvidencePath: string; repairedHostReceiptPath: string };
type ActivationNote = ResumeNote & { world: World; packageDigest: string; transportDigest: string; manifest: Manifest; installId: string; lockId: string; channel: string; graph: Graph; implementation: Node['implementation']; ports: Node['ports']; activationAuthorization: ActivationAuthorization; resumedEvidence: { sourcePath: string; original: ResumeNote }; headBefore: Head | null; headAfter?: Head };
type FileRecord = { path: string; bytes: number; sha256: string };
type HostBuild = { success: boolean; failure: unknown; terminals: { label: string; code: number; signal: unknown; startedAt: string; finishedAt: string }[]; artifacts: { name: string; source: FileRecord; target: FileRecord; extension: string; pe64: boolean; exact: boolean; sourceSeal: string }[]; inputSha256Before: string; inputSha256After: string; changedInputs: unknown[]; inputPresenceUnchanged: boolean; formalUnchanged: boolean; frozenUnchanged: boolean; fixFreeze: { files: FileRecord[] } };
type ActivationCustody = { sourcePath: string; sourceSha256: string; repairedHostReceiptPath: string; repairedHostSha256: string; graph: Graph; command: Command };
type Observation = { ids: string[]; error?: string; dispose(): void };
type Locator = ReturnType<UseElectron['page']['locator']>;
type UploadReceipt = { transferId: string; received: string; revision: string; expiresAt: string; state: { kind: string; blob?: { byteSize: string; digest: string } } };
type UploadAttempt = {
  filename: string; digest: string; phase: string; attempts: number; previousOperations: string[]; previousSubmissions: string[];
  before: { inventory: Installed[]; world: Description }; submission?: { world: World; requestId: string; kind: string };
  transferId?: string; upload?: UploadReceipt; operationKey?: { world: World; operationId: string }; status?: Receipt; receipt?: Receipt;
  unchanged?: { inventory: boolean; activeRelease: boolean }; refreshed?: boolean;
};
type OriginalUploadIdentity = { world: World; requestId: string; commandKind: string; transferId: string; operationId: string; byteSize: string; digest: string };
type OriginalUploadReadback = {
  identity: OriginalUploadIdentity; attempts: number; sameIdentity: boolean; full: boolean; statusResultEqual: boolean; refreshed: boolean;
  actualPhase?: string; failure?: Failure | null; status?: Receipt; receipt?: Receipt; upload?: UploadReceipt;
  reads?: { kind: string; value?: unknown; error?: { message: string; failure: unknown } }[];
};
const world: World = { tenantId: 'local', worldId: 'personal' };
const nodeId = 'order-evaluation';
const bindingId = 'order-evaluation';
const terminal = ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'commit_indeterminate', 'effect_indeterminate', 'retained'];
function equal(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World package setup ${label} mismatch`);
}
function hash(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

export class WorldPackageSetup extends Ability {
  private phase = 'idle';
  private incarnation = '';
  private commands: Command[] = [];
  private resumedCommands: Command[] = [];
  private resumedEvidence?: { sourcePath: string; original: ResumeNote; readback: { kind: string; receipt: Receipt }[]; originalRejection?: { source: string; message: string } };
  private activationAuthorization?: ActivationAuthorization;
  private activationEvidence?: { sourcePath: string; original: ActivationNote; readback?: Receipt; custodyPath: string; custody?: ActivationCustody; repairedHost?: { receiptPath: string; artifact: FileRecord; platformSource: FileRecord } };
  private custodyReserved = false;
  private result: Partial<{ world: World; packagePath: string; packageDigest: string; transportDigest: string; manifest: Manifest; installId: string; lockId: string; channel: string; headBefore: Head | null; headAfter: Head; graph: Graph; implementation: Node['implementation']; ports: Node['ports']; config: Config; installedRecord: Installed; trustPolicy: Policy; worldBefore: Description; worldAfter: Description }> = {};
  private uploadAttempt?: UploadAttempt;
  private originalUpload?: OriginalUploadReadback;
  constructor(private readonly electron: UseElectron) { super(); }
  private get workspace() { return this.electron.page.locator('main .world-workspace'); }
  private get detail() { return this.workspace.locator('aside.world-detail-panel'); }
  private get bindings() { return this.workspace.locator('section.world-section').filter({ has: this.electron.page.getByRole('heading', { name: /^(能力绑定|Capability bindings)$/, exact: true }) }); }

  private async read<T>(route: 'query' | 'operation', kind: string, request: unknown, responseKind = kind): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${route}`, method: 'POST', timeoutMs: 10_000,
      body: route === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`World package setup ${kind}: transport=${reply.error.code}`);
    const body = reply.data.json as Envelope;
    if (!body || !body.success) throw new Error(`World package setup ${kind}: code=${body?.error?.code ?? 'invalid-envelope'}; stage=${body?.error?.stage ?? 'read'}; diagnosticId=${body?.error?.diagnosticId ?? 'not-disclosed'}`, { cause: body });
    if (!reply.data.ok || reply.data.status !== 200 || body.data.kind !== responseKind) throw new Error(`World package setup ${kind}: mismatched public response`);
    return body.data.result as T;
  }
  private query<T>(kind: string, request: unknown): Promise<T> { return this.read<T>('query', kind, request); }
  private async inventory(): Promise<Installed[]> {
    const items: Installed[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { items: Installed[]; nextCursor?: string | null } = await this.query('packages', { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items) || page.items.length > 100) throw new Error('Invalid public package inventory');
      for (const item of page.items) { equal(item.world, world, 'inventory world'); if (items.some(old => old.installId === item.installId)) throw new Error('Repeated installation in public inventory'); items.push(item); }
      cursor = page.nextCursor ?? null;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Package inventory cursor did not terminate');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return items;
  }
  private async open(details: Locator) {
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  }
  private async capabilities() {
    const tab = this.workspace.getByRole('tab', { name: /^(能力扩展|Capabilities)$/, exact: true });
    if (await tab.count() !== 1) await this.electron.page.getByRole('link', { name: /^(世界设置|World settings)$/, exact: true }).click();
    if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
    await this.workspace.getByLabel(/^(ZIP 安装包|Package ZIP)$/, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await this.workspace.getByRole('button', { name: /^(配置能力绑定|Configure capability bindings)$/, exact: true }).click({ timeout: 15_000 });
  }
  private async installed(installId: string) {
    await this.capabilities();
    // This page appends inventory pages; the exact install ID is the option's public value.
    const selection = this.bindings.getByRole('combobox', { name: /^(插件 \/ 提供者 \/ 制品 \/ 能力|Plugin \/ provider \/ artifact \/ capability)$/, exact: true });
    for (let page = 0; page < 100; page++) {
      const option = selection.locator('option').filter({ hasText: installId });
      if (await option.count()) break;
      const next = this.workspace.getByRole('button', { name: /^(加载更多|Load more)$/, exact: true });
      if (await next.count() !== 1 || !await next.isEnabled()) throw new Error(`Installed package is not reachable through UI inventory: ${installId}`);
      const before = await selection.locator('option').count(); await next.click();
      const until = Date.now() + 15_000;
      while (await selection.locator('option').count() === before && Date.now() < until) await setTimeout(100);
      if (await selection.locator('option').count() === before) throw new Error('UI package inventory did not advance');
    }
    const manifest = (await this.inventory()).find(item => item.installId === installId)!.manifest;
    await this.workspace.getByRole('textbox', { name: /^(搜索已安装能力|Search installed capabilities)$/, exact: true }).fill(installId);
    await this.workspace.locator('button[aria-pressed]').filter({ has: this.electron.page.locator('span.font-semibold').filter({ hasText: manifest.identity.id }) }).click();
    const id = this.detail.locator('dl > div').filter({ has: this.electron.page.locator('dt').filter({ hasText: /^(安装标识|安装 ID|Installation ID)$/ }) }).locator('dd');
    if (await id.count() && (await id.innerText()).trim() !== installId) throw new Error('UI inspected a different installation');
  }

  private async submit(kind: string, action: () => Promise<void>, resultKind: string): Promise<Receipt> {
    if (this.commands.some(item => item.kind === kind) || this.commands.some(item => item.outcome !== 'completed')) throw new Error(`Refusing repeated or unresolved ${kind}`);
    const command: Command = { kind, operationKey: null, outcome: 'delivery-unknown' };
    const previousAlerts = await this.workspace.getByRole('alert').allTextContents();
    const observation = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
      const state: Observation = { ids: [], dispose: () => undefined };
      const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!record(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !record(value.payload)) return;
        const hint = value.payload;
        if (!record(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') { state.error = 'World event continuity lost'; return; }
        if (!record(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) { if (state.ids.length >= 2) state.error = 'Ambiguous operation events'; else state.ids.push(hint.resource.id); }
      });
      return state;
    }, { world, incarnation: this.incarnation });
    this.commands.push(command); this.phase = kind;
    let originalError: unknown;
    try {
      await action();
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        const observed = await observation.evaluate(state => ({ ids: state.ids, error: state.error }));
        if (observed.error || observed.ids.length > 1) throw new Error(observed.error ?? 'Ambiguous original operation');
        if (observed.ids.length === 1) {
          const operationId = observed.ids[0];
          if (command.operationKey && command.operationKey.operationId !== operationId) throw new Error('Original operation key changed');
          if (!command.operationKey) {
            command.operationKey = { world, operationId };
            await this.retainActivationCommand(command);
          }
          const receipt = await this.read<Receipt>('operation', 'status', command.operationKey);
          equal(receipt.accepted.world, world, 'operation world'); equal(receipt.accepted.operationId, operationId, 'operation ID'); equal(receipt.accepted.incarnation, this.incarnation, 'operation incarnation');
          command.receipt = receipt; command.outcome = receipt.phase;
          if (terminal.includes(receipt.phase)) {
            const failed = receipt.phase !== 'completed' || receipt.failure;
            const failure = failed ? new Error(`phase=${receipt.phase}; code=${receipt.failure?.code ?? 'not-disclosed'}; stage=${receipt.failure?.stage ?? receipt.progress.stage}; diagnosticId=${receipt.failure?.diagnosticId ?? 'not-disclosed'}`) : undefined;
            let result: Receipt;
            try {
              result = await this.read<Receipt>('operation', 'result', command.operationKey);
              equal(result.accepted, receipt.accepted, 'terminal result ownership'); equal(result.phase, receipt.phase, 'terminal result phase');
              command.receipt = result; command.outcome = result.phase;
              await this.retainActivationCommand(command);
            } catch (error) { throw failure ? new AggregateError([failure, error], 'Original terminal failure and complete result readback failure retained') : error; }
            equal(result.accepted.world, world, 'result world'); equal(result.accepted.operationId, operationId, 'result operation ID'); equal(result.accepted.incarnation, this.incarnation, 'result incarnation');
            if (failure) throw failure;
            if (kind === 'install_package' && result.result?.kind === 'package') this.result.installId = (result.result.result as { installId: string }).installId;
            if (result.phase !== 'completed' || result.failure || result.disclosure.kind !== 'full' || result.result?.kind !== resultKind) throw new Error(`Original ${kind} result is not full completed ${resultKind}; code=${result.failure?.code ?? 'not-disclosed'}; stage=${result.failure?.stage ?? result.progress.stage}; diagnosticId=${result.failure?.diagnosticId ?? 'not-disclosed'}`);
            const final = await observation.evaluate(state => ({ ids: state.ids, error: state.error }));
            if (final.error) throw new Error(final.error); equal(final.ids, [operationId], 'single original operation');
            command.outcome = 'completed'; return result;
          }
        } else {
          const alerts = this.workspace.getByRole('alert');
          const texts = await alerts.allTextContents();
          if (texts.length) command.uiAlerts = texts;
          for (let index = 0; index < texts.length; index++) {
            if (previousAlerts.includes(texts[index])) continue;
            const details = alerts.nth(index).locator(':scope > details > div');
            if (await details.count() !== 1) continue;
            const diagnostic = await details.locator(':scope > p').first().textContent() ?? '';
            const records = details.locator(':scope > dl');
            if (!/world\.authorization_denied\s*·\s*admission\s*·/.test(diagnostic) || await records.count() !== 2) continue;
            const failure = await this.fixedRecord(records.nth(1));
            if (!isDeepStrictEqual(failure, { kind: 'authorization', failure: { kind: 'insufficient_scope' } })) continue;
            command.uiRejection = { text: texts[index], diagnostic, details: failure };
            this.phase = 'blocked-ui-authorization-denied';
            throw new Error(`Original ${kind} UI authorization rejection observed: ${texts[index]}; no completed operation receipt, delivery remains unproved`);
          }
        }
        await setTimeout(150);
      }
      throw new Error('Original request outcome unknown after bounded public readback; no replay');
    } catch (error) {
      originalError = new Error(`World package setup ${kind}; operationId=${command.operationKey?.operationId ?? 'not-disclosed'}; ${error instanceof Error ? error.message : String(error)}; original scene retained, no resend`, { cause: error });
      throw originalError;
    } finally {
      const cleanupErrors: unknown[] = [];
      try { await observation.evaluate(state => state.dispose()); } catch (error) { cleanupErrors.push(error); }
      try { await observation.dispose(); } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) throw new AggregateError(originalError ? [originalError, ...cleanupErrors] : cleanupErrors, 'World package setup retained original failure and observation cleanup failures');
    }
  }
  private async confirm(button: Locator) {
    await button.click({ timeout: 15_000 });
    const dialog = this.electron.page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^(确认|Confirm)$/, exact: true }).click({ timeout: 15_000 });
    if (await dialog.count() !== 0) throw new Error('Application confirmation did not close');
  }
  private async fixedRecord(container: Locator): Promise<unknown> {
    return container.evaluate(element => {
      const decode = (node: Element): unknown => {
        if (node.tagName === 'DL') return Object.fromEntries(Array.from(node.children).map(row => [row.querySelector(':scope > dt')!.textContent!, decode(row.querySelector(':scope > dd')!.firstElementChild!)]));
        if (node.tagName === 'OL') return Array.from(node.children).map(item => decode(item.firstElementChild!));
        const value = node.textContent;
        if (value === 'None' || value === '无') return [];
        if (value === 'Not set' || value === '未设置') return null;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
      };
      return decode(element);
    });
  }

  async preparePackageUpload() {
    if (this.uploadAttempt || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) throw new Error('Package upload requires one new attempt in the dedicated licensed profile');
    const before = await this.query<Description>('discover', { includeCapabilities: false });
    equal(before.world, world, 'upload World'); equal(before.status, 'ready', 'upload ready');
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    this.uploadAttempt = { filename: `e2e-truncated-package-${randomUUID()}.zip`, digest: hash(bytes), phase: 'prepared', attempts: 0,
      previousOperations: await this.workspace.getByRole('combobox', { name: /^(Records from this session|本次会话记录)$/, exact: true }).locator('option[value]:not([value=""])').evaluateAll(items => items.map(item => (item as HTMLOptionElement).value)),
      previousSubmissions: await this.workspace.locator('details[data-upload-submission]').evaluateAll(items => items.map(item => item.getAttribute('data-upload-submission')!)),
      before: { inventory: await this.inventory(), world: before } };
    return this.packageUploadEvidence();
  }
  async submitTruncatedPackage() {
    const attempt = this.uploadAttempt;
    if (!attempt || attempt.phase !== 'prepared' || attempt.attempts) throw new Error('Refusing repeated or unresolved package upload');
    const input = this.workspace.getByLabel(/^(ZIP 安装包|Package ZIP)$/, { exact: true });
    await input.setInputFiles({ name: attempt.filename, mimeType: 'application/zip', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]) });
    equal(await input.evaluate(async element => {
      const file = (element as HTMLInputElement).files![0];
      return { name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
    }), { name: attempt.filename, bytes: [0x50, 0x4b, 0x03, 0x04] }, 'actual selected truncated ZIP');
    await this.workspace.getByRole('combobox', { name: /^(安装目标|Installation target)$/, exact: true }).selectOption('');
    attempt.attempts = 1; attempt.phase = 'delivery-unknown';
    await this.workspace.getByRole('button', { name: /^(提交安装|Submit installation)$/, exact: true }).click({ timeout: 15_000 });
    await this.electron.page.waitForFunction(previous => {
      const current = document.querySelector('main .world-workspace details[data-upload-submission]')?.getAttribute('data-upload-submission');
      return Boolean(current && !previous.includes(current));
    }, attempt.previousSubmissions, { timeout: 15_000 });
    const shell = this.workspace.locator('details[data-upload-submission]');
    const requestId = await shell.getAttribute('data-upload-submission');
    attempt.submission = { world, requestId: requestId!, kind: 'install_package' };
    attempt.transferId = (await this.workspace.getByLabel(/^(Upload ID|上传编号)$/, { exact: true }).innerText()).trim();
    if (!requestId || !attempt.transferId) throw new Error('Original upload identity was not disclosed; no replay');
    await this.open(shell);
    equal(await this.fixedRecord(shell.locator(':scope > dl')), attempt.submission, 'actual shell submission');
    if (await shell.getByRole('alert').count()) throw new Error(`Original submission rejected: requestId=${requestId}; transferId=${attempt.transferId}; no replay`);
    attempt.upload = await this.read<UploadReceipt>('query', 'upload_status', { transferId: attempt.transferId }, 'upload');
    equal([attempt.upload.transferId, attempt.upload.received, attempt.upload.state],
      [attempt.transferId, '4', { kind: 'sealed', blob: { byteSize: '4', digest: attempt.digest } }], 'sealed exact four-byte upload');
    attempt.phase = 'sealed'; return this.packageUploadEvidence();
  }
  async selectPackageUploadOperation() {
    const attempt = this.uploadAttempt!;
    const selection = this.workspace.getByRole('combobox', { name: /^(Records from this session|本次会话记录)$/, exact: true });
    const ids = await selection.locator('option[value]:not([value=""])').evaluateAll(items => items.map(item => (item as HTMLOptionElement).value));
    const added = ids.filter(id => !attempt.previousOperations.includes(id));
    if (added.length !== 1 || !added[0]) throw new Error(`Original upload operation unknown or ambiguous; requestId=${attempt.submission?.requestId}; transferId=${attempt.transferId}; no replay`);
    attempt.operationKey = { world, operationId: added[0] };
    await selection.selectOption(added[0]);
    return this.packageUploadEvidence();
  }
  private retainedPackageUpload = false;
  async loadPackageUploadReadback() {
    if (this.uploadAttempt || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) throw new Error('Package readback requires the dedicated licensed profile and no new upload');
    const source = await this.publicJson<UploadAttempt>('.scratch/e2e-acceptance-2026-10-24-licensed-current-targets-1793159282642925700/package-upload-attempt.json');
    const attempt = source.value;
    equal([attempt.attempts, attempt.digest, attempt.submission, attempt.operationKey, attempt.transferId], [1, hash(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      { world, requestId: '413bb4db-40fe-4398-ba8f-334ca48f256b', kind: 'install_package' },
      { world, operationId: 'operation-6b770807b06865225e6119738300987b7bb70a2551f950400ed31f4703175956' },
      'upload-96c840cbb4ec063e5524010ca5aa944cdd5535b2a2330c00139799556a0a7064'], 'retained repaired-build upload identity');
    equal([attempt.before.world.world, attempt.upload?.received, attempt.upload?.state], [world, '4', { kind: 'sealed', blob: { byteSize: '4', digest: attempt.digest } }], 'retained upload and baseline World');
    this.uploadAttempt = attempt; this.retainedPackageUpload = true;
    return this.packageUploadEvidence();
  }
  async inspectPackageUpload(refreshed: boolean) {
    const attempt = this.uploadAttempt!; const key = attempt.operationKey!;
    const status = await this.read<Receipt>('operation', 'status', key);
    const receipt = await this.read<Receipt>('operation', 'result', key);
    equal(status, receipt, 'same full terminal status and result');
    equal([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation, receipt.phase, receipt.disclosure, receipt.failure?.code, receipt.failure?.stage, receipt.failure?.details, receipt.failure?.operationId, receipt.commit, receipt.effects, receipt.result],
      [world, key.operationId, attempt.before.world.incarnation, 'failed', { kind: 'full' }, 'world.package.failed', 'verify', { kind: 'package', failure: { kind: 'invalid_archive' } }, key.operationId, null, [], null], 'full invalid-archive operation failure, not submission failure');
    if (!receipt.failure?.diagnosticId) throw new Error('Original package failure omitted its diagnostic ID');
    if (!this.retainedPackageUpload) {
      const shell = this.workspace.locator('details[data-upload-submission]');
      equal(await shell.getAttribute('data-upload-submission'), attempt.submission!.requestId, 'retained submission ID');
      equal(await this.fixedRecord(shell.locator(':scope > dl')), attempt.submission, 'retained shell submission');
      equal((await this.workspace.getByLabel(/^(Upload ID|上传编号)$/, { exact: true }).innerText()).trim(), attempt.transferId, 'retained transfer ID');
      equal(await shell.getByRole('alert').count(), 0, 'no asynchronous failure on submission');
    }
    const upload = await this.read<UploadReceipt>('query', 'upload_status', { transferId: attempt.transferId }, 'upload');
    equal(upload, attempt.upload, 'same sealed public upload receipt');
    const records = this.workspace.getByRole('region', { name: /^(Processing records|处理记录)$/, exact: true });
    const failure = records.getByRole('region', { name: /^(Confirmed result|已确认结果)$/, exact: true }).locator('details').filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(Failure details|失败详情)$/ }) });
    await this.open(failure);
    equal(await this.fixedRecord(failure.locator(':scope > div > dl')), receipt.failure.details, 'rendered final failure details');
    const trace = records.locator('aside[aria-labelledby="world-operation-trace"]');
    equal((await trace.locator('.world-panel-body > p.font-mono').innerText()).trim(), key.operationId, 'rendered original operation');
    equal(await trace.locator('[data-status]').getAttribute('data-status'), 'failed', 'rendered failed terminal');
    const text = await trace.getByRole('alert').innerText();
    if (![receipt.failure.code, receipt.failure.stage, receipt.failure.diagnosticId].every(value => text.includes(value))) throw new Error('Final UI receipt omitted the original safe failure');
    equal(await this.inventory(), attempt.before.inventory, 'unchanged complete inventory');
    const after = await this.query<Description>('discover', { includeCapabilities: false });
    equal([after.world, after.status, after.incarnation, after.activeRelease, after.activeReleaseHead], [world, 'ready', attempt.before.world.incarnation, attempt.before.world.activeRelease, attempt.before.world.activeReleaseHead], 'unchanged active release');
    if (refreshed) equal(receipt, attempt.receipt, 'same terminal receipt after World refresh');
    attempt.status = status; attempt.receipt = receipt; attempt.phase = 'failed'; attempt.refreshed = refreshed;
    attempt.unchanged = { inventory: true, activeRelease: true };
    return this.packageUploadEvidence();
  }
  packageUploadEvidence() { return structuredClone(this.uploadAttempt); }

  async readOriginalPackageUpload(refreshed: boolean, allowAdmitted = false) {
    if (!this.originalUpload) {
      const source = await this.publicJson<OriginalUploadIdentity>('.scratch/e2e-acceptance-2026-10-24-licensed-current-targets-1793153487769148900/package-upload-original-identity.json');
      const { world: originalWorld, requestId, commandKind, transferId, operationId, byteSize, digest } = source.value;
      equal(originalWorld, world, 'original upload World');
      equal([commandKind, byteSize, digest], ['install_package', '4', hash(Buffer.from([0x50, 0x4b, 0x03, 0x04]))], 'original four-byte input');
      if (![requestId, transferId, operationId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Original upload identity is incomplete; no replay');
      this.originalUpload = { identity: { world: originalWorld, requestId, commandKind, transferId, operationId, byteSize, digest }, attempts: 0,
        sameIdentity: false, full: false, statusResultEqual: false, refreshed: false };
    }
    const evidence = this.originalUpload; const identity = evidence.identity;
    const key = { world: identity.world, operationId: identity.operationId };
    const reads: NonNullable<OriginalUploadReadback['reads']> = []; evidence.reads = reads;
    for (const kind of ['status', 'result', 'upload_status']) {
      try {
        reads.push({ kind, value: await this.read(kind === 'upload_status' ? 'query' : 'operation', kind,
          kind === 'upload_status' ? { transferId: identity.transferId } : key, kind === 'upload_status' ? 'upload' : kind) });
      } catch (error) {
        reads.push({ kind, error: { message: error instanceof Error ? error.message : String(error), failure: error instanceof Error ? error.cause : null } });
      }
    }
    evidence.status = reads[0].value as Receipt | undefined; evidence.receipt = reads[1].value as Receipt | undefined;
    evidence.upload = reads[2].value as UploadReceipt | undefined;
    evidence.actualPhase = evidence.receipt?.phase ?? evidence.status?.phase; evidence.failure = evidence.receipt?.failure ?? evidence.status?.failure;
    if (reads.some(read => read.error)) throw new Error(`Original package readback failed; operationId=${identity.operationId}; transferId=${identity.transferId}; typed reads retained, no replay`);
    const status = evidence.status!; const receipt = evidence.receipt!;
    equal(status, receipt, 'original status and result exact');
    equal([receipt.accepted.world, receipt.accepted.operationId], [identity.world, identity.operationId], 'original operation identity');
    equal([evidence.upload!.transferId, evidence.upload!.received, evidence.upload!.state],
      [identity.transferId, identity.byteSize, { kind: 'sealed', blob: { byteSize: identity.byteSize, digest: identity.digest } }], 'original sealed upload identity');
    equal(receipt.disclosure.kind, 'full', 'original receipt full disclosure');
    if (allowAdmitted) equal([receipt.phase, receipt.failure, receipt.commit, receipt.effects, receipt.result], ['admitted', null, null, [], null], 'original admitted operation without failure, commit, effects or result');
    else if (!['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit'].includes(receipt.phase)) throw new Error(`Original package operation is not terminal: ${receipt.phase}; identity retained, no recovery or replay`);
    if (refreshed) equal(receipt, this.originalUploadReceipt, 'same original terminal receipt after World refresh');
    else this.originalUploadReceipt = structuredClone(receipt);
    evidence.sameIdentity = true; evidence.full = true; evidence.statusResultEqual = true; evidence.refreshed = refreshed;
    return this.originalPackageUploadEvidence();
  }
  private originalUploadReceipt?: Receipt;
  async inspectOriginalPackageUploadUI() {
    const evidence = this.originalUpload!; const receipt = evidence.receipt!;
    const records = this.workspace.getByRole('region', { name: /^(Processing records|处理记录)$/, exact: true });
    const trace = records.locator('aside[aria-labelledby="world-operation-trace"]');
    equal((await trace.locator('.world-panel-body > p.font-mono').innerText()).trim(), evidence.identity.operationId, 'original UI operation ID');
    equal(await trace.locator('[data-status]').getAttribute('data-status'), receipt.phase, 'actual original UI terminal phase');
    const details = records.getByRole('region', { name: /^(Confirmed result|已确认结果)$/, exact: true }).locator('.world-panel-body > details');
    const identity = details.last(); await this.open(identity);
    equal((await this.fixedRecord(identity.locator(':scope > div > dl')) as { accepted: unknown }).accepted, receipt.accepted, 'full original rendered receipt identity');
    if (receipt.failure) {
      const text = await trace.getByRole('alert').innerText();
      if (![receipt.failure.code, receipt.failure.stage, receipt.failure.diagnosticId].every(value => text.includes(value))) throw new Error('Original UI failure differs from the public terminal receipt');
      const failure = details.filter({ has: this.electron.page.locator('summary').filter({ hasText: /^(Failure details|失败详情)$/ }) });
      await this.open(failure); equal(await this.fixedRecord(failure.locator(':scope > div > dl')), receipt.failure.details, 'full original rendered failure');
    }
    if (receipt.result) {
      const result = details.first(); await this.open(result);
      equal(await this.fixedRecord(result.locator(':scope > div > dl')), receipt.result, 'full original rendered result');
    }
    return this.originalPackageUploadEvidence();
  }
  originalPackageUploadEvidence() { return structuredClone(this.originalUpload); }

  private packageRecovery?: { assemble: string; sourceSeal: string; repair: FileRecord; resumeAttempts: number; phase: string; before?: Receipt; after?: OriginalUploadReadback; uiErrors?: string[] };
  async prepareOriginalPackageRecovery() {
    const source = process.env.E2E_WORLD_PACKAGE_REPAIRED_ASSEMBLE_RECEIPT?.trim() ?? '';
    if (!source || !process.env.E2E_MAIN?.trim() || this.packageRecovery) throw new Error('One explicit E2E_WORLD_PACKAGE_REPAIRED_ASSEMBLE_RECEIPT and assembled E2E_MAIN are required; no recovery attempted');
    const assembled = await this.publicJson<{ success: boolean; failure: unknown; E2E_MAIN: string; hostReceipt: string; hostProducer: string; nativeEvidence: string; hostSourceSeal: string; artifact: { desktop: { main: { files: FileRecord[] } }; native: { name: string; sourceSeal: string; copied: FileRecord }[] } }>(source);
    const desktop = assembled.value;
    equal([desktop.success, desktop.failure], [true, null], 'successful repaired desktop assemble');
    equal(await realpath(resolve(repositoryRoot, desktop.E2E_MAIN)), await realpath(electronMain), 'current assembled E2E_MAIN');
    const main = desktop.artifact.desktop.main.files.find(file => resolve(repositoryRoot, file.path) === electronMain);
    if (!main) throw new Error('Assemble omitted the current main artifact');
    equal(await this.fileRecord(main.path), main, 'actual assembled main bytes');
    const guard = (await this.publicJson<{ passed: boolean; nativeBuildSucceeded: boolean; rootExitCode: number; forcedTermination: boolean; nativeBuildResult: string }>(resolve(repositoryRoot, desktop.nativeEvidence, 'guard.json'))).value;
    equal([guard.passed, guard.nativeBuildSucceeded, guard.rootExitCode, guard.forcedTermination], [true, true, 0, false], 'successful repaired native build');
    equal(resolve(repositoryRoot, guard.nativeBuildResult), resolve(repositoryRoot, desktop.hostReceipt), 'assemble native producer binding');
    const host = (await this.publicJson<HostBuild>(desktop.hostReceipt)).value;
    equal([host.success, host.failure, host.inputSha256Before, host.inputSha256After], [true, null, desktop.hostSourceSeal, desktop.hostSourceSeal], 'stable repaired native source seal');
    const seal = (await this.publicJson<{ files: FileRecord[]; sha256: string }>(`${desktop.hostProducer}.source-final.json`)).value;
    equal([seal.sha256, hash(Buffer.from(JSON.stringify(seal.files)))], [desktop.hostSourceSeal, `sha256:${desktop.hostSourceSeal}`], 'recomputed repaired native source seal');
    const repairPath = 'runtime-host/modules/world/src/owner/workflows/packages.rs';
    const repairs = seal.files.filter(file => file.path === repairPath);
    if (repairs.length !== 1 || repairs[0].sha256 === 'af39bfa152d8e346ad57c7fdbe15ed953c626b228e0d30aa3dece56f87ee8415') throw new Error('Native source seal lacks the package dispatch repair');
    equal(await this.fileRecord(repairPath), repairs[0], 'current exact packages dispatch repair');
    const artifact = desktop.artifact.native.find(item => item.name === 'runtime-host');
    const native = host.artifacts.find(item => item.name === 'runtime-host');
    if (!artifact || !native) throw new Error('Repaired Host artifact is absent');
    equal([artifact.sourceSeal, native.sourceSeal, artifact.copied.bytes, artifact.copied.sha256], [desktop.hostSourceSeal, desktop.hostSourceSeal, native.target.bytes, native.target.sha256], 'assembled repaired native binding');
    equal(resolve(repositoryRoot, artifact.copied.path), resolve(appProjectRoot, 'runtime-host/dist/win32-x64/runtime-host.exe'), 'current assembled repaired Host path');
    equal(await this.fileRecord(artifact.copied.path), artifact.copied, 'current actual repaired Host bytes');
    this.packageRecovery = { assemble: assembled.path, sourceSeal: seal.sha256, repair: repairs[0], resumeAttempts: 0, phase: 'verified-repair' };
    await this.readOriginalPackageUpload(false, true);
    this.packageRecovery.before = structuredClone(this.originalUpload!.receipt);
    return this.originalPackageRecoveryEvidence();
  }
  async resumeOriginalPackageOnce() {
    const recovery = this.packageRecovery;
    if (!recovery || recovery.resumeAttempts || !recovery.before) throw new Error('Refusing unproved or repeated original package resume');
    await this.readOriginalPackageUpload(false, true);
    equal(this.originalUpload!.receipt, recovery.before, 'same original admitted revision before UI Resume');
    await this.inspectOriginalPackageUploadUI();
    const resume = this.workspace.locator('aside[aria-labelledby="world-operation-trace"]').getByRole('button', { name: /^(Resume original operation|继续原处理)$/, exact: true });
    if (await resume.count() !== 1 || !await resume.isEnabled()) throw new Error('Normal original Resume control is unavailable; no permission changes or recovery attempted');
    recovery.resumeAttempts = 1; recovery.phase = 'resume-delivery-unknown';
    await resume.click({ timeout: 15_000 });
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const status = await this.read<Receipt>('operation', 'status', { world: this.originalUpload!.identity.world, operationId: this.originalUpload!.identity.operationId });
      this.originalUpload!.status = status; this.originalUpload!.actualPhase = status.phase; this.originalUpload!.failure = status.failure;
      if (['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit'].includes(status.phase)) {
        await this.readOriginalPackageUpload(false); recovery.after = this.originalPackageUploadEvidence(); recovery.phase = 'terminal';
        return this.originalPackageRecoveryEvidence();
      }
      const trace = this.workspace.locator('aside[aria-labelledby="world-operation-trace"]');
      const errors = await trace.getByRole('alert').allTextContents();
      if (errors.length && !await resume.isDisabled()) {
        recovery.uiErrors = errors; recovery.after = this.originalPackageUploadEvidence();
        throw new Error(`Original Resume rejected or unresolved; operationId=${this.originalUpload!.identity.operationId}; phase=${status.phase}; UI failure retained, no second click`);
      }
      if (!['admitted', 'running', 'waiting_dependency'].includes(status.phase)) throw new Error(`Original Resume unknown phase=${status.phase}; preserve identity, no second click`);
      await setTimeout(150);
    }
    throw new Error('Original Resume has no terminal receipt within the observation bound; preserve identity, no second click');
  }
  originalPackageRecoveryEvidence() { return structuredClone({ ...this.packageRecovery, original: this.originalUpload }); }

  continuationFromEnvironment(activationEvidencePath: string): ActivationContinuation {
    return { activationEvidencePath, repairedHostReceiptPath: process.env.E2E_WORLD_ORDER_REPAIRED_HOST_RECEIPT?.trim() ?? '' };
  }
  private async publicJson<T>(source: string, filename: RegExp = /\.json$/i) {
    if (!source.trim()) throw new Error('World package setup blocked: explicit public evidence path required');
    const path = await realpath(resolve(repositoryRoot, source));
    const within = relative(await realpath(resolve(repositoryRoot, '.scratch')), path);
    if (!within || within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within) || !filename.test(path) || /(?:^|[\\/])(?:\.?profiles?|secrets?)(?:[\\/]|$)/i.test(path)) throw new Error('Evidence must be an explicit public scratch JSON, never Profile or secrets');
    const file = await stat(path);
    if (!file.isFile() || !file.size || file.size > 32 * 1024 * 1024) throw new Error('Public evidence must be a nonempty file of at most 32 MiB');
    const bytes = await readFile(path);
    return { path, value: JSON.parse(bytes.toString('utf8')) as T, sha256: hash(bytes) };
  }
  private async setupNote<T extends ResumeNote>(source: string) {
    const evidence = await this.publicJson<{ schemaVersion: number; scenes: { activities: { children: { error?: { message: string } }[] }[] }[] }>(source, /(?:^|[\\/])db\.json$/i);
    const contents: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const entry = value as { title?: unknown; contents?: unknown };
      if (entry.title === 'a note of worldOrderPackageSetup') {
        if (typeof entry.contents !== 'string') throw new Error('World package setup note is not serialized evidence');
        contents.push(entry.contents);
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(evidence.value);
    if (evidence.value.schemaVersion !== 1 || contents.length !== 1) throw new Error('Run must contain exactly one public World package setup note');
    return { ...evidence, note: JSON.parse(contents[0]) as T };
  }
  private async resume(source: string, inventory: Installed[], authorization?: ActivationAuthorization, continuation?: ActivationContinuation) {
    this.phase = 'resume-evidence';
    const { path, value: run, note: original } = await this.setupNote<ResumeNote>(source);
    this.resumedEvidence = { sourcePath: path, original, readback: [] };
    equal([original.phase, original.retained], ['activate', true], 'original retained activation attempt');
    if (!Array.isArray(original.commands) || original.commands.length !== 4) throw new Error('Resume requires the original trust/install/enable receipts and unresolved activation');
    equal(original.commands.map(command => command.kind), ['replace_package_trust_policy', 'install_package', 'enable_package', 'activate'], 'original command sequence; no configure submitted');
    equal(original.commands[3], { kind: 'activate', operationKey: null, outcome: 'delivery-unknown' }, 'original unresolved activation retained unchanged');
    equal(original.operationKeys, original.commands.slice(0, 3).map(command => command.operationKey), 'original operation keys');
    const ids = new Set<string>();
    for (const command of original.commands.slice(0, 3)) {
      const key = command.operationKey; const receipt = command.receipt;
      if (command.outcome !== 'completed' || !key || typeof key.operationId !== 'string' || !key.operationId || ids.has(key.operationId) || !receipt) throw new Error('Resume requires unique original completed operation receipts');
      ids.add(key.operationId); equal(key.world, world, 'original operation World');
      equal([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, key.operationId, this.incarnation], 'original receipt ownership');
      if (receipt.phase !== 'completed' || receipt.failure !== null || receipt.disclosure.kind !== 'full' || receipt.result?.kind !== (command.kind === 'replace_package_trust_policy' ? 'package_trust_policy' : 'package')) throw new Error('Original operation is not full completed; no replay');
      const current = await this.read<Receipt>('operation', 'result', key);
      this.resumedEvidence.readback.push({ kind: command.kind, receipt: current });
      equal(current, receipt, 'full fresh operation result equals complete original receipt');
      this.resumedCommands.push(structuredClone(command));
      if (command.kind === 'install_package') this.result.installId = (receipt.result.result as { installId: string }).installId;
    }
    const trust = original.commands[0].receipt!.result!.result as { revision: string };
    const installed = original.commands[1].receipt!.result!.result as { installId: string; revision: string };
    const enabled = original.commands[2].receipt!.result!.result as { installId: string; revision: string };
    if (typeof installed.installId !== 'string' || !installed.installId || !/^[1-9]\d*$/.test(installed.revision)) throw new Error('Original install result omitted its exact identity/revision');
    equal(enabled, { installId: installed.installId, revision: String(BigInt(installed.revision) + 1n) }, 'only original enable advanced installation');
    const matches = inventory.filter(item => isDeepStrictEqual(item.manifest.identity, this.result.manifest!.identity));
    if (matches.length !== 1) throw new Error('Original package identity has no unique public installation; no install or upgrade');
    const record = matches[0]; this.result.installedRecord = record;
    equal([record.world, record.installId, record.revision, record.packageDigest, record.transportDigest, record.manifest], [world, installed.installId, enabled.revision, this.result.packageDigest, this.result.transportDigest, this.result.manifest], 'exact original enabled inventory');
    this.result.trustPolicy = await this.query<Policy>('package_trust_policy', {});
    equal(this.result.trustPolicy.revision, trust.revision, 'original trust policy revision');
    equal([record.trust.policyRevision, record.trust.packageDigest], [trust.revision, this.result.packageDigest], 'original install trust');
    if (!this.result.trustPolicy.trustedProcessDigests.includes(this.result.packageDigest!)) throw new Error('Original exact trusted-process digest is no longer trusted');
    this.result.config = await this.query<Config>('package_config', { installId: installed.installId });
    equal(this.result.manifest!.config.fields.map(field => [field.name, field.valueType.kind, field.default]), [['enabled', 'boolean', { kind: 'boolean', value: true }]], 'original enabled default; no configure receipt');
    const fields = [{ name: 'enabled', value: { kind: 'boolean', value: true } }];
    equal(this.result.config, { installId: installed.installId, revision: '1', fields, digest: hash(Buffer.from(`matcha.world-package-config/1\n${JSON.stringify(fields)}`)) }, 'complete original unmodified enabled configuration');
    this.result.headBefore = await this.query<Head | null>('binding_head', { channel: this.result.channel });
    if (!continuation) equal(this.result.headBefore, null, 'original unactivated channel remains null');
    equal((await this.inventory()).find(item => item.installId === installed.installId), record, 'stable exact resumed inventory');
    equal(await this.query('package_trust_policy', {}), this.result.trustPolicy, 'stable resumed trust policy');
    this.result.worldAfter = await this.query<Description>('discover', { includeCapabilities: false });
    equal(this.result.worldAfter, this.result.worldBefore, 'World unchanged during read-only resume');
    if (!authorization) {
      this.phase = 'blocked-activation-unresolved';
      throw new Error('World package setup blocked: original activation has no completed receipt (operationKey=null; outcome=delivery-unknown); trust/install/enable verified read-only, no activate click or resend; explicit authorization and a lawful new-request contract are required');
    }
    equal([authorization.world, authorization.fence?.world, authorization.fence?.domain, authorization.revisions, authorization.outboxIds], [world, world, 'authorization', [], []], 'explicit authorization commit boundary');
    if (!/^commit:order-activation:20261027:[^\s:]+$/.test(authorization.commitId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(authorization.committedAt) || !Number.isFinite(Date.parse(authorization.committedAt))
      || !/^[1-9]\d*$/.test(authorization.fence.epoch) || BigInt(authorization.fence.epoch) > 9_223_372_036_854_775_807n) throw new Error('Invalid explicit activation authorization commit receipt');
    const rejection = run.scenes[0].activities[0]?.children?.[1]?.error?.message;
    if (typeof rejection !== 'string' || !/^World package setup activate; operationId=not-disclosed; Original activate rejected:/.test(rejection)
      || !/world\.authorization_denied\s*·\s*admission\s*·/.test(rejection) || !rejection.includes('failurekindinsufficient_scopekindauthorization; original scene retained, no resend')) throw new Error('Original activation lacks the exact retained admission insufficient_scope rejection; no new activation');
    this.resumedEvidence.originalRejection = { source: 'scenes[0].activities[0].children[1].error.message', message: rejection };
    this.activationAuthorization = structuredClone(authorization);
    if (!continuation) {
      this.phase = 'blocked-activation-custody';
      throw new Error('World package setup blocked: old admission rejection and authorization cannot bypass the latest accepted activation; explicit activation custody and repaired Host receipt required');
    }
    await this.resumeActivation(continuation, record, this.result.config);
    return { record, config: this.result.config };
  }

  private async resumeActivation(input: ActivationContinuation, record: Installed, config: Config) {
    this.phase = 'activation-custody';
    const evidence = await this.setupNote<ActivationNote>(input.activationEvidencePath);
    const original = evidence.note; const command = original.commands?.[0];
    const custodyPath = resolve(dirname(evidence.path), 'world-order-activation-continuation.json');
    this.activationEvidence = { sourcePath: evidence.path, original, custodyPath };
    equal([original.world, original.packageDigest, original.transportDigest, original.manifest, original.installId, original.lockId, original.channel, original.activationAuthorization, original.retained],
      [world, this.result.packageDigest, this.result.transportDigest, this.result.manifest, record.installId, this.result.lockId, this.result.channel, this.activationAuthorization, true], 'latest activation exact package and authorization custody');
    equal(await realpath(resolve(repositoryRoot, original.resumedEvidence.sourcePath)), this.resumedEvidence!.sourcePath, 'latest activation original installation source');
    equal(original.resumedEvidence.original, this.resumedEvidence!.original, 'latest activation complete original installation evidence');
    if (original.commands.length !== 1 || command.kind !== 'activate' || !command.operationKey || !command.receipt || !['activate', 'activated'].includes(original.phase)) throw new Error('Latest activation is unknown or lacks its sole accepted operation; blocked without replay');
    equal(original.operationKeys, [command.operationKey], 'latest activation single operation key');
    equal(command.operationKey.world, world, 'latest activation operation World');
    equal([command.receipt.accepted.world, command.receipt.accepted.operationId, command.receipt.accepted.incarnation], [world, command.operationKey.operationId, this.incarnation], 'latest activation receipt ownership');
    const current = await this.read<Receipt>('operation', 'result', command.operationKey);
    this.activationEvidence.readback = current;
    equal(current, command.receipt, 'complete fresh activation result equals complete retained receipt');
    this.verifyGraph(original.graph, record, config, this.result.lockId!);
    equal([original.implementation, original.ports], [original.graph.nodes[0].implementation, original.graph.nodes[0].ports], 'latest activation exact implementation and ports');
    equal([command.outcome, current.phase, current.disclosure.kind], [current.phase, current.phase, 'full'], 'latest activation full terminal custody');
    this.resumedCommands.push(structuredClone(command));
    if (!input.repairedHostReceiptPath.trim()) {
      this.phase = 'blocked-host-repair';
      throw new Error('World package setup blocked: E2E_WORLD_ORDER_REPAIRED_HOST_RECEIPT is required; no guessed repair receipt or activate click');
    }
    if (current.phase === 'completed' && current.failure === null && current.result?.kind === 'activation') {
      await this.resumeCompletedActivation(current, original.graph, original.headAfter);
      return;
    }
    equal([current.phase, current.disclosure.kind, current.failure?.code, current.failure?.stage, current.failure?.details, current.failure?.operationId, current.commit, current.effects, current.result],
      ['failed', 'full', 'world.package.failed', 'verify', { kind: 'package', failure: { kind: 'io_read' } }, command.operationKey.operationId, null, [], null], 'latest exact failed verify io_read without commit or effects');
    equal(original.headBefore, null, 'failed activation original null head');
    await this.verifyRepairedHost(input.repairedHostReceiptPath, current.updatedAt);
    let custody: ActivationCustody | undefined;
    try { custody = (await this.publicJson<ActivationCustody>(custodyPath)).value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (custody) {
      this.activationEvidence.custody = custody;
      equal([custody.sourcePath, custody.sourceSha256, custody.repairedHostReceiptPath, custody.repairedHostSha256, custody.graph],
        [evidence.path, evidence.sha256, this.activationEvidence.repairedHost!.receiptPath, this.activationEvidence.repairedHost!.artifact.sha256, original.graph], 'retained new activation custody boundary');
      const retained = custody.command;
      if (retained.kind !== 'activate' || retained.outcome !== 'completed' || !retained.operationKey || !retained.receipt) throw new Error('Original continuation activation is failed or unresolved; retain latest custody and do not resend');
      equal(retained.operationKey.world, world, 'continuation operation World');
      equal([retained.receipt.accepted.world, retained.receipt.accepted.operationId, retained.receipt.accepted.incarnation], [world, retained.operationKey.operationId, this.incarnation], 'continuation receipt ownership');
      if (retained.operationKey.operationId === command.operationKey.operationId) throw new Error('Continuation reused the earlier failed operation');
      const result = await this.read<Receipt>('operation', 'result', retained.operationKey);
      equal(result, retained.receipt, 'full fresh completed continuation result');
      this.resumedCommands.push(structuredClone(retained));
      await this.resumeCompletedActivation(result, custody.graph);
      return;
    }
    equal(this.result.headBefore, null, 'fresh failed activation has no current head');
    equal(await this.query('binding_head', { channel: this.result.channel }), null, 'repaired new activation still has no head');
    this.activationEvidence.custody = { sourcePath: evidence.path, sourceSha256: evidence.sha256, repairedHostReceiptPath: this.activationEvidence.repairedHost!.receiptPath,
      repairedHostSha256: this.activationEvidence.repairedHost!.artifact.sha256, graph: original.graph, command: { kind: 'activate', operationKey: null, outcome: 'delivery-unknown' } };
  }
  private async fileRecord(source: string): Promise<FileRecord> {
    const file = await open(await realpath(resolve(repositoryRoot, source)), 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || !info.size || info.size > 1024 * 1024 * 1024) throw new Error('Repair artifact must be a nonempty regular file of at most 1 GiB');
      const digest = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
      for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; digest.update(buffer.subarray(0, bytesRead)); }
      return { path: source, bytes: info.size, sha256: digest.digest('hex') };
    } finally { await file.close(); }
  }
  private async verifyRepairedHost(source: string, failedAt: string) {
    this.phase = 'host-repair-evidence';
    const receipt = await this.publicJson<HostBuild>(source, /(?<!\.guard)\.result\.json$/i);
    const prefix = receipt.path.replace(/\.result\.json$/i, ''); const build = receipt.value;
    const guard = (await this.publicJson<{ spawned: boolean; forcedTermination: boolean; outcome: string; rootExitCode: number; remainingOwnedPids: number[] }>(`${prefix}.guard.result.json`)).value;
    equal([build.success, build.failure, build.changedInputs, build.inputPresenceUnchanged, build.formalUnchanged, build.frozenUnchanged], [true, null, [], true, true, true], 'successful stable Host repair build');
    equal([guard.spawned, guard.forcedTermination, guard.outcome, guard.rootExitCode, guard.remainingOwnedPids], [true, false, 'process-exit', 0, []], 'Host repair successful guard without forced cleanup');
    if (!Array.isArray(build.terminals) || build.terminals.length !== 1) throw new Error('Repair receipt requires one successful Host build');
    const terminal = build.terminals[0];
    equal([terminal.label, terminal.code, terminal.signal], ['host-build', 0, null], 'successful Host build terminal');
    if (![failedAt, terminal.startedAt, terminal.finishedAt].every(value => Number.isFinite(Date.parse(value))) || Date.parse(terminal.startedAt) <= Date.parse(failedAt) || Date.parse(terminal.finishedAt) < Date.parse(terminal.startedAt)) throw new Error('Host repair build must follow the retained io_read failure');
    const before = (await this.publicJson<{ files: FileRecord[]; sha256: string }>(`${prefix}.source-T0.json`)).value;
    const after = (await this.publicJson<{ files: FileRecord[]; sha256: string }>(`${prefix}.source-final.json`)).value;
    if (!/^[0-9a-f]{64}$/.test(build.inputSha256Before)) throw new Error('Host build omitted its exact source seal');
    equal([build.inputSha256After, before.sha256, after.sha256, hash(Buffer.from(JSON.stringify(before.files))), hash(Buffer.from(JSON.stringify(after.files)))],
      [build.inputSha256Before, build.inputSha256Before, build.inputSha256Before, `sha256:${build.inputSha256Before}`, `sha256:${build.inputSha256Before}`], 'recomputed stable Host source seal');
    equal(after.files, before.files, 'complete Host source snapshot unchanged during build');
    const platformPath = 'runtime-host/platform/src/state_dir/windows/mod.rs';
    const platform = after.files.filter(item => item.path === platformPath);
    if (platform.length !== 1 || platform[0].sha256 === '49d983393a48b4a0ea0abaf37c0e7f895520dadb8fc57d0eeedf12447c3f9a52') throw new Error('Host repair has no changed Windows state directory source');
    equal(await this.fileRecord(platformPath), platform[0], 'source-final Windows repair equals exact current source');
    equal(build.fixFreeze.files.filter(item => item.path === platformPath), platform, 'Host build froze the exact Windows repair');
    const artifacts = (await this.publicJson<HostBuild['artifacts']>(`${prefix}.artifact.json`)).value;
    equal(artifacts, build.artifacts, 'Host build exact artifact manifest');
    const hosts = artifacts.filter(item => item.name === 'runtime-host');
    if (hosts.length !== 1) throw new Error('Host repair must have one exact runtime-host artifact');
    const host = hosts[0];
    equal([host.extension, host.pe64, host.exact, host.sourceSeal, host.source.bytes, host.source.sha256], ['exe', true, true, build.inputSha256Before, host.target.bytes, host.target.sha256], 'exact source-bound Windows x64 Host artifact');
    if (!/^[0-9a-f]{64}$/.test(host.target.sha256) || host.target.sha256 === '4ba55d276078c83085f17c0fed77dbbbaf308b89bdab24c7f60eb20458c4fcfc') throw new Error('Host repair artifact is invalid or still the failed r12 binary');
    const target = await realpath(resolve(repositoryRoot, host.target.path));
    const within = relative(await realpath(resolve(repositoryRoot, '.scratch')), target);
    if (!within || within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within) || /(?:^|[\\/])(?:\.?profiles?|secrets?)(?:[\\/]|$)/i.test(target) || !/(?:^|[\\/])runtime-host\.exe$/i.test(target)) throw new Error('Repair Host artifact must remain in public scratch custody');
    equal(await this.fileRecord(host.target.path), host.target, 'repair artifact actual bytes');
    const running = await this.fileRecord(resolve(appProjectRoot, 'runtime-host/dist/win32-x64/runtime-host.exe'));
    equal([running.bytes, running.sha256], [host.target.bytes, host.target.sha256], 'current application exact repaired Host bytes');
    this.activationEvidence!.repairedHost = { receiptPath: receipt.path, artifact: host.target, platformSource: platform[0] };
  }
  private async retainActivationCommand(command: Command) {
    if (command.kind !== 'activate' || !this.custodyReserved || !this.activationEvidence?.custody) return;
    this.activationEvidence.custody.command = structuredClone(command);
    const file = await open(this.activationEvidence.custodyPath, 'r+');
    try { await file.truncate(0); await file.writeFile(JSON.stringify(this.activationEvidence.custody, null, 2)); await file.sync(); } finally { await file.close(); }
  }
  private async reserveActivation() {
    if (!this.activationEvidence?.custody) return;
    equal(this.result.graph, this.activationEvidence.custody.graph, 'new activation exact retained failed plan');
    const file = await open(this.activationEvidence.custodyPath, 'wx');
    try { await file.writeFile(JSON.stringify(this.activationEvidence.custody, null, 2)); await file.sync(); } finally { await file.close(); }
    this.custodyReserved = true;
  }
  private async resumeCompletedActivation(receipt: Receipt, graph: Graph, expectedHead?: Head) {
    equal([receipt.phase, receipt.disclosure.kind, receipt.failure, receipt.result?.kind], ['completed', 'full', null, 'activation'], 'full completed activation without another click');
    const heads = (receipt.result!.result as { heads: Head[] }).heads;
    if (heads.length !== 1) throw new Error('Completed activation did not return its sole head');
    const head = heads[0];
    equal([head.world, head.channel, head.activationLockId], [world, this.result.channel, this.result.lockId], 'completed activation exact head identity');
    if (expectedHead !== undefined) equal(head, expectedHead, 'retained complete successful head');
    equal(await this.query('binding_head', { channel: this.result.channel }), head, 'fresh complete activated head');
    const matches: Graph[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { items: Graph[]; nextCursor?: string | null } = await this.query('bindings', { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items) || page.items.length > 100) throw new Error('Invalid public binding inventory');
      matches.push(...page.items.filter(item => item.id === graph.id));
      cursor = page.nextCursor ?? null;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Binding inventory cursor did not terminate');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    equal(matches, [graph], 'full fresh activated graph equals original successful graph');
    equal(await this.query('binding_head', { channel: this.result.channel }), head, 'stable complete activated head');
    const after = await this.query<Description>('discover', { includeCapabilities: false });
    equal(after, this.result.worldBefore, 'World unchanged during completed activation read-only resume');
    Object.assign(this.result, { graph, implementation: graph.nodes[0].implementation, ports: graph.nodes[0].ports, headAfter: head, worldAfter: after });
    this.phase = 'activated-resumed';
  }
  private verifyGraph(graph: Graph, record: Installed, config: Config, lockId: string) {
    const provided = record.manifest.provides[0]; const artifact = record.manifest.artifacts[0];
    equal(graph.world, world, 'plan world'); equal(graph.id, lockId, 'plan lock'); equal(graph.roots, [nodeId], 'single root'); equal(graph.trustedRoots, [nodeId], 'single trusted root'); equal(graph.edges, [], 'no dependencies');
    equal(graph.compositions, [{ bindingId, nodes: [nodeId], mode: 'single', merge: 'none', failure: 'fail_closed', order: [], wiring: [] }], 'single fail-closed composition');
    if (graph.nodes.length !== 1) throw new Error('Plan did not contain exactly one evaluation node');
    const node = graph.nodes[0];
    equal([node.id, node.bindingId, node.slot, node.providerId, node.trust, node.required], [nodeId, bindingId, 'evaluation', provided.providerId, 'trusted_process', false], 'trusted evaluation node');
    equal([node.implementation.installId, node.implementation.packageDigest, node.implementation.artifactId, node.implementation.artifactDigest, node.implementation.configDigest, node.implementation.entrypoint, node.implementation.contracts], [record.installId, this.result.packageDigest, artifact.id, artifact.digest, config.digest, artifact.entrypoint, provided.contracts], 'server-resolved exact implementation');
    if (!node.ports.length || node.ports.some(port => !port.name || !/^sha256:[0-9a-f]{64}$/.test(port.requestSchema) || !/^sha256:[0-9a-f]{64}$/.test(port.resultSchema))) throw new Error('Plan omitted actual method ports and schema digests');
  }

  async setup(packagePath: string, lockId: string, resumeEvidencePath?: string, activationAuthorization?: ActivationAuthorization, activationContinuation?: ActivationContinuation) {
    if (this.phase !== 'idle' || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) throw new Error('Package setup requires one attempt in the dedicated licensed E2E profile');
    this.phase = 'preflight'; this.result = { world, packagePath, lockId, channel: lockId };
    if ((activationAuthorization !== undefined || activationContinuation !== undefined) && resumeEvidencePath === undefined) throw new Error('Activation continuation requires explicit original installation resume evidence');
    const path = await realpath(resolve(repositoryRoot, packagePath)); this.result.packagePath = path;
    const within = relative(await realpath(resolve(repositoryRoot, '.scratch')), path);
    if (!within || within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within) || !/\.zip$/i.test(path) || /(?:^|[\\/])(?:\.profiles?|secrets?)(?:[\\/]|$)/i.test(path)) throw new Error('Package must be an explicit public scratch ZIP, never Profile or secrets');
    if (!lockId.trim() || lockId !== lockId.trim()) throw new Error('Explicit nonempty activation lock ID required');
    const file = await stat(path);
    if (!file.isFile() || !file.size || file.size > 256 * 1024 * 1024) throw new Error('Package must be a nonempty public ZIP of at most 256 MiB');
    const bytes = await readFile(path);
    // world-pack writes package.json first and stored. Reject other layouts instead of implementing a ZIP library.
    if (bytes.length < 30 || bytes.length > 256 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(6) & 9 || bytes.readUInt16LE(8) !== 0) throw new Error('Expected a bounded world-pack ZIP with its first manifest entry stored');
    const nameLength = bytes.readUInt16LE(26); const start = 30 + nameLength + bytes.readUInt16LE(28); const size = bytes.readUInt32LE(22);
    if (bytes.subarray(30, 30 + nameLength).toString('utf8') !== 'package.json' || !size || size > 1_048_576 || bytes.readUInt32LE(18) !== size || start + size > bytes.length) throw new Error('Invalid original stored package.json entry');
    const manifestBytes = bytes.subarray(start, start + size); const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
    const packageDigest = hash(manifestBytes); const transportDigest = hash(bytes);
    Object.assign(this.result, { manifest, packageDigest, transportDigest });
    if (manifest.format !== 'matcha.world-package/1' || manifest.provides.length !== 1 || manifest.provides[0].slot !== 'evaluation' || manifest.provides[0].trust !== 'trusted_process' || manifest.artifacts.length !== 1 || manifest.artifacts[0].runtime !== 'trusted_process' || manifest.artifacts[0].kind !== 'implementation' || manifest.provides[0].artifactId !== manifest.artifacts[0].id || manifest.requestedAccess.length || manifest.requires.length || manifest.state.length) throw new Error('Only the minimal independent trusted-process evaluation package with no requested access, dependencies or state is authorized');
    const before = await this.query<Description>('discover', { includeCapabilities: false });
    this.result.worldBefore = before;
    equal(before.world, world, 'ready world'); if (before.status !== 'ready') throw new Error('World is not ready'); this.incarnation = before.incarnation;
    const inventory = await this.inventory();
    if (resumeEvidencePath !== undefined) {
      const resumed = await this.resume(resumeEvidencePath, inventory, activationAuthorization, activationContinuation);
      if (this.phase === 'activated-resumed') return this.evidence();
      return this.activate(resumed.record, resumed.config, lockId, null, before);
    }
    if (inventory.some(record => isDeepStrictEqual(record.manifest.identity, manifest.identity))) throw new Error('Exact package identity already installed; explicit original run evidence required; no duplicate install, upgrade or replay');
    const channel = lockId; const headBefore = await this.query<Head | null>('binding_head', { channel }); this.result.headBefore = headBefore;
    await this.capabilities();
    const policy = await this.query<Policy>('package_trust_policy', {}); this.result.trustPolicy = policy;
    if (!policy.trustedProcessDigests.includes(packageDigest)) {
      const details = this.workspace.locator('xpath=.//details[summary[normalize-space(.)="当前包信任策略" or normalize-space(.)="Current package trust policy"]]');
      await this.open(details);
      await details.getByRole('button', { name: /^(读取当前策略|Read current policy)$/, exact: true }).click();
      await details.getByRole('combobox', { name: /^(添加到信任集合|Add to trust set)$/, exact: true }).selectOption('trustedProcessDigests');
      await details.getByRole('textbox', { name: /^(精确 packageDigest|Exact packageDigest)$/, exact: true }).fill(packageDigest);
      await details.getByRole('button', { name: /^(将摘要加入草稿|Add digest to draft)$/, exact: true }).click();
      const receipt = await this.submit('replace_package_trust_policy', () => this.confirm(details.getByRole('button', { name: /^(确认并提交信任变更|Confirm and submit trust changes)$/, exact: true })), 'package_trust_policy');
      const next = { ...policy, revision: String(BigInt(policy.revision) + 1n), trustedProcessDigests: [...policy.trustedProcessDigests, packageDigest] };
      this.result.trustPolicy = await this.query<Policy>('package_trust_policy', {});
      equal(receipt.result!.result, { revision: next.revision }, 'trust revision receipt'); equal(this.result.trustPolicy, next, 'only exact package digest added; other trust fields unchanged');
      await this.capabilities();
    }
    const input = this.workspace.getByLabel(/^(ZIP 安装包|Package ZIP)$/, { exact: true });
    await input.setInputFiles(path);
    const selectedDigest = await input.evaluate(async element => {
      const file = (element as HTMLInputElement).files?.[0]; if (!file) throw new Error('No selected package file');
      return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    });
    equal(selectedDigest, transportDigest, 'actual UI file bytes');
    await this.workspace.getByRole('combobox', { name: /^(安装目标|Installation target)$/, exact: true }).selectOption('');
    const install = await this.submit('install_package', () => this.workspace.getByRole('button', { name: /^(提交安装|Submit installation)$/, exact: true }).click({ timeout: 15_000 }), 'package');
    const identity = install.result!.result as { installId: string; revision: string }; this.result.installId = identity.installId;
    let record = (await this.inventory()).find(item => item.installId === identity.installId);
    if (!record) throw new Error('Original install receipt is absent from public inventory'); this.result.installedRecord = record;
    equal(record.revision, identity.revision, 'installed revision'); equal(record.packageDigest, packageDigest, 'installed package digest'); equal(record.transportDigest, transportDigest, 'installed transport digest'); equal(record.manifest, manifest, 'exact original manifest');
    await this.installed(record.installId);
    const configuration = this.detail.locator('xpath=.//details[summary[normalize-space(.)="公开配置" or normalize-space(.)="Public configuration"]]');
    await this.open(configuration);
    await configuration.getByRole('button', { name: /^(读取当前配置|Read current configuration)$/, exact: true }).click();
    await configuration.locator('form').waitFor({ state: 'visible', timeout: 15_000 });
    let config = await this.query<Config>('package_config', { installId: record.installId }); this.result.config = config; equal(config.installId, record.installId, 'configuration install');
    const enabled = config.fields.find(field => field.name === 'enabled');
    if (!isDeepStrictEqual(enabled?.value, { kind: 'boolean', value: true })) {
      if (!manifest.config.fields.some(field => field.name === 'enabled' && field.valueType.kind === 'boolean')) throw new Error('Package lacks the real boolean enabled configuration');
      const field = configuration.locator('form > div').filter({ has: this.electron.page.locator('p.font-medium').filter({ hasText: /^enabled$/ }) });
      await field.getByLabel(/^(修改方式|Change)$/, { exact: true }).selectOption('set');
      await field.getByLabel('enabled', { exact: true }).selectOption('true');
      const configured = await this.submit('configure_package', () => configuration.getByRole('button', { name: /^(提交配置|Submit configuration)$/, exact: true }).click({ timeout: 15_000 }), 'package');
      equal((configured.result!.result as { installId: string }).installId, record.installId, 'configured receipt install');
      const current = await this.query<Config>('package_config', { installId: record.installId }); this.result.config = current;
      equal(current.fields, [...config.fields.filter(field => field.name !== 'enabled'), { name: 'enabled', value: { kind: 'boolean', value: true } }].sort((a, b) => a.name.localeCompare(b.name)), 'enabled configuration only');
      config = current; await this.installed(record.installId);
    }
    const enable = await this.submit('enable_package', () => this.confirm(this.detail.getByRole('button', { name: /^(申请启用|Request enable)$/, exact: true })), 'package');
    equal((enable.result!.result as { installId: string }).installId, record.installId, 'enabled receipt install');
    record = (await this.inventory()).find(item => item.installId === identity.installId)!; this.result.installedRecord = record;
    return this.activate(record, config, lockId, headBefore, before);
  }
  private async activate(record: Installed, config: Config, lockId: string, headBefore: Head | null, before: Description) {
    const channel = lockId; const packageDigest = this.result.packageDigest!;
    await this.installed(record.installId);
    const provided = record.manifest.provides[0]; const artifact = record.manifest.artifacts[0]; const panel = this.bindings;
    await panel.getByRole('combobox', { name: /^(插件 \/ 提供者 \/ 制品 \/ 能力|Plugin \/ provider \/ artifact \/ capability)$/, exact: true }).selectOption(JSON.stringify([record.installId, provided.providerId, artifact.id, 'evaluation']));
    await panel.getByRole('textbox', { name: /^(节点标识|Node ID)$/, exact: true }).fill(nodeId);
    await panel.getByRole('textbox', { name: /^(绑定标识|Binding ID)$/, exact: true }).fill(bindingId);
    await panel.getByRole('button', { name: /^(添加节点|Add node)$/, exact: true }).click();
    const row = panel.locator('tbody tr').filter({ has: this.electron.page.locator('td').filter({ hasText: new RegExp(`^${nodeId}$`) }) });
    await row.getByLabel(/^(入口|Entry point)$/, { exact: true }).check();
    await row.getByLabel(/^(申请受信任入口|Request trusted entry)$/, { exact: true }).check();
    await panel.getByRole('combobox', { name: /^(组合所属绑定|Binding to compose)$/, exact: true }).selectOption(bindingId);
    await panel.getByRole('combobox', { name: /^(执行方式|Execution mode)$/, exact: true }).selectOption('single');
    await panel.getByRole('combobox', { name: /^(合并规则|Merge rule)$/, exact: true }).selectOption('none');
    await panel.getByRole('combobox', { name: /^(失败规则|Failure rule)$/, exact: true }).selectOption('fail_closed');
    await panel.getByRole('button', { name: /^(确认组合|Confirm composition)$/, exact: true }).click();
    await panel.getByRole('textbox', { name: /^(通道名称|Channel name)$/, exact: true }).fill(channel);
    await panel.getByRole('button', { name: /^(读取当前绑定|Read current binding)$/, exact: true }).click();
    await panel.getByRole('combobox', { name: new RegExp(`^(绑定 ${bindingId} 的通道|Channel for binding ${bindingId})$`), exact: true }).selectOption(channel);
    equal(await this.query('binding_head', { channel }), headBefore, 'actual unchanged channel head');
    await panel.getByRole('textbox', { name: /^(新激活锁标识|New activation lock ID)$/, exact: true }).fill(lockId);
    await panel.getByRole('button', { name: /^(生成激活计划|Generate activation plan)$/, exact: true }).click();
    const activate = panel.getByRole('button', { name: /^(确认并激活|Confirm and activate)$/, exact: true });
    await activate.waitFor({ state: 'visible', timeout: 15_000 });
    const plan = await this.fixedRecord(activate.locator('..').locator(':scope > dl')) as Plan; this.result.graph = plan.graph;
    this.verifyGraph(plan.graph, record, config, lockId);
    equal(plan.channels, [{ bindingId, channel }], 'plan channel'); equal(plan.heads, [{ world, channel, expected: headBefore, replacement: lockId }], 'real channel CAS');
    const node = plan.graph.nodes[0];
    Object.assign(this.result, { implementation: node.implementation, ports: node.ports });
    await this.reserveActivation();
    const activation = await this.submit('activate', () => this.confirm(activate), 'activation');
    const heads = (activation.result!.result as { heads: Head[] }).heads;
    if (heads.length !== 1 || heads[0].channel !== channel || heads[0].activationLockId !== lockId) throw new Error('Original activation receipt has mismatched channel/lock');
    const headAfter = await this.query<Head>('binding_head', { channel }); this.result.headAfter = headAfter; equal(headAfter, heads[0], 'durable exact activation head');
    const after = await this.query<Description>('discover', { includeCapabilities: false }); this.result.worldAfter = after;
    equal([after.world, after.status, after.incarnation, after.activeRelease, after.activeReleaseHead], [before.world, 'ready', before.incarnation, before.activeRelease, before.activeReleaseHead], 'World remains ready and original business release is not published or replaced');
    Object.assign(this.result, { world, packageDigest, installId: record.installId, lockId, channel, headBefore, headAfter, graph: plan.graph, implementation: node.implementation, ports: node.ports });
    this.phase = 'activated'; return this.evidence();
  }
  evidence() {
    return structuredClone({ ...this.result, phase: this.phase, operationKeys: this.commands.flatMap(item => item.operationKey ? [item.operationKey] : []), commands: this.commands, resumedCommands: this.resumedCommands, resumedEvidence: this.resumedEvidence, activationAuthorization: this.activationAuthorization, activationEvidence: this.activationEvidence, retained: true });
  }
}
