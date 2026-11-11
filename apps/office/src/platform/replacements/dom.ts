import { JSDOM, VirtualConsole } from 'jsdom';

let installed = false;

/**
 * Same bootstrap as GenOffice's CLI dom.ts, but with jsdom imported statically:
 * the plugin ships as one bundle, so there is no Node resolution step to defer.
 */
export async function ensureDom(): Promise<void> {
  if (installed) return;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole()
  });
  const w = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'navigator']) {
    Object.defineProperty(g, key, {
      value: key === 'window' ? w : w[key],
      configurable: true,
      writable: true
    });
  }
  for (const key of Object.getOwnPropertyNames(w)) {
    if (key in g) continue;
    try {
      g[key] = w[key];
    } catch {
      // jsdom exposes some non-writable globals; the editors do not need them
    }
  }
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const noMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  });
  g.matchMedia ??= noMedia;
  w.matchMedia ??= noMedia;
  g.requestAnimationFrame ??= (cb: (time: number) => void) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  const range = (w.Range as { prototype: Record<string, unknown> }).prototype;
  range.getClientRects ??= () => [];
  range.getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const document_ = w.document as Record<string, unknown>;
  document_.getSelection ??= () => null;
  installed = true;
}
