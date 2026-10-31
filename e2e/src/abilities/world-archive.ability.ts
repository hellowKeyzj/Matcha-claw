import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { UseElectron } from './use-electron.ability.js';

type WorldRef = { tenantId: string; worldId: string };
type Prerequisites = {
  world: WorldRef; status: string; activeRelease: string; activeReleaseHead: unknown; incarnation: string;
  activationLock: string; scopes: string[]; slots: string[]; catalogs: Record<string, number>;
  catalogEntries: Record<string, unknown[]>; tasks: unknown[]; packages: unknown[]; trustPolicy: unknown; unchanged: boolean;
};
type Receipt = {
  accepted: { world: WorldRef; operationId: string; incarnation: string; revision: string };
  phase: string; disclosure: { kind: string }; failure: unknown; effects: unknown[];
  result: { kind: string; result: { manifest: { digest: string; byteSize: string } } };
};
const directoryKinds = ['action_proposals', 'changes', 'connections', 'definitions', 'evaluations', 'materials'];
const sessionSelector = 'main .world-workspace aside[aria-labelledby="world-operation-records"] select';
function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World backup ${label} differs; retain the original attempt without replay`);
}
function prerequisites(value: unknown): Prerequisites {
  const facts = value as Prerequisites;
  if (!facts?.world?.tenantId || !facts.world.worldId || facts.status !== 'ready' || !facts.activeRelease
    || !facts.activeReleaseHead || !/^\d+$/.test(facts.incarnation) || !facts.activationLock || facts.unchanged !== true
    || !Array.isArray(facts.scopes) || !Array.isArray(facts.slots) || !Array.isArray(facts.tasks)
    || !Array.isArray(facts.packages) || !facts.trustPolicy || !facts.catalogs || !facts.catalogEntries) {
    throw new Error('World backup requires complete current UI-selected public prerequisites; no identity or capability is guessed');
  }
  exact(Object.keys(facts.catalogEntries).sort(), directoryKinds, 'six complete directory names');
  for (const kind of directoryKinds) {
    if (!Array.isArray(facts.catalogEntries[kind])) throw new Error(`World backup ${kind} directory is incomplete`);
    exact(facts.catalogEntries[kind].length, facts.catalogs[kind], `${kind} count`);
  }
  return facts;
}

export class WorldArchive extends Ability {
  private baseline?: Prerequisites;
  private priorIds: string[] = [];
  private attempted = false;
  private custodyPath?: string;
  private key?: { world: WorldRef; operationId: string };
  private receipt?: Receipt;
  constructor(private readonly electron: UseElectron) { super(); }

  private async record(kind: string, value: unknown, mode: 'a' | 'wx' = 'a'): Promise<void> {
    if (!this.custodyPath) throw new Error('World backup custody was not prepared');
    const file = await open(this.custodyPath, mode);
    try {
      await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`);
      await file.sync();
    } finally { await file.close(); }
  }

  async prepare(value: unknown): Promise<void> {
    if (this.baseline || this.attempted) throw new Error('World backup is one-shot per run; no resume or replacement');
    this.baseline = prerequisites(value);
    this.priorIds = await this.electron.page.locator(`${sessionSelector} option`).evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
    if (new Set(this.priorIds).size !== this.priorIds.length) throw new Error('World backup session contains ambiguous operation identities');
    this.custodyPath = join(this.electron.outputDirectory, `world-archive-${randomUUID()}.jsonl`);
    await this.record('baseline', this.baseline, 'wx');
  }

  private async captureKey(): Promise<void> {
    const ids = await this.electron.page.locator(`${sessionSelector} option`).evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
    await this.record('ui-session', { before: this.priorIds, after: ids });
    const added = ids.filter(id => !this.priorIds.includes(id));
    if (added.length !== 1 || new Set(ids).size !== ids.length || !/^[A-Za-z0-9_.:-]{1,256}$/.test(added[0])) {
      throw new Error('World backup has no unique new public session OperationKey; the unknown attempt is retained, never resent');
    }
    this.key = { world: this.baseline!.world, operationId: added[0] };
    await this.record('operation-key', { source: 'ui-session', key: this.key });
    exact(await this.electron.page.locator(sessionSelector).inputValue(), this.key.operationId, 'actual selected operation');
  }

  async submit() {
    if (!this.baseline || this.attempted) throw new Error('World backup cannot be submitted again');
    this.attempted = true;
    await this.record('attempt', { world: this.baseline.world, command: {
      kind: 'backup', request: { expectedRelease: this.baseline.activeRelease, includeMaterials: false },
    } });
    try {
      await this.electron.page.getByRole('button', { name: /^(Create backup|创建备份)$/, exact: true }).click({ timeout: 10_000 });
      await this.electron.page.locator(sessionSelector).waitFor({ state: 'visible', timeout: 30_000 });
      await this.captureKey();
      return this.key!;
    } catch (error) {
      const failures = [error];
      if (!this.key) {
        try { await this.captureKey(); } catch (captureFailure) { failures.push(captureFailure); }
      }
      try { await this.record('unknown', { key: this.key ?? null, replayed: false }); }
      catch (custodyFailure) { failures.push(custodyFailure); }
      throw new AggregateError(failures, 'Original World backup submission is unconfirmed; preserve custody without retry, resume, restore or deletion');
    }
  }

  private async read(kind: 'status' | 'result' | 'backup_status'): Promise<Receipt> {
    if (!this.key) throw new Error('World backup has no original public OperationKey');
    const query = kind === 'backup_status';
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${query ? 'query' : 'operation'}`, method: 'POST', timeoutMs: 10_000,
      body: query ? { world: this.key.world, query: { kind, request: this.key } } : { kind, request: this.key } });
    if (!reply.ok) throw new Error(`World backup ${kind} transport=${reply.error.code}; original key retained`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: Receipt }; error?: { code: string; stage: string; diagnosticId: string } };
    if (!body?.success) throw new Error(`World backup ${kind}: HTTP ${reply.data.status}; code=${body?.error?.code}; stage=${body?.error?.stage}; diagnosticId=${body?.error?.diagnosticId}`);
    if (!reply.data.ok || reply.data.status !== 200 || body.data?.kind !== (query ? 'operation' : kind)) throw new Error(`World backup ${kind} public result kind mismatch`);
    await this.record(kind, body.data.result);
    return body.data.result;
  }

  async confirmReceipt() {
    const status = await this.read('status');
    const result = await this.read('result');
    const backup = await this.read('backup_status');
    exact(result.accepted.world, this.key!.world, 'receipt World');
    exact(result.accepted.operationId, this.key!.operationId, 'receipt OperationKey');
    exact(result.accepted.incarnation, this.baseline!.incarnation, 'receipt incarnation');
    if (result.phase !== 'completed' || result.failure != null) {
      const failure = result.failure as { code?: string; stage?: string; diagnosticId?: string } | null;
      throw new Error(`World backup key=${JSON.stringify(this.key)}; phase=${result.phase}; code=${failure?.code ?? 'not-returned'}; stage=${failure?.stage ?? 'not-returned'}; diagnosticId=${failure?.diagnosticId ?? 'not-returned'}; original public receipts retained without replay`);
    }
    exact([result.phase, result.disclosure.kind, result.failure, result.effects, result.result?.kind],
      ['completed', 'full', null, [], 'backup'], 'completed full backup result');
    const manifest = result.result.result.manifest;
    if (!manifest || !/^sha256:[a-f0-9]{64}$/.test(manifest.digest) || !/^[1-9]\d{0,19}$/.test(manifest.byteSize)
      || BigInt(manifest.byteSize) > 18_446_744_073_709_551_615n) throw new Error('World backup manifest is not a positive sealed SHA-256 blob reference');
    exact(status, result, 'status/result consistency');
    exact(backup, result, 'backup_status operation consistency');
    if (this.receipt) exact(result, this.receipt, 'same original terminal receipt after refresh');
    else this.receipt = result;
    return result;
  }

  async downloadReceipt() {
    if (!this.receipt) throw new Error('Download requires the original completed public backup receipt');
    const [download] = await Promise.all([
      this.electron.page.waitForEvent('download', { timeout: 15_000 }),
      this.electron.page.getByRole('button', { name: /^(Save backup operation receipt|保存备份操作回执)$/, exact: true }).click(),
    ]);
    exact(download.suggestedFilename(), 'world-backup-receipt.json', 'download filename');
    const directory = await mkdtemp(join(this.electron.outputDirectory, 'world-backup-receipt-'));
    const path = join(directory, 'world-backup-receipt.json');
    await download.saveAs(path);
    exact(await download.failure(), null, 'same-application download outcome');
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > 8 * 1024 * 1024) throw new Error('World backup receipt download exceeds the 8 MiB bound');
    exact(JSON.parse(await readFile(path, 'utf8')), this.receipt, 'entire downloaded original public receipt');
    await this.record('download', { path, byteSize: info.size, equalsReceipt: true });
    return { byteSize: info.size, equalsReceipt: true };
  }

  async comparePrerequisites(value: unknown) {
    if (!this.receipt || !this.baseline) throw new Error('World backup readback requires its original baseline and terminal receipt');
    const current = prerequisites(value);
    await this.record('readback', current);
    exact(current, this.baseline, 'release/head/incarnation, six full directories, Tasks, packages and trust policy unchanged');
    return { unchanged: true, operationKey: this.key, manifest: this.receipt.result.result.manifest };
  }
}
