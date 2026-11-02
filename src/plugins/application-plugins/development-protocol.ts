export interface AppDevelopmentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppDevelopmentSnapshot {
  title: string;
  url: string;
  nodes: readonly {
    id: string;
    tag: string;
    role: string;
    name: string;
    text: string;
    value?: string;
    rect: AppDevelopmentRect;
  }[];
  truncated: boolean;
}

export type AppDevelopmentAction = { type: 'click' | 'fill'; id: string; value?: string };
export type AppDevelopmentActionResult = { outcome: 'applied' | 'stale' | 'unsupported' };

export interface AppFrameHandle {
  inspect(signal: AbortSignal): Promise<AppDevelopmentSnapshot>;
  act(action: AppDevelopmentAction, signal: AbortSignal): Promise<AppDevelopmentActionResult>;
  getBounds(): AppDevelopmentRect | null;
}

export function isAppDevelopmentSnapshot(value: unknown): value is AppDevelopmentSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).some((key) => !['title', 'url', 'nodes', 'truncated'].includes(key))
    || typeof snapshot.title !== 'string' || snapshot.title.length > 200 || typeof snapshot.url !== 'string'
    || snapshot.url.length > 2048 || typeof snapshot.truncated !== 'boolean' || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > 200) return false;
  return snapshot.nodes.every((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const node = value as Record<string, unknown>;
    if (Object.keys(node).some((key) => !['id', 'tag', 'role', 'name', 'text', 'value', 'rect'].includes(key))
      || typeof node.id !== 'string' || !/^\d+-\d+$/.test(node.id) || node.id.length > 80
      || typeof node.tag !== 'string' || node.tag.length > 80 || typeof node.role !== 'string' || node.role.length > 80
      || typeof node.name !== 'string' || node.name.length > 200 || typeof node.text !== 'string' || node.text.length > 500
      || node.value !== undefined && (typeof node.value !== 'string' || node.value.length > 1000)
      || !node.rect || typeof node.rect !== 'object' || Array.isArray(node.rect)) return false;
    const rect = node.rect as Record<string, unknown>;
    return Object.keys(rect).every((key) => ['x', 'y', 'width', 'height'].includes(key))
      && ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
      && Number(rect.width) >= 0 && Number(rect.height) >= 0;
  });
}

// Serialized into development frames only. No selectors or executable source cross this boundary.
export function installAppDevelopmentBridge() {
  const nodes = new Map<string, HTMLElement>();
  let generation = 0;
  const invalidate = () => { nodes.clear(); };
  const observer = new MutationObserver(invalidate);
  observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return element.isConnected && rect.width > 0 && rect.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden' && !element.closest('[inert]');
  };
  return {
    inspect(): AppDevelopmentSnapshot {
      observer.takeRecords();
      invalidate();
      const snapshot: AppDevelopmentSnapshot['nodes'][number][] = [];
      const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
      const start = performance.now();
      const prefix = ++generation;
      let scanned = 0;
      let truncated = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++scanned > 4000 || snapshot.length >= 200 || performance.now() - start > 40) { truncated = true; break; }
        if (!(node instanceof HTMLElement) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName) || !visible(node)) continue;
        const interactive = node.matches('button,input,textarea,select,a,[role],[contenteditable="true"],[tabindex]');
        if (!interactive && node.children.length) continue;
        const id = `${prefix}-${snapshot.length}`;
        nodes.set(id, node);
        const rect = node.getBoundingClientRect();
        const input = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement ? node : null;
        const privateInput = node instanceof HTMLInputElement && ['password', 'file'].includes(node.type);
        snapshot.push({ id, tag: node.tagName.toLowerCase(), role: (node.getAttribute('role') ?? '').slice(0, 80),
          name: (node.getAttribute('aria-label') ?? input?.labels?.[0]?.textContent ?? node.getAttribute('title') ?? '').slice(0, 200),
          text: (node.textContent ?? '').slice(0, 500), ...(input && !privateInput ? { value: input.value.slice(0, 1000) } : {}),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      }
      return { title: document.title.slice(0, 200), url: location.href.slice(0, 2048), nodes: snapshot, truncated };
    },
    act(action: AppDevelopmentAction): AppDevelopmentActionResult {
      if (observer.takeRecords().length) invalidate();
      const element = nodes.get(action.id);
      if (!element || !visible(element)) return { outcome: 'stale' };
      if (element.matches(':disabled,[aria-disabled="true"]')) return { outcome: 'unsupported' };
      if (action.type === 'click') {
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        element.click();
      } else if (action.type === 'fill' && typeof action.value === 'string' && action.value.length <= 10_000) {
        if (element instanceof HTMLInputElement && !['file', 'hidden', 'button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(element.type)) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, action.value);
        } else if (element instanceof HTMLTextAreaElement) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, action.value);
        } else return { outcome: 'unsupported' };
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else return { outcome: 'unsupported' };
      invalidate();
      return { outcome: 'applied' };
    },
    dispose() { observer.disconnect(); invalidate(); },
  };
}
