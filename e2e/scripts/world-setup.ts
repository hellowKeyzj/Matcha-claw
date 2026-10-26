import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { stdin } from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron } from '../src/abilities/use-electron.ability.js';
import { licensedProfileRoot, repositoryRoot } from '../src/config/electron.js';

const evidence = process.env.WORLD_SETUP_EVIDENCE!;
const stage = process.env.WORLD_SETUP_STAGE ?? 'provision';
const materialsCustody = process.env.WORLD_READBACK_MATERIALS_CUSTODY;
if (!evidence || !['provision', 'task', 'readback'].includes(stage)) throw new Error('World setup requires an evidence directory and a known stage');
if (materialsCustody !== undefined && (stage !== 'readback' || !isAbsolute(materialsCustody))) throw new Error('Materials readback requires stage=readback and the absolute original public custody path');
const inputs = resolve(repositoryRoot, '.scratch/world-implementation-2026-10-21');
const initialPath = resolve(inputs, 'world-personal-initial-20261024-729e3bf4.json');
const taskPath = resolve(inputs, 's06-task-noop-input-20261025-81b7c54e/task.ready.json');
const initial = materialsCustody ? undefined : JSON.parse(await readFile(initialPath, 'utf8'));
const task = materialsCustody ? undefined : JSON.parse(await readFile(taskPath, 'utf8'));
const world = { tenantId: 'local', worldId: 'personal' };
const chunks: Buffer[] = [];
for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
const supplied = Buffer.concat(chunks);
let connection = supplied.toString('utf8').trim();
supplied.fill(0);
for (const chunk of chunks) chunk.fill(0);
if (materialsCustody && supplied.length) throw new Error('Materials readback requires empty stdin; no storage input is accepted');
await mkdir(evidence, { recursive: true });
let owner: UseElectron | undefined;
let phase = 'launch';
let secretInFlight = false;
const result: Record<string, unknown> = { stage, modelRequests: 0, sourceRequests: 0, storageSaveAttempted: false, initialImportAttempted: false, taskRegistrationAttempted: false };
function checkpoint(next: string) { phase = next; console.log(JSON.stringify({ phase })); }
async function storageStatus() {
  return owner!.page.evaluate(async () => {
    const bridge = (window as unknown as { electron: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).electron.ipcRenderer;
    return await bridge.invoke('world:storageStatus') as { outcome: string; configured?: boolean; initialStorageId?: string };
  });
}
async function query(kind: string, request: unknown, readbackName?: string) {
  const response = await owner!.fetchHostApi({ path: '/api/world/query', method: 'POST', body: { world, query: { kind, request } }, timeoutMs: 10_000 });
  if (readbackName) await writeFile(resolve(evidence, readbackName), JSON.stringify(response, null, 2), { flag: 'wx' });
  if (!response.ok) throw new Error(`World query transport: ${response.error.code}`);
  const body = response.data.json as { success?: boolean; data?: { kind: string; result: unknown }; error?: { code: string; stage: string; diagnosticId: string } };
  if (response.data.status !== 200 || body.success !== true || body.data?.kind !== kind) {
    throw new Error(`World query failed: HTTP ${response.data.status}; ${JSON.stringify(body.error ?? null)}`);
  }
  return body.data.result;
}
try {
  // Secret entry uses the existing non-recording setup lifecycle, not a test trace.
  owner = await UseElectron.start(evidence, true);
  const license = await owner.licenseReceipt();
  if (license.state !== 'granted' || !license.valid || !license.hasStoredKey || !license.hasUsableCache) throw new Error('Existing dedicated license is unavailable');
  result.license = license;
  await owner.enterLocalApp();
  checkpoint('wait-host-ready');
  const hostDeadline = Date.now() + 180_000;
  for (;;) {
    const reply = await owner.fetchHostApi({ path: '/api/runtime-host/status', method: 'GET', timeoutMs: 3_000 });
    const host = reply.ok ? reply.data.json as { hostLifecycle?: string; runtimeLifecycle?: string } | null : null;
    const ready = reply.ok && reply.data.ok && reply.data.status === 200
      && host?.hostLifecycle === 'ready' && host.runtimeLifecycle === 'ready';
    result.hostObservation = reply.ok ? { httpStatus: reply.data.status, ready } : { transportError: reply.error.code, ready };
    if (ready) break;
    if (Date.now() >= hostDeadline) throw new Error(`World setup Host did not become ready: ${JSON.stringify(result.hostObservation)}`);
    await delay(250);
  }
  const page = owner.page;
  page.setDefaultTimeout(45_000);
  const sidebar = page.locator('aside nav button[aria-controls="sidebar-world-pages"]');
  if (await sidebar.getAttribute('aria-expanded') === 'false') await sidebar.click();
  await page.locator('aside nav a[href="#/world/settings"]').click();
  const workspace = page.locator('main .world-workspace');
  checkpoint('read-storage-status');
  let status = await storageStatus();
  if (status.outcome !== 'available') throw new Error('World storage status is unavailable');
  result.storageBefore = status;
  if (!status.configured) {
    if (stage !== 'provision' || !connection.startsWith('postgresql://') || !connection.includes('@127.0.0.1:')) throw new Error('New dedicated loopback storage input is required');
    checkpoint('save-storage-ui');
    await workspace.locator('label').filter({ has: page.getByText('配置用途', { exact: true }) }).locator('select').selectOption('initial');
    secretInFlight = true;
    await workspace.getByLabel('PostgreSQL 连接信息', { exact: true }).fill(connection);
    connection = '';
    result.storageSaveAttempted = true;
    await workspace.getByRole('button', { name: '保存待验证配置', exact: true }).click();
    await workspace.getByRole('status').filter({ hasText: '配置已保存，重启后核验；尚未验证连接。' }).waitFor();
    secretInFlight = false;
    status = await storageStatus();
    if (status.outcome !== 'available' || !status.configured || !status.initialStorageId) throw new Error('Saved storage was not confirmed; no resubmission');
  }
  connection = '';
  result.storageAfter = status;
  if (stage === 'provision') {
    checkpoint('import-original-administrator-ui');
    const choose = workspace.getByRole('button', { name: '选择管理员配置并建立世界', exact: true });
    await choose.waitFor();
    if (await choose.isDisabled()) throw new Error('Initial import is not admitted by the normal UI');
    const native = owner.completeNativeFileImport(initialPath, {
      pickerTitle: '导入管理员提供的世界初始配置', title: '确认初始化世界', button: '确认初始化',
      expectedText: ['组织：local', '世界：personal', `原提交：${initial.commitId}`, '身份 1 · 授权 1 · 策略 0 · 保留策略 0', '评测：未配置 · 维护：未配置', '仅导入配置中明确列出的权限；不会自动授予桌面或 Agent 权限。'],
    });
    result.initialImportAttempted = true;
    const submitted = await Promise.allSettled([native, choose.click()]);
    const failure = submitted.find(item => item.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    await workspace.getByRole('status').filter({ hasText: '初始化提交已确认；可用状态以世界服务返回为准。' }).waitFor({ timeout: 130_000 });
    result.initialUiConfirmed = true;
  } else {
    await workspace.getByRole('button', { name: /^(打开已有世界|切换世界)$/ }).click();
    await workspace.getByLabel('租户编号', { exact: true }).fill(world.tenantId);
    await workspace.getByLabel('世界编号', { exact: true }).fill(world.worldId);
    await workspace.getByRole('button', { name: '打开世界', exact: true }).click();
  }
  checkpoint('read-world-ready');
  await workspace.locator('.world-heading [data-status="ready"]').waitFor({ timeout: 45_000 });
  const description = await query('discover', { includeCapabilities: !materialsCustody }, materialsCustody ? 'readback-discover.json' : undefined) as { world: unknown; status: string; revision: string; incarnation: string; activeRelease: unknown; activeReleaseHead: unknown; editingContext?: { scopes?: unknown[]; externalContracts?: unknown[]; activationLock?: { nodes?: unknown[] } } };
  if (description.status !== 'ready' || !isDeepStrictEqual(description.world, world)) throw new Error('Exact World readiness readback differs');
  result.world = { world: description.world, status: description.status, revision: description.revision, incarnation: description.incarnation,
    scopeCount: description.editingContext?.scopes?.length ?? 0, bindingNodeCount: description.editingContext?.activationLock?.nodes?.length ?? 0, externalUseCount: description.editingContext?.externalContracts?.length ?? 0 };
  if (materialsCustody) {
    result.materialReadbackOnly = true;
    result.installUnknownRetained = true;
    checkpoint('read-original-materials-custody');
    const custodyPath = await realpath(materialsCustody);
    const publicRelative = relative(await realpath(resolve(repositoryRoot, '.scratch')), custodyPath);
    if (!publicRelative || isAbsolute(publicRelative) || publicRelative === '..' || publicRelative.startsWith('..\\') || publicRelative.startsWith('../')
      || /(^|[\\/])(?:\.profiles?|secrets?)([\\/]|$)/i.test(publicRelative)) throw new Error('Materials custody must be the original public .scratch file');
    const info = await stat(custodyPath);
    if (!info.isFile() || !info.size || info.size > 32 * 1024 * 1024) throw new Error('Materials custody must be bounded complete JSONL');
    const custody = await readFile(custodyPath, 'utf8');
    if (!custody.endsWith('\n')) throw new Error('Original materials custody is incomplete');
    type Key = { world: unknown; operationId: string };
    type Receipt = { accepted: Key & { incarnation: string }; phase: string; disclosure: { kind: string }; failure: unknown; result: unknown };
    type Installed = Record<string, unknown> & { world: unknown; installId: string; packageDigest: string; transportDigest: string };
    const events = custody.trimEnd().split('\n').map(line => JSON.parse(line) as { kind: string; stage?: string; key?: Key; receipt?: Receipt });
    const header = events[0] as typeof events[number] & { schemaVersion: number; world: unknown; profileRoot: string; policyAfter: unknown;
      before: { description: typeof description; packages: Installed[] }; guard: { packageDigest: string; transportDigest: string } };
    if (header?.kind !== 'prepared' || header.schemaVersion !== 1 || events.filter(event => event.kind === 'prepared').length !== 1
      || !isDeepStrictEqual(header.world, world) || resolve(owner.profileRoot) !== resolve(licensedProfileRoot)
      || resolve(header.profileRoot) !== resolve(owner.profileRoot)) throw new Error('Original materials custody World/Profile differs');
    const basis = (value: typeof description) => [value.world, value.status, value.incarnation, value.activeRelease, value.activeReleaseHead];
    if (!isDeepStrictEqual(basis(description), basis(header.before.description))) throw new Error('Original materials World/release basis differs');
    const operations = events.filter(event => event.kind === 'operation' && event.stage === 'replace_package_trust_policy');
    const confirmed = events.filter(event => event.kind === 'confirmed' && event.stage === 'replace_package_trust_policy');
    if (operations.length !== 1 || confirmed.length !== 1 || !operations[0]!.key || !confirmed[0]!.receipt) throw new Error('Unique original trust operation/confirmation is required');
    const key = operations[0]!.key!;
    const original = confirmed[0]!.receipt!;
    if (!isDeepStrictEqual(key.world, world) || !key.operationId || typeof key.operationId !== 'string') throw new Error('Original trust operation key differs');
    result.materialsCustody = { path: custodyPath, sha256: createHash('sha256').update(custody).digest('hex'), trustKey: key };
    checkpoint('read-original-materials-trust');
    for (const kind of ['status', 'result']) {
      const response = await owner.fetchHostApi({ path: '/api/world/operation', method: 'POST', body: { kind, request: key }, timeoutMs: 10_000 });
      await writeFile(resolve(evidence, `readback-trust-${kind}.json`), JSON.stringify(response, null, 2), { flag: 'wx' });
      if (!response.ok) throw new Error(`Original trust ${kind} transport: ${response.error.code}`);
      const body = response.data.json as { success?: boolean; data?: { kind: string; result: Receipt }; error?: unknown };
      if (!response.data.ok || response.data.status !== 200 || body.success !== true || body.data?.kind !== kind) throw new Error(`Original trust ${kind} read failed: ${JSON.stringify(body.error ?? null)}`);
      const receipt = body.data.result;
      if (!isDeepStrictEqual(receipt.accepted.world, world) || receipt.accepted.operationId !== key.operationId
        || receipt.accepted.incarnation !== header.before.description.incarnation || receipt.phase !== 'completed'
        || receipt.disclosure.kind !== 'full' || receipt.failure !== null || !isDeepStrictEqual(receipt, original)) throw new Error(`Original trust ${kind} receipt differs; no replay`);
    }
    const policy = await query('package_trust_policy', {}, 'readback-policy.json');
    if (!isDeepStrictEqual(policy, header.policyAfter)) throw new Error('Complete materials trust policy differs from the original confirmed replacement');
    checkpoint('read-complete-materials-inventory');
    const inventory: Installed[] = [];
    const cursors = new Set<string>();
    const installIds = new Set<string>();
    let cursor: string | null = null;
    let pageNumber = 0;
    do {
      const packages = await query('packages', { page: { limit: 100, cursor } }, `readback-packages-${++pageNumber}.json`) as { items: Installed[]; nextCursor: string | null };
      if (!Array.isArray(packages.items) || packages.items.length > 100) throw new Error('Invalid public materials inventory page');
      for (const record of packages.items) {
        if (!isDeepStrictEqual(record.world, world) || typeof record.installId !== 'string' || !record.installId || installIds.has(record.installId)) throw new Error('Invalid or repeated public installation identity');
        installIds.add(record.installId); inventory.push(record);
      }
      cursor = packages.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error('Invalid or repeated public inventory cursor');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    inventory.sort((a, b) => a.installId.localeCompare(b.installId));
    await writeFile(resolve(evidence, 'readback-inventory.json'), JSON.stringify(inventory, null, 2), { flag: 'wx' });
    result.materialsInventory = { count: inventory.length, unchangedFromBefore: isDeepStrictEqual(inventory, [...header.before.packages].sort((a, b) => a.installId.localeCompare(b.installId))),
      currentMatchingInstallIds: inventory.filter(record => record.packageDigest === header.guard.packageDigest && record.transportDigest === header.guard.transportDigest).map(record => record.installId),
      interpretation: 'Current public inventory only; absence does not prove no dispatch or acceptance, matching records do not identify the original operation; installation remains unknown.' };
    const after = await query('discover', { includeCapabilities: false }, 'readback-discover-after.json') as typeof description;
    if (!isDeepStrictEqual(basis(after), basis(header.before.description))) throw new Error('Original materials World/release basis changed during readback');
    await workspace.screenshot({ path: resolve(evidence, 'world-ready.png') });
    result.completionMeaning = 'Read-only verification completed; no installation, enablement, retry or mutation was performed.';
  } else {
  checkpoint('restore-original-task-ui');
  const taskRef = { world, id: task.id, revision: task.revision };
  let registered = await query('task_contract', taskRef);
  result.taskObservation = registered === null ? 'absent' : 'present';
  if (registered === null && stage !== 'readback') {
    await page.locator('aside nav a[href="#/world/model"]').click();
    await workspace.getByRole('tab', { name: '版本与编译基线', exact: true }).click();
    await workspace.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^导入完整任务契约$/ }) }).locator('summary').click();
    await workspace.getByLabel('完整任务契约', { exact: true }).setInputFiles(taskPath);
    await workspace.getByRole('status').filter({ hasText: '已载入完整契约，请核对后登记。' }).waitFor();
    result.taskRegistrationAttempted = true;
    await workspace.getByRole('button', { name: '登记任务', exact: true }).click();
    const deadline = Date.now() + 45_000;
    do {
      registered = await query('task_contract', taskRef);
      if (registered !== null) break;
      await delay(250);
    } while (Date.now() < deadline);
  }
  const expectedTask = { ...task, budget: { maxCost: null, deadline: null, ...task.budget } };
  if (!isDeepStrictEqual(registered, expectedTask)) throw new Error('Original Task exact readback is absent or different; no resubmission');
  result.task = { id: task.id, revision: task.revision, exactReadback: true, maxModelCalls: task.budget.maxModelCalls, maxSourceReads: task.budget.maxSourceReads };
  const noOpReason = process.env.WORLD_READBACK_NOOP_REASON;
  if (noOpReason) {
    if (stage !== 'readback' || !/^E2E independent NoOp [0-9a-f-]{36}$/.test(noOpReason)) throw new Error('An exact owned NoOp reason is required for readback only');
    checkpoint('read-original-noop');
    const changes = await query('changes', { page: { limit: 100, cursor: null } }) as { items: Array<{ world: unknown; id: string; revision: string; status: string; baseRelease: string; operations: unknown[]; evidence: unknown[]; cases: unknown[] }>; nextCursor: string | null };
    const matches = changes.items.filter(change => isDeepStrictEqual(change.operations, [{ kind: 'no_op', reason: noOpReason }]));
    if (changes.nextCursor || matches.length !== 1) throw new Error('The exact original NoOp is not uniquely readable; no submission is repeated');
    const change = matches[0];
    const exact = await query('change', { id: change.id });
    if (!isDeepStrictEqual(change.world, world) || change.revision !== '1' || change.status !== 'proposed'
      || change.baseRelease !== 'release:personal:genesis' || change.evidence.length || change.cases.length || !isDeepStrictEqual(exact, change)) {
      throw new Error('The complete original proposed NoOp differs; no mutation is retried');
    }
    result.noOp = { change, exactReadback: true };
    await page.locator('aside nav a[href="#/world/changes"]').click();
    await workspace.locator('.world-catalog li > button').filter({ hasText: noOpReason }).click();
    await workspace.locator('article.world-panel > header > div > span.font-mono').filter({ hasText: change.id }).waitFor();
  }
  await page.screenshot({ path: resolve(evidence, 'world-ready.png'), mask: [page.locator('input[type="password"]')] });
  }
  result.completed = true;
} catch (error) {
  result.completed = false;
  result.failedPhase = phase;
  result.safeError = secretInFlight ? 'Storage UI action was not confirmed; secret-bearing exception omitted' : error instanceof Error ? error.message.slice(0, 2200) : 'World setup failed';
  if (owner && !secretInFlight) {
    try {
      result.worldUiErrors = await owner.page.locator('main .world-workspace [role="alert"]').allTextContents();
      result.worldUiStatuses = await owner.page.locator('main .world-workspace [role="status"]').allTextContents();
      if (materialsCustody) await owner.page.locator('main .world-workspace').screenshot({ path: resolve(evidence, 'world-setup-failure.png'), timeout: 5_000 });
      else await owner.page.screenshot({ path: resolve(evidence, 'world-setup-failure.png'), mask: [owner.page.locator('input[type="password"]')] });
    } catch { result.failureScreenshotUnavailable = true; }
  }
  process.exitCode = 1;
} finally {
  connection = '';
  if (owner) {
    try { await owner.close(); result.ownerClosed = true; }
    catch (error) { result.ownerClosed = false; result.cleanupError = error instanceof Error ? error.message : 'Owned Electron cleanup failed'; process.exitCode = 1; }
  }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
}
