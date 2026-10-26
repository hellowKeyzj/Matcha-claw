# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: licensed\world-storage.spec.ts >> World 存储幂等启用：独立运行如实记录 fresh 或 restored，自动恢复无需输入，六目录可读且重复连接不改完整授权
- Location: src\scenarios\licensed\world-storage.spec.ts:9:1

# Error details

```
Error: Dedicated World database readback failed; no mutation or retry was attempted
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - generic [ref=e4]:
      - generic [ref=e5]:
        - button "收起侧边栏" [ref=e6] [cursor=pointer]
        - img "MatchaClaw" [ref=e9]
        - generic [ref=e10]: MatchaClaw
      - generic [ref=e11]:
        - button "设置" [ref=e12] [cursor=pointer]
        - button "Minimize" [ref=e16] [cursor=pointer]
        - button "Maximize" [ref=e18] [cursor=pointer]
        - button "Close" [ref=e21] [cursor=pointer]
    - generic [ref=e25]:
      - complementary [ref=e26]:
        - navigation [ref=e27]:
          - button "新对话" [ref=e28] [cursor=pointer]
          - link "任务中心" [ref=e33] [cursor=pointer]:
            - /url: "#/tasks"
          - link "Agent" [ref=e39] [cursor=pointer]:
            - /url: "#/subagents"
          - link "团队" [ref=e45] [cursor=pointer]:
            - /url: "#/teams"
          - link "模型" [ref=e53] [cursor=pointer]:
            - /url: "#/providers"
          - link "频道" [ref=e59] [cursor=pointer]:
            - /url: "#/channels"
          - link "Wiki" [ref=e68] [cursor=pointer]:
            - /url: "#/wiki"
          - button "世界" [ref=e74] [cursor=pointer]
          - link "仪表盘" [ref=e84] [cursor=pointer]:
            - /url: "#/dashboard"
        - button "登录 MatchaClaw" [ref=e91] [cursor=pointer]:
          - generic [ref=e92]:
            - generic [ref=e93]: M
            - generic [ref=e94]:
              - generic [ref=e95]: 未登录
              - generic [ref=e97]: 未登录
      - separator "Resize sidebar" [ref=e98]
      - main [ref=e100]:
        - generic [ref=e101]:
          - generic:
            - generic:
              - complementary:
                - generic [ref=e103]:
                  - button "Matcha Agent / Matcha" [ref=e104] [cursor=pointer]:
                    - img "Matcha Agent / Matcha avatar" [ref=e106]
                  - button "新会话" [ref=e107] [cursor=pointer]
          - generic [ref=e111]:
            - generic [ref=e114]:
              - button [ref=e115] [cursor=pointer]
              - button "导出 Markdown" [disabled]
              - button "打开右侧栏" [ref=e124] [cursor=pointer]
            - generic [ref=e129]:
              - generic [ref=e130]: MatchaClaw
              - heading "今天想做什么？" [level=2] [ref=e134]
              - generic [ref=e139]:
                - textbox "输入消息，/ 选择技能，Enter 发送，Shift+Enter 换行" [active] [ref=e142]
                - generic [ref=e144]:
                  - button "更多操作" [ref=e145] [cursor=pointer]
                  - button "选择权限模式 · 选择权限模式" [ref=e147] [cursor=pointer]
                  - 'button "选择模型: 选择模型" [ref=e151] [cursor=pointer]':
                    - generic [ref=e152]: 选择模型
                  - button "发送" [disabled]
  - region "Notifications alt+T"
```

# Test source

```ts
  1   | import { Ability } from '@serenity-js/core';
  2   | import { execFile } from 'node:child_process';
  3   | import { createHash } from 'node:crypto';
  4   | import { access, readFile, realpath, writeFile } from 'node:fs/promises';
  5   | import { isAbsolute, relative, resolve } from 'node:path';
  6   | import { isDeepStrictEqual } from 'node:util';
  7   | import { licensedProfileRoot, repositoryRoot } from '../config/electron.js';
  8   | import { UseElectron } from './use-electron.ability.js';
  9   | 
  10  | type WorldRef = { tenantId: string; worldId: string };
  11  | type Description = { world: WorldRef; status: string; activeRelease: string; activeReleaseHead: unknown; incarnation: string };
  12  | type Facts = { relations: number; storage?: Array<{ storage_id: string }>; worlds?: WorldRef[];
  13  |   head?: Array<{ storage_id: string; mode: string }>; runtime?: Array<{ status: string; generation: string; revision: string }>;
  14  |   authorization?: Array<{ name: string; count: number; digest: string }> };
  15  | type Baseline = { schemaVersion: 1; database: string; runnerPid: number; world: WorldRef; storageId: string;
  16  |   release: string; releaseHead: unknown; incarnation: string; facts: Facts };
  17  | const catalogs = ['definitions', 'materials', 'connections', 'action_proposals', 'changes', 'evaluations'];
  18  | 
  19  | const databaseReadback = `
  20  | import { SQL } from 'bun';
  21  | const input = JSON.parse(await Bun.stdin.text());
  22  | const sql = new SQL({ url: input.connectionString, max: 1, connectionTimeout: 10 });
  23  | try {
  24  |   const facts = await sql.begin(async tx => {
  25  |     await tx.unsafe('SET TRANSACTION READ ONLY');
  26  |     await tx\`SELECT set_config('statement_timeout','10000',true),set_config('app.world_catalog_read','on',true)\`;
  27  |     const [{ count }] = await tx\`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')\`;
  28  |     if (!count) return { relations: 0 };
  29  |     const storage = await tx\`SELECT storage_id FROM world_storage_identity ORDER BY storage_id\`;
  30  |     const worlds = await tx\`SELECT tenant_id AS "tenantId",world_id AS "worldId" FROM world_runtime_head ORDER BY tenant_id,world_id\`;
  31  |     if (!input.world) return { relations: count, storage, worlds };
  32  |     await tx\`SELECT set_config('app.world_tenant',\${input.world.tenantId},true),set_config('app.world_id',\${input.world.worldId},true)\`;
  33  |     const head = await tx\`SELECT storage_id,mode FROM world_storage_head\`;
  34  |     const runtime = await tx\`SELECT status,generation::text,revision::text FROM world_runtime_head WHERE tenant_id=\${input.world.tenantId} AND world_id=\${input.world.worldId}\`;
  35  |     const authorization = [];
  36  |     for (const table of ['world_auth_principal','world_auth_grant','world_auth_policy','world_auth_retention_policy']) {
  37  |       const [row] = await tx.unsafe('SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),\'\')) AS digest FROM ' + table + ' t');
  38  |       authorization.push({ name: table, ...row });
  39  |     }
  40  |     return { relations: count, storage, worlds, head, runtime, authorization };
  41  |   });
  42  |   console.log(JSON.stringify(facts));
  43  | } catch { console.error('Dedicated World database readback failed; private diagnostics omitted'); process.exitCode = 1; }
  44  | finally { await sql.close(); }
  45  | `;
  46  | 
  47  | export class WorldStorage extends Ability {
  48  |   private connection = '';
  49  |   private database = '';
  50  |   private kind?: 'fresh' | 'restored';
  51  |   private baseline?: Baseline;
  52  |   private readonly baselinePath = resolve(licensedProfileRoot, 'world-storage-baseline.json');
  53  |   constructor(private readonly electron: UseElectron) { super(); }
  54  | 
  55  |   private async privateConnection() {
  56  |     if (this.connection) return;
  57  |     const supplied = process.env.E2E_WORLD_STORAGE_CONNECTION_FILE;
  58  |     if (!supplied || !isAbsolute(supplied) || process.platform !== 'win32') {
  59  |       throw new Error('World storage E2E requires E2E_WORLD_STORAGE_CONNECTION_FILE: a dedicated licensed-profile CurrentUser DPAPI fixture on Windows');
  60  |     }
  61  |     const path = await realpath(supplied);
  62  |     const inside = relative(await realpath(licensedProfileRoot), path);
  63  |     if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
  64  |       throw new Error('World storage credentials must belong to the dedicated licensed profile');
  65  |     }
  66  |     const script = `Add-Type -AssemblyName System.Security; try { $v=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:E2E_WORLD_STORAGE_CONNECTION_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) | ConvertFrom-Json; [Console]::Out.Write($v.connectionString) } catch { exit 1 }`;
  67  |     const connection = await new Promise<string>((accept, reject) => {
  68  |       execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, maxBuffer: 64 * 1024,
  69  |         env: { ...process.env, E2E_WORLD_STORAGE_CONNECTION_FILE: path } }, (error, stdout) => {
  70  |         if (error) reject(new Error('Dedicated World credential cannot be read; private diagnostics omitted'));
  71  |         else accept(stdout.trim());
  72  |       });
  73  |     });
  74  |     let url: URL;
  75  |     try { url = new URL(connection); }
  76  |     catch { throw new Error('Dedicated World connection is not a valid PostgreSQL URL; private input omitted'); }
  77  |     if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
  78  |       || !/^\/world_[a-z0-9_]+$/.test(url.pathname) || !url.username || !url.password) {
  79  |       throw new Error('World storage E2E accepts only an owned loopback world_* database fixture');
  80  |     }
  81  |     this.database = createHash('sha256').update([url.hostname, url.port, url.pathname, url.username].join('\n')).digest('hex');
  82  |     this.connection = connection;
  83  |   }
  84  | 
  85  |   private async facts(world?: WorldRef): Promise<Facts> {
  86  |     await this.privateConnection();
  87  |     return new Promise<Facts>((accept, reject) => {
> 88  |       const child = execFile(resolve(repositoryRoot, 'resources/bin/win32-x64/bun.exe'), ['-e', databaseReadback],
      |                             ^ Error: Dedicated World database readback failed; no mutation or retry was attempted
  89  |         { cwd: repositoryRoot, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
  90  |           if (error) reject(new Error('Dedicated World database readback failed; no mutation or retry was attempted'));
  91  |           else {
  92  |             try { accept(JSON.parse(stdout) as Facts); }
  93  |             catch { reject(new Error('Dedicated World database returned no complete safe facts')); }
  94  |           }
  95  |         });
  96  |       child.stdin?.on('error', () => reject(new Error('Dedicated World readback input closed')));
  97  |       child.stdin?.end(JSON.stringify({ connectionString: this.connection, world }));
  98  |     });
  99  |   }
  100 | 
  101 |   async prepare(): Promise<{ kind: 'fresh' | 'restored' }> {
  102 |     const facts = await this.facts();
  103 |     if (facts.relations === 0) {
  104 |       try { await access(this.baselinePath); }
  105 |       catch (error) {
  106 |         if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  107 |         this.kind = 'fresh';
  108 |         return { kind: 'fresh' };
  109 |       }
  110 |       throw new Error('Fresh World requires an unused database and no prior storage baseline; existing evidence is not overwritten');
  111 |     }
  112 |     this.baseline = JSON.parse(await readFile(this.baselinePath, 'utf8')) as Baseline;
  113 |     const saved = this.baseline;
  114 |     if (saved.schemaVersion !== 1 || saved.database !== this.database || saved.runnerPid === process.pid
  115 |       || !isDeepStrictEqual(facts.storage, [{ storage_id: saved.storageId }])
  116 |       || !isDeepStrictEqual(facts.worlds, [saved.world])) {
  117 |       throw new Error('World restore requires the exact prior-run baseline and dedicated database; no initialization is attempted');
  118 |     }
  119 |     this.kind = 'restored';
  120 |     return { kind: 'restored' };
  121 |   }
  122 | 
  123 |   async connect(): Promise<void> {
  124 |     await this.privateConnection();
  125 |     await this.electron.withPrivateInput(async () => {
  126 |       const panel = this.electron.page.locator('main .world-workspace section').filter({
  127 |         has: this.electron.page.getByRole('heading', { name: /^(Connect and enable storage|连接并启用存储)$/, exact: true }),
  128 |       });
  129 |       const input = panel.locator('input[type="password"]');
  130 |       try {
  131 |         await input.fill(this.connection);
  132 |         await panel.locator('button[type="submit"]').click();
  133 |         await this.electron.page.waitForFunction(() => {
  134 |           const heading = Array.from(document.querySelectorAll('main .world-workspace section > header > h2'))
  135 |             .find(node => /^(Connect and enable storage|连接并启用存储)$/.test(node.textContent?.trim() ?? ''));
  136 |           return heading?.closest('section')?.getAttribute('aria-busy') === 'false'
  137 |             && Boolean(heading.closest('section')?.querySelector('button[type="submit"]:enabled'));
  138 |         }, undefined, { timeout: 130_000 });
  139 |       } finally { await input.fill(''); }
  140 |     });
  141 |     this.connection = '';
  142 |   }
  143 | 
  144 |   private async query<T>(world: WorldRef, kind: string, request: unknown): Promise<T> {
  145 |     const response = await this.electron.fetchHostApi({ path: '/api/world/query', method: 'POST',
  146 |       body: { world, query: { kind, request } }, timeoutMs: 10_000 });
  147 |     if (!response.ok) throw new Error(`World storage ${kind} transport failed: ${response.error.code}`);
  148 |     const body = response.data.json as { success: boolean; data?: { kind: string; result: T }; error?: { code: string; stage: string; diagnosticId: string } };
  149 |     if (!response.data.ok || response.data.status !== 200 || body.success !== true || body.data?.kind !== kind) {
  150 |       throw new Error(`World storage ${kind} failed: HTTP ${response.data.status}; code=${body.error?.code}; stage=${body.error?.stage}; diagnosticId=${body.error?.diagnosticId}`);
  151 |     }
  152 |     return body.data.result;
  153 |   }
  154 | 
  155 |   private async readReady() {
  156 |     if (!this.kind) throw new Error('Prepare the dedicated World storage fixture before reading');
  157 |     await this.electron.page.locator('.world-context-bar [data-status="ready"]').waitFor();
  158 |     const selected = (await this.electron.page.locator('.world-context-bar button[aria-label]').first().innerText()).trim();
  159 |     const found = await this.facts();
  160 |     if (found.storage?.length !== 1 || found.worlds?.length !== 1 || found.worlds[0].worldId !== selected) {
  161 |       throw new Error('Ready UI does not select the exact sole World from the dedicated database');
  162 |     }
  163 |     const world = found.worlds[0];
  164 |     const description = await this.query<Description>(world, 'discover', { includeCapabilities: false });
  165 |     if (description.status !== 'ready' || !description.activeRelease || !description.activeReleaseHead
  166 |       || !isDeepStrictEqual(description.world, world)) throw new Error('World public Discover is not canonically ready');
  167 |     await Promise.all(catalogs.map(async kind => {
  168 |       const seen = new Set<string>();
  169 |       let cursor: string | null = null;
  170 |       do {
  171 |         const page: { items: unknown[]; nextCursor: string | null } = await this.query(world, kind, {
  172 |           ...(kind === 'definitions' ? { kind: null } : {}), page: { limit: 100, cursor },
  173 |         });
  174 |         if (!Array.isArray(page.items) || page.items.length > 100 || !(page.nextCursor === null
  175 |           || typeof page.nextCursor === 'string' && page.nextCursor && !seen.has(page.nextCursor) && seen.size < 1000)) {
  176 |           throw new Error(`World ${kind} did not return complete bounded directory pages`);
  177 |         }
  178 |         cursor = page.nextCursor;
  179 |         if (cursor) seen.add(cursor);
  180 |       } while (cursor !== null);
  181 |     }));
  182 |     const facts = await this.facts(world);
  183 |     if (!isDeepStrictEqual(facts.head, [{ storage_id: found.storage[0].storage_id, mode: 'active' }])
  184 |       || facts.runtime?.length !== 1 || facts.runtime[0].status !== 'ready'
  185 |       || facts.authorization?.length !== 4 || facts.authorization.some(row => row.count !== 1)) {
  186 |       throw new Error('World canonical storage, runtime or scoped authorization facts differ from the desktop seed');
  187 |     }
  188 |     try { await access(resolve(this.electron.profileRoot, 'user-data/world-initial.v1.json')); }
```