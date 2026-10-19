export const MAX_BROWSER_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_BROWSER_SCREENSHOT_BYTES = Math.floor((MAX_BROWSER_IMAGE_BYTES - 'data:image/jpeg;base64,'.length) / 4) * 3;
export const MAX_BROWSER_VIEWPORT_DIMENSION = 8192;

export type BrowserViewport = { readonly width: number; readonly height: number };

export type BrowserScreenshot = {
  readonly dataUrl: string;
  readonly targetId?: string;
  readonly tabId?: string;
  readonly url?: string;
  readonly viewport?: BrowserViewport;
};

export type BrowserTab = {
  readonly targetId: string;
  readonly tabId?: string;
  readonly title?: string;
  readonly url?: string;
  readonly active?: boolean;
};

export type BrowserAction =
  | { readonly kind: 'clickCoords'; readonly targetId: string; readonly x: number; readonly y: number; readonly button?: 'left' | 'right' | 'middle'; readonly doubleClick?: boolean }
  | { readonly kind: 'press'; readonly targetId: string; readonly key: string }
  | { readonly kind: 'type'; readonly targetId: string; readonly selector: string; readonly text: string; readonly submit?: boolean; readonly slowly?: boolean }
  | { readonly kind: 'resize'; readonly targetId: string; readonly width: number; readonly height: number }
  | { readonly kind: 'scrollBy'; readonly targetId: string; readonly deltaX: number; readonly deltaY: number; readonly x?: number; readonly y?: number }
  | { readonly kind: 'history'; readonly targetId: string; readonly delta: -1 | 1 }
  | { readonly kind: 'reload'; readonly targetId: string }
  | { readonly kind: 'insertText'; readonly targetId: string; readonly text: string };

export type BrowserOperationErrorCode = 'browser_evaluation_disabled' | 'browser_input_unsupported' | 'browser_operation_unsupported';
export type BrowserOperationFailure = { readonly ok: false; readonly errorCode: BrowserOperationErrorCode };

export function decodeBrowserOperationFailure(value: unknown): BrowserOperationFailure | null {
  return isRecord(value) && keys(value, ['ok', 'errorCode']) && value.ok === false
    && (value.errorCode === 'browser_evaluation_disabled' || value.errorCode === 'browser_input_unsupported' || value.errorCode === 'browser_operation_unsupported')
    ? value as BrowserOperationFailure : null;
}

export type BrowserStatus = {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly cdpReady?: boolean;
  readonly pageReady?: boolean;
  readonly headless?: boolean;
  readonly attachOnly?: boolean;
  readonly profile?: string;
  readonly driver?: string;
  readonly transport?: 'cdp' | 'extension' | 'chrome-mcp';
};

export function decodeBrowserStatus(value: unknown): BrowserStatus | null {
  if (!isRecord(value) || !keys(value, ['enabled', 'running', 'cdpReady', 'pageReady', 'headless', 'attachOnly', 'profile', 'driver', 'transport'])
    || typeof value.enabled !== 'boolean' || typeof value.running !== 'boolean'
    || !['cdpReady', 'pageReady', 'headless', 'attachOnly'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
    || !optionalText(value, 'profile', 256) || !optionalText(value, 'driver', 256)
    || (value.transport !== undefined && value.transport !== 'cdp' && value.transport !== 'extension' && value.transport !== 'chrome-mcp')) return null;
  return value as BrowserStatus;
}

export type BrowserRequestInput = {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query?: { readonly profile: string };
  readonly body?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly target?: 'host' | 'node';
  readonly node?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, limit = 4096): value is string {
  // eslint-disable-next-line no-control-regex -- Reject C0 controls and DEL at the Browser identity boundary.
  return typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function dimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_BROWSER_VIEWPORT_DIMENSION;
}

function browserUrl(value: unknown): value is string {
  if (!text(value, 16_384)) return false;
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function optionalText(value: Record<string, unknown>, key: string, limit = 4096): boolean {
  return value[key] === undefined || text(value[key], limit);
}

function imageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_BROWSER_IMAGE_BYTES) return false;
  const prefix = value.startsWith('data:image/png;base64,') ? 'data:image/png;base64,'
    : value.startsWith('data:image/jpeg;base64,') ? 'data:image/jpeg;base64,' : null;
  if (!prefix) return false;
  const encoded = value.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false;
  try {
    const bytes = atob(encoded);
    if (bytes.length > MAX_BROWSER_SCREENSHOT_BYTES || btoa(bytes) !== encoded) return false;
    return prefix.includes('/png;')
      ? bytes.startsWith('\x89PNG\r\n\x1a\n') && bytes.endsWith('\x00\x00\x00\x00IEND\xaeB\x60\x82')
      : bytes.startsWith('\xff\xd8\xff') && bytes.endsWith('\xff\xd9');
  } catch {
    return false;
  }
}

export function decodeBrowserScreenshot(value: unknown): BrowserScreenshot | null {
  if (!isRecord(value) || !keys(value, ['dataUrl', 'targetId', 'tabId', 'url', 'viewport'])
    || !imageDataUrl(value.dataUrl) || !optionalText(value, 'targetId', 256) || !optionalText(value, 'tabId', 256)
    || (value.url !== undefined && !browserUrl(value.url))) return null;
  if (value.viewport !== undefined && (!isRecord(value.viewport) || !keys(value.viewport, ['width', 'height'])
    || !dimension(value.viewport.width) || !dimension(value.viewport.height))) return null;
  return value as BrowserScreenshot;
}

export function decodeBrowserTab(value: unknown): BrowserTab | null {
  if (!isRecord(value) || !keys(value, ['targetId', 'tabId', 'title', 'url', 'active']) || !text(value.targetId, 256)
    || !optionalText(value, 'tabId', 256)
    || (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 16_384 || value.title.includes('\0')))
    || (value.url !== undefined && !browserUrl(value.url))
    || (value.active !== undefined && typeof value.active !== 'boolean')) return null;
  return value as BrowserTab;
}

export function decodeBrowserTabs(value: unknown): BrowserTab[] | null {
  if (!isRecord(value) || !keys(value, ['tabs', 'running']) || !Array.isArray(value.tabs) || value.tabs.length > 1024
    || (value.running !== undefined && typeof value.running !== 'boolean')) return null;
  const ids = new Set<string>();
  for (const entry of value.tabs) {
    const tab = decodeBrowserTab(entry);
    if (!tab || ids.has(tab.targetId)) return null;
    ids.add(tab.targetId);
  }
  return value.tabs as BrowserTab[];
}

export type BrowserStartResult = { readonly ok: true; readonly profile?: string };
export type BrowserMutationResult = { readonly ok: true; readonly targetId?: string; readonly tabId?: string; readonly url?: string };

export function decodeBrowserStartResult(value: unknown): BrowserStartResult | null {
  return isRecord(value) && keys(value, ['ok', 'profile']) && value.ok === true && optionalText(value, 'profile', 256)
    ? value as BrowserStartResult : null;
}

export function decodeBrowserMutationResult(value: unknown): BrowserMutationResult | null {
  return isRecord(value) && keys(value, ['ok', 'targetId', 'tabId', 'url']) && value.ok === true
    && optionalText(value, 'targetId', 256) && optionalText(value, 'tabId', 256) && (value.url === undefined || browserUrl(value.url))
    ? value as BrowserMutationResult : null;
}

export function isBrowserAction(value: unknown): value is BrowserAction {
  if (!isRecord(value) || !text(value.targetId, 256)) return false;
  switch (value.kind) {
    case 'clickCoords':
      return keys(value, ['kind', 'targetId', 'x', 'y', 'button', 'doubleClick'])
        && typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= MAX_BROWSER_VIEWPORT_DIMENSION
        && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= MAX_BROWSER_VIEWPORT_DIMENSION
        && (value.button === undefined || value.button === 'left' || value.button === 'right' || value.button === 'middle')
        && (value.doubleClick === undefined || typeof value.doubleClick === 'boolean');
    case 'press':
      return keys(value, ['kind', 'targetId', 'key']) && text(value.key, 256);
    case 'type':
      return keys(value, ['kind', 'targetId', 'selector', 'text', 'submit', 'slowly']) && text(value.selector)
        && typeof value.text === 'string' && value.text.length <= 32_768 && !value.text.includes('\0')
        && (value.submit === undefined || typeof value.submit === 'boolean')
        && (value.slowly === undefined || typeof value.slowly === 'boolean');
    case 'resize':
      return keys(value, ['kind', 'targetId', 'width', 'height']) && dimension(value.width) && dimension(value.height);
    case 'scrollBy':
      return keys(value, ['kind', 'targetId', 'deltaX', 'deltaY', 'x', 'y'])
        && typeof value.deltaX === 'number' && Number.isFinite(value.deltaX) && Math.abs(value.deltaX) <= 1200
        && typeof value.deltaY === 'number' && Number.isFinite(value.deltaY) && Math.abs(value.deltaY) <= 1200
        && ((value.x === undefined && value.y === undefined) || (typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= MAX_BROWSER_VIEWPORT_DIMENSION
          && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= MAX_BROWSER_VIEWPORT_DIMENSION));
    case 'history':
      return keys(value, ['kind', 'targetId', 'delta']) && (value.delta === -1 || value.delta === 1);
    case 'reload':
      return keys(value, ['kind', 'targetId']);
    case 'insertText':
      return keys(value, ['kind', 'targetId', 'text']) && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 32_768 && !value.text.includes('\0');
    default:
      return false;
  }
}

export function isBrowserRequestInput(value: unknown): value is BrowserRequestInput {
  if (!isRecord(value) || !keys(value, ['method', 'path', 'query', 'body', 'timeoutMs', 'target', 'node'])
    || (value.query !== undefined && (!isRecord(value.query) || !keys(value.query, ['profile']) || !text(value.query.profile, 256)))
    || (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60_000))
    || (value.target !== undefined && value.target !== 'host' && value.target !== 'node')
    || (value.node !== undefined && (value.target !== 'node' || !text(value.node, 256)))) return false;
  const body = value.body === undefined ? {} : value.body;
  if (!isRecord(body)) return false;
  if (value.method === 'GET' && (value.path === '/tabs' || value.path === '/')) return keys(body, []);
  if (value.method === 'DELETE' && typeof value.path === 'string' && value.path.startsWith('/tabs/') && keys(body, [])) {
    try {
      const targetId = decodeURIComponent(value.path.slice('/tabs/'.length));
      return text(targetId, 256) && !/[\\/?#]/u.test(targetId) && targetId !== '.' && targetId !== '..';
    } catch {
      return false;
    }
  }
  if (value.method !== 'POST') return false;
  switch (value.path) {
    case '/start': return keys(body, []);
    case '/tabs/open': return keys(body, ['url']) && browserUrl(body.url);
    case '/tabs/focus': return keys(body, ['targetId']) && text(body.targetId, 256);
    case '/navigate': return keys(body, ['targetId', 'url']) && text(body.targetId, 256) && browserUrl(body.url);
    case '/screenshot': return keys(body, ['targetId', 'type']) && text(body.targetId, 256) && (body.type === undefined || body.type === 'png' || body.type === 'jpeg');
    case '/act': return isBrowserAction(body);
    default: return false;
  }
}

export function decodeBrowserRequestInput(value: unknown): BrowserRequestInput | null {
  return isBrowserRequestInput(value) ? value : null;
}
