import { Ability } from '@serenity-js/core';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { licensedProfileRoot, repositoryRoot } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

type WorldRef = { tenantId: string; worldId: string };
type Description = { world: WorldRef; status: string; activeRelease: string; activeReleaseHead: unknown; incarnation: string };
type Facts = { relations: number; storage?: Array<{ storage_id: string }>; worlds?: WorldRef[];
  head?: Array<{ storage_id: string; mode: string }>; runtime?: Array<{ status: string; generation: string; revision: string }>;
  authorization?: Array<{ name: string; count: number; digest: string }> };
type Baseline = { schemaVersion: 1; database: string; runnerPid: number; world: WorldRef; storageId: string;
  release: string; releaseHead: unknown; incarnation: string; facts: Facts };
const catalogs = ['definitions', 'materials', 'connections', 'action_proposals', 'changes', 'evaluations'];

const databaseReadback = `
import { SQL } from 'bun';
const input = JSON.parse(await Bun.stdin.text());
const sql = new SQL({ url: input.connectionString, max: 1, connectionTimeout: 10 });
try {
  const facts = await sql.begin(async tx => {
    await tx.unsafe('SET TRANSACTION READ ONLY');
    await tx\`SELECT set_config('statement_timeout','10000',true),set_config('app.world_catalog_read','on',true)\`;
    const [{ count }] = await tx\`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')\`;
    if (!count) return { relations: 0 };
    const storage = await tx\`SELECT storage_id FROM world_storage_identity ORDER BY storage_id\`;
    const worlds = await tx\`SELECT tenant_id AS "tenantId",world_id AS "worldId" FROM world_runtime_head ORDER BY tenant_id,world_id\`;
    if (!input.world) return { relations: count, storage, worlds };
    await tx\`SELECT set_config('app.world_tenant',\${input.world.tenantId},true),set_config('app.world_id',\${input.world.worldId},true)\`;
    const head = await tx\`SELECT storage_id,mode FROM world_storage_head\`;
    const runtime = await tx\`SELECT status,generation::text,revision::text FROM world_runtime_head WHERE tenant_id=\${input.world.tenantId} AND world_id=\${input.world.worldId}\`;
    const authorization = [];
    for (const table of ['world_auth_principal','world_auth_grant','world_auth_policy','world_auth_retention_policy']) {
      const [row] = await tx.unsafe("SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),'')) AS digest FROM " + table + ' t');
      authorization.push({ name: table, ...row });
    }
    return { relations: count, storage, worlds, head, runtime, authorization };
  });
  console.log(JSON.stringify(facts));
} catch { console.error('Dedicated World database readback failed; private diagnostics omitted'); process.exitCode = 1; }
finally { await sql.close(); }
`;

export class WorldStorage extends Ability {
  private connection = '';
  private database = '';
  private kind?: 'fresh' | 'restored';
  private baseline?: Baseline;
  private readonly baselinePath = resolve(licensedProfileRoot, 'world-storage-baseline.json');
  constructor(private readonly electron: UseElectron) { super(); }

  private async privateConnection() {
    if (this.connection) return;
    const supplied = process.env.E2E_WORLD_STORAGE_CONNECTION_FILE;
    if (!supplied || !isAbsolute(supplied) || process.platform !== 'win32') {
      throw new Error('World storage E2E requires E2E_WORLD_STORAGE_CONNECTION_FILE: a dedicated licensed-profile CurrentUser DPAPI fixture on Windows');
    }
    const path = await realpath(supplied);
    const inside = relative(await realpath(licensedProfileRoot), path);
    if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('World storage credentials must belong to the dedicated licensed profile');
    }
    const script = `Add-Type -AssemblyName System.Security; try { $v=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:E2E_WORLD_STORAGE_CONNECTION_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) | ConvertFrom-Json; [Console]::Out.Write($v.connectionString) } catch { exit 1 }`;
    const connection = await new Promise<string>((accept, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, maxBuffer: 64 * 1024,
        env: { ...process.env, E2E_WORLD_STORAGE_CONNECTION_FILE: path } }, (error, stdout) => {
        if (error) reject(new Error('Dedicated World credential cannot be read; private diagnostics omitted'));
        else accept(stdout.trim());
      });
    });
    let url: URL;
    try { url = new URL(connection); }
    catch { throw new Error('Dedicated World connection is not a valid PostgreSQL URL; private input omitted'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || !/^\/world_[a-z0-9_]+$/.test(url.pathname) || !url.username || !url.password) {
      throw new Error('World storage E2E accepts only an owned loopback world_* database fixture');
    }
    const port = process.env.E2E_WORLD_STORAGE_PORT;
    if (port !== undefined) {
      if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Dedicated World storage port is invalid');
      url.port = port;
    }
    this.database = createHash('sha256').update([url.hostname, url.port, url.pathname, url.username].join('\n')).digest('hex');
    this.connection = port === undefined ? connection : url.href;
  }

  private async facts(world?: WorldRef): Promise<Facts> {
    await this.privateConnection();
    return new Promise<Facts>((accept, reject) => {
      const child = execFile(resolve(repositoryRoot, 'resources/bin/win32-x64/bun.exe'), ['-e', databaseReadback],
        { cwd: repositoryRoot, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error) reject(new Error('Dedicated World database readback failed; no mutation or retry was attempted'));
          else {
            try { accept(JSON.parse(stdout) as Facts); }
            catch { reject(new Error('Dedicated World database returned no complete safe facts')); }
          }
        });
      child.stdin?.on('error', () => reject(new Error('Dedicated World readback input closed')));
      child.stdin?.end(JSON.stringify({ connectionString: this.connection, world }));
    });
  }

  async prepare(): Promise<{ kind: 'fresh' | 'restored' }> {
    const facts = await this.facts();
    if (facts.relations === 0) {
      try { await access(this.baselinePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.kind = 'fresh';
        return { kind: 'fresh' };
      }
      throw new Error('Fresh World requires an unused database and no prior storage baseline; existing evidence is not overwritten');
    }
    this.baseline = JSON.parse(await readFile(this.baselinePath, 'utf8')) as Baseline;
    const saved = this.baseline;
    if (saved.schemaVersion !== 1 || saved.database !== this.database || saved.runnerPid === process.pid
      || !isDeepStrictEqual(facts.storage, [{ storage_id: saved.storageId }])
      || !isDeepStrictEqual(facts.worlds, [saved.world])) {
      throw new Error('World restore requires the exact prior-run baseline and dedicated database; no initialization is attempted');
    }
    this.kind = 'restored';
    return { kind: 'restored' };
  }

  async connect(): Promise<void> {
    await this.privateConnection();
    await this.electron.withPrivateInput(async () => {
      const panel = this.electron.page.locator('main .world-workspace section').filter({
        has: this.electron.page.getByRole('heading', { name: /^(Connect and enable storage|连接并启用存储)$/, exact: true }),
      });
      const input = panel.locator('input[type="password"]');
      try {
        await input.fill(this.connection);
        await panel.locator('button[type="submit"]').click();
        await this.electron.page.waitForFunction(() => {
          const heading = Array.from(document.querySelectorAll('main .world-workspace section > header > h2'))
            .find(node => /^(Connect and enable storage|连接并启用存储)$/.test(node.textContent?.trim() ?? ''));
          return heading?.closest('section')?.getAttribute('aria-busy') === 'false'
            && Boolean(heading.closest('section')?.querySelector('button[type="submit"]:enabled'));
        }, undefined, { timeout: 130_000 });
      } finally { await input.fill(''); }
    });
    this.connection = '';
  }

  private async query<T>(world: WorldRef, kind: string, request: unknown): Promise<T> {
    const response = await this.electron.fetchHostApi({ path: '/api/world/query', method: 'POST',
      body: { world, query: { kind, request } }, timeoutMs: 10_000 });
    if (!response.ok) throw new Error(`World storage ${kind} transport failed: ${response.error.code}`);
    const body = response.data.json as { success: boolean; data?: { kind: string; result: T }; error?: { code: string; stage: string; diagnosticId: string } };
    if (!response.data.ok || response.data.status !== 200 || body.success !== true || body.data?.kind !== kind) {
      throw new Error(`World storage ${kind} failed: HTTP ${response.data.status}; code=${body.error?.code}; stage=${body.error?.stage}; diagnosticId=${body.error?.diagnosticId}`);
    }
    return body.data.result;
  }

  private async readReady() {
    if (!this.kind) throw new Error('Prepare the dedicated World storage fixture before reading');
    await this.electron.page.locator('.world-context-bar [data-status="ready"]').waitFor();
    const selected = (await this.electron.page.locator('.world-context-bar button[aria-label]').first().innerText()).trim();
    const found = await this.facts();
    if (found.storage?.length !== 1 || found.worlds?.length !== 1 || found.worlds[0].worldId !== selected) {
      throw new Error('Ready UI does not select the exact sole World from the dedicated database');
    }
    const world = found.worlds[0];
    const description = await this.query<Description>(world, 'discover', { includeCapabilities: false });
    if (description.status !== 'ready' || !description.activeRelease || !description.activeReleaseHead
      || !isDeepStrictEqual(description.world, world)) throw new Error('World public Discover is not canonically ready');
    await Promise.all(catalogs.map(async kind => {
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: { items: unknown[]; nextCursor: string | null } = await this.query(world, kind, {
          ...(kind === 'definitions' ? { kind: null } : {}), page: { limit: 100, cursor },
        });
        if (!Array.isArray(page.items) || page.items.length > 100 || !(page.nextCursor === null
          || typeof page.nextCursor === 'string' && page.nextCursor && !seen.has(page.nextCursor) && seen.size < 1000)) {
          throw new Error(`World ${kind} did not return complete bounded directory pages`);
        }
        cursor = page.nextCursor;
        if (cursor) seen.add(cursor);
      } while (cursor !== null);
    }));
    const facts = await this.facts(world);
    if (!isDeepStrictEqual(facts.head, [{ storage_id: found.storage[0].storage_id, mode: 'active' }])
      || facts.runtime?.length !== 1 || facts.runtime[0].status !== 'ready'
      || facts.authorization?.length !== 4 || facts.authorization.some(row => row.count !== 1)) {
      throw new Error('World canonical storage, runtime or scoped authorization facts differ from the desktop seed');
    }
    try { await access(resolve(this.electron.profileRoot, 'user-data/world-initial.v1.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { world, description, facts, storageId: found.storage[0].storage_id };
      throw error;
    }
    throw new Error('World initial request journal remains unresolved; no retry or deletion is attempted');
  }

  async inspectReady() {
    const current = await this.readReady();
    const snapshot: Baseline = { schemaVersion: 1, database: this.database, runnerPid: process.pid, world: current.world,
      storageId: current.storageId, release: current.description.activeRelease, releaseHead: current.description.activeReleaseHead,
      incarnation: current.description.incarnation, facts: current.facts };
    if (this.kind === 'fresh') {
      if (this.baseline || current.facts.runtime?.[0].generation !== '1' || current.facts.runtime[0].revision !== '1') {
        throw new Error('Fresh World was not initialized exactly once');
      }
      await writeFile(this.baselinePath, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
      this.baseline = snapshot;
    } else {
      const saved = this.baseline!;
      if (!isDeepStrictEqual({ ...snapshot, runnerPid: saved.runnerPid }, saved)) {
        throw new Error('Automatic World restore changed the original canonical release or authorization');
      }
    }
    return { kind: this.kind!, world: current.world, storageId: current.storageId, activeRelease: current.description.activeRelease,
      catalogs: [...catalogs], canonicalReady: true, authorizationUnchanged: true, restoredWithoutInput: this.kind === 'restored' };
  }

  async confirmRepeated() {
    if (!this.baseline) throw new Error('Original World storage baseline is required before reconnecting');
    const current = await this.readReady();
    if (!isDeepStrictEqual(current.world, this.baseline.world) || current.storageId !== this.baseline.storageId
      || current.description.activeRelease !== this.baseline.release
      || !isDeepStrictEqual(current.description.activeReleaseHead, this.baseline.releaseHead)
      || current.description.incarnation !== this.baseline.incarnation || !isDeepStrictEqual(current.facts, this.baseline.facts)) {
      throw new Error('Repeated connection changed the canonical World, storage, release or complete authorization facts');
    }
    return { sameWorld: true, sameStorage: true, sameRelease: true, authorizationUnchanged: true,
      catalogs: [...catalogs], journalCleared: true };
  }
}
