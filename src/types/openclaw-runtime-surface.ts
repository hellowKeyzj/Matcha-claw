import { validateSessionIdentity, type SessionIdentity } from './desktop/runtime-address';

export type OpenClawSurfaceJson = null | boolean | number | string | OpenClawSurfaceJson[] | { [key: string]: OpenClawSurfaceJson };
export type OpenClawSurfaceObject = { [key: string]: OpenClawSurfaceJson };

export const OPENCLAW_MCP_APP_OPERATIONS = [
  'mcp.app.view', 'mcp.app.callTool', 'mcp.app.listTools', 'mcp.app.listResources',
  'mcp.app.listResourceTemplates', 'mcp.app.readResource', 'mcp.app.updateModelContext',
] as const;
export type OpenClawMcpAppOperationId = typeof OPENCLAW_MCP_APP_OPERATIONS[number];

type McpAppBinding = { sessionIdentity: SessionIdentity; viewId: string };
export type OpenClawMcpAppRequest = McpAppBinding & (
  | { operationId: 'mcp.app.view' }
  | { operationId: 'mcp.app.callTool'; toolName: string; arguments?: OpenClawSurfaceObject }
  | { operationId: 'mcp.app.listTools' | 'mcp.app.listResources' | 'mcp.app.listResourceTemplates'; cursor?: string }
  | { operationId: 'mcp.app.readResource'; uri: string }
  | { operationId: 'mcp.app.updateModelContext'; content?: [] | [{ type: 'text'; text: string }] }
);
export interface OpenClawCanvasRequest {
  operationId: 'canvas.document.view';
  sessionIdentity: SessionIdentity;
  docId: string;
}
export interface OpenClawProgressCardRequest {
  operationId: 'progressCard.get';
  sessionIdentity: SessionIdentity;
}
export interface OpenClawProgressCard {
  sessionKey: string;
  revision: number;
  updatedAt: number;
  markdown?: string;
  steps?: { step: string; status: 'pending' | 'in_progress' | 'completed' }[];
}
export interface OpenClawProgressCardResult {
  sessionIdentity: SessionIdentity;
  card: OpenClawProgressCard | null;
}

export interface OpenClawMcpAppSurfaceDescriptor extends McpAppBinding {
  kind: 'mcp-app';
  title?: string;
  expiresAtMs?: number;
  readOnly?: boolean;
}
export interface OpenClawCanvasSurfaceDescriptor {
  kind: 'canvas';
  sessionIdentity: SessionIdentity;
  documentId: string;
  title?: string;
  sandbox?: 'strict' | 'scripts';
}
export type OpenClawRuntimeSurfaceDescriptor = OpenClawMcpAppSurfaceDescriptor | OpenClawCanvasSurfaceDescriptor;

export interface OpenClawSandboxCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
  blockDescendantFrames?: boolean;
}
export interface OpenClawMcpAppViewResult extends McpAppBinding {
  html: string;
  /** Absolute URL bound by the backend to the native independent sandbox listener. */
  sandboxUrl: string;
  csp?: OpenClawSandboxCsp;
  toolInput: OpenClawSurfaceJson;
  toolResult: OpenClawSurfaceJson;
  readOnly: boolean;
  messageSupported: boolean;
  updateModelContextSupported: boolean;
}
export interface OpenClawCanvasViewResult {
  sessionIdentity: SessionIdentity;
  documentId: string;
  html: string;
  sandboxUrl: string;
}
export interface OpenClawMcpAppCallToolResult {
  content: OpenClawSurfaceJson[];
  structuredContent?: OpenClawSurfaceObject;
  isError?: boolean;
  _meta?: OpenClawSurfaceObject;
}
export interface OpenClawMcpAppListToolsResult { tools: OpenClawSurfaceObject[]; nextCursor?: string }
export interface OpenClawMcpAppListResourcesResult { resources: OpenClawSurfaceObject[]; nextCursor?: string }
export interface OpenClawMcpAppListResourceTemplatesResult { resourceTemplates: OpenClawSurfaceObject[]; nextCursor?: string }
export interface OpenClawMcpAppReadResourceResult { contents: OpenClawSurfaceObject[] }
export interface OpenClawMcpAppResults {
  'mcp.app.view': OpenClawMcpAppViewResult;
  'mcp.app.callTool': OpenClawMcpAppCallToolResult;
  'mcp.app.listTools': OpenClawMcpAppListToolsResult;
  'mcp.app.listResources': OpenClawMcpAppListResourcesResult;
  'mcp.app.listResourceTemplates': OpenClawMcpAppListResourceTemplatesResult;
  'mcp.app.readResource': OpenClawMcpAppReadResourceResult;
  'mcp.app.updateModelContext': Record<string, never>;
}

export const OPENCLAW_SURFACE_ERROR_CODES = [
  'MCP_APP_VIEW_EXPIRED', 'SURFACE_INVALID_REQUEST', 'SURFACE_UNAVAILABLE', 'SURFACE_REJECTED',
  'SURFACE_INVALID_RESPONSE', 'SURFACE_CAPACITY_EXHAUSTED', 'SURFACE_OUTCOME_UNKNOWN',
] as const;
export type OpenClawSurfaceErrorCode = typeof OPENCLAW_SURFACE_ERROR_CODES[number];
export interface OpenClawSurfaceError { code: OpenClawSurfaceErrorCode; message: string }

export function isOpenClawSurfaceSessionIdentity(value: unknown): value is SessionIdentity {
  if (validateSessionIdentity(value)) return false;
  const identity = value as SessionIdentity;
  const prefix = `agent:${identity.agentId}:`;
  const suffix = identity.sessionKey.slice(prefix.length);
  return identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw'
    && identity.endpoint.runtimeInstanceId === 'local' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(identity.agentId)
    && text(identity.sessionKey) && identity.sessionKey.startsWith(prefix) && suffix.length > 0
    && !/^agent:/i.test(suffix) && suffix.split(':').every((segment) => segment.length > 0);
}
export function isOpenClawMcpAppOperationId(value: unknown): value is OpenClawMcpAppOperationId {
  return OPENCLAW_MCP_APP_OPERATIONS.some((operation) => operation === value);
}
export function isOpenClawMcpAppRequest(value: unknown): value is OpenClawMcpAppRequest {
  if (!record(value) || !isOpenClawSurfaceSessionIdentity(value.sessionIdentity) || !text(value.viewId, 128)) return false;
  const required = ['operationId', 'sessionIdentity', 'viewId'];
  switch (value.operationId) {
    case 'mcp.app.view': return keys(value, required);
    case 'mcp.app.callTool': return keys(value, [...required, 'toolName'], ['arguments']) && text(value.toolName)
      && (value.arguments === undefined || jsonObject(value.arguments));
    case 'mcp.app.listTools':
    case 'mcp.app.listResources':
    case 'mcp.app.listResourceTemplates': return keys(value, required, ['cursor']) && (value.cursor === undefined || text(value.cursor));
    case 'mcp.app.readResource': return keys(value, [...required, 'uri']) && text(value.uri);
    case 'mcp.app.updateModelContext': return keys(value, required, ['content']) && (value.content === undefined
      || (Array.isArray(value.content) && (value.content.length === 0 || (value.content.length === 1
        && record(value.content[0]) && keys(value.content[0], ['type', 'text']) && value.content[0].type === 'text'
        && typeof value.content[0].text === 'string' && new TextEncoder().encode(value.content[0].text).length <= 16 * 1024))));
    default: return false;
  }
}
export function isOpenClawCanvasRequest(value: unknown): value is OpenClawCanvasRequest {
  return record(value) && keys(value, ['operationId', 'sessionIdentity', 'docId']) && value.operationId === 'canvas.document.view'
    && isOpenClawSurfaceSessionIdentity(value.sessionIdentity) && documentId(value.docId);
}
export function isOpenClawProgressCardRequest(value: unknown): value is OpenClawProgressCardRequest {
  return record(value) && keys(value, ['operationId', 'sessionIdentity']) && value.operationId === 'progressCard.get'
    && isOpenClawProgressCardSessionIdentity(value.sessionIdentity);
}
function isOpenClawProgressCardSessionIdentity(value: unknown): value is SessionIdentity {
  if (isOpenClawSurfaceSessionIdentity(value)) return true;
  if (validateSessionIdentity(value)) return false;
  const identity = value as SessionIdentity;
  return identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw'
    && identity.endpoint.runtimeInstanceId === 'local' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(identity.agentId)
    && (identity.sessionKey === 'global' || identity.sessionKey === 'unknown');
}
export function decodeOpenClawProgressCardResult(value: unknown): OpenClawProgressCardResult | null {
  if (!record(value) || !keys(value, ['sessionIdentity', 'card']) || !isOpenClawProgressCardSessionIdentity(value.sessionIdentity)) return null;
  const card = value.card;
  if (card === null) return value as unknown as OpenClawProgressCardResult;
  const identity = value.sessionIdentity;
  const observerKey = identity.sessionKey === 'global' || identity.sessionKey === 'unknown'
    ? `agent:${identity.agentId}:${identity.sessionKey}` : identity.sessionKey;
  if (!record(card) || !keys(card, ['sessionKey', 'revision', 'updatedAt'], ['markdown', 'steps'])
    || card.sessionKey !== observerKey || !Number.isSafeInteger(card.revision) || (card.revision as number) < 1
    || !Number.isSafeInteger(card.updatedAt)
    || (card.markdown !== undefined && (typeof card.markdown !== 'string' || new TextEncoder().encode(card.markdown).length > 8192))) return null;
  if (card.steps !== undefined && (!Array.isArray(card.steps) || card.steps.length > 50
    || card.steps.some((step) => !record(step) || !keys(step, ['step', 'status']) || typeof step.step !== 'string'
      || !step.step.trim() || new TextEncoder().encode(step.step).length > 512
      || !['pending', 'in_progress', 'completed'].includes(step.status as string))
    || card.steps.filter((step) => step.status === 'in_progress').length > 1)) return null;
  return value as unknown as OpenClawProgressCardResult;
}
export function decodeOpenClawRuntimeSurfaceDescriptor(value: unknown): OpenClawRuntimeSurfaceDescriptor | null {
  if (!record(value) || !isOpenClawSurfaceSessionIdentity(value.sessionIdentity) || (value.title !== undefined && !text(value.title))) return null;
  if (value.kind === 'mcp-app') return keys(value, ['kind', 'sessionIdentity', 'viewId'], ['title', 'expiresAtMs', 'readOnly'])
    && text(value.viewId, 128) && (value.expiresAtMs === undefined || timestamp(value.expiresAtMs))
    && (value.readOnly === undefined || typeof value.readOnly === 'boolean') ? value as unknown as OpenClawMcpAppSurfaceDescriptor : null;
  return value.kind === 'canvas' && keys(value, ['kind', 'sessionIdentity', 'documentId'], ['title', 'sandbox'])
    && documentId(value.documentId) && (value.sandbox === undefined || value.sandbox === 'strict' || value.sandbox === 'scripts')
    ? value as unknown as OpenClawCanvasSurfaceDescriptor : null;
}
export function decodeOpenClawMcpAppViewResult(value: unknown): OpenClawMcpAppViewResult | null {
  return record(value) && keys(value, ['sessionIdentity', 'viewId', 'html', 'sandboxUrl', 'toolInput', 'toolResult', 'readOnly', 'messageSupported', 'updateModelContextSupported'], ['csp'])
    && isOpenClawSurfaceSessionIdentity(value.sessionIdentity) && text(value.viewId, 128)
    && html(value.html) && sandboxUrl(value.sandboxUrl) && json(value.toolInput) && json(value.toolResult)
    && typeof value.readOnly === 'boolean' && typeof value.messageSupported === 'boolean' && typeof value.updateModelContextSupported === 'boolean'
    && value.readOnly === !value.messageSupported && (!value.updateModelContextSupported || value.messageSupported)
    && (value.csp === undefined || sandboxCsp(value.csp)) ? value as unknown as OpenClawMcpAppViewResult : null;
}
export function decodeOpenClawCanvasViewResult(value: unknown): OpenClawCanvasViewResult | null {
  return record(value) && keys(value, ['sessionIdentity', 'documentId', 'html', 'sandboxUrl'])
    && isOpenClawSurfaceSessionIdentity(value.sessionIdentity) && documentId(value.documentId)
    && html(value.html) && sandboxUrl(value.sandboxUrl) ? value as unknown as OpenClawCanvasViewResult : null;
}
export function decodeOpenClawMcpAppResult<T extends OpenClawMcpAppOperationId>(operationId: T, value: unknown): OpenClawMcpAppResults[T] | null {
  if (operationId === 'mcp.app.view') return decodeOpenClawMcpAppViewResult(value) as OpenClawMcpAppResults[T] | null;
  if (!record(value)) return null;
  let valid = false;
  switch (operationId) {
    case 'mcp.app.callTool': valid = keys(value, ['content'], ['structuredContent', 'isError', '_meta'])
      && Array.isArray(value.content) && value.content.every((entry) => json(entry))
      && (value.structuredContent === undefined || jsonObject(value.structuredContent))
      && (value._meta === undefined || jsonObject(value._meta)) && (value.isError === undefined || typeof value.isError === 'boolean'); break;
    case 'mcp.app.listTools': valid = listResult(value, 'tools'); break;
    case 'mcp.app.listResources': valid = listResult(value, 'resources'); break;
    case 'mcp.app.listResourceTemplates': valid = listResult(value, 'resourceTemplates'); break;
    case 'mcp.app.readResource': valid = keys(value, ['contents']) && Array.isArray(value.contents) && value.contents.every((entry) => jsonObject(entry)); break;
    case 'mcp.app.updateModelContext': valid = keys(value, []); break;
  }
  return valid ? value as OpenClawMcpAppResults[T] : null;
}
export function decodeOpenClawSurfaceError(value: unknown): OpenClawSurfaceError | null {
  return record(value) && keys(value, ['code', 'message']) && OPENCLAW_SURFACE_ERROR_CODES.some((code) => code === value.code)
    && text(value.message, 512) ? value as unknown as OpenClawSurfaceError : null;
}
function listResult(value: Record<string, unknown>, field: string): boolean {
  return keys(value, [field], ['nextCursor']) && Array.isArray(value[field]) && value[field].every((entry) => jsonObject(entry))
    && (value.nextCursor === undefined || text(value.nextCursor));
}
function sandboxCsp(value: unknown): boolean {
  return record(value) && keys(value, [], ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains', 'blockDescendantFrames'])
    && Object.entries(value).every(([key, item]) => key === 'blockDescendantFrames' ? typeof item === 'boolean'
      : Array.isArray(item) && item.every((domain) => text(domain, 2048)));
}
function sandboxUrl(value: unknown): boolean {
  if (!text(value, 12 * 1024)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash
      && url.pathname === '/mcp-app-sandbox' && [...url.searchParams.keys()].every((key) => key === 'csp');
  } catch { return false; }
}
function html(value: unknown): boolean { return typeof value === 'string' && new TextEncoder().encode(value).length <= 2 * 1024 * 1024; }
function documentId(value: unknown): value is string { return text(value, 256) && value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value); }
function timestamp(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function text(value: unknown, max = 4096): value is string {
  // eslint-disable-next-line no-control-regex -- Reject C0/C1 controls at the surface boundary.
  return typeof value === 'string' && value.trim() === value && value.length > 0 && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function jsonObject(value: unknown): value is OpenClawSurfaceObject { return record(value) && json(value); }
function json(value: unknown, depth = 0): value is OpenClawSurfaceJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 64) return false;
  if (Array.isArray(value)) return value.every((item) => json(item, depth + 1));
  return record(value) && Object.values(value).every((item) => json(item, depth + 1));
}
