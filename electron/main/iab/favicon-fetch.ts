import { lookup } from 'node:dns';
import { lookup as lookupAddress, resolve4, resolve6 } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { Agent, fetch } from 'undici';

const blockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function blockedIpv4(address: number): boolean {
  const first = (address >>> 24) & 255;
  const second = (address >>> 16) & 255;
  const third = (address >>> 8) & 255;
  return first === 0 || first === 10 || first === 127 ||
    first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 ||
    first === 169 && second === 254 || first === 100 && second >= 64 && second <= 127 ||
    first === 192 && second === 0 && (third === 0 || third === 2) ||
    first === 192 && second === 88 && third === 99 ||
    first === 198 && (second === 18 || second === 19) || first === 198 && second === 51 && third === 100 ||
    first === 203 && second === 0 && third === 113 || first >= 224;
}

function ipv6Words(address: string): number[] | undefined {
  const value = address.split('%')[0];
  const parts = value.split('::');
  if (parts.length > 2 || value.includes('.')) return;
  const words = (part: string): number[] | undefined => {
    if (!part) return [];
    const result = part.split(':').map((word) => Number.parseInt(word, 16));
    return result.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? result : undefined;
  };
  const left = words(parts[0]);
  const right = words(parts[1] ?? '');
  if (!left || !right) return;
  if (parts.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing < 1 ? undefined : [...left, ...Array<number>(missing).fill(0), ...right];
}

function blockedAddress(value: string): boolean {
  const lower = value.toLowerCase();
  const address = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (address === 'localhost' || address.endsWith('.localhost') || address === '::1') return true;
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice(7);
    if (blockedAddress(mapped)) return true;
    const words = mapped.split(':').map((word) => Number.parseInt(word, 16));
    if (words.length === 2 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) &&
      blockedIpv4(((words[0] << 16) | words[1]) >>> 0)) return true;
  }
  if (address.includes(':')) {
    const words = ipv6Words(address);
    if (!words) return true;
    const [first, second, third] = words;
    if (first < 0x2000 || first > 0x3fff || first === 0x2002 ||
      first === 0x2001 && (second === 0 || second === 2 && third === 0 || second === 0xdb8 || second >= 0x10 && second <= 0x2f)) return true;
  }
  if (/^\d+$/.test(address) || /^0x[\da-f]+$/i.test(address)) {
    const numeric = Number(address);
    return numeric >= 0 && numeric <= 0xffffffff && blockedIpv4(numeric >>> 0);
  }
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  let numeric = 0;
  for (const part of parts) {
    const byte = Number.parseInt(part, /^0x/i.test(part) ? 16 : part.startsWith('0') && part.length > 1 ? 8 : 10);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return false;
    numeric = (numeric << 8) | byte;
  }
  return blockedIpv4(numeric >>> 0);
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  let settle!: () => void;
  observe(new Promise<void>((resolve) => { settle = resolve; }));
  try {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      try {
        if (error) { callback(error, []); return; }
        if (addresses.some(({ address }) => blockedAddress(address))) {
          callback(Object.assign(new Error('Refusing connection to a private/local address'), { code: 'ERR_PRIVATE_NETWORK' }), []);
          return;
        }
        const first = addresses[0];
        if (!first) { callback(new Error('DNS lookup returned no address'), []); return; }
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      } finally { settle(); }
    });
  } catch (error) { settle(); throw error; }
};

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

async function checkDns(url: URL, signal: AbortSignal): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return;
  const results = await abortable(observe(Promise.allSettled([resolve4(hostname), resolve6(hostname)])), signal);
  const addresses = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (!addresses.length) addresses.push((await abortable(observe(lookupAddress(hostname)), signal)).address);
  if (addresses.some(blockedAddress)) throw new Error('DNS resolved to a private/local address');
}

let client: Promise<{ agent: Agent; fetch: typeof fetch }> | undefined;
const shutdown = new AbortController();
const inflight = new Set<Promise<unknown>>();
const waiting = new Set<() => void>();
const MAX_ACTIVE_FETCHES = 4;
const MAX_WAITING_FETCHES = 32;
let closing: Promise<void> | undefined;

function startWaiting(): void {
  // Count unfinished DNS too: aborting a fetch does not cancel the system resolver.
  while (!shutdown.signal.aborted && inflight.size < MAX_ACTIVE_FETCHES && waiting.size) {
    const start = waiting.values().next().value!;
    waiting.delete(start);
    start();
  }
}

function observe<T>(work: Promise<T>): Promise<T> {
  inflight.add(work);
  const settled = (): void => { inflight.delete(work); startWaiting(); };
  void work.then(settled, settled);
  return work;
}

function getClient() {
  return client ??= import('undici').then(({ Agent, fetch }) => ({
    agent: new Agent({ connect: { lookup: publicLookup } }), fetch,
  })).catch((error) => { client = undefined; throw error; });
}

export function closePublicFaviconClient(): Promise<void> {
  return closing ??= (async () => {
    shutdown.abort(new DOMException('Favicon client closed', 'AbortError'));
    while (inflight.size) await Promise.allSettled([...inflight]);
    await (await client)?.agent.close();
  })();
}

// No Electron Session: page cookies and authentication never accompany favicon requests.
export function fetchPublicFavicon(value: string, signal: AbortSignal): Promise<{ image: Buffer; contentType?: string } | undefined> {
  if (closing) return Promise.reject(new Error('Favicon client is closed'));
  const combined = AbortSignal.any([signal, shutdown.signal]);
  if (combined.aborted) return Promise.reject(combined.reason);
  if (inflight.size < MAX_ACTIVE_FETCHES) return observe(readFavicon(value, combined));
  if (waiting.size >= MAX_WAITING_FETCHES) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = (): void => { waiting.delete(start); combined.removeEventListener('abort', abort); reject(combined.reason); };
    const start = (): void => {
      combined.removeEventListener('abort', abort);
      observe(readFavicon(value, combined)).then(resolve, reject);
    };
    waiting.add(start);
    combined.addEventListener('abort', abort, { once: true });
  });
}

async function readFavicon(value: string, signal: AbortSignal): Promise<{ image: Buffer; contentType?: string } | undefined> {
  let url = new URL(value);
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || blockedAddress(url.hostname)) return;
    await checkDns(url, signal);
    const { agent, fetch } = await getClient();
    signal.throwIfAborted();
    if (blockedPorts.has(Number(url.port))) return;
    const response = await fetch(url.href, { signal, redirect: 'manual', dispatcher: agent });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || Number(response.headers.get('content-length')) > 72_000) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 72_000) { await reader.cancel(); return; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (size) return { image: Buffer.concat(chunks, size), contentType: response.headers.get('content-type') ?? undefined };
    return;
  }
}
