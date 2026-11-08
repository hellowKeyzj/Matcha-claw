import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebContents } from 'electron';

import type { IabHistoryEntry, IabHistoryPage, IabHistoryQuery } from '../../../src/types/desktop/iab';
import { fetchPublicFavicon } from './favicon-fetch';
import { replacePrivateFile } from '../../utils/private-file';

const MAX_ENTRIES = 3_000;
type PendingVisit = { url: string; title: string; visitedAt: number; timer: ReturnType<typeof setTimeout>; cancelled?: boolean; drainMetadata?(): Promise<void> };

export function normalizeHistoryUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8_192) return;
    const fragment = new URLSearchParams(url.hash.slice(1).split('?').at(-1) ?? '');
    for (const params of [url.searchParams, fragment]) {
      for (const key of params.keys()) {
        const normalized = key.replace(/[-_]/g, '').toLowerCase();
        if (/^(code|.*token|password|secret|authorization|credential|signature|sig|apikey|auth|sessionid|ticket|jwt|accesskey|accesskeyid|awsaccesskeyid|ossaccesskeyid|xamzcredential|xgoogcredential)$/.test(normalized) ||
          /^(xamz|xgoog)signature$/.test(normalized)) return;
      }
    }
    return url.href;
  } catch { return; }
}

function originOf(url: string): string { return new URL(url).origin; }
function isStoredFavicon(value: unknown): value is string {
  return typeof value === 'string' && value.length < 100_000 &&
    /^data:image\/(png|jpeg|webp|gif|x-icon|vnd.microsoft.icon|svg\+xml);base64,/i.test(value);
}

async function fetchFavicon(url: string, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return;
  if (url.startsWith('data:')) return isStoredFavicon(url) ? url : undefined;
  if (url.length > 2_048) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  timer.unref();
  try {
    const response = await fetchPublicFavicon(url, AbortSignal.any([signal, controller.signal]));
    if (!response) return;
    const { image } = response;
    const mime = image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
      : image.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg'
        : image.subarray(0, 4).toString('ascii') === 'GIF8' ? 'image/gif'
          : image.subarray(0, 4).toString('ascii') === 'RIFF' && image.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp'
            : image.subarray(0, 4).equals(Buffer.from('00000100', 'hex')) ? 'image/x-icon'
              : response.contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'image/svg+xml' ? 'image/svg+xml' : undefined;
    return mime ? `data:${mime};base64,${image.toString('base64')}` : undefined;
  } catch { return; } finally { controller.abort(); clearTimeout(timer); }
}

export class IabHistory {
  private readonly path: string;
  private ready?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private entries: IabHistoryEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pendingVisits = new Map<string, PendingVisit>();
  private readonly committingVisits = new Set<PendingVisit>();
  private readonly observers = new Set<{ flush(): Promise<void>; close(): Promise<void> }>();
  private readonly pendingWork = new Set<Promise<void>>();
  private backgroundFailure?: { error: unknown };
  private closed = false;
  private closing?: Promise<void>;

  constructor(root: string) { this.path = join(root, 'aw-browser-history.json'); }

  initialize(): Promise<void> {
    return this.ready ??= this.load().catch((error) => { this.ready = undefined; throw error; });
  }

  private async load(): Promise<void> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (raw.length > 8_000_000) throw new Error('Browser history exceeds size limit');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
    if (!Array.isArray(parsed)) return;
    this.entries = parsed.filter((entry): entry is IabHistoryEntry => entry &&
      typeof entry.id === 'string' && typeof entry.url === 'string' && normalizeHistoryUrl(entry.url) === entry.url &&
      typeof entry.title === 'string' && entry.title.length <= 1_000 && Number.isFinite(entry.visitedAt) && entry.visitedAt > 0)
      .sort((left, right) => right.visitedAt - left.visitedAt).slice(0, MAX_ENTRIES)
      .map(({ id, url, title, visitedAt, faviconUrl }) => ({ id, url, title, visitedAt,
        ...(isStoredFavicon(faviconUrl) ? { faviconUrl } : {}) }));
    const origins = new Set<string>();
    for (const entry of this.entries) {
      if (!entry.faviconUrl) continue;
      const origin = originOf(entry.url);
      if (origins.has(origin)) delete entry.faviconUrl;
      else origins.add(origin);
    }
    if (JSON.stringify(parsed) !== JSON.stringify(this.entries)) await replacePrivateFile(this.path, JSON.stringify(this.entries));
  }

  observeTab(tabId: string, contents: WebContents): () => void {
    if (this.closed) throw new Error('Browser history is closed');
    let disposed = false;
    let faviconChain: AbortController | undefined;
    let metadata: { url: string; title?: string; icon?: string } | undefined;
    let metadataTimer: ReturnType<typeof setTimeout> | undefined;
    const flushMetadata = async (): Promise<void> => {
      clearTimeout(metadataTimer);
      metadataTimer = undefined;
      const update = metadata;
      if (!update) return;
      const pending = this.pendingVisits.get(tabId);
      if (pending?.url === update.url) return;
      metadata = undefined;
      await this.commitMetadata(update.url, update.icon ?? '', update.title);
    };
    const updateMetadata = (update: { title?: string; icon?: string }): void => {
      if (disposed || contents.isDestroyed()) return;
      const url = normalizeHistoryUrl(contents.getURL());
      if (!url) return;
      if (metadata && metadata.url !== url) { this.track(flushMetadata()); metadata = undefined; }
      metadata = { ...metadata, ...update, url };
      const pending = this.pendingVisits.get(tabId);
      if (pending?.url === url && update.title !== undefined) pending.title = update.title;
      if (!metadataTimer) metadataTimer = setTimeout(() => { this.track(flushMetadata()); }, 150);
    };
    const visit = (): void => {
      if (disposed || contents.isDestroyed()) return;
      this.track(this.recordVisit(contents.getURL(), contents.getTitle(), tabId));
      const pending = this.pendingVisits.get(tabId);
      if (pending) pending.drainMetadata = flushMetadata;
    };
    const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (!mainFrame) return;
      faviconChain?.abort();
      faviconChain = undefined;
      if (inPlace) return;
      const pending = this.pendingVisits.get(tabId);
      if (pending) clearTimeout(pending.timer);
      this.pendingVisits.delete(tabId);
    };
    const inPage = (_event: unknown, _url: string, mainFrame: boolean): void => { if (mainFrame) visit(); };
    const title = (): void => { if (!contents.isDestroyed()) updateMetadata({ title: contents.getTitle() }); };
    const favicon = (_event: unknown, values: string[]): void => {
      if (disposed || contents.isDestroyed()) return;
      faviconChain?.abort();
      faviconChain = undefined;
      const page = normalizeHistoryUrl(contents.getURL());
      if (!page) return;
      const candidates: string[] = [];
      for (const value of values) {
        if (candidates.length === 3) break;
        if (value.startsWith('data:')) {
          if (isStoredFavicon(value) && !candidates.includes(value)) candidates.push(value);
          continue;
        }
        if (value.length > 2_048) continue;
        try {
          const url = new URL(value);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !candidates.includes(url.href)) candidates.push(url.href);
        } catch { /* Ignore invalid page-provided icons. */ }
      }
      if (!candidates.length) return;
      const fallback = new URL('/favicon.ico', page).href;
      if (!candidates.includes(fallback)) candidates.push(fallback);
      const chain = new AbortController();
      faviconChain = chain;
      this.track((async () => {
        try {
          for (const candidate of candidates) {
            if (chain.signal.aborted) return;
            const icon = await fetchFavicon(candidate, chain.signal);
            if (chain.signal.aborted) return;
            if (!icon) continue;
            if (!disposed && !contents.isDestroyed() && normalizeHistoryUrl(contents.getURL()) === page) updateMetadata({ icon });
            break;
          }
        } finally { if (faviconChain === chain) faviconChain = undefined; }
      })());
    };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      disposed = true;
      faviconChain?.abort();
      faviconChain = undefined;
      contents.removeListener('did-start-navigation', navigate);
      contents.removeListener('did-navigate', visit);
      contents.removeListener('did-navigate-in-page', inPage);
      contents.removeListener('page-title-updated', title);
      contents.removeListener('page-favicon-updated', favicon);
      contents.removeListener('destroyed', dispose);
      this.observers.delete(observer);
      const pending = this.pendingVisits.get(tabId);
      this.pendingVisits.delete(tabId);
      if (pending) clearTimeout(pending.timer);
      const committing = pending ? this.commitVisit(pending.url, pending.title, pending.visitedAt, pending) : Promise.resolve();
      closing = this.track(committing.finally(flushMetadata));
      return closing;
    };
    const observer = { flush: flushMetadata, close };
    const dispose = (): void => { void close(); };
    this.observers.add(observer);
    contents.on('did-start-navigation', navigate);
    contents.on('did-navigate', visit);
    contents.on('did-navigate-in-page', inPage);
    contents.on('page-title-updated', title);
    contents.on('page-favicon-updated', favicon);
    contents.once('destroyed', dispose);
    return dispose;
  }

  recordVisit(url: string, title: string, tabId?: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser history is closed'));
    const normalized = normalizeHistoryUrl(url);
    if (!normalized) return Promise.resolve();
    if (tabId === undefined) return this.commitVisit(normalized, title, Date.now());
    const previous = this.pendingVisits.get(tabId);
    if (previous) clearTimeout(previous.timer);
    const pending: PendingVisit = {
      url: normalized, title, visitedAt: Date.now(),
      timer: setTimeout(() => {
        if (this.pendingVisits.get(tabId) !== pending) return;
        this.pendingVisits.delete(tabId);
        this.track(this.commitVisit(pending.url, pending.title, pending.visitedAt, pending));
      }, 500),
    };
    pending.timer.unref();
    this.pendingVisits.set(tabId, pending);
    return Promise.resolve();
  }

  private commitVisit(url: string, title: string, visitedAt: number, pending?: PendingVisit): Promise<void> {
    if (pending) this.committingVisits.add(pending);
    return this.mutate(() => {
      if (pending?.cancelled) return false;
      const day = new Date(visitedAt).toDateString();
      const previous = this.entries.find((entry) => entry.url === url && new Date(entry.visitedAt).toDateString() === day);
      this.entries = this.entries.filter((entry) => entry !== previous);
      this.entries.unshift({ id: previous?.id ?? randomUUID(), url, title: title.slice(0, 1_000), visitedAt,
        ...(previous?.faviconUrl ? { faviconUrl: previous.faviconUrl } : {}) });
    }).then(async () => { if (!pending?.cancelled) await pending?.drainMetadata?.(); })
      .finally(() => { if (pending) this.committingVisits.delete(pending); });
  }

  recordFavicon(url: string, faviconUrl: string, title?: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser history is closed'));
    return this.commitMetadata(url, faviconUrl, title);
  }

  private async commitMetadata(url: string, faviconUrl: string, title?: string): Promise<void> {
    const normalized = normalizeHistoryUrl(url);
    if (!normalized) return;
    const favicon = isStoredFavicon(faviconUrl) ? faviconUrl : undefined;
    await this.mutate(() => {
      const entry = this.entries.find((entry) => entry.url === normalized);
      let changed = false;
      if (entry && title && entry.title !== title.slice(0, 1_000)) { entry.title = title.slice(0, 1_000); changed = true; }
      if (favicon) {
        const origin = originOf(normalized);
        const target = entry ?? this.entries.find((entry) => originOf(entry.url) === origin);
        for (const item of this.entries) {
          if (originOf(item.url) !== origin) continue;
          if (item === target && item.faviconUrl !== favicon) { item.faviconUrl = favicon; changed = true; }
          else if (item !== target && item.faviconUrl) { delete item.faviconUrl; changed = true; }
        }
      }
      return changed;
    });
  }

  async faviconForUrl(url: string): Promise<string | undefined> {
    const normalized = normalizeHistoryUrl(url);
    if (!normalized) return;
    await this.initialize();
    await this.writing.catch(() => {});
    return this.entries.find((entry) => entry.url === normalized)?.faviconUrl ??
      this.entries.find((entry) => originOf(entry.url) === originOf(normalized) && entry.faviconUrl)?.faviconUrl;
  }

  async suggest(query: string, limit = 8): Promise<IabHistoryEntry[]> {
    await this.initialize();
    await this.writing.catch(() => {});
    const text = query.trim().toLocaleLowerCase().slice(0, 1_000);
    const icons = new Map(this.entries.filter((entry) => entry.faviconUrl).map((entry) => [originOf(entry.url), entry.faviconUrl!]));
    const seen = new Set<string>();
    const results: IabHistoryEntry[] = [];
    for (const entry of this.entries) {
      if (text && !`${entry.title} ${entry.url}`.toLocaleLowerCase().includes(text)) continue;
      const origin = originOf(entry.url);
      if (seen.has(origin)) continue;
      seen.add(origin);
      results.push({ ...entry, ...(icons.has(origin) ? { faviconUrl: icons.get(origin) } : {}) });
      if (results.length >= Math.min(8, Math.max(1, limit))) break;
    }
    return results;
  }

  async query(query: IabHistoryQuery): Promise<IabHistoryPage> {
    await this.initialize();
    await this.writing.catch(() => {});
    const text = (query.query ?? '').trim().toLocaleLowerCase().slice(0, 1_000);
    const icons = new Map<string, string>();
    for (const entry of this.entries) {
      if (!entry.faviconUrl) continue;
      const origin = originOf(entry.url);
      if (!icons.has(origin)) icons.set(origin, entry.faviconUrl);
    }
    const matches = this.entries.filter((entry) => (!text || `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(text)) &&
      (query.from === undefined || entry.visitedAt >= query.from) && (query.to === undefined || entry.visitedAt <= query.to));
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(MAX_ENTRIES, Math.max(1, query.limit ?? 100));
    return { entries: matches.slice(offset, offset + limit).map(({ id, url, title, visitedAt }) => {
      const origin = originOf(url);
      const faviconUrl = icons.get(origin);
      icons.delete(origin);
      return { id, url, title, visitedAt, ...(faviconUrl ? { faviconUrl } : {}) };
    }), total: matches.length,
      nextOffset: offset + limit < matches.length ? offset + limit : null };
  }

  async remove(ids: string[] | 'all'): Promise<void> {
    if (ids !== 'all' && (!Array.isArray(ids) || ids.length > MAX_ENTRIES || ids.some((id) => typeof id !== 'string'))) {
      throw new Error('Invalid history selection');
    }
    const selected = new Set(ids === 'all' ? [] : ids);
    const cancelSelectedVisits = (): void => {
      const urls = new Set(this.entries.filter((entry) => selected.has(entry.id)).map((entry) => entry.url));
      this.discardPending((url) => ids === 'all' || urls.has(url));
    };
    cancelSelectedVisits();
    await this.initialize();
    cancelSelectedVisits();
    await this.mutate(() => {
      cancelSelectedVisits();
      const icons = new Map(this.entries.filter((entry) => entry.faviconUrl).map((entry) => [originOf(entry.url), entry.faviconUrl!]));
      this.entries = ids === 'all' ? [] : this.entries.filter((entry) => !selected.has(entry.id));
      for (const [origin, favicon] of icons) {
        if (this.entries.some((entry) => originOf(entry.url) === origin && entry.faviconUrl)) continue;
        const entry = this.entries.find((entry) => originOf(entry.url) === origin);
        if (entry) entry.faviconUrl = favicon;
      }
    });
  }

  removeOrigin(url: string): Promise<void> {
    const normalized = normalizeHistoryUrl(url);
    if (!normalized) return Promise.reject(new Error('Invalid history site'));
    const origin = originOf(normalized);
    this.discardPending((pendingUrl) => originOf(pendingUrl) === origin);
    return this.mutate(() => {
      this.discardPending((pendingUrl) => originOf(pendingUrl) === origin);
      const filtered = this.entries.filter((entry) => originOf(entry.url) !== origin);
      if (filtered.length === this.entries.length) return false;
      this.entries = filtered;
    });
  }

  private discardPending(matches: (url: string) => boolean): void {
    for (const [key, pending] of this.pendingVisits) {
      if (!matches(pending.url)) continue;
      clearTimeout(pending.timer);
      pending.cancelled = true;
      this.pendingVisits.delete(key);
    }
    for (const pending of this.committingVisits) if (matches(pending.url)) pending.cancelled = true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private mutate(change: () => boolean | void): Promise<void> {
    const writing = this.writing.catch(() => {}).then(async () => {
      await this.initialize();
      const previous = this.entries.map((entry) => ({ ...entry }));
      if (change() === false) return;
      this.entries.sort((left, right) => right.visitedAt - left.visitedAt);
      let size = this.entries.reduce((sum, entry) => sum + JSON.stringify(entry).length + 1, 2);
      const newestByOrigin = new Map<string, IabHistoryEntry>();
      for (const entry of this.entries) if (!newestByOrigin.has(originOf(entry.url))) newestByOrigin.set(originOf(entry.url), entry);
      while (this.entries.length > MAX_ENTRIES || size > 4_000_000) {
        const removed = this.entries.pop();
        if (!removed) break;
        size -= JSON.stringify(removed).length + 1;
        const target = newestByOrigin.get(originOf(removed.url));
        if (!removed.faviconUrl || !target || target === removed || target.faviconUrl) continue;
        const before = JSON.stringify(target).length;
        target.faviconUrl = removed.faviconUrl;
        size += JSON.stringify(target).length - before;
      }
      try { await replacePrivateFile(this.path, JSON.stringify(this.entries)); }
      catch (error) { this.entries = previous; throw error; }
      for (const listener of this.listeners) listener();
    });
    this.writing = writing;
    return writing;
  }

  private track(work: Promise<void>): Promise<void> {
    this.pendingWork.add(work);
    void work.then(
      () => this.pendingWork.delete(work),
      (error: unknown) => { this.backgroundFailure ??= { error }; this.pendingWork.delete(work); },
    );
    return work;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      for (const observer of this.observers) void observer.close();
      await this.flush();
    })();
  }

  async flush(): Promise<void> {
    const visits = [...this.pendingVisits.values()];
    this.pendingVisits.clear();
    for (const visit of visits) {
      clearTimeout(visit.timer);
      this.track(this.commitVisit(visit.url, visit.title, visit.visitedAt, visit));
    }
    while (this.pendingWork.size) await Promise.allSettled([...this.pendingWork]);
    for (const observer of this.observers) this.track(observer.flush());
    for (;;) {
      while (this.pendingWork.size) await Promise.allSettled([...this.pendingWork]);
      const writing = this.writing;
      const results = await Promise.allSettled([this.initialize(), writing]);
      for (const result of results) if (result.status === 'rejected') this.backgroundFailure ??= { error: result.reason };
      if (!this.pendingWork.size && writing === this.writing) break;
    }
    const failure = this.backgroundFailure;
    this.backgroundFailure = undefined;
    if (failure) throw failure.error;
  }
}
