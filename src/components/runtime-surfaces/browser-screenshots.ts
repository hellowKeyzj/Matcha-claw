import { hostOpenClawBrowserRequest } from '@/lib/host-api';
import { decodeBrowserScreenshot, type BrowserRequestInput, type BrowserScreenshot } from '@/types/openclaw-browser';

export type BrowserRequestScope = Pick<BrowserRequestInput, 'target' | 'node' | 'query'>;

export async function requestBrowser<T = unknown>(
  scope: BrowserRequestScope,
  method: BrowserRequestInput['method'],
  path: string,
  body: BrowserRequestInput['body'],
  current: () => boolean,
): Promise<T> {
  if (!current()) throw new DOMException('Browser surface closed', 'AbortError');
  return hostOpenClawBrowserRequest<T>({ ...scope, method, path, ...(body ? { body } : {}), timeoutMs: 15_000 }, { timeoutMs: 20_000 });
}

type ScreenshotEntry = {
  readonly key: string;
  readonly tabKey: string;
  readonly consumers: Set<() => boolean>;
  readonly capture: () => Promise<BrowserScreenshot | null>;
  readonly settle: () => void;
  readonly pending: Promise<void>;
  image: BrowserScreenshot | null;
  settled: boolean;
};

// One resource pool for cards and live surfaces. Receipts outlive image eviction;
// scope + tab + result revision invalidate them without recapturing historical rows.
const screenshots = new Map<string, ScreenshotEntry>();
const pendingScreenshots: ScreenshotEntry[] = [];
const activeTabs = new Set<string>();
const MAX_RECEIPTS = 128;
const MAX_PENDING = 16;
const MAX_IMAGE_CHARS = 24 * 1024 * 1024;
let activeCaptures = 0;

function trimScreenshots(): void {
  let imageChars = 0;
  for (const entry of [...screenshots.values()].reverse()) {
    imageChars += entry.image?.dataUrl.length ?? 0;
    if (imageChars > MAX_IMAGE_CHARS) entry.image = null;
  }
  for (const [key, entry] of screenshots) {
    if (screenshots.size <= MAX_RECEIPTS) break;
    if (entry.settled) screenshots.delete(key);
  }
}

function drainScreenshots(): void {
  while (activeCaptures < 2) {
    const index = pendingScreenshots.findIndex((entry) => !activeTabs.has(entry.tabKey));
    if (index < 0) return;
    const entry = pendingScreenshots.splice(index, 1)[0];
    if (![...entry.consumers].some((current) => current())) {
      entry.settled = true;
      screenshots.delete(entry.key);
      entry.settle();
      continue;
    }
    activeCaptures += 1;
    activeTabs.add(entry.tabKey);
    void entry.capture().catch(() => null).then((image) => {
      entry.image = [...entry.consumers].some((current) => current()) ? image : null;
      entry.settled = true;
      entry.settle();
      entry.consumers.clear();
      activeCaptures -= 1;
      activeTabs.delete(entry.tabKey);
      trimScreenshots();
      drainScreenshots();
    });
  }
}

export async function loadBrowserScreenshot(
  scope: BrowserRequestScope,
  scopeKey: string,
  targetId: string,
  revision: string,
  current: () => boolean,
): Promise<BrowserScreenshot | null> {
  if (!current()) return null;
  const tabKey = JSON.stringify([scopeKey, scope.target, scope.node, scope.query?.profile, targetId]);
  const key = JSON.stringify([tabKey, revision]);
  let entry = screenshots.get(key);
  if (!entry) {
    if (pendingScreenshots.length >= MAX_PENDING) return null;
    let settle!: ScreenshotEntry['settle'];
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const consumers = new Set([current]);
    const hasConsumer = () => [...consumers].some((consumer) => consumer());
    entry = {
      key, tabKey, consumers, pending, settle, image: null, settled: false,
      capture: async () => decodeBrowserScreenshot(await requestBrowser(scope, 'POST', '/screenshot', { targetId, type: 'png' }, hasConsumer)),
    };
    screenshots.set(key, entry);
    pendingScreenshots.push(entry);
    trimScreenshots();
    drainScreenshots();
  } else {
    screenshots.delete(key);
    screenshots.set(key, entry);
    if (!entry.settled) entry.consumers.add(current);
  }
  if (!entry.settled) await entry.pending;
  entry.consumers.delete(current);
  return current() ? entry.image : null;
}
