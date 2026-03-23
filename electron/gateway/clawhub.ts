/**
 * ClawHub Service
 * Manages interactions with the ClawHub CLI for skills management
 */
import { spawn } from 'child_process';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, shell } from 'electron';
import { getOpenClawConfigDir, ensureDir, getClawHubCliBinPath, getClawHubCliEntryPath } from '../utils/paths';
import { getSetting, setSetting } from '../utils/store';
import { proxyAwareFetch } from '../utils/proxy-fetch';

export interface ClawHubSearchParams {
    query: string;
    limit?: number;
}

export interface ClawHubInstallParams {
    slug: string;
    version?: string;
    force?: boolean;
}

export interface ClawHubUninstallParams {
    slug: string;
}

export interface ClawHubSkillResult {
    slug: string;
    name: string;
    description: string;
    version: string;
    author?: string;
    downloads?: number;
    stars?: number;
}

type ClawHubSearchResponse = {
    results?: Array<{
        slug?: string;
        displayName?: string;
        summary?: string | null;
        version?: string | null;
    }>;
};

type ClawHubExploreResponse = {
    items?: Array<{
        slug?: string;
        displayName?: string;
        summary?: string | null;
        latestVersion?: {
            version?: string;
        } | null;
    }>;
};

const CLAWHUB_DEFAULT_REGISTRY = 'https://clawhub.ai';
const CLAWHUB_BROWSER_AUTH_TIMEOUT_MS = 5 * 60_000;
const CLAWHUB_CALLBACK_HTML = `<!doctype html>
<html lang="en">
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClawHub Login</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; padding: 24px; }
    .card { max-width: 560px; margin: 40px auto; padding: 18px 16px; border: 1px solid rgba(127,127,127,.35); border-radius: 12px; }
  </style>
  <body>
    <div class="card">
      <h1 style="margin: 0 0 10px; font-size: 18px;">Completing login…</h1>
      <p id="status" style="margin: 0; opacity: .8;">Waiting for token.</p>
    </div>
    <script>
      const statusEl = document.getElementById('status')
      const params = new URLSearchParams(location.hash.replace(/^#/, ''))
      const token = params.get('token')
      const registry = params.get('registry')
      const state = params.get('state')
      if (!token) {
        statusEl.textContent = 'Missing token in URL. You can close this tab and try again.'
      } else if (!state) {
        statusEl.textContent = 'Missing state in URL. You can close this tab and try again.'
      } else {
        fetch('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, registry, state }),
        }).then(() => {
          statusEl.textContent = 'Logged in. You can close this tab.'
          setTimeout(() => window.close(), 250)
        }).catch(() => {
          statusEl.textContent = 'Failed to send token to app. You can close this tab and try again.'
        })
      }
    </script>
  </body>
</html>`;

type ClawHubLoopbackAuthResult = {
    token: string;
    registry?: string;
};

export class ClawHubService {
    private workDir: string;
    private cliPath: string;
    private cliEntryPath: string;
    private useNodeRunner: boolean;
    private ansiRegex: RegExp;

    constructor() {
        // Use the user's OpenClaw config directory (~/.openclaw) for skill management
        // This avoids installing skills into the project's openclaw submodule
        this.workDir = getOpenClawConfigDir();
        ensureDir(this.workDir);

        const binPath = getClawHubCliBinPath();
        const entryPath = getClawHubCliEntryPath();

        this.cliEntryPath = entryPath;
        const forceNodeRunner = process.platform === 'win32';

        if (!forceNodeRunner && !app.isPackaged && fs.existsSync(binPath)) {
            this.cliPath = binPath;
            this.useNodeRunner = false;
        } else {
            this.cliPath = process.execPath;
            this.useNodeRunner = true;
        }
        const esc = String.fromCharCode(27);
        const csi = String.fromCharCode(155);
        const pattern = `(?:${esc}|${csi})[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`;
        this.ansiRegex = new RegExp(pattern, 'g');
    }

    private stripAnsi(line: string): string {
        return line.replace(this.ansiRegex, '').trim();
    }

    private extractFrontmatterName(skillManifestPath: string): string | null {
        try {
            const raw = fs.readFileSync(skillManifestPath, 'utf8');
            // Match the first frontmatter block and read `name: ...`
            const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) return null;
            const body = frontmatterMatch[1];
            const nameMatch = body.match(/^\s*name\s*:\s*["']?([^"'\n]+)["']?\s*$/m);
            if (!nameMatch) return null;
            const name = nameMatch[1].trim();
            return name || null;
        } catch {
            return null;
        }
    }

    private resolveSkillDirByManifestName(candidates: string[]): string | null {
        const skillsRoot = path.join(this.workDir, 'skills');
        if (!fs.existsSync(skillsRoot)) return null;

        const wanted = new Set(
            candidates
                .map((v) => v.trim().toLowerCase())
                .filter((v) => v.length > 0),
        );
        if (wanted.size === 0) return null;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
        } catch {
            return null;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillDir = path.join(skillsRoot, entry.name);
            const skillManifestPath = path.join(skillDir, 'SKILL.md');
            if (!fs.existsSync(skillManifestPath)) continue;

            const frontmatterName = this.extractFrontmatterName(skillManifestPath);
            if (!frontmatterName) continue;
            if (wanted.has(frontmatterName.toLowerCase())) {
                return skillDir;
            }
        }
        return null;
    }

    /**
     * Run a ClawHub CLI command
     */
    private async runCommand(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            if (this.useNodeRunner && !fs.existsSync(this.cliEntryPath)) {
                reject(new Error(`ClawHub CLI entry not found at: ${this.cliEntryPath}`));
                return;
            }

            if (!this.useNodeRunner && !fs.existsSync(this.cliPath)) {
                reject(new Error(`ClawHub CLI not found at: ${this.cliPath}`));
                return;
            }

            const commandArgs = this.useNodeRunner ? [this.cliEntryPath, ...args] : args;
            const displayCommand = [this.cliPath, ...commandArgs].join(' ');
            console.log(`Running ClawHub command: ${displayCommand}`);

            const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
            const env = {
                ...baseEnv,
                CI: 'true',
                FORCE_COLOR: '0',
            };
            if (this.useNodeRunner) {
                env.ELECTRON_RUN_AS_NODE = '1';
            }
            const child = spawn(this.cliPath, commandArgs, {
                cwd: this.workDir,
                shell: false,
                env: {
                    ...env,
                    CLAWHUB_WORKDIR: this.workDir,
                },
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                console.error('ClawHub process error:', error);
                reject(error);
            });

            child.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    console.error(`ClawHub command failed with code ${code}`);
                    console.error('Stderr:', stderr);
                    reject(new Error(`Command failed: ${stderr || stdout}`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    private resolveRegistryBase(): string {
        const explicitRegistry = (process.env.CLAWHUB_REGISTRY || process.env.CLAWDHUB_REGISTRY || '').trim();
        const registry = explicitRegistry || CLAWHUB_DEFAULT_REGISTRY;
        return registry.replace(/\/+$/, '');
    }

    private async readClawHubToken(): Promise<string | undefined> {
        try {
            const token = await getSetting('clawHubToken');
            if (typeof token !== 'string') {
                return undefined;
            }
            const normalized = token.trim().replace(/^Bearer\s+/i, '').trim();
            return normalized.length > 0 ? normalized : undefined;
        } catch {
            return undefined;
        }
    }

    private buildCliAuthUrl(params: { siteUrl: string; redirectUri: string; state: string; label?: string }): string {
        const url = new URL('/cli/auth', params.siteUrl);
        url.searchParams.set('redirect_uri', params.redirectUri);
        if (params.label) {
            url.searchParams.set('label_b64', Buffer.from(params.label, 'utf8').toString('base64url'));
        }
        url.searchParams.set('state', params.state);
        return url.toString();
    }

    private async startLoopbackAuthServer(timeoutMs = CLAWHUB_BROWSER_AUTH_TIMEOUT_MS): Promise<{
        redirectUri: string;
        state: string;
        waitForResult: () => Promise<ClawHubLoopbackAuthResult>;
        close: () => void;
    }> {
        const expectedState = randomBytes(16).toString('hex');
        let resolveResult: ((value: ClawHubLoopbackAuthResult) => void) | null = null;
        let rejectResult: ((reason?: unknown) => void) | null = null;
        const resultPromise = new Promise<ClawHubLoopbackAuthResult>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });

        const server = createServer((req, res) => {
            const method = req.method || 'GET';
            const url = req.url || '/';
            if (method === 'GET' && (url === '/' || url.startsWith('/callback'))) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(CLAWHUB_CALLBACK_HTML);
                return;
            }
            if (method === 'POST' && url === '/token') {
                const chunks: Buffer[] = [];
                req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                req.on('end', () => {
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                            token?: unknown;
                            state?: unknown;
                            registry?: unknown;
                        };
                        if (!parsed || typeof parsed !== 'object') {
                            throw new Error('invalid payload');
                        }
                        const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
                        const state = typeof parsed.state === 'string' ? parsed.state : '';
                        if (!token) {
                            throw new Error('token required');
                        }
                        if (!state || state !== expectedState) {
                            throw new Error('state mismatch');
                        }
                        const registry = typeof parsed.registry === 'string' ? parsed.registry.trim() : undefined;
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ok: true }));
                        resolveResult?.({ token, registry });
                    } catch (error) {
                        res.statusCode = 400;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ok: false }));
                        rejectResult?.(error);
                    } finally {
                        server.close();
                    }
                });
                return;
            }
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Not found');
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('Failed to bind loopback auth server');
        }

        const timer = setTimeout(() => {
            server.close();
            rejectResult?.(new Error('Timed out waiting for browser login'));
        }, timeoutMs);
        resultPromise.finally(() => clearTimeout(timer)).catch(() => {});

        return {
            redirectUri: `http://127.0.0.1:${address.port}/callback`,
            state: expectedState,
            waitForResult: () => resultPromise,
            close: () => server.close(),
        };
    }

    private async verifyToken(token: string): Promise<void> {
        const registryBase = this.resolveRegistryBase();
        const url = new URL('/api/v1/whoami', registryBase);
        const response = await proxyAwareFetch(url.toString(), {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });
        if (!response.ok) {
            const text = (await response.text()).trim();
            throw new Error(text || `Token verification failed (HTTP ${response.status})`);
        }
    }

    private async fetchRegistryJson<T>(
        routePath: string,
        query: Record<string, string> = {},
    ): Promise<T> {
        const registryBase = this.resolveRegistryBase();
        const url = new URL(routePath, registryBase);
        Object.entries(query).forEach(([key, value]) => {
            if (value.trim().length > 0) {
                url.searchParams.set(key, value);
            }
        });

        const token = await this.readClawHubToken();
        const headers: Record<string, string> = {
            Accept: 'application/json',
        };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        const response = await proxyAwareFetch(url.toString(), {
            method: 'GET',
            headers,
        });
        const rawText = await response.text();
        if (!response.ok) {
            const message = rawText.trim();
            if (response.status === 429) {
                throw new Error('Rate limit exceeded');
            }
            throw new Error(message || `HTTP ${response.status}`);
        }

        if (!rawText.trim()) {
            return {} as T;
        }

        try {
            return JSON.parse(rawText) as T;
        } catch {
            throw new Error('Invalid ClawHub registry response');
        }
    }

    private mapSearchResults(payload: ClawHubSearchResponse): ClawHubSkillResult[] {
        const results = Array.isArray(payload.results) ? payload.results : [];
        return results
            .map((item) => {
                const slug = (item.slug || '').trim();
                if (!slug) return null;
                return {
                    slug,
                    name: (item.displayName || slug).trim() || slug,
                    description: (item.summary || '').trim(),
                    version: (item.version || 'latest').trim() || 'latest',
                } satisfies ClawHubSkillResult;
            })
            .filter((item): item is ClawHubSkillResult => item !== null);
    }

    private async searchByKeyword(query: string, limit?: number): Promise<ClawHubSkillResult[]> {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
            return [];
        }
        const boundedLimit = limit && Number.isFinite(limit)
            ? Math.min(Math.max(1, Math.floor(limit)), 200)
            : 50;
        const payload = await this.fetchRegistryJson<ClawHubSearchResponse>('/api/v1/search', {
            q: normalizedQuery,
            limit: String(boundedLimit),
        });
        return this.mapSearchResults(payload);
    }

    /**
     * Search for skills
     */
    async search(params: ClawHubSearchParams): Promise<ClawHubSkillResult[]> {
        try {
            // If query is empty, use 'explore' to show trending skills
            if (!params.query || params.query.trim() === '') {
                return this.explore({ limit: params.limit });
            }
            return this.searchByKeyword(params.query, params.limit);
        } catch (error) {
            console.error('ClawHub search error:', error);
            throw error;
        }
    }

    /**
     * Explore trending skills
     */
    async explore(params: { limit?: number } = {}): Promise<ClawHubSkillResult[]> {
        try {
            const boundedLimit = params.limit && Number.isFinite(params.limit)
                ? Math.min(Math.max(1, Math.floor(params.limit)), 200)
                : 25;
            const payload = await this.fetchRegistryJson<ClawHubExploreResponse>('/api/v1/skills', {
                limit: String(boundedLimit),
                sort: 'updated',
            });
            const items = Array.isArray(payload.items) ? payload.items : [];
            return items
                .map((item) => {
                    const slug = (item.slug || '').trim();
                    if (!slug) return null;
                    const latestVersion = item.latestVersion?.version || 'latest';
                    return {
                        slug,
                        name: (item.displayName || slug).trim() || slug,
                        version: latestVersion.trim() || 'latest',
                        description: (item.summary || '').trim(),
                    } satisfies ClawHubSkillResult;
                })
                .filter((item): item is ClawHubSkillResult => item !== null);
        } catch (error) {
            console.error('ClawHub explore error:', error);
            throw error;
        }
    }

    async loginAndSyncToken(): Promise<void> {
        const receiver = await this.startLoopbackAuthServer();
        try {
            const authUrl = this.buildCliAuthUrl({
                siteUrl: this.resolveRegistryBase(),
                redirectUri: receiver.redirectUri,
                state: receiver.state,
                label: 'MatchaClaw',
            });
            await shell.openExternal(authUrl);
            const result = await receiver.waitForResult();
            const normalizedToken = result.token.trim().replace(/^Bearer\s+/i, '').trim();
            if (!normalizedToken) {
                throw new Error('Received empty token from ClawHub login callback.');
            }
            await this.verifyToken(normalizedToken);
            await setSetting('clawHubToken', normalizedToken);
        } finally {
            receiver.close();
        }
    }

    /**
     * Install a skill
     */
    async install(params: ClawHubInstallParams): Promise<void> {
        const args = ['install', params.slug];

        if (params.version) {
            args.push('--version', params.version);
        }

        if (params.force) {
            args.push('--force');
        }

        await this.runCommand(args);
    }

    /**
     * Uninstall a skill
     */
    async uninstall(params: ClawHubUninstallParams): Promise<void> {
        const fsPromises = fs.promises;

        // 1. Delete the skill directory
        const skillDir = path.join(this.workDir, 'skills', params.slug);
        if (fs.existsSync(skillDir)) {
            console.log(`Deleting skill directory: ${skillDir}`);
            await fsPromises.rm(skillDir, { recursive: true, force: true });
        }

        // 2. Remove from lock.json
        const lockFile = path.join(this.workDir, '.clawhub', 'lock.json');
        if (fs.existsSync(lockFile)) {
            try {
                const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
                if (lockData.skills && lockData.skills[params.slug]) {
                    console.log(`Removing ${params.slug} from lock.json`);
                    delete lockData.skills[params.slug];
                    await fsPromises.writeFile(lockFile, JSON.stringify(lockData, null, 2));
                }
            } catch (err) {
                console.error('Failed to update ClawHub lock file:', err);
            }
        }
    }

    /**
     * List installed skills
     */
    async listInstalled(): Promise<Array<{ slug: string; version: string }>> {
        try {
            const output = await this.runCommand(['list']);
            if (!output || output.includes('No installed skills')) {
                return [];
            }

            const lines = output.split('\n').filter(l => l.trim());
            return lines.map(line => {
                const cleanLine = this.stripAnsi(line);
                const match = cleanLine.match(/^(\S+)\s+v?(\d+\.\S+)/);
                if (match) {
                    return {
                        slug: match[1],
                        version: match[2],
                    };
                }
                return null;
            }).filter((s): s is { slug: string; version: string } => s !== null);
        } catch (error) {
            console.error('ClawHub list error:', error);
            return [];
        }
    }

    /**
     * Open skill README/manual in default editor
     */
    async openSkillReadme(skillKeyOrSlug: string, fallbackSlug?: string): Promise<boolean> {
        const candidates = [skillKeyOrSlug, fallbackSlug]
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map(v => v.trim());
        const uniqueCandidates = [...new Set(candidates)];
        const directSkillDir = uniqueCandidates
            .map((id) => path.join(this.workDir, 'skills', id))
            .find((dir) => fs.existsSync(dir));
        const skillDir = directSkillDir || this.resolveSkillDirByManifestName(uniqueCandidates);

        // Try to find documentation file
        const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];
        let targetFile = '';

        if (skillDir) {
            for (const file of possibleFiles) {
                const filePath = path.join(skillDir, file);
                if (fs.existsSync(filePath)) {
                    targetFile = filePath;
                    break;
                }
            }
        }

        if (!targetFile) {
            // If no md file, just open the directory
            if (skillDir) {
                targetFile = skillDir;
            } else {
                throw new Error('Skill directory not found');
            }
        }

        try {
            // Open file with default application
            await shell.openPath(targetFile);
            return true;
        } catch (error) {
            console.error('Failed to open skill readme:', error);
            throw error;
        }
    }
}
