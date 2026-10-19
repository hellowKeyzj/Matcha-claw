import {
  buildSessionIdentityKey,
  validateSessionIdentity,
  type NativeRuntimeEndpointRef,
  type SessionIdentity,
} from './desktop/runtime-address';

export type BoardIdentity = SessionIdentity & { readonly endpoint: NativeRuntimeEndpointRef };
export type BoardChatDock = 'left' | 'right' | 'bottom' | 'hidden';
export type BoardSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';
export type BoardWidgetPresentation = 'card' | 'full-bleed' | 'frameless';
export type BoardWidgetHeightMode = 'auto' | 'fixed';
export type BoardJson = null | boolean | number | string | BoardJson[] | { [key: string]: BoardJson };
export type BoardParams = Record<string, BoardJson>;

export interface BoardTab {
  tabId: string;
  title: string;
  position: number;
  chatDock: BoardChatDock;
}

export interface BoardWidgetDeclared {
  netOrigins?: string[];
  tools?: string[];
}

export interface BoardWidgetGeneratedIdentity {
  source: 'show_widget';
  key: string;
  fallbackName: string;
}

export interface BoardMcpAppDescriptor {
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId: string;
}

export type BoardWidgetContent =
  | { kind: 'html'; html: string }
  | { kind: 'mcp-app'; descriptor: BoardMcpAppDescriptor }
  | { kind: 'plugin'; pluginKind: string; props?: BoardParams }
  | { kind: 'registered'; contentKind: string; source: string };

export type BoardWidgetPutContent =
  | Exclude<BoardWidgetContent, { kind: 'mcp-app' }>
  | { kind: 'mcp-app'; viewId: string }
  | { kind: 'canvas-doc'; docId: string };

/** Native view metadata is ephemeral: never persist frame URLs, tickets or sandbox metadata. */
export interface BoardWidget {
  name: string;
  tabId: string;
  title?: string;
  contentKind: 'html' | 'mcp-app' | 'plugin';
  contentOwner?: 'html' | 'mcp-app' | 'plugin' | 'registered';
  registeredContentKind?: string;
  pluginKind?: string;
  props?: BoardParams;
  presentation?: BoardWidgetPresentation;
  heightMode?: BoardWidgetHeightMode;
  sizeW: number;
  sizeH: number;
  position: number;
  grantState: 'none' | 'pending' | 'granted' | 'rejected';
  revision: number;
  instanceId?: string;
  declaredSummary?: string[];
  declared?: BoardWidgetDeclared;
  frameUrl?: string;
  viewTicket?: string;
  viewTicketTtlMs?: number;
  viewGeneration?: string;
  sandboxUrl?: string;
  sandboxPort?: number;
  sandboxOrigin?: string;
  kindLabel?: string;
}

export interface BoardSnapshot {
  sessionKey: string;
  revision: number;
  tabs: BoardTab[];
  widgets: BoardWidget[];
}

export type BoardOp =
  | { kind: 'tab_create'; tabId: string; title: string; chatDock?: BoardChatDock }
  | { kind: 'tab_update'; tabId: string; title?: string; chatDock?: BoardChatDock; position?: number }
  | { kind: 'tab_delete'; tabId: string }
  | { kind: 'tabs_reorder'; tabIds: string[] }
  | { kind: 'widget_move'; name: string; tabId?: string; position?: number; after?: string }
  | { kind: 'widget_resize'; name: string; sizeW: number; sizeH: number; heightMode?: BoardWidgetHeightMode }
  | { kind: 'widget_remove'; name: string };

export interface BoardWidgetPlacement {
  tabId?: string;
  size?: BoardSize;
  after?: string;
}

export type BoardOperation =
  | { method: 'board.get' }
  | { method: 'board.update'; ops: BoardOp[] }
  | {
    method: 'board.widget.put';
    name: string;
    title?: string;
    content: BoardWidgetPutContent;
    presentation?: BoardWidgetPresentation;
    heightMode?: BoardWidgetHeightMode;
    placement?: BoardWidgetPlacement;
    declared?: BoardWidgetDeclared;
    generatedIdentity?: BoardWidgetGeneratedIdentity;
  }
  | { method: 'board.widget.grant'; name: string; decision: 'granted' | 'rejected'; revision: number; instanceId: string }
  | { method: 'board.widget.appView'; name: string; revision: number; instanceId: string }
  | ({ method: 'board.event'; payload: BoardJson } & ({ widget: string } | { ticket: string }))
  | { method: 'board.prompt.authorize'; ticket: string }
  | { method: 'board.data.read'; ticket: string; bindingId: string; params?: BoardParams }
  | ({ method: 'board.action'; ticket: string } & (
    | { action: 'cron.trigger'; jobId: string }
    | { action: string; params?: BoardParams }
  ));

export interface BoardExecuteRequest {
  identity: BoardIdentity;
  operation: BoardOperation;
}

export interface BoardWidgetPutResult extends BoardSnapshot {
  resolvedWidgetName: string;
}

export interface BoardWidgetAppViewResult {
  viewId: string;
  expiresAtMs: number;
}

export interface BoardResultMap {
  'board.get': BoardSnapshot;
  'board.update': BoardSnapshot;
  'board.widget.put': BoardWidgetPutResult;
  'board.widget.grant': BoardSnapshot;
  'board.widget.appView': BoardWidgetAppViewResult;
  'board.event': { ok: true; appended: boolean };
  'board.prompt.authorize': { confirmationRequired: boolean };
  'board.data.read': BoardJson;
  'board.action': BoardJson;
}

export type BoardMethod = BoardOperation['method'];
export type BoardResult<M extends BoardMethod = BoardMethod> = BoardResultMap[M];
export type BoardFailureCode = 'unsupported' | 'invalid' | 'forbidden' | 'stale' | 'expired' | 'missing-source' | 'unavailable' | 'unknown';
export interface BoardFailure { code: BoardFailureCode; message: string }
export interface BoardErrorResponse { error: BoardFailure }

export type BoardCommand =
  | { kind: 'focus_tab'; tabId: string }
  | { kind: 'set_chat_dock'; dock: BoardChatDock };
export interface BoardChangedEvent { identity: BoardIdentity; revision: number; widget?: string }
export interface BoardCommandEvent { identity: BoardIdentity; command: BoardCommand }
export type BoardEvent =
  | { kind: 'changed'; event: BoardChangedEvent }
  | { kind: 'command'; event: BoardCommandEvent };

export const BOARD_EXECUTE_PATH = '/api/board/execute';
export const BOARD_METHODS: readonly BoardMethod[] = [
  'board.get', 'board.update', 'board.widget.put', 'board.widget.grant', 'board.widget.appView',
  'board.event', 'board.prompt.authorize', 'board.data.read', 'board.action',
];
export const BOARD_FAILURE_CODES: readonly BoardFailureCode[] = [
  'unsupported', 'invalid', 'forbidden', 'stale', 'expired', 'missing-source', 'unavailable', 'unknown',
];
export const boardIdentityKey = (identity: BoardIdentity): string => buildSessionIdentityKey(identity);

export function decodeBoardIdentity(value: unknown): BoardIdentity {
  if (validateSessionIdentity(value) || !record(value) || !record(value.endpoint) || value.endpoint.kind !== 'native-runtime') invalid();
  return value as unknown as BoardIdentity;
}

export function decodeBoardExecuteRequest(value: unknown): BoardExecuteRequest {
  if (!closed(value, ['identity', 'operation'])) invalid();
  return { identity: decodeBoardIdentity(value.identity), operation: decodeBoardOperation(value.operation) };
}

export function decodeBoardOperation(value: unknown): BoardOperation {
  if (!record(value)) invalid();
  let valid = false;
  switch (value.method) {
    case 'board.get': valid = closed(value, ['method']); break;
    case 'board.update': valid = closed(value, ['method', 'ops']) && array(value.ops, op); break;
    case 'board.widget.put':
      valid = closed(value, ['method', 'name', 'content'], ['title', 'presentation', 'heightMode', 'placement', 'declared', 'generatedIdentity'])
        && name(value.name) && optional(value.title, title) && content(value.content)
        && optional(value.presentation, presentation) && optional(value.heightMode, heightMode)
        && optional(value.placement, placement) && optional(value.declared, declared)
        && optional(value.generatedIdentity, generatedIdentity);
      break;
    case 'board.widget.grant':
    case 'board.widget.appView':
      valid = closed(value, ['method', 'name', 'revision', 'instanceId', ...(value.method === 'board.widget.grant' ? ['decision'] : [])])
        && name(value.name) && integer(value.revision, 1) && nonempty(value.instanceId)
        && (value.method !== 'board.widget.grant' || oneOf(value.decision, ['granted', 'rejected']));
      break;
    case 'board.event':
      valid = (closed(value, ['method', 'widget', 'payload']) && name(value.widget)
        || closed(value, ['method', 'ticket', 'payload']) && ticket(value.ticket)) && json(value.payload);
      break;
    case 'board.prompt.authorize': valid = closed(value, ['method', 'ticket']) && ticket(value.ticket); break;
    case 'board.data.read':
      valid = closed(value, ['method', 'ticket', 'bindingId'], ['params']) && ticket(value.ticket)
        && text(value.bindingId, 1, 64) && optional(value.params, params);
      break;
    case 'board.action':
      valid = ticket(value.ticket) && (
        closed(value, ['method', 'ticket', 'action', 'jobId']) && value.action === 'cron.trigger' && text(value.jobId, 1, 256)
        || closed(value, ['method', 'ticket', 'action'], ['params']) && text(value.action, 1, 269) && optional(value.params, params)
      );
      break;
  }
  if (!valid) invalid();
  return value as BoardOperation;
}

export function decodeBoardSnapshot(value: unknown): BoardSnapshot {
  if (!snapshot(value)) invalid();
  return value as BoardSnapshot;
}

export function decodeBoardResult<M extends BoardMethod>(method: M, value: unknown): BoardResult<M> {
  let valid: boolean;
  switch (method) {
    case 'board.get': case 'board.update': case 'board.widget.grant': valid = snapshot(value); break;
    case 'board.widget.put': valid = snapshot(value, true) && record(value) && name(value.resolvedWidgetName); break;
    case 'board.widget.appView': valid = closed(value, ['viewId', 'expiresAtMs']) && nonempty(value.viewId) && integer(value.expiresAtMs, 0); break;
    case 'board.event': valid = closed(value, ['ok', 'appended']) && value.ok === true && typeof value.appended === 'boolean'; break;
    case 'board.prompt.authorize': valid = closed(value, ['confirmationRequired']) && typeof value.confirmationRequired === 'boolean'; break;
    case 'board.data.read': case 'board.action': valid = json(value); break;
  }
  if (!valid) invalid();
  return value as BoardResult<M>;
}

export function decodeBoardChangedEvent(value: unknown): BoardChangedEvent {
  if (!closed(value, ['identity', 'revision'], ['widget']) || !integer(value.revision, 0) || !optional(value.widget, name)) invalid();
  decodeBoardIdentity(value.identity);
  return value as unknown as BoardChangedEvent;
}

export function decodeBoardCommandEvent(value: unknown): BoardCommandEvent {
  if (!closed(value, ['identity', 'command']) || !command(value.command)) invalid();
  decodeBoardIdentity(value.identity);
  return value as unknown as BoardCommandEvent;
}

export function decodeBoardEvent(value: unknown): BoardEvent {
  if (!closed(value, ['kind', 'event'])) invalid();
  if (value.kind === 'changed') return { kind: 'changed', event: decodeBoardChangedEvent(value.event) };
  if (value.kind === 'command') return { kind: 'command', event: decodeBoardCommandEvent(value.event) };
  return invalid();
}

export function decodeBoardFailure(value: unknown): BoardFailure {
  if (!closed(value, ['code', 'message']) || !oneOf(value.code, BOARD_FAILURE_CODES) || !text(value.message, 1, 256)) invalid();
  return value as unknown as BoardFailure;
}

function op(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.kind) {
    case 'tab_create': return closed(value, ['kind', 'tabId', 'title'], ['chatDock']) && tabId(value.tabId) && title(value.title) && optional(value.chatDock, dock);
    case 'tab_update': return closed(value, ['kind', 'tabId'], ['title', 'chatDock', 'position']) && tabId(value.tabId) && optional(value.title, title) && optional(value.chatDock, dock) && optional(value.position, position);
    case 'tab_delete': return closed(value, ['kind', 'tabId']) && tabId(value.tabId);
    case 'tabs_reorder': return closed(value, ['kind', 'tabIds']) && array(value.tabIds, tabId);
    case 'widget_move': return closed(value, ['kind', 'name'], ['tabId', 'position', 'after']) && name(value.name) && optional(value.tabId, tabId) && optional(value.position, position) && optional(value.after, name);
    case 'widget_resize': return closed(value, ['kind', 'name', 'sizeW', 'sizeH'], ['heightMode']) && name(value.name) && integer(value.sizeW) && integer(value.sizeH) && optional(value.heightMode, heightMode);
    case 'widget_remove': return closed(value, ['kind', 'name']) && name(value.name);
    default: return false;
  }
}

function content(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.kind) {
    case 'html': return closed(value, ['kind', 'html']) && text(value.html, 0, 262144);
    case 'mcp-app': return closed(value, ['kind', 'viewId']) && nonempty(value.viewId);
    case 'canvas-doc': return closed(value, ['kind', 'docId']) && nonempty(value.docId);
    case 'plugin': return closed(value, ['kind', 'pluginKind'], ['props']) && pluginKind(value.pluginKind) && optional(value.props, jsonRecord);
    case 'registered': return closed(value, ['kind', 'contentKind', 'source']) && contentKind(value.contentKind) && text(value.source, 0, 262144);
    default: return false;
  }
}

function placement(value: unknown): boolean {
  return closed(value, [], ['tabId', 'size', 'after']) && optional(value.tabId, tabId)
    && optional(value.size, (size) => oneOf(size, ['sm', 'md', 'lg', 'xl', 'full'])) && optional(value.after, name);
}

function declared(value: unknown): boolean {
  return closed(value, [], ['netOrigins', 'tools'])
    && optional(value.netOrigins, (origins) => array(origins, (origin) => text(origin, 1, 2048), 32))
    && optional(value.tools, (tools) => array(tools, (tool) => text(tool, 1, 269), 64));
}

function generatedIdentity(value: unknown): boolean {
  return closed(value, ['source', 'key', 'fallbackName']) && value.source === 'show_widget'
    && typeof value.key === 'string' && /^[a-f0-9]{64}$/.test(value.key) && name(value.fallbackName);
}

function snapshot(value: unknown, put = false): boolean {
  return closed(value, ['sessionKey', 'revision', 'tabs', 'widgets', ...(put ? ['resolvedWidgetName'] : [])])
    && nonempty(value.sessionKey) && integer(value.revision, 0) && array(value.tabs, tab) && array(value.widgets, widget);
}

function tab(value: unknown): boolean {
  return closed(value, ['tabId', 'title', 'position', 'chatDock']) && tabId(value.tabId) && title(value.title)
    && position(value.position) && dock(value.chatDock);
}

function widget(value: unknown): boolean {
  return closed(value, ['name', 'tabId', 'contentKind', 'sizeW', 'sizeH', 'position', 'grantState', 'revision'], [
    'title', 'contentOwner', 'registeredContentKind', 'pluginKind', 'props', 'presentation', 'heightMode',
    'instanceId', 'declaredSummary', 'declared', 'frameUrl', 'viewTicket', 'viewTicketTtlMs', 'viewGeneration',
    'sandboxUrl', 'sandboxPort', 'sandboxOrigin', 'kindLabel',
  ]) && name(value.name) && tabId(value.tabId) && optional(value.title, title)
    && oneOf(value.contentKind, ['html', 'mcp-app', 'plugin']) && optional(value.contentOwner, (owner) => oneOf(owner, ['html', 'mcp-app', 'plugin', 'registered']))
    && optional(value.registeredContentKind, contentKind) && optional(value.pluginKind, pluginKind) && optional(value.props, jsonRecord)
    && optional(value.presentation, presentation) && optional(value.heightMode, heightMode)
    && integer(value.sizeW, 1, 12) && integer(value.sizeH, 1, 20) && position(value.position)
    && oneOf(value.grantState, ['none', 'pending', 'granted', 'rejected']) && integer(value.revision, 1)
    && optional(value.instanceId, nonempty) && optional(value.declaredSummary, (summary) => array(summary, (item) => typeof item === 'string'))
    && optional(value.declared, declared) && optional(value.viewTicketTtlMs, (ttl) => integer(ttl, 1))
    && optional(value.viewGeneration, (generation) => typeof generation === 'string' && /^[a-f0-9]{32}$/.test(generation))
    && optional(value.sandboxPort, (port) => integer(port, 1, 65535)) && optional(value.kindLabel, title)
    && ['frameUrl', 'viewTicket', 'sandboxUrl', 'sandboxOrigin'].every((key) => optional(value[key], (item) => typeof item === 'string'));
}

function command(value: unknown): boolean {
  return closed(value, ['kind', 'tabId']) && value.kind === 'focus_tab' && tabId(value.tabId)
    || closed(value, ['kind', 'dock']) && value.kind === 'set_chat_dock' && dock(value.dock);
}

function params(value: unknown): boolean {
  return jsonRecord(value) && Object.keys(value).length <= 64 && Object.keys(value).every((key) => text(key, 1, 80));
}
function jsonRecord(value: unknown): value is BoardParams { return record(value) && Object.values(value).every(json); }
function json(value: unknown): value is BoardJson {
  return value === null || typeof value === 'boolean' || typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(json) || jsonRecord(value);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function closed(value: unknown, required: string[], optionalKeys: string[] = []): value is Record<string, unknown> {
  return record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optionalKeys.includes(key));
}
function optional(value: unknown, check: (value: unknown) => boolean): boolean { return value === undefined || check(value); }
function array(value: unknown, check: (value: unknown) => boolean, max = Infinity): boolean { return Array.isArray(value) && value.length <= max && value.every(check); }
function text(value: unknown, min: number, max = Infinity): value is string {
  if (typeof value !== 'string') return false;
  let length = 0;
  for (const _character of value) if (++length > max) return false;
  return length >= min;
}
function nonempty(value: unknown): value is string { return text(value, 1); }
function integer(value: unknown, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function oneOf(value: unknown, values: readonly string[]): boolean { return typeof value === 'string' && values.includes(value); }
function tabId(value: unknown): boolean { return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value); }
function name(value: unknown): boolean { return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value); }
function pluginKind(value: unknown): boolean { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/.test(value); }
function contentKind(value: unknown): boolean { return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value); }
function title(value: unknown): boolean { return text(value, 1, 80); }
function ticket(value: unknown): boolean { return text(value, 1, 2048); }
function position(value: unknown): boolean { return integer(value, 0); }
function dock(value: unknown): boolean { return oneOf(value, ['left', 'right', 'bottom', 'hidden']); }
function presentation(value: unknown): boolean { return oneOf(value, ['card', 'full-bleed', 'frameless']); }
function heightMode(value: unknown): boolean { return oneOf(value, ['auto', 'fixed']); }
function invalid(): never { throw new Error('Board payload is invalid'); }
