import type { IabOverlayCommand, IabUiCommand, IabUiRequest } from '../../../src/types/desktop/iab';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown, maximum = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
}
function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function bounds(value: unknown): boolean {
  return record(value) && keys(value, ['x', 'y', 'width', 'height'])
    && ['x', 'y', 'width', 'height'].every((key) => number(value[key]))
    && (value.width as number) >= 0 && (value.height as number) >= 0;
}
function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === 'boolean'; }
function integer(value: unknown): value is number { return number(value) && Number.isSafeInteger(value) && value >= 0; }
function download(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.action === 'open-directory') return keys(value, ['action']);
  return ['open', 'show-in-folder', 'cancel', 'pause', 'resume', 'remove'].includes(String(value.action))
    && keys(value, ['action', 'id']) && text(value.id, 256);
}
function choiceMenu(value: unknown): boolean {
  if (!record(value) || !keys(value, ['requestId', 'anchor', 'align', 'keyboard', 'items', 'initialPage', 'labels', 'theme', 'locale'])
    || !text(value.requestId, 256) || !bounds(value.anchor) || (value.align !== 'start' && value.align !== 'end')
    || typeof value.keyboard !== 'boolean' || !Array.isArray(value.items) || value.items.length > 3_000
    || !integer(value.initialPage) || value.initialPage > value.items.length
    || (value.theme !== 'light' && value.theme !== 'dark') || !text(value.locale, 64)
    || !record(value.labels) || !keys(value.labels, ['empty', 'previous', 'next', 'page'])
    || !['empty', 'previous', 'next', 'page'].every((key) => text((value.labels as Record<string, unknown>)[key], 1_024))) return false;
  try { Intl.getCanonicalLocales(value.locale); } catch { return false; }
  const ids = new Set<string>();
  return value.items.every((item) => {
    if (!record(item) || !keys(item, ['id', 'label', 'icon', 'selected', 'badge', 'disabled'])
      || !text(item.id, 256) || ids.has(item.id) || !text(item.label, 4_096)
      || !optionalBoolean(item.selected) || !optionalBoolean(item.disabled)
      || item.badge !== undefined && !text(item.badge, 256)
      || item.icon !== undefined && (!text(item.icon, 99_999)
        || !/^data:image\/(?:png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i.test(item.icon)
        || item.icon.endsWith(','))) return false;
    ids.add(item.id);
    return true;
  });
}
function overlay(value: unknown): boolean {
  if (!record(value) || !integer(value.sessionId)) return false;
  switch (value.action) {
    case 'dismiss': case 'refresh-downloads': return keys(value, ['sessionId', 'action']);
    case 'menu': return keys(value, ['sessionId', 'action', 'command'])
      && ['find', 'history', 'downloads', 'open-external', 'screenshot', 'clear-cache', 'clear-site-data', 'zoom-in', 'zoom-out', 'zoom-reset'].includes(String(value.command));
    case 'download': return keys(value, ['sessionId', 'action', 'command']) && download(value.command);
    case 'select-suggestion': case 'remove-suggestion': case 'select-choice': return keys(value, ['sessionId', 'action', 'id']) && text(value.id, 256);
    default: return false;
  }
}
function command(value: unknown): value is IabUiCommand {
  if (!record(value)) return false;
  const tab = () => text(value.tabId, 256);
  switch (value.action) {
    case 'snapshot': case 'list-all': case 'downloads-clear':
      return keys(value, ['action']);
    case 'open': return keys(value, ['action', 'url', 'displayScope', 'background'])
      && text(value.url) && text(value.displayScope) && optionalBoolean(value.background);
    case 'promote-display-scope': return keys(value, ['action', 'from', 'to']) && text(value.from) && text(value.to);
    case 'switch': case 'close': case 'back': case 'forward': case 'reload': case 'screenshot-save': case 'hide-suggestions':
      return keys(value, ['action', 'tabId']) && tab();
    case 'navigate': return keys(value, ['action', 'tabId', 'url']) && tab() && text(value.url);
    case 'set-views': {
      if (!keys(value, ['action', 'views']) || !Array.isArray(value.views) || value.views.length > 3_000) return false;
      const ids = new Set<string>();
      return value.views.every((view) => {
        if (!record(view) || !keys(view, ['tabId', 'bounds']) || !text(view.tabId, 256) || ids.has(view.tabId) || !bounds(view.bounds)) return false;
        ids.add(view.tabId);
        return true;
      });
    }
    case 'show-choices': return keys(value, ['action', 'menu']) && choiceMenu(value.menu);
    case 'dismiss-choices': return keys(value, ['action', 'requestId']) && text(value.requestId, 256);
    case 'set-presentation': return keys(value, ['action', 'theme', 'locale'])
      && (value.theme === 'light' || value.theme === 'dark') && text(value.locale, 64);
    case 'find': return keys(value, ['action', 'tabId', 'text', 'searchId', 'forward']) && tab()
      && typeof value.text === 'string' && value.text.length <= 1_000 && !value.text.includes('\0')
      && integer(value.searchId) && optionalBoolean(value.forward);
    case 'stop-find': return keys(value, ['action', 'tabId', 'mode']) && tab()
      && (value.mode === undefined || ['clearSelection', 'keepSelection', 'activateSelection'].includes(String(value.mode)));
    case 'set-zoom': return keys(value, ['action', 'tabId', 'zoomFactor']) && tab()
      && number(value.zoomFactor) && value.zoomFactor >= 0.25 && value.zoomFactor <= 5;
    case 'open-internal': return keys(value, ['action', 'page', 'tabId']) && tab() && (value.page === 'history' || value.page === 'downloads');
    case 'history-query': {
      const query = value.query;
      return keys(value, ['action', 'query']) && record(query) && keys(query, ['query', 'offset', 'limit', 'from', 'to'])
        && (query.query === undefined || typeof query.query === 'string' && query.query.length <= 1_000)
        && (query.offset === undefined || integer(query.offset))
        && (query.limit === undefined || integer(query.limit) && query.limit > 0 && query.limit <= 3_000)
        && (query.from === undefined || number(query.from)) && (query.to === undefined || number(query.to));
    }
    case 'history-remove': return keys(value, ['action', 'ids']) && (value.ids === 'all'
      || Array.isArray(value.ids) && value.ids.length <= 3_000 && value.ids.every((id) => text(id, 256)));
    case 'history-remove-origin': return keys(value, ['action', 'url']) && text(value.url);
    case 'history-suggest': return keys(value, ['action', 'tabId', 'query', 'selectedIndex', 'anchor']) && tab()
      && typeof value.query === 'string' && value.query.length <= 8_192 && number(value.selectedIndex)
      && Number.isInteger(value.selectedIndex) && value.selectedIndex >= -1 && value.selectedIndex < 8 && bounds(value.anchor);
    case 'downloads-list': return keys(value, ['action', 'refreshFileState']) && optionalBoolean(value.refreshFileState);
    case 'download': return keys(value, ['action', 'command']) && download(value.command);
    case 'show-menu': case 'show-downloads': {
      const anchor = value.anchor;
      return keys(value, ['action', 'tabId', 'anchor']) && tab() && record(anchor)
        && keys(anchor, ['x', 'y', 'width', 'height', 'keyboard', 'browserBounds'])
        && bounds({ x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height })
        && typeof anchor.keyboard === 'boolean' && (anchor.browserBounds === undefined || bounds(anchor.browserBounds));
    }
    case 'overlay': return keys(value, ['action', 'command']) && overlay(value.command);
    case 'clear-data': return keys(value, ['action', 'tabId', 'token', 'data', 'confirmation']) && tab() && text(value.token, 256)
      && (value.data === 'cache' || value.data === 'site-storage') && record(value.confirmation)
      && keys(value.confirmation, ['scope', 'confirmed']) && value.confirmation.scope === 'shared-session' && value.confirmation.confirmed === true;
    default: return false;
  }
}

export function decodeIabOverlayCommand(value: unknown): IabOverlayCommand {
  if (!overlay(value)) throw new Error('Invalid browser tools overlay command');
  return value as IabOverlayCommand;
}

/** One validation boundary for the privileged application renderer, never the web page. */
export function decodeIabUiRequest(value: unknown): IabUiRequest {
  if (!record(value) || !keys(value, ['command']) || !command(value.command)) {
    throw new Error('Invalid in-app browser request');
  }
  return value as unknown as IabUiRequest;
}
