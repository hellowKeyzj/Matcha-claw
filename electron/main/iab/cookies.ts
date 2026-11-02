import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage, WebContentsView, type Session } from 'electron';

import type { IabLog } from './contracts';
import { replacePrivateFile } from './persistence';

type PartitionKey = { topLevelSite: string; hasCrossSiteAncestor: boolean };
type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session: boolean;
  hostOnly?: boolean;
  expirationDate?: number;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  partitionKey?: PartitionKey;
  partitionKeyOpaque?: boolean;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
};
type ProtocolCookie = Omit<SessionCookie, 'sameSite' | 'expirationDate'> & {
  sameSite?: 'None' | 'Lax' | 'Strict';
  expires?: number;
};

const FROM_PROTOCOL = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' } as const;
const TO_PROTOCOL = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' } as const;

class CookieValidationError extends Error {}

function cookieIdentity(cookie: SessionCookie): string {
  return JSON.stringify([cookie.domain, cookie.path ?? '/', cookie.name,
    cookie.partitionKey?.topLevelSite ?? null, cookie.partitionKey?.hasCrossSiteAncestor ?? null]);
}

function hasRestorablePartition(cookie: SessionCookie): boolean {
  return cookie.partitionKeyOpaque !== true && (cookie.partitionKey === undefined ||
    (cookie.partitionKey !== null && typeof cookie.partitionKey === 'object' &&
      typeof cookie.partitionKey.topLevelSite === 'string' && !!cookie.partitionKey.topLevelSite &&
      typeof cookie.partitionKey.hasCrossSiteAncestor === 'boolean'));
}

function isSessionCookie(value: unknown): value is SessionCookie {
  if (!value || typeof value !== 'object') return false;
  const cookie = value as SessionCookie;
  return cookie.session === true && cookie.expirationDate === undefined &&
    hasRestorablePartition(cookie) && typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' && typeof cookie.domain === 'string' && !!cookie.domain &&
    ['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite);
}

export class IabCookies {
  private readonly path: string;
  private ready?: Promise<void>;
  private target?: WebContentsView;
  private targetEpoch = 0;
  private enabled = false;
  private disposed = false;
  private dirty = false;
  private saving?: Promise<void>;

  constructor(root: string, private readonly session: Session, private readonly log?: IabLog) {
    this.path = join(root, 'aw-session-cookies-v2.enc');
  }

  initialize(): Promise<void> {
    return this.ready ??= this.restore().finally(() => this.closeTarget()).then(() => {
      if (this.disposed || this.enabled) return;
      this.enabled = true;
      this.session.cookies.on('changed', this.onChanged);
    }).catch((error) => {
      this.ready = undefined;
      throw error;
    });
  }

  private async restore(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('IAB cookie encryption is unavailable');
    let cookies: SessionCookie[];
    try {
      const backup: unknown = JSON.parse(safeStorage.decryptString(await readFile(this.path)));
      const record = backup as { version?: unknown; cookies?: unknown };
      if (record?.version !== 2 || !Array.isArray(record.cookies) || !record.cookies.every(isSessionCookie)) {
        throw new Error('Invalid session cookie backup');
      }
      cookies = record.cookies;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (this.disposed || !cookies.length) return;
    const existing = new Set((await this.readCookies()).filter(hasRestorablePartition).map(cookieIdentity));
    const missing = cookies.filter((cookie) => !existing.has(cookieIdentity(cookie)));
    const restored: SessionCookie[] = [];
    for (let index = 0; index < missing.length && !this.disposed; index += 100) {
      restored.push(...await this.restoreBatch(missing.slice(index, index + 100)));
    }
    if (this.disposed || !restored.length) return;
    const actual = new Map((await this.readCookies()).filter(hasRestorablePartition).map((cookie) => [cookieIdentity(cookie), cookie]));
    if (restored.some((cookie) => {
      const value = actual.get(cookieIdentity(cookie));
      return !value?.session || value.value !== cookie.value;
    })) throw new Error('Cookie restore could not be verified');
  }

  private async restoreBatch(cookies: SessionCookie[]): Promise<SessionCookie[]> {
    try {
      await this.command('Network.setCookies', { cookies: cookies.map((cookie) => ({
        url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path ?? '/'}`,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path ?? '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.sameSite === 'unspecified' ? {} : { sameSite: TO_PROTOCOL[cookie.sameSite] }),
        ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
        priority: cookie.priority,
        sourceScheme: cookie.sourceScheme,
        sourcePort: cookie.sourcePort,
      })) });
      return cookies;
    } catch (error) {
      if (this.disposed) return [];
      if (!(error instanceof CookieValidationError)) throw error;
      if (cookies.length === 1) {
        this.log?.warn('[iab-cookie] session cookie persistence failed: restore-cookie');
        return [];
      }
      const middle = Math.floor(cookies.length / 2);
      return [...await this.restoreBatch(cookies.slice(0, middle)), ...await this.restoreBatch(cookies.slice(middle))];
    }
  }

  private async readCookies(): Promise<SessionCookie[]> {
    const result = await this.command('Network.getAllCookies') as { cookies: ProtocolCookie[] };
    return result.cookies.map(({ sameSite, expires, ...cookie }) => ({
      ...cookie,
      hostOnly: !cookie.domain.startsWith('.'),
      sameSite: sameSite === undefined ? 'unspecified' : FROM_PROTOCOL[sameSite],
      ...(cookie.session ? {} : { expirationDate: expires }),
    }));
  }

  // Electron.cookies omits CHIPS identity and source metadata; restore through a private CDP target.
  private async command(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const epoch = this.targetEpoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.disposed) throw new Error('IAB cookie target was released');
      if (!this.target || this.target.webContents.isDestroyed()) {
        this.target = new WebContentsView({ webPreferences: {
          session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false,
        } });
        this.target.webContents.debugger.attach('1.3');
      }
      return await Promise.race([
        this.target.webContents.debugger.sendCommand(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('IAB cookie command timed out')), 5_000);
          timer.unref();
        }),
      ]);
    } catch (error) {
      if (method === 'Network.setCookies' && error instanceof Error &&
        /^(Invalid cookie fields$|Invalid parameters|Failed to deserialize params\.cookies)/.test(error.message)) {
        throw new CookieValidationError(error.message, { cause: error });
      }
      if (epoch === this.targetEpoch) this.closeTarget();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private closeTarget(): void {
    const target = this.target;
    this.target = undefined;
    this.targetEpoch++;
    if (target && !target.webContents.isDestroyed()) target.webContents.close();
  }

  private readonly onChanged = (): void => {
    if (!this.enabled || this.disposed) return;
    void this.save().catch(() => this.log?.warn('[iab-cookie] session cookie persistence failed: save'));
  };

  private save(): Promise<void> {
    if (!this.enabled || this.disposed) return Promise.resolve();
    this.dirty = true;
    if (this.saving) return this.saving;
    const saving = Promise.resolve().then(async () => {
      try {
        while (this.dirty && !this.disposed) {
          this.dirty = false;
          const cookies = (await this.readCookies()).filter(isSessionCookie);
          if (this.disposed) return;
          await replacePrivateFile(this.path, safeStorage.encryptString(JSON.stringify({ version: 2, cookies })));
        }
      } finally {
        this.closeTarget();
      }
    });
    this.saving = saving;
    void saving.finally(() => {
      this.saving = undefined;
      if (this.dirty) void this.save().catch(() => this.log?.warn('[iab-cookie] session cookie persistence failed: save'));
    }).catch(() => {});
    return saving;
  }

  async flush(): Promise<void> {
    await this.initialize();
    await this.save();
    while (this.saving) await this.saving;
    if (this.enabled) await this.session.cookies.flushStore();
    while (this.saving) await this.saving;
  }

  async clearSite(origin?: string): Promise<void> {
    // Clearing a corrupt/unavailable backup must remain possible even when restore was disabled.
    await this.initialize().catch(() => {});
    if (origin !== undefined) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid IAB site origin');
      origin = url.origin;
    }
    await this.session.clearData({
      ...(origin === undefined ? {} : { origins: [origin] }),
      dataTypes: ['cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL', 'backgroundFetch'],
    });
    await this.session.clearStorageData({ ...(origin === undefined ? {} : { origin }), storages: ['cachestorage'] });
    await this.saving?.catch(() => {});
    // Never touch browser history when clearing site data.
    if (origin === undefined || !this.enabled) await rm(this.path, { force: true });
    else await this.save();
    if (!this.enabled) await this.initialize();
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.dirty = false;
    this.session.cookies.removeListener('changed', this.onChanged);
    this.closeTarget();
  }
}
