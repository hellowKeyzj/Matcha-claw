import { Ability } from '@serenity-js/core';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { appProjectRoot, licensedProfileRoot, repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

type World = { tenantId: string; worldId: string };
type FileFact = { path: string; bytes: number; sha256: string };
type Root = { publisher: string; keyId: string; publicKey: number[]; allowProcess: boolean; allowNative: boolean };
type Signing = Omit<Root, 'publicKey'> & { publicKey: string };
type Policy = { revision: string; unsignedWasm: string; trustedPublishers: Root[]; trustedProcessDigests: string[]; trustedNativeDigests: string[] };
type Manifest = {
  format: string; identity: { publisher: string; id: string; version: string };
  files: { path: string; size: string; digest: string }[];
  artifacts: { id: string; kind: string; runtime: string; path: string; digest: string; entrypoint: { kind: string; executable: string } }[];
  provides: unknown[]; requires: unknown[]; dependencies: unknown[]; requestedAccess: unknown[]; state: unknown[];
};
type Guard = {
  passed: boolean; materialsStage: string; materialsInputs: { 'runtime-host': FileFact; 'world-pack': FileFact };
  packagePath: string; packageBytes: number; packageDigest: string; transportDigest: string; signing: Signing;
};
type Installed = {
  world: World; installId: string; revision: string; packageDigest: string; transportDigest: string; manifest: Manifest;
  trust: { policyRevision: string; signatureVerified: boolean; publisher: string; keyId: string; packageDigest: string; decidedAt: string };
};
type Description = { world: World; status: string; incarnation: string; activeRelease: unknown; activeReleaseHead: unknown };
type Receipt = {
  accepted: { world: World; operationId: string; incarnation: string; revision: string }; phase: string; disclosure: { kind: string };
  progress: { stage: string }; failure: { code: string; stage: string; diagnosticId: string } | null;
  result: { kind: string; result: unknown } | null;
};
type Key = { world: World; operationId: string };
type Stage = 'replace_package_trust_policy' | 'install_package' | 'enable_package';
type Header = {
  kind: 'prepared'; schemaVersion: 1; world: World; profileRoot: string; guardPath: string; guardSha256: string;
  guard: Guard; manifest: Manifest; before: { description: Description; policy: Policy; packages: Installed[] }; policyAfter: Policy;
};
type NewInstallDecision = { schemaVersion: 1; humanDecision: '不保留旧请求'; singleNewAttempt: true; custodySha256: string; packageDigest: string; transportDigest: string; readback: string };
type Event = Header | { kind: 'new_install_authorized'; decision: NewInstallDecision; decisionPath: string; decisionSha256: string; originalAttemptIndex: number }
  | { kind: 'attempt'; stage: Stage; input: unknown } | { kind: 'operation'; stage: Stage; key: Key }
  | { kind: 'trace'; stage: Stage; key: Key; phase: string; text: string }
  | { kind: 'receipt'; stage: Stage; receipt: Receipt }
  | { kind: 'upload'; stage: 'install_package'; transferId: string }
  | { kind: 'confirmed'; stage: Stage; receipt: Receipt; record?: Installed }
  | { kind: 'blocked'; phase: string; message: string; alerts: string[] };
type Observation = { ids: string[]; error?: string; dispose(): void };
type Locator = ReturnType<UseElectron['page']['locator']>;
const world = { tenantId: 'local', worldId: 'personal' };
const identity = { publisher: 'matcha', id: 'world-materials', version: '1.0.20261027' };
const stages: Stage[] = ['replace_package_trust_policy', 'install_package', 'enable_package'];
const terminal = ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'commit_indeterminate', 'effect_indeterminate', 'retained'];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const basis = (description: Description) => [description.world, description.status, description.incarnation, description.activeRelease, description.activeReleaseHead];
const displayed = (policy: Policy) => ({ ...policy, trustedPublishers: policy.trustedPublishers.map(root => ({ ...root, publicKey: Buffer.from(root.publicKey).toString('hex') })) });
function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World materials setup ${label} differs; retain original custody, no resend`);
}
function trustedPolicy(policy: Policy, guard: Guard): Policy {
  const root = { ...guard.signing, publicKey: Array.from(Buffer.from(guard.signing.publicKey, 'hex')) };
  const existing = policy.trustedPublishers.filter(item => item.publisher === root.publisher && item.keyId === root.keyId);
  if (existing.length > 1) throw new Error('Ambiguous existing signing root; no trust mutation');
  if (existing.length) exact(existing[0], root, 'existing signing root retains the exact key and false flags');
  const addRoot = existing.length === 0; const addDigest = !policy.trustedProcessDigests.includes(guard.packageDigest);
  if (!/^[1-9]\d*$/.test(policy.revision) || ((addRoot || addDigest) && BigInt(policy.revision) >= 9_223_372_036_854_775_807n)
    || policy.trustedPublishers.length + Number(addRoot) > 4096 || policy.trustedProcessDigests.length + Number(addDigest) > 4096) throw new Error('Trust policy has no revision/root/digest capacity');
  return { ...policy, revision: String(BigInt(policy.revision) + BigInt(addRoot || addDigest)),
    trustedPublishers: addRoot ? [...policy.trustedPublishers, root] : policy.trustedPublishers,
    trustedProcessDigests: addDigest ? [...policy.trustedProcessDigests, guard.packageDigest] : policy.trustedProcessDigests };
}

export class WorldMaterialsSetup extends Ability {
  private phase = 'idle';
  private custodyPath = '';
  private events: Event[] = [];
  private header!: Header;
  private originalFailure?: string;
  private deadline = 0;
  private confirmationOpen = false;
  constructor(private readonly electron: UseElectron) { super(); }
  private get workspace() { return this.electron.page.locator('main .world-workspace'); }
  private get detail() { return this.workspace.locator('aside.world-detail-panel'); }
  private get policyPanel() { return this.workspace.locator('details').filter({ has: this.electron.page.locator(':scope > summary').filter({ hasText: /^(当前包信任策略|Current package trust policy)$/ }) }); }

  private async publicPath(path: string): Promise<string> {
    const actual = await realpath(resolve(repositoryRoot, path));
    const within = relative(await realpath(resolve(repositoryRoot, '.scratch')), actual);
    if (!within || within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)
      || /(?:^|[\\/])(?:\.?profiles?|secrets?)(?:[\\/]|$)/i.test(actual)) throw new Error('Materials inputs must be original public scratch artifacts, never Profile or secrets');
    return actual;
  }
  private async fileFact(path: string): Promise<FileFact> {
    const file = await open(path, 'r');
    try {
      const before = await file.stat();
      if (!before.isFile() || !before.size || before.size > 1024 * 1024 * 1024) throw new Error('Materials artifact must be a nonempty regular file within the original 1 GiB limit');
      const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
      for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
      const after = await file.stat();
      exact([after.size, after.mtimeMs, after.ctimeMs], [before.size, before.mtimeMs, before.ctimeMs], 'stable artifact while streaming SHA');
      return { path, bytes: before.size, sha256: hash.digest('hex') };
    } finally { await file.close(); }
  }
  private async manifest(guard: Guard): Promise<Manifest> {
    const script = `import hashlib, json, os, sys, zipfile
with open(sys.argv[1], 'rb') as source:
    before = os.fstat(source.fileno())
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if not names or len(names) > 4096 or len(set(names)) != len(names) or names[0] != 'package.json':
            raise ValueError('Invalid signed ZIP entry identity')
        if any(entry.is_dir() or entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) for entry in entries):
            raise ValueError('Unsupported signed ZIP entry')
        if any(entry.file_size < 0 or entry.compress_size > before.st_size for entry in entries) or sum(entry.file_size for entry in entries) > 1024 * 1024 * 1024:
            raise ValueError('Signed ZIP exceeds its expanded 1 GiB boundary')
        def read_small(name, limit):
            entry = archive.getinfo(name)
            if not 0 < entry.file_size <= limit:
                raise ValueError('Signed ZIP metadata exceeds its boundary')
            with archive.open(entry) as item:
                data = item.read(limit + 1)
            if len(data) != entry.file_size:
                raise ValueError('Signed ZIP metadata size mismatch')
            return data
        manifest = read_small('package.json', 1048576)
        signature = read_small('signatures/package.sig', 65536)
        digest = hashlib.sha256()
        size = 0
        with archive.open('bin/runtime-host.exe') as payload:
            while True:
                chunk = payload.read(1048576)
                if not chunk:
                    break
                size += len(chunk)
                if size > 1024 * 1024 * 1024:
                    raise ValueError('Host payload exceeds its 1 GiB boundary')
                digest.update(chunk)
        if size != archive.getinfo('bin/runtime-host.exe').file_size:
            raise ValueError('Host payload size mismatch')
    after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('Signed ZIP changed during verification')
print(json.dumps(dict(names=names, manifest=manifest.decode('utf-8'), manifestDigest='sha256:' + hashlib.sha256(manifest).hexdigest(), signature=signature.decode('utf-8'), hostBytes=size, hostSha256=digest.hexdigest())))`;
    const output = await new Promise<string>((accept, reject) => {
      execFile('python', ['-I', '-X', 'utf8', '-c', script, guard.packagePath],
        { cwd: repositoryRoot, encoding: 'utf8', timeout: Math.max(1, Math.min(30_000, this.deadline - Date.now())), maxBuffer: 2 * 1024 * 1024, windowsHide: true },
        (error, stdout) => { if (error) reject(error); else accept(stdout); });
    });
    const archive = JSON.parse(output) as { names: string[]; manifest: string; manifestDigest: string; signature: string; hostBytes: number; hostSha256: string };
    exact(archive.manifestDigest, guard.packageDigest, 'exact raw manifest digest');
    exact([archive.hostBytes, archive.hostSha256], [guard.materialsInputs['runtime-host'].bytes, guard.materialsInputs['runtime-host'].sha256], 'actual streamed expanded Host ZIP payload');
    const manifest = JSON.parse(archive.manifest) as Manifest;
    const signature = JSON.parse(archive.signature) as { publisher: string; keyId: string; algorithm: string; packageDigest: string; signature: number[] };
    exact(archive.names.slice().sort(), ['package.json', ...manifest.files.map(item => item.path), 'signatures/package.sig'].sort(), 'complete signed ZIP entry set');
    exact(manifest.identity, identity, 'authorized package identity');
    exact(manifest.format, 'matcha.world-package/1', 'package format');
    exact([manifest.requestedAccess, manifest.provides, manifest.requires, manifest.dependencies, manifest.state], [[], [], [], [], []], 'no grants, slots, imports, dependencies or state');
    if (manifest.artifacts.length !== 1) throw new Error('Materials package must contain only its original process artifact');
    const artifact = manifest.artifacts[0]; const payload = manifest.files.filter(item => item.path === 'bin/runtime-host.exe');
    exact([artifact.kind, artifact.runtime, artifact.path, artifact.digest, artifact.entrypoint.kind, artifact.entrypoint.executable],
      ['implementation', 'trusted_process', 'bin/runtime-host.exe', `sha256:${guard.materialsInputs['runtime-host'].sha256}`, 'process', 'bin/runtime-host.exe'], 'materials process exact Host SHA');
    exact(payload.map(item => [item.size, item.digest]), [[String(guard.materialsInputs['runtime-host'].bytes), artifact.digest]], 'declared Host payload bytes');
    exact([signature.publisher, signature.keyId, signature.algorithm, signature.packageDigest], [guard.signing.publisher, guard.signing.keyId, 'ed25519', guard.packageDigest], 'original signature identity');
    if (!Array.isArray(signature.signature) || signature.signature.length !== 64 || signature.signature.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Invalid original Ed25519 signature bytes');
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(guard.signing.publicKey, 'hex')]), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(`${manifest.format}\n${guard.packageDigest}`), publicKey, Buffer.from(signature.signature))) throw new Error('Original package public signature verification failed; no trust mutation');
    return manifest;
  }
  private async read<T>(route: 'query' | 'operation', kind: string, request: unknown): Promise<T> {
    const reply = await this.electron.fetchHostApi({ path: `/api/world/${route}`, method: 'POST', timeoutMs: 10_000,
      body: route === 'query' ? { world, query: { kind, request } } : { kind, request } });
    if (!reply.ok) throw new Error(`Materials ${kind} read transport=${reply.error.code}; no replay`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: T }; error?: { code: string; stage: string; diagnosticId: string } };
    if (!reply.data.ok || reply.data.status !== 200 || body?.success !== true || body.data?.kind !== kind) throw new Error(`Materials ${kind} read HTTP=${reply.data.status}; ${JSON.stringify(body?.error ?? null)}`);
    return body.data.result;
  }
  private async inventory(): Promise<Installed[]> {
    const items: Installed[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { items: Installed[]; nextCursor?: string | null } = await this.read('query', 'packages', { page: { limit: 100, cursor } });
      if (!Array.isArray(page.items) || page.items.length > 100) throw new Error('Invalid public package page');
      for (const record of page.items) {
        exact(record.world, world, 'inventory World');
        if (items.some(item => item.installId === record.installId)) throw new Error('Repeated public installation identity');
        items.push(record);
      }
      cursor = page.nextCursor ?? null;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Public inventory cursor did not terminate');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return items.sort((a, b) => a.installId.localeCompare(b.installId));
  }
  private async append(event: Event): Promise<void> {
    const file = await open(this.custodyPath, 'a');
    try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); this.events.push(event); }
    finally { await file.close(); }
  }
  private stageEvents(stage: Stage) {
    const marker = this.events.findIndex(event => event.kind === 'new_install_authorized');
    return stage === 'replace_package_trust_policy' || marker < 0 ? this.events : this.events.slice(marker + 1);
  }
  private confirmed(stage: Stage) { return this.stageEvents(stage).find((event): event is Extract<Event, { kind: 'confirmed' }> => event.kind === 'confirmed' && event.stage === stage); }
  private operation(stage: Stage) { return this.stageEvents(stage).find((event): event is Extract<Event, { kind: 'operation' }> => event.kind === 'operation' && event.stage === stage); }
  private get requiredStages() { return this.header.before.policy.revision === this.header.policyAfter.revision ? stages.slice(1) : stages; }
  private async retainUpload(): Promise<void> {
    const output = this.workspace.getByLabel(/^(上传编号|Upload ID)$/, { exact: true });
    const count = await output.count();
    if (count === 0) return;
    exact(count, 1, 'single public upload identity');
    const transferId = (await output.textContent({ timeout: 1000 }))?.trim();
    if (!transferId || Buffer.byteLength(transferId) > 256 || /\p{Cc}/u.test(transferId)) throw new Error('Public upload identity is invalid; no guessed identity');
    const prior = this.stageEvents('install_package').filter((event): event is Extract<Event, { kind: 'upload' }> => event.kind === 'upload');
    if (prior.length) exact(prior.map(event => event.transferId), [transferId], 'unchanged original upload identity');
    else await this.append({ kind: 'upload', stage: 'install_package', transferId });
  }
  private verifyReceipt(stage: Stage, receipt: Receipt, key: Key): void {
    exact([receipt.accepted.world, receipt.accepted.operationId, receipt.accepted.incarnation], [world, key.operationId, this.header.before.description.incarnation], 'original operation ownership');
    if (receipt.phase !== 'completed' || receipt.failure !== null || receipt.disclosure.kind !== 'full'
      || receipt.result?.kind !== (stage === 'replace_package_trust_policy' ? 'package_trust_policy' : 'package')) throw new Error(`Original ${stage} operation=${key.operationId}; phase=${receipt.phase}; code=${receipt.failure?.code}; stage=${receipt.failure?.stage ?? receipt.progress.stage}; diagnosticId=${receipt.failure?.diagnosticId}; no replay`);
    if (stage === 'replace_package_trust_policy') exact(receipt.result.result, { revision: this.header.policyAfter.revision }, 'original trust revision receipt');
    else {
      const result = receipt.result.result as { installId: string; revision: string };
      if (typeof result.installId !== 'string' || !result.installId || !/^[1-9]\d*$/.test(result.revision)) throw new Error('Original package receipt omitted installation identity/revision');
      if (stage === 'install_package') exact(result.revision, '2', 'new default-disabled installation revision');
      if (stage === 'enable_package') {
        const installed = this.confirmed('install_package')?.record;
        if (!installed) throw new Error('Enable requires the exact original installation custody');
        exact(result, { installId: installed.installId, revision: String(BigInt(installed.revision) + 1n) }, 'original enable CAS revision');
      }
    }
  }
  private async confirmStage(stage: Stage, receipt: Receipt, key: Key): Promise<void> {
    this.verifyReceipt(stage, receipt, key);
    exact(await this.read('query', 'package_trust_policy', {}), this.header.policyAfter, 'complete durable policy preserves all other fields');
    const packages = await this.inventory(); let record: Installed | undefined;
    if (stage !== 'replace_package_trust_policy') {
      const result = receipt.result!.result as { installId: string; revision: string };
      record = packages.find(item => item.installId === result.installId);
      if (!record) throw new Error('Original installation receipt has no corresponding public record');
      exact([record.revision, record.manifest, record.packageDigest, record.transportDigest], [result.revision, this.header.manifest, this.header.guard.packageDigest, this.header.guard.transportDigest], 'exact installed manifest and package/transport');
      exact([record.trust.policyRevision, record.trust.signatureVerified, record.trust.publisher, record.trust.keyId, record.trust.packageDigest],
        [this.header.policyAfter.revision, true, this.header.guard.signing.publisher, this.header.guard.signing.keyId, this.header.guard.packageDigest], 'verified signature and precise install trust');
      if (stage === 'enable_package') exact(record, { ...this.confirmed('install_package')!.record, revision: result.revision }, 'enable changes only exact installation revision');
    }
    exact(packages, [...this.header.before.packages, ...(record ? [record] : [])].sort((a, b) => a.installId.localeCompare(b.installId)), 'all other installations preserved');
    exact(basis(await this.read<Description>('query', 'discover', { includeCapabilities: false })), basis(this.header.before.description), 'unchanged World release and binding basis');
    await this.append({ kind: 'confirmed', stage, receipt, ...(record ? { record } : {}) });
  }
  private async capabilities(): Promise<void> {
    const tab = this.workspace.getByRole('tab', { name: /^(能力扩展|Capabilities)$/, exact: true });
    if (await tab.getAttribute('aria-selected') !== 'true') await tab.click({ timeout: 15_000 });
    await this.workspace.getByLabel(/^(ZIP 安装包|Package ZIP)$/, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  }
  private async inspectInstalled(record: Installed): Promise<void> {
    await this.capabilities();
    const search = this.workspace.getByRole('textbox', { name: /^(搜索已安装能力|Search installed capabilities)$/, exact: true });
    await search.fill(record.installId);
    const card = this.workspace.locator('.world-capability-grid > button[aria-pressed]').filter({ has: this.electron.page.locator('span.font-semibold').filter({ hasText: /^world-materials$/ }) });
    for (let page = 0; await card.count() === 0 && page < 100; page++) {
      const next = this.workspace.getByRole('button', { name: /^(加载更多|Load more)$/, exact: true });
      const until = Math.min(this.deadline, Date.now() + 15_000);
      while (Date.now() < until && !await card.count() && (!await next.count() || !await next.isEnabled())) await setTimeout(100);
      if (await card.count()) break;
      if (!await next.count() || !await next.isEnabled()) throw new Error('Exact original installation is unavailable in UI inventory');
      await next.click({ timeout: 15_000 });
    }
    exact(await card.count(), 1, 'single exact installation card'); await card.click({ timeout: 15_000 });
    const id = this.detail.locator('dl > div').filter({ has: this.electron.page.locator('dt').filter({ hasText: /^(安装标识|安装 ID|Installation ID)$/ }) }).locator('dd');
    exact((await id.innerText()).trim(), record.installId, 'UI installation identity');
  }
  private async retainTrace(stage: Stage, key: Key, receipt: Receipt): Promise<void> {
    await this.workspace.getByRole('tab', { name: /^(处理记录|Processing records)$/, exact: true }).click({ timeout: 15_000 });
    const records = this.workspace.getByRole('region', { name: /^(处理记录|Processing records)$/, exact: true });
    const summary = records.locator('details > summary').filter({ hasText: /^(按编号查找历史记录|Find a past record by ID)$/ });
    if (await summary.locator('..').getAttribute('open') === null) await summary.click({ timeout: 15_000 });
    await records.getByRole('textbox', { name: /^(处理编号|Operation ID)$/, exact: true }).fill(key.operationId);
    await records.getByRole('button', { name: /^(查询|Look up)$/, exact: true }).click({ timeout: 15_000 });
    const trace = records.locator('aside[aria-labelledby="world-operation-trace"]');
    const until = Math.min(this.deadline, Date.now() + 15_000);
    while (Date.now() < until) {
      const id = trace.locator('.world-panel-body > p.font-mono'); const phase = trace.locator('.world-status[data-status]');
      if (await id.count() === 1 && await phase.count() === 1 && await id.textContent() === key.operationId
        && await phase.getAttribute('data-status') === receipt.phase) {
        await this.append({ kind: 'trace', stage, key, phase: receipt.phase, text: await trace.innerText() }); return;
      }
      await setTimeout(100);
    }
    throw new Error(`Original ${stage} trace did not display exact operation=${key.operationId} phase=${receipt.phase}`);
  }
  private async submit(stage: Stage, input: unknown, action: () => Promise<void>): Promise<void> {
    if (this.stageEvents(stage).some(event => event.kind === 'attempt' && event.stage === stage)) throw new Error(`Original ${stage} already attempted; read its retained receipt, never repeat`);
    const observation = await this.electron.page.evaluateHandle(({ world, incarnation }) => {
      const ipc = (window as unknown as { electron: { ipcRenderer: { on(channel: string, listener: (value: unknown) => void): () => void } } }).electron.ipcRenderer;
      const state: Observation = { ids: [], dispose: () => undefined };
      const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
      state.dispose = ipc.on('host:event', value => {
        if (!object(value) || !['world:changed', 'world:resync-required'].includes(String(value.eventName)) || !object(value.payload)) return;
        const hint = value.payload;
        if (!object(hint.world) || hint.world.tenantId !== world.tenantId || hint.world.worldId !== world.worldId) return;
        if (hint.incarnation !== incarnation || hint.kind === 'resync_required') { state.error = 'Original World operation event continuity lost'; return; }
        if (!object(hint.resource) || hint.resource.kind !== 'operation' || typeof hint.resource.id !== 'string') return;
        if (!state.ids.includes(hint.resource.id)) state.ids.push(hint.resource.id);
        if (state.ids.length > 1) state.error = 'Ambiguous original operation events';
      });
      return state;
    }, { world, incarnation: this.header.before.description.incarnation });
    let primaryFailure: unknown;
    try {
      this.phase = stage;
      await this.append({ kind: 'attempt', stage, input });
      await action();
      while (Date.now() < this.deadline) {
        if (stage === 'install_package') await this.retainUpload();
        const observed = await observation.evaluate(state => ({ ids: state.ids, error: state.error }));
        if (observed.error) throw new Error(observed.error);
        if (observed.ids.length === 1) {
          const key = { world, operationId: observed.ids[0] };
          if (!this.operation(stage)) await this.append({ kind: 'operation', stage, key });
          exact(this.operation(stage)!.key, key, 'single original operation key');
          const status = await this.read<Receipt>('operation', 'status', key);
          exact([status.accepted.world, status.accepted.operationId, status.accepted.incarnation], [world, key.operationId, this.header.before.description.incarnation], 'original status ownership');
          if (terminal.includes(status.phase)) {
            await this.append({ kind: 'receipt', stage, receipt: status });
            const originalFailure = status.phase !== 'completed' || status.failure
              ? new Error(`Original ${stage} operation=${key.operationId}; phase=${status.phase}; code=${status.failure?.code}; stage=${status.failure?.stage ?? status.progress.stage}; diagnosticId=${status.failure?.diagnosticId}; no replay`) : undefined;
            let result: Receipt;
            try {
              result = await this.read<Receipt>('operation', 'result', key);
              exact([result.accepted, result.phase], [status.accepted, status.phase], 'original result ownership and phase');
              await this.append({ kind: 'receipt', stage, receipt: result });
              await this.retainTrace(stage, key, result);
            } catch (error) { throw originalFailure ? new AggregateError([originalFailure, error], 'Original terminal failure and result/trace readback failure retained') : error; }
            if (originalFailure) throw originalFailure;
            this.verifyReceipt(stage, result, key);
            const final = await observation.evaluate(state => ({ ids: state.ids, error: state.error }));
            exact(final, { ids: [key.operationId], error: undefined }, 'sole original traced operation');
            exact(await this.electron.page.getByRole('dialog').count(), 0, 'closed application confirmation collection'); this.confirmationOpen = false;
            await this.confirmStage(stage, result, key);
            return;
          }
        } else {
          const alerts = await this.workspace.getByRole('alert').allTextContents();
          if (alerts.length) throw new Error(`Original ${stage} has no operation receipt: ${JSON.stringify(alerts)}`);
        }
        await setTimeout(100);
      }
      throw new Error(`Original ${stage} outcome remains unknown; no original operation identity is invented, no retry`);
    } catch (error) { primaryFailure = error; throw error; }
    finally {
      const errors: unknown[] = [];
      try { await observation.evaluate(state => state.dispose()); } catch (error) { errors.push(error); }
      try { await observation.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(primaryFailure === undefined ? errors : [primaryFailure, ...errors], 'Original materials failure and event observation cleanup errors retained');
    }
  }
  private async applicationConfirm(button: Locator, inspect: (dialog: Locator) => Promise<void>): Promise<Locator> {
    exact(await this.electron.page.getByRole('dialog').count(), 0, 'initial confirmation boundary');
    await button.click({ timeout: 15_000 });
    const dialog = this.electron.page.getByRole('dialog'); await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    exact(await dialog.count(), 1, 'single application confirmation'); this.confirmationOpen = true; await inspect(dialog);
    return dialog.getByRole('button', { name: /^(确认|Confirm)$/, exact: true });
  }
  private async trust(): Promise<void> {
    await this.capabilities(); const panel = this.policyPanel;
    if (await panel.getAttribute('open') === null) await panel.locator(':scope > summary').click();
    await panel.getByRole('button', { name: /^(读取当前策略|Read current policy)$/, exact: true }).click();
    await panel.locator('fieldset').waitFor({ state: 'visible', timeout: 15_000 });
    const root = this.header.guard.signing;
    if (!this.header.before.policy.trustedPublishers.some(item => item.publisher === root.publisher && item.keyId === root.keyId)) {
      await panel.locator('input[name="publisher"]').fill(root.publisher);
      await panel.locator('input[name="keyId"]').fill(root.keyId);
      await panel.locator('input[name="publicKey"]').fill(root.publicKey);
      exact(await Promise.all(['allowProcess', 'allowNative'].map(name => panel.locator(`input[name="${name}"]`).isChecked())), [false, false], 'signature root flags remain false');
      await panel.getByRole('button', { name: /^(将公钥加入草稿|Add public key to draft)$/, exact: true }).click();
    }
    if (!this.header.before.policy.trustedProcessDigests.includes(this.header.guard.packageDigest)) {
      await panel.getByRole('combobox', { name: /^(添加到信任集合|Add to trust set)$/, exact: true }).selectOption('trustedProcessDigests');
      await panel.getByRole('textbox', { name: /^(精确 packageDigest|Exact packageDigest)$/, exact: true }).fill(this.header.guard.packageDigest);
      await panel.getByRole('button', { name: /^(将摘要加入草稿|Add digest to draft)$/, exact: true }).click();
    }
    const previews = async () => {
      exact(JSON.parse(await panel.getByLabel(/^(替换前完整策略|Complete policy before replacement)$/, { exact: true }).innerText()), displayed(this.header.before.policy), 'complete before policy preview');
      exact(JSON.parse(await panel.getByLabel(/^(替换后完整策略|Complete policy after replacement)$/, { exact: true }).innerText()), displayed(this.header.policyAfter), 'complete after policy preview');
      exact(await this.read('query', 'package_trust_policy', {}), this.header.before.policy, 'original policy CAS');
    };
    await previews();
    const confirm = await this.applicationConfirm(panel.getByRole('button', { name: /^(确认并提交信任变更|Confirm and submit trust changes)$/, exact: true }), async dialog => {
      const text = await dialog.innerText();
      exact([/本 World 的签名信任根|signing trust roots? (?:for|of) this World/i.test(text), /不是官方背书|not (?:an )?official endorsement/i.test(text), /不是密钥与摘要配对限定|do not restrict trust to a key-and-digest pair/i.test(text)], [true, true, true], 'full signing-root risk notice');
      if (!text.includes('personal') || !text.includes(`${this.header.before.policy.revision} → ${this.header.policyAfter.revision}`)) throw new Error('Trust confirmation World/revision differs');
      await previews();
    });
    await this.submit('replace_package_trust_policy', { expectedRevision: this.header.before.policy.revision, policy: this.header.policyAfter }, () => confirm.click({ timeout: 15_000 }));
  }
  private async install(): Promise<void> {
    await this.capabilities();
    const input = this.workspace.getByLabel(/^(ZIP 安装包|Package ZIP)$/, { exact: true });
    await input.setInputFiles(this.header.guard.packagePath);
    exact(await input.evaluate(element => Array.from((element as HTMLInputElement).files ?? []).map(file => ({ name: file.name, size: file.size }))),
      [{ name: basename(this.header.guard.packagePath), size: this.header.guard.packageBytes }], 'actual selected absolute ZIP file');
    await this.workspace.getByRole('combobox', { name: /^(安装目标|Installation target)$/, exact: true }).selectOption('');
    exact(await this.workspace.getByLabel(/^(上传编号|Upload ID)$/, { exact: true }).count(), 0, 'no prior upload identity before the original submission');
    await this.submit('install_package', { packagePath: this.header.guard.packagePath, packageBytes: this.header.guard.packageBytes, transportDigest: this.header.guard.transportDigest, target: 'new' },
      () => this.workspace.getByRole('button', { name: /^(提交安装|Submit installation)$/, exact: true }).click({ timeout: 15_000 }));
  }
  private async enable(): Promise<void> {
    const record = this.confirmed('install_package')!.record!;
    await this.inspectInstalled(record);
    const confirm = await this.applicationConfirm(this.detail.getByRole('button', { name: /^(申请启用|Request enable)$/, exact: true }), async dialog => {
      if (!(await dialog.innerText()).includes(identity.id)) throw new Error('Enable confirmation identifies a different package');
      exact((await this.inventory()).find(item => item.installId === record.installId), record, 'original disabled installation revision before enable CAS');
    });
    await this.submit('enable_package', { installId: record.installId, expectedRevision: record.revision }, () => confirm.click({ timeout: 15_000 }));
  }
  private async prepareNewInstall(existing: string): Promise<void> {
    const markers = this.events.filter((event): event is Extract<Event, { kind: 'new_install_authorized' }> => event.kind === 'new_install_authorized');
    const source = process.env.E2E_WORLD_MATERIALS_NEW_INSTALL_RECEIPT;
    if (markers.length > 1 || (markers.length && source)) throw new Error('Single new-install decision already consumed; inspect only its retained attempt');
    if (!markers.length && !source) return;
    const publicJson = async (path: string) => {
      if (!isAbsolute(path)) throw new Error('New-install evidence requires an absolute public scratch path');
      const actual = await this.publicPath(path); const info = await stat(actual);
      if (!info.isFile() || !info.size || info.size > 32 * 1024 * 1024) throw new Error('New-install public evidence exceeds its bound');
      return { path: actual, bytes: await readFile(actual) };
    };
    const file = source ? await publicJson(source) : undefined;
    const decision = file ? JSON.parse(file.bytes.toString('utf8')) as NewInstallDecision : markers[0].decision;
    const markerIndex = markers.length ? this.events.indexOf(markers[0]) : this.events.length;
    const prefix = existing.split('\n').slice(0, markerIndex).join('\n') + '\n';
    exact([decision.schemaVersion, decision.humanDecision, decision.singleNewAttempt, decision.custodySha256, decision.packageDigest, decision.transportDigest],
      [1, '不保留旧请求', true, sha256(Buffer.from(prefix)), this.header.guard.packageDigest, this.header.guard.transportDigest], 'single new-install decision and unchanged original journal');
    const prior = this.events.slice(0, markerIndex);
    const attempts = prior.filter(event => event.kind === 'attempt');
    exact(attempts.map(event => event.stage), ['replace_package_trust_policy', 'install_package'], 'one old unknown installation attempt');
    if (prior.some(event => 'stage' in event && (event.stage === 'enable_package' || (event.stage === 'install_package' && event.kind !== 'attempt')))) throw new Error('Old installation has operation evidence; new attempt is not permitted');
    const trust = prior.filter((event): event is Extract<Event, { kind: 'confirmed' }> => event.kind === 'confirmed' && event.stage === 'replace_package_trust_policy');
    const keys = prior.filter((event): event is Extract<Event, { kind: 'operation' }> => event.kind === 'operation' && event.stage === 'replace_package_trust_policy');
    if (trust.length !== 1 || keys.length !== 1) throw new Error('Single original confirmed trust custody required');
    if (markers.length) {
      exact(markers[0].originalAttemptIndex, prior.indexOf(attempts[1]), 'retained old attempt index');
      if (this.events.slice(markerIndex + 1).some(event => 'stage' in event && event.stage === 'replace_package_trust_policy')) throw new Error('New-install decision must not replace original trust custody');
      return;
    }
    const readbackFile = await publicJson(decision.readback);
    const readback = JSON.parse(readbackFile.bytes.toString('utf8')) as { stage: string; completed: boolean; ownerClosed: boolean; materialReadbackOnly: boolean; installUnknownRetained: boolean; materialsCustody: { path: string; sha256: string; trustKey: Key }; materialsInventory: { unchangedFromBefore: boolean; currentMatchingInstallIds: string[] } };
    exact([readback.stage, readback.completed, readback.ownerClosed, readback.materialReadbackOnly, readback.installUnknownRetained, readback.materialsCustody.sha256, readback.materialsCustody.trustKey, readback.materialsInventory.unchangedFromBefore, readback.materialsInventory.currentMatchingInstallIds],
      ['readback', true, true, true, true, decision.custodySha256, keys[0].key, true, []], 'successful original read-only materials evidence');
    exact(await this.publicPath(readback.materialsCustody.path), await this.publicPath(this.custodyPath), 'readback original custody path');
    const receipt = await this.read<Receipt>('operation', 'result', keys[0].key);
    this.verifyReceipt('replace_package_trust_policy', receipt, keys[0].key); exact(receipt, trust[0].receipt, 'fresh original trust before new installation');
    exact(await this.read('query', 'package_trust_policy', {}), this.header.policyAfter, 'fresh full policy before single new installation');
    exact(await this.inventory(), this.header.before.packages, 'fresh complete inventory before single new installation');
    exact(basis(await this.read<Description>('query', 'discover', { includeCapabilities: false })), basis(this.header.before.description), 'fresh original World basis before single new installation');
    exact(await readFile(this.custodyPath, 'utf8'), existing, 'unchanged original journal before decision append');
    await this.append({ kind: 'new_install_authorized', decision, decisionPath: file!.path, decisionSha256: sha256(file!.bytes), originalAttemptIndex: prior.indexOf(attempts[1]) });
  }
  private async prepare(): Promise<void> {
    if (resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) throw new Error('Materials setup only permits the dedicated licensed E2E Profile');
    const source = process.env.E2E_WORLD_MATERIALS_PACKAGE_RECEIPT?.trim();
    if (!source) throw new Error('E2E_WORLD_MATERIALS_PACKAGE_RECEIPT must identify the original signed world-pack guard.json');
    const guardPath = await this.publicPath(source); const info = await stat(guardPath);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Original package guard must be bounded public JSON');
    const bytes = await readFile(guardPath); const guard = JSON.parse(bytes.toString('utf8')) as Guard;
    exact([guard.passed, guard.materialsStage], [true, 'signed'], 'successful original signed packaging stage');
    exact([guard.signing.publisher, guard.signing.allowProcess, guard.signing.allowNative], ['matcha', false, false], 'authorized public test root');
    if (!/^[0-9a-f]{64}$/.test(guard.signing.publicKey) || !guard.signing.keyId || Buffer.byteLength(guard.signing.keyId) > 256 || /\p{Cc}/u.test(guard.signing.keyId)
      || !/^sha256:[0-9a-f]{64}$/.test(guard.packageDigest) || !/^sha256:[0-9a-f]{64}$/.test(guard.transportDigest) || !isAbsolute(guard.packagePath)) throw new Error('Invalid original signed package public metadata');
    exact(Object.keys(guard.materialsInputs).sort(), ['runtime-host', 'world-pack'], 'original materials input set');
    for (const name of ['runtime-host', 'world-pack'] as const) {
      const expected = guard.materialsInputs[name];
      if (isAbsolute(expected.path) || !/^[0-9a-f]{64}$/.test(expected.sha256)) throw new Error('Materials input requires repo-relative path and exact SHA');
      const actual = await this.fileFact(await this.publicPath(expected.path));
      exact([actual.bytes, actual.sha256], [expected.bytes, expected.sha256], `original ${name} input bytes`);
    }
    const running = await this.fileFact(resolve(appProjectRoot, 'runtime-host/dist/win32-x64/runtime-host.exe'));
    exact([running.bytes, running.sha256], [guard.materialsInputs['runtime-host'].bytes, guard.materialsInputs['runtime-host'].sha256], 'materials executable is the exact current application Host');
    const path = await this.publicPath(guard.packagePath);
    const zip = await this.fileFact(path);
    exact([zip.bytes, `sha256:${zip.sha256}`], [guard.packageBytes, guard.transportDigest], 'streamed original transport bytes');
    const manifest = await this.manifest(guard);
    this.custodyPath = resolve(dirname(guardPath), 'world-materials-setup.custody.jsonl');
    let existing: string | undefined;
    try { existing = await readFile(this.custodyPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing !== undefined) {
      if (!existing.endsWith('\n') || Buffer.byteLength(existing) > 32 * 1024 * 1024) throw new Error('Original materials custody is incomplete or exceeds its bound; safely blocked');
      this.events = existing.trimEnd().split('\n').map(line => JSON.parse(line) as Event);
      const header = this.events[0];
      if (header?.kind !== 'prepared' || header.schemaVersion !== 1) throw new Error('Original materials custody header missing; no new attempt');
      this.header = header;
      exact([header.world, header.profileRoot, header.guardPath, header.guardSha256, header.guard, header.manifest], [world, this.electron.profileRoot, guardPath, sha256(bytes), guard, manifest], 'original durable custody and signed package');
      exact(header.policyAfter, trustedPolicy(header.before.policy, guard), 'custody permits only missing exact public root and process digest additions');
      await this.prepareNewInstall(existing);
      const marker = this.events.findIndex(event => event.kind === 'new_install_authorized');
      const attempts = this.events.filter((event, index): event is Extract<Event, { kind: 'attempt' }> => event.kind === 'attempt' && (marker < 0 || event.stage === 'replace_package_trust_policy' || index > marker));
      exact(attempts.map(event => event.stage), this.requiredStages.slice(0, attempts.length), 'single ordered original attempts');
      for (const stage of stages) {
        for (const kind of ['operation', 'confirmed']) if (this.stageEvents(stage).filter(event => event.kind === kind && 'stage' in event && event.stage === stage).length > 1) throw new Error('Ambiguous original materials stage custody');
      }
      return;
    }
    if (process.env.E2E_WORLD_MATERIALS_NEW_INSTALL_RECEIPT) throw new Error('New-install decision requires existing original unknown custody');
    const description = await this.read<Description>('query', 'discover', { includeCapabilities: false });
    exact([description.world, description.status], [world, 'ready'], 'ready dedicated World');
    const policy = await this.read<Policy>('query', 'package_trust_policy', {}); const packages = await this.inventory();
    if (packages.some(item => isDeepStrictEqual(item.manifest.identity, identity))) throw new Error('Materials installation already exists without original custody; safely blocked, no guessed identity');
    const policyAfter = trustedPolicy(policy, guard);
    this.header = { kind: 'prepared', schemaVersion: 1, world, profileRoot: this.electron.profileRoot, guardPath, guardSha256: sha256(bytes), guard, manifest, before: { description, policy, packages }, policyAfter };
    const file = await open(this.custodyPath, 'wx');
    try { await file.writeFile(`${JSON.stringify(this.header)}\n`); await file.sync(); this.events.push(this.header); }
    finally { await file.close(); }
  }
  async setup(): Promise<void> {
    if (this.phase !== 'idle') throw new Error('Materials setup has already been invoked; only original custody may be inspected');
    this.phase = 'preflight'; this.deadline = Date.now() + 180_000;
    try {
      await this.prepare();
      for (const stage of this.requiredStages) {
        const attempt = this.stageEvents(stage).find(event => event.kind === 'attempt' && event.stage === stage);
        const confirmed = this.confirmed(stage); const operation = this.operation(stage);
        if (attempt) {
          if (!operation) throw new Error(`Original ${stage} has no persisted operation ID; safely blocked, never guess or resend`);
          const receipt = await this.read<Receipt>('operation', 'result', operation.key);
          this.verifyReceipt(stage, receipt, operation.key);
          if (confirmed) exact(receipt, confirmed.receipt, 'fresh exact original completed receipt');
          else {
            await this.append({ kind: 'receipt', stage, receipt }); await this.retainTrace(stage, operation.key, receipt);
            await this.confirmStage(stage, receipt, operation.key);
          }
        } else {
          if (operation || confirmed) throw new Error('Stage custody has no original attempt; safely blocked');
          exact(basis(await this.read<Description>('query', 'discover', { includeCapabilities: false })), basis(this.header.before.description), 'unchanged original World before mutation');
          exact(await this.read('query', 'package_trust_policy', {}), stage === 'replace_package_trust_policy' ? this.header.before.policy : this.header.policyAfter, 'exact full policy before original mutation');
          const installed = this.confirmed('install_package')?.record;
          exact(await this.inventory(), [...this.header.before.packages, ...(installed ? [installed] : [])].sort((a, b) => a.installId.localeCompare(b.installId)), 'exact complete inventory before original mutation');
          if (stage === 'replace_package_trust_policy') await this.trust();
          else if (stage === 'install_package') await this.install();
          else await this.enable();
        }
      }
      const record = this.confirmed('enable_package')!.record!;
      exact(await this.read('query', 'package_trust_policy', {}), this.header.policyAfter, 'final complete trust policy');
      exact(await this.inventory(), [...this.header.before.packages, record].sort((a, b) => a.installId.localeCompare(b.installId)), 'final enabled installation and unchanged other packages');
      exact(basis(await this.read<Description>('query', 'discover', { includeCapabilities: false })), basis(this.header.before.description), 'no publication or activation');
      this.phase = 'enabled';
    } catch (error) {
      this.originalFailure = error instanceof Error ? error.message : String(error);
      if (this.events.length) {
        try { await this.append({ kind: 'blocked', phase: this.phase, message: this.originalFailure, alerts: [] }); }
        catch (custodyError) { throw new AggregateError([error, custodyError], 'Original materials failure and durable custody failure retained'); }
        if (this.phase === 'install_package') {
          try { await this.retainUpload(); }
          catch (evidenceError) { throw new AggregateError([error, evidenceError], 'Original materials failure and upload identity evidence failure retained'); }
        }
        try { await this.append({ kind: 'blocked', phase: this.phase, message: this.originalFailure, alerts: await this.workspace.getByRole('alert').allTextContents() }); }
        catch (evidenceError) { throw new AggregateError([error, evidenceError], 'Original materials failure and alert evidence failure retained'); }
      }
      throw error;
    }
  }
  async preserve(): Promise<void> {
    if (!this.confirmationOpen) return;
    const dialogs = this.electron.page.getByRole('dialog');
    const count = await dialogs.count();
    if (count === 1) await dialogs.getByRole('button', { name: /^(取消|Cancel)$/, exact: true }).click({ timeout: 15_000 });
    exact(await dialogs.count(), 0, 'closed own confirmation after original failure'); this.confirmationOpen = false;
  }
  evidence() {
    const record = this.confirmed('enable_package')?.record;
    return structuredClone({ phase: this.phase, world, custodyPath: this.custodyPath, originalFailure: this.originalFailure,
      packagePath: this.header?.guard.packagePath, packageDigest: this.header?.guard.packageDigest, transportDigest: this.header?.guard.transportDigest,
      manifest: this.header?.manifest, signing: this.header?.guard.signing, installId: record?.installId, record,
      signatureVerified: record?.trust.signatureVerified === true, enabled: this.phase === 'enabled',
      enabledEvidence: 'original completed enable operation plus exact installation revision; not a live activation graph',
      rootFlagsFalse: this.header?.guard.signing.allowProcess === false && this.header?.guard.signing.allowNative === false,
      oldInstallUnknown: this.events.some(event => event.kind === 'new_install_authorized') ? { retainedInHistory: true, continuationAbandoned: true, cancelledOrProvenUnaccepted: false } : undefined,
      newInstallDecision: this.events.find(event => event.kind === 'new_install_authorized'),
      uploads: this.stageEvents('install_package').filter(event => event.kind === 'upload'),
      commands: stages.map(stage => ({ stage, key: this.operation(stage)?.key, confirmed: this.confirmed(stage) })), retained: true });
  }
}
