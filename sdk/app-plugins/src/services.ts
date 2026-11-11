import { validateRuntimeEndpointRef } from './identity.js';
import { isAppRenderPdfRequest, isAppRenderDocumentRequest, type AppRenderPdfRequest, type AppRenderPdfResult, type AppRenderDocumentRequest, type AppRenderDocumentResult, type AppRenderDocumentRead } from './api.js';
import type { AppAgentTarget } from './execution.js';

export const APP_SERVICE_MAX_BYTES = 8 * 1024 * 1024;
export const APP_SERVICE_VERSION = '1.6.0';
export const APP_SERVICE_ERROR_CODES = ['invalid-request', 'unavailable', 'outcome-unknown', 'cancelled', 'response-too-large', 'not-found', 'conflict', 'permission-denied', 'storage-unavailable'] as const;
export type AppServiceErrorCode = typeof APP_SERVICE_ERROR_CODES[number];
export class AppServiceError extends Error {
  constructor(readonly code: AppServiceErrorCode, message: string) { super(message); }
}

type Api<I, O extends { [K in keyof I]: unknown }> = {
  readonly [K in keyof I]: (input: I[K], signal?: AbortSignal) => Promise<O[K]>;
};
export interface AppWorkspaceTarget extends AppAgentTarget { readonly relativePath: string }
export interface AppWorkspaceInputs {
  readText: AppWorkspaceTarget & { readonly maxBytes?: number };
  readBinary: AppWorkspaceTarget & { readonly maxBytes?: number };
  stat: AppWorkspaceTarget;
  listDir: AppWorkspaceTarget & { readonly includeHidden?: boolean };
  writeText: AppWorkspaceTarget & { readonly content: string };
  writeBinary: AppWorkspaceTarget & { readonly data: string };
}
export interface AppWorkspaceResults {
  readText: { readonly name: string; readonly content: string; readonly size: number };
  readBinary: { readonly name: string; readonly data: string; readonly size: number };
  stat: { readonly name: string; readonly isDirectory: boolean; readonly size: number; readonly mtimeMs: number };
  listDir: { readonly entries: readonly { readonly relativePath: string; readonly display: string; readonly isDirectory: boolean; readonly size: number }[] };
  writeText: { readonly name: string; readonly size: number };
  writeBinary: { readonly name: string; readonly size: number };
}
export type AppWorkspaceApi = Api<AppWorkspaceInputs, AppWorkspaceResults>;

export interface AppKnowledgeFile {
  readonly relativePath: string;
  readonly mimeType: string;
  readonly contentBase64: string;
}
export type AppKnowledgeProcessingState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unsupported' | 'unknown';
export interface AppKnowledgeArchive {
  readonly archiveId: string;
  readonly projectId: string;
  readonly requestKey: string;
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly callId: string;
  readonly accepted: true;
  readonly saveState: 'saved';
  readonly files: readonly {
    readonly relativePath: string;
    readonly mimeType: string;
    readonly byteLength: number;
    readonly sourcePath: string;
    readonly taskId: string | null;
    readonly parseState: AppKnowledgeProcessingState;
    /** Source/page index state; this does not certify vector embedding success. */
    readonly indexState: AppKnowledgeProcessingState;
  }[];
}
export interface AppKnowledgeHit {
  readonly relativePath: string;
  readonly title: string;
  readonly score: number;
  readonly snippets: readonly string[];
  readonly content: string | null;
}
export interface AppKnowledgeInputs {
  list: Record<string, never>;
  listDir: { readonly projectId: string; readonly relativePath: string };
  read: { readonly projectId: string; readonly relativePath: string };
  search: { readonly projectId: string; readonly query: string; readonly limit?: number };
  retrieveContext: { readonly projectId: string; readonly query: string; readonly limit?: number };
  archive: {
    readonly projectId: string;
    readonly requestKey: string;
    readonly title: string;
    readonly sourceUrl?: string;
    readonly mainFile: AppKnowledgeFile;
    readonly attachments?: readonly AppKnowledgeFile[];
  };
  archiveStatus: { readonly projectId: string; readonly requestKey: string };
}
export interface AppKnowledgeResults {
  list: { readonly projects: readonly { readonly projectId: string; readonly title: string; readonly isCurrent: boolean }[] };
  listDir: { readonly projectId: string; readonly relativePath: string; readonly entries: readonly { readonly relativePath: string; readonly isDirectory: boolean; readonly size: number; readonly modifiedAtMs: number }[] };
  read: { readonly projectId: string; readonly relativePath: string; readonly content: string; readonly revision: { readonly id: string; readonly size: number; readonly modifiedAtMs: number } };
  search: { readonly projectId: string; readonly query: string; readonly hits: readonly AppKnowledgeHit[] };
  retrieveContext: AppKnowledgeResults['search'];
  archive: AppKnowledgeArchive;
  archiveStatus: AppKnowledgeArchive;
}
export type AppKnowledgeApi = Api<AppKnowledgeInputs, AppKnowledgeResults>;

export type AppCredentialsAvailability = { readonly available: true } | { readonly available: false; readonly reason: 'encryption-unavailable' | 'insecure-backend' | 'storage-unavailable' };
export interface AppCredentialsInputs {
  availability: Record<string, never>;
  get: { readonly key: string };
  set: { readonly key: string; readonly value: string };
  delete: { readonly key: string };
}
export interface AppCredentialsResults {
  availability: AppCredentialsAvailability;
  get: { readonly value: string | null };
  set: { readonly stored: true };
  delete: { readonly deleted: true };
}
export type AppCredentialsApi = Api<AppCredentialsInputs, AppCredentialsResults>;

export interface AppCapabilitiesInputs { describe: { readonly target?: AppAgentTarget } }
export interface AppCapabilitiesResults {
  describe: {
    readonly sdkVersion: string;
    /** Availability is an observation, never an authorization grant or an outcome guarantee. */
    readonly operations: readonly {
      readonly id: string;
      readonly status: 'available' | 'unavailable' | 'request-dependent';
      readonly reason?: string;
      readonly limits: Readonly<Record<string, number>>;
    }[];
  };
}
export type AppCapabilitiesApi = Api<AppCapabilitiesInputs, AppCapabilitiesResults>;

export interface AppRenderingInputs { renderPdf: AppRenderPdfRequest; renderDocument: AppRenderDocumentRequest }
export interface AppRenderingResults { renderPdf: AppRenderPdfResult; renderDocument: AppRenderDocumentResult }
export interface AppRenderingApi {
  renderPdf(input: AppRenderPdfRequest, signal?: AbortSignal): Promise<AppRenderPdfResult>;
  renderDocument(input: AppRenderDocumentRequest, signal?: AbortSignal, read?: AppRenderDocumentRead): Promise<AppRenderDocumentResult>;
}

export interface AppDesktopInputs {
  systemLocale: Record<string, never>;
  openExternal: { readonly url: string };
  revealFile: { readonly path: string };
  pickFile: { readonly extensions: readonly string[] };
}
export interface AppDesktopResults {
  systemLocale: { readonly locale: string };
  openExternal: { readonly opened: true };
  revealFile: { readonly revealed: true };
  pickFile: { readonly path: string | null };
}
/** Trusted background only; local paths must not be forwarded to opaque UI or model output. */
export type AppDesktopApi = Api<AppDesktopInputs, AppDesktopResults>;

export interface AppServiceInputs {
  desktop: AppDesktopInputs;
  rendering: AppRenderingInputs;
  workspace: AppWorkspaceInputs;
  knowledge: AppKnowledgeInputs;
  credentials: AppCredentialsInputs;
  capabilities: AppCapabilitiesInputs;
}
export interface AppServiceResults {
  desktop: AppDesktopResults;
  rendering: AppRenderingResults;
  workspace: AppWorkspaceResults;
  knowledge: AppKnowledgeResults;
  credentials: AppCredentialsResults;
  capabilities: AppCapabilitiesResults;
}
export const APP_SERVICE_OPERATIONS = {
  desktop: ['openExternal', 'revealFile', 'pickFile', 'systemLocale'],
  rendering: ['renderPdf', 'renderDocument'],
  workspace: ['readText', 'readBinary', 'stat', 'listDir', 'writeText', 'writeBinary'],
  knowledge: ['list', 'listDir', 'read', 'search', 'retrieveContext', 'archive', 'archiveStatus'],
  credentials: ['availability', 'get', 'set', 'delete'],
  capabilities: ['describe'],
} as const satisfies { [K in keyof AppServiceInputs]: readonly (keyof AppServiceInputs[K])[] };
export type AppServiceRequest = {
  [S in keyof AppServiceInputs]: {
    [K in keyof AppServiceInputs[S]]: { readonly service: S; readonly operation: K; readonly input: AppServiceInputs[S][K] }
  }[keyof AppServiceInputs[S]]
}[keyof AppServiceInputs];
export type AppServiceResult = { [S in keyof AppServiceResults]: AppServiceResults[S][keyof AppServiceResults[S]] }[keyof AppServiceResults];

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function text(value: unknown, maximum = 4096): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0'); }
function integer(value: unknown, maximum: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function target(value: unknown): boolean { return record(value) && fields(value, ['endpoint', 'agentId']) && validateRuntimeEndpointRef(value.endpoint) === null && text(value.agentId); }
function path(value: unknown, root = false): value is string {
  return typeof value === 'string' && value.length <= 4096 && (root && value === '' || value.length > 0 && !/[\\:\0]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
}
function base64(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - padding > maximum) return false;
  if (!padding) return true;
  const terminal = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(value[value.length - padding - 1]!);
  return terminal >= 0 && terminal % (padding === 1 ? 4 : 16) === 0;
}
function file(value: unknown): boolean {
  return record(value) && fields(value, ['relativePath', 'mimeType', 'contentBase64']) && path(value.relativePath)
    && text(value.mimeType, 200) && base64(value.contentBase64, 6 * 1024 * 1024);
}
export function isAppServiceRequest(value: unknown): value is AppServiceRequest {
  if (!record(value) || !fields(value, ['service', 'operation', 'input']) || !record(value.input)) return false;
  const input = value.input;
  const operation = value.operation;
  switch (value.service) {
    case 'desktop':
      if (operation === 'systemLocale') return fields(input, []);
      if (operation === 'openExternal') {
        if (!fields(input, ['url']) || !text(input.url) || /[\\\s\u0000-\u001f\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(input.url)) return false;
        try {
          const url = new URL(input.url);
          return !url.username && !url.password && (url.protocol === 'mailto:' ? !!url.pathname && !url.host
            : (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname);
        } catch { return false; }
      }
      if (operation === 'revealFile') return fields(input, ['path']) && text(input.path)
        && !/[\u0000-\u001f\u007f]/.test(input.path)
        && (/^\/(?![\\/])/.test(input.path) || /^[A-Za-z]:[\\/][^:]*$/.test(input.path));
      return operation === 'pickFile' && fields(input, ['extensions']) && Array.isArray(input.extensions)
        && input.extensions.length > 0 && input.extensions.length <= 64
        && input.extensions.every(extension => typeof extension === 'string' && /^[A-Za-z0-9]{1,32}$/.test(extension));
    case 'rendering': return operation === 'renderPdf' ? isAppRenderPdfRequest(input) : operation === 'renderDocument' && isAppRenderDocumentRequest(input);
    case 'workspace': {
      const extra = operation === 'writeText' ? ['content'] : operation === 'writeBinary' ? ['data'] : [];
      const optional = operation === 'readText' || operation === 'readBinary' ? ['maxBytes'] : operation === 'listDir' ? ['includeHidden'] : [];
      return (APP_SERVICE_OPERATIONS.workspace as readonly unknown[]).includes(operation)
        && fields(input, ['endpoint', 'agentId', 'relativePath', ...extra], optional)
        && validateRuntimeEndpointRef(input.endpoint) === null && text(input.agentId) && path(input.relativePath, operation === 'listDir')
        && (input.maxBytes === undefined || integer(input.maxBytes, operation === 'readText' ? 2 * 1024 * 1024 : 4 * 1024 * 1024))
        && (input.includeHidden === undefined || typeof input.includeHidden === 'boolean')
        && (operation !== 'writeText' || typeof input.content === 'string' && new TextEncoder().encode(input.content).byteLength <= 2 * 1024 * 1024)
        && (operation !== 'writeBinary' || base64(input.data, 4 * 1024 * 1024));
    }
    case 'knowledge':
      if (operation === 'list') return fields(input, []);
      if (!text(input.projectId)) return false;
      if (operation === 'listDir') return fields(input, ['projectId', 'relativePath']) && path(input.relativePath, true);
      if (operation === 'read') return fields(input, ['projectId', 'relativePath']) && path(input.relativePath);
      if (operation === 'search' || operation === 'retrieveContext') return fields(input, ['projectId', 'query'], ['limit']) && text(input.query, 16_384) && (input.limit === undefined || integer(input.limit, 100));
      if (operation === 'archiveStatus') return fields(input, ['projectId', 'requestKey']) && text(input.requestKey, 128);
      return operation === 'archive' && fields(input, ['projectId', 'requestKey', 'title', 'mainFile'], ['sourceUrl', 'attachments'])
        && text(input.requestKey, 128) && text(input.title, 512) && (input.sourceUrl === undefined || text(input.sourceUrl, 4096))
        && file(input.mainFile) && (input.attachments === undefined || Array.isArray(input.attachments) && input.attachments.length <= 127 && input.attachments.every(file));
    case 'credentials':
      if (operation === 'availability') return fields(input, []);
      return typeof input.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.key)
        && (operation === 'get' || operation === 'delete' ? fields(input, ['key'])
          : operation === 'set' && fields(input, ['key', 'value']) && typeof input.value === 'string' && new TextEncoder().encode(input.value).byteLength <= 64 * 1024);
    case 'capabilities': return operation === 'describe' && fields(input, [], ['target']) && (input.target === undefined || target(input.target));
    default: return false;
  }
}
