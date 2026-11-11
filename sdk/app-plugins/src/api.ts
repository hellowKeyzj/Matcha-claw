import type { AppPluginManifest } from './manifest.js';
import type { SessionIdentity } from './identity.js';
import type { AppExecutionApi } from './execution.js';
import { isAppDocumentResourcesRequest, type AppDocumentResourcesApi, type AppDocumentResourcesRequest } from './document-resources.js';
import type { AppCapabilitiesApi, AppCredentialsApi, AppDesktopApi, AppKnowledgeApi, AppRenderingApi, AppWorkspaceApi } from './services.js';
export * from './execution.js';
export * from './services.js';

export type AppJson = null | boolean | number | string | AppJson[] | { [key: string]: AppJson };

export interface AppToolResult {
  readonly content: readonly Record<string, unknown>[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface AppToolContext {
  readonly signal: AbortSignal;
  reportProgress(progress: number, total?: number, message?: string): void;
}

export type AppToolHandler = (
  arguments_: Readonly<Record<string, unknown>>,
  context: AppToolContext,
) => Promise<AppToolResult>;

export interface AppModelRequest {
  readonly kind: 'image' | 'video';
  readonly prompt: string;
  readonly selectionId?: string;
  readonly images?: readonly { data: string; mimeType: string }[];
  readonly mask?: { data: string; mimeType: string };
  readonly size?: string;
  readonly durationSeconds?: number;
  readonly count?: number;
}

export interface AppModelResult {
  readonly outputs: readonly { data: string; mimeType: string }[];
}

export interface AppSpeechModelRequest {
  readonly prompt: string;
  readonly selectionId?: string;
  readonly voice?: string;
  readonly language?: string;
}

export interface AppTranscriptionModelRequest {
  readonly audio: { readonly data: string; readonly mimeType: string };
  readonly selectionId?: string;
  readonly language?: string;
}

export interface AppMusicModelRequest {
  readonly prompt: string;
  readonly selectionId?: string;
  readonly durationSeconds?: number;
}

export interface AppMediaModelListRequest {
  readonly kind: 'image' | 'video';
}

export interface AppPixelSizeLimits {
  readonly step: number;
  readonly maxEdge: number;
  readonly minPixels: number;
  readonly maxPixels: number;
  readonly maxAspectRatio: number;
  readonly experimentalAbovePixels: number;
}

export function isAppPixelSizeSupported(size: string, limits: AppPixelSizeLimits): boolean {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(size);
  if (!match || match[0] !== size) return false;
  const width = Number(match[1]), height = Number(match[2]);
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width <= limits.maxEdge && height <= limits.maxEdge
    && width % limits.step === 0 && height % limits.step === 0
    && width * height >= limits.minPixels && width * height <= limits.maxPixels
    && Math.max(width, height) <= Math.min(width, height) * limits.maxAspectRatio;
}

export interface AppMediaModel {
  readonly selectionId: string;
  readonly name: string;
  readonly capabilities: {
    readonly maxImages: number;
    readonly maxCount: number;
    readonly mask: boolean;
    readonly pixelSize: boolean;
    readonly pixelSizeLimits?: AppPixelSizeLimits;
    readonly sizes?: readonly string[];
    readonly durationsSeconds?: readonly number[];
    readonly storyboard: false;
  };
}

export interface AppMediaModelList {
  readonly models: readonly AppMediaModel[];
  readonly defaultSelectionId?: string;
}

export interface AppVideoTask {
  readonly kind: 'openai-video' | 'google-video' | 'openrouter-video' | 'dashscope-video' | 'ark-video';
  readonly selectionId: string;
  readonly accountId: string;
  readonly modelId: string;
  readonly endpointId: string;
  readonly remoteId: string;
}

export function isAppVideoTask(value: unknown): value is AppVideoTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  const fields = ['kind', 'selectionId', 'accountId', 'modelId', 'endpointId', 'remoteId'];
  if (Object.keys(task).length !== fields.length || !fields.every((field) => Object.hasOwn(task, field))
    || typeof task.kind !== 'string' || !['openai-video', 'google-video', 'openrouter-video', 'dashscope-video', 'ark-video'].includes(task.kind)
    || typeof task.selectionId !== 'string' || task.selectionId.length !== 'model-selection:v1:'.length + 64 || !/^model-selection:v1:[0-9a-f]{64}$/.test(task.selectionId)
    || typeof task.accountId !== 'string' || !task.accountId.length || task.accountId.length > 128 || new TextEncoder().encode(task.accountId).length > 128
    || typeof task.modelId !== 'string' || !task.modelId.length || task.modelId.length > 512 || new TextEncoder().encode(task.modelId).length > 512
    || typeof task.endpointId !== 'string' || task.endpointId.length !== 'media-endpoint:v1:'.length + 64 || !/^media-endpoint:v1:[0-9a-f]{64}$/.test(task.endpointId)
    || typeof task.remoteId !== 'string') return false;
  if (task.kind === 'google-video' && !task.remoteId.startsWith('interactions/')) return false;
  const remoteId = task.kind === 'google-video' ? task.remoteId.slice('interactions/'.length) : task.remoteId;
  return remoteId.length > 0 && remoteId.length <= (task.kind === 'google-video' ? 2048 : 256) && !/[^A-Za-z0-9_-]/.test(remoteId);
}

export interface AppVideoTaskRequest {
  readonly task: AppVideoTask;
}

export interface AppVideoTaskResult {
  readonly task: AppVideoTask;
  readonly status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'unknown';
  readonly progress?: number;
}

export interface AppTextModelRequest {
  readonly prompt: string;
  readonly selectionId?: string;
  readonly images?: readonly { data: string; mimeType: string }[];
}

export interface AppTextModelResult {
  readonly text: string;
}

export class AppConfirmationUnavailableError extends Error {
  readonly code = 'approval_unavailable';
}

export interface AppConfirmationRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly details: readonly { readonly label: string; readonly value: string }[];
}

export function isAppConfirmationRequest(value: unknown): value is AppConfirmationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const text = (input: unknown, maximum: number) => typeof input === 'string' && input.trim().length > 0 && input.length <= maximum;
  return Object.keys(request).length === 4 && Object.keys(request).every((key) => ['title', 'description', 'confirmLabel', 'details'].includes(key))
    && text(request.title, 200) && text(request.description, 4000) && text(request.confirmLabel, 80)
    && Array.isArray(request.details) && request.details.length <= 32 && request.details.every((detail: unknown) => {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
      const item = detail as Record<string, unknown>;
      return Object.keys(item).length === 2 && Object.keys(item).every((key) => key === 'label' || key === 'value')
        && text(item.label, 200) && text(item.value, 24_000);
    }) && new TextEncoder().encode(JSON.stringify(request)).byteLength <= 64 * 1024;
}

export interface AppPluginContext {
  readonly pluginId: string;
  readonly version: string;
  readonly storagePath: string;
  readonly packagePath: string;
  registerTool(name: string, handler: AppToolHandler): () => void;
  /** Host-owned human decision for this active tool call only. Recheck business revisions after confirmation. Throws when no foreground owner is available. */
  requestConfirmation(request: AppConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  publish(topic: string, data: AppJson): void;
  readonly execution: AppExecutionApi;
  readonly desktop: AppDesktopApi;
  readonly rendering: AppRenderingApi;
  readonly workspace: AppWorkspaceApi;
  readonly knowledge: AppKnowledgeApi;
  readonly credentials: AppCredentialsApi;
  readonly capabilities: AppCapabilitiesApi;
  readonly models: {
    list(request: AppMediaModelListRequest, signal?: AbortSignal): Promise<AppMediaModelList>;
    generate(request: AppModelRequest, signal?: AbortSignal): Promise<AppModelResult>;
    submitVideo(request: AppModelRequest & { readonly kind: 'video' }, signal?: AbortSignal): Promise<AppVideoTaskResult>;
    queryVideo(request: AppVideoTaskRequest, signal?: AbortSignal): Promise<AppVideoTaskResult>;
    collectVideo(request: AppVideoTaskRequest, signal?: AbortSignal): Promise<AppModelResult>;
    generateText(request: AppTextModelRequest, signal?: AbortSignal): Promise<AppTextModelResult>;
    generateSpeech(request: AppSpeechModelRequest, signal?: AbortSignal): Promise<AppModelResult>;
    transcribe(request: AppTranscriptionModelRequest, signal?: AbortSignal): Promise<AppModelResult>;
    generateMusic(request: AppMusicModelRequest, signal?: AbortSignal): Promise<AppModelResult>;
  };
  readonly log: {
    info(message: string): void;
    error(message: string): void;
  };
}

export interface AppPluginModule {
  activate(context: AppPluginContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface AppPluginCall {
  readonly id: string;
  readonly digest: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface AppRuntimeEvent {
  readonly pluginId: string;
  readonly digest: string;
  readonly topic: string;
  readonly data: AppJson;
}

export interface AppWebviewContext {
  readonly sessionIdentity?: SessionIdentity;
  /** Opaque workspace draft incarnation, retained only when that draft creates its session. Not an authorization grant. */
  readonly workspaceDraftId?: string;
  readonly language?: string;
  readonly theme?: 'light' | 'dark';
  readonly presentation?: { readonly id: string; readonly data?: AppJson };
  readonly data?: AppJson;
}

export interface AppComposeSource {
  readonly pluginId: string;
  readonly digest: string;
}

export interface AppComposeAttachmentRemovalRequest {
  readonly context: { readonly name: string; readonly text: string };
  readonly attachmentIndex: number;
  readonly remainingAttachmentIndices: readonly number[];
}

export interface AppComposeAttachmentRemovalResult {
  readonly context: { readonly name: string; readonly text: string; readonly attachmentIndices: readonly number[] } | null;
}

export interface AppComposeRequest {
  readonly text: string;
  readonly textMode?: 'append' | 'replace';
  readonly context?: {
    readonly name: string;
    readonly text: string;
    readonly attachmentIndices?: readonly number[];
    /** Stable within this plugin; replaces the entire owned compose group. */
    readonly groupKey?: string;
    /** Declared local pure tool; without one, removing an owned attachment removes the group. */
    readonly attachmentRemoval?: { readonly tool: string };
  };
  readonly attachments?: readonly {
    readonly name: string;
    readonly mimeType: string;
    readonly data: string;
  }[];
}

export function validateAppComposeRequest(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'common:appFrame.invalidCompose';
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !['text', 'textMode', 'attachments', 'context'].includes(key))) return 'common:appFrame.unsupportedComposeField';
  if (request.textMode !== undefined && request.textMode !== 'append' && request.textMode !== 'replace') return 'common:appFrame.invalidCompose';
  if (request.context !== undefined) {
    if (!request.context || typeof request.context !== 'object' || Array.isArray(request.context)) return 'common:appFrame.invalidComposeContext';
    const context = request.context as Record<string, unknown>;
    if (Object.keys(context).some((key) => !['name', 'text', 'attachmentIndices', 'groupKey', 'attachmentRemoval'].includes(key)) || typeof context.name !== 'string' || !context.name.trim() || context.name.length > 120
      || typeof context.text !== 'string' || !context.text.trim() || new TextEncoder().encode(context.text).byteLength > 32 * 1024) return 'common:appFrame.invalidComposeContext';
    if (context.groupKey !== undefined && (typeof context.groupKey !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(context.groupKey))) return 'common:appFrame.invalidComposeContext';
    if (context.attachmentRemoval !== undefined) {
      const removal = context.attachmentRemoval;
      if (!context.groupKey || !removal || typeof removal !== 'object' || Array.isArray(removal)
        || Object.keys(removal).some((key) => key !== 'tool') || typeof (removal as Record<string, unknown>).tool !== 'string'
        || !/^[a-zA-Z0-9_-]{1,128}$/.test((removal as { tool: string }).tool)) return 'common:appFrame.invalidComposeContext';
    }
    if (context.groupKey && (Array.isArray(request.attachments) && request.attachments.length > 0)
      && (!Array.isArray(context.attachmentIndices) || context.attachmentIndices.length !== request.attachments.length)) return 'common:appFrame.invalidComposeContext';
    if (context.attachmentIndices !== undefined) {
      const indices = context.attachmentIndices;
      if (!Array.isArray(indices) || !Array.isArray(request.attachments) || indices.length > request.attachments.length
        || new Set(indices).size !== indices.length || indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= (request.attachments as unknown[]).length)) return 'common:appFrame.invalidComposeContext';
    }
  }
  if (typeof request.text !== 'string' || (!request.text.trim() && !(request.context as { groupKey?: string } | undefined)?.groupKey)
    || new TextEncoder().encode(request.text).byteLength > 32 * 1024) return 'common:appFrame.composeTextLimit';
  if (request.attachments === undefined) return null;
  if (!Array.isArray(request.attachments) || request.attachments.length > 16) return 'common:appFrame.attachmentCountLimit';
  let total = 0;
  for (const value of request.attachments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'common:appFrame.invalidAttachment';
    const attachment = value as Record<string, unknown>;
    if (Object.keys(attachment).some((key) => !['name', 'mimeType', 'data'].includes(key))
      || typeof attachment.name !== 'string' || !attachment.name.trim() || attachment.name.length > 200 || /[\\/]/.test(attachment.name) || Array.from(attachment.name).some((character) => character.charCodeAt(0) < 32)
      || typeof attachment.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(attachment.mimeType)) return 'common:appFrame.invalidAttachmentMetadata';
    if (typeof attachment.data !== 'string' || !attachment.data.length || attachment.data.length > Math.ceil(5 * 1024 * 1024 / 3) * 4
      || attachment.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) return 'common:appFrame.invalidAttachmentData';
    const bytes = attachment.data.length / 4 * 3 - (attachment.data.endsWith('==') ? 2 : attachment.data.endsWith('=') ? 1 : 0);
    if (bytes > 5 * 1024 * 1024) return 'common:appFrame.attachmentSizeLimit';
    total += bytes;
    if (total > 20 * 1024 * 1024) return 'common:appFrame.attachmentTotalLimit';
  }
  return null;
}

export function validateAppWorkspaceFileRequest(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'common:appFrame.invalidWorkspaceFile';
  const request = value as Record<string, unknown>;
  const path = request.relativePath;
  if (Object.keys(request).some((key) => key !== 'relativePath' && key !== 'data')
    || typeof path !== 'string' || !path.length || path.length > 4096 || path.includes('\0')
    || path.startsWith('/') || path.startsWith('\\') || path.includes(':')
    || path.split(/[\\/]/).some((component) => !component || component === '.' || component === '..')
    || typeof request.data !== 'string' || request.data.length > 4 * Math.ceil(50 * 1024 * 1024 / 3)
    || request.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.data)) return 'common:appFrame.invalidWorkspaceFile';
  const bytes = request.data.length / 4 * 3 - (request.data.endsWith('==') ? 2 : request.data.endsWith('=') ? 1 : 0);
  return bytes <= 50 * 1024 * 1024 ? null : 'common:appFrame.invalidWorkspaceFile';
}

export interface AppSessionMediaItem {
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly readable?: boolean;
}

export interface AppSessionMediaListRequest {
  readonly cursor?: string;
}

export interface AppSessionMediaList {
  readonly scope: 'loaded-window' | 'session-images';
  readonly items: readonly AppSessionMediaItem[];
  readonly nextCursor?: string;
  readonly historyImages?: 'supported' | 'unsupported';
  readonly omittedOversized?: boolean;
}

export interface AppSessionMediaData {
  readonly data: string;
  readonly mimeType: string;
  readonly name: string;
}

export type AppRenderDocumentRead = (input: AppJson, signal?: AbortSignal) => Promise<AppJson>;
export interface AppRenderDocumentRequest {
  readonly entry: string;
  readonly html?: string;
  readonly document?: AppDocumentResourcesRequest;
  readonly payload?: AppJson;
}
export interface AppRenderDocumentResult { readonly data: string; readonly mimeType: string }
export function isAppRenderDocumentRequest(value: unknown): value is AppRenderDocumentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['entry', 'html', 'document', 'payload'].includes(key)) || input.html !== undefined && typeof input.html !== 'string'
    || input.document !== undefined && (input.html !== undefined || !isAppDocumentResourcesRequest(input.document))
    || typeof input.entry !== 'string' || input.entry.length > 1024 || !/\.(?:m?js)$/.test(input.entry)
    || /[\\:%?#\0]/.test(input.entry) || input.entry.split('/').some(part => !part || part === '.' || part === '..')) return false;
  const json = (item: unknown): boolean => item === null || typeof item === 'string' || typeof item === 'boolean'
    || typeof item === 'number' && Number.isFinite(item) || Array.isArray(item) && item.every(json)
    || !!item && typeof item === 'object' && Object.values(item).every(json);
  return input.payload === undefined || json(input.payload);
}

export interface AppScreenSourcesResult {
  readonly status: 'ok' | 'denied';
  readonly sources: readonly { readonly id: string; readonly name: string; readonly kind: 'screen' | 'window'; readonly thumbnail: string }[];
}
export interface AppScreenCaptureRequest { readonly id: string }
export interface AppScreenCaptureResult { readonly mediaType: 'image/png'; readonly base64: string; readonly width: number; readonly height: number }

export interface AppClipboardContent {
  readonly text?: string;
  readonly html?: string;
  readonly image?: { readonly data: string; readonly mimeType: 'image/png' };
  readonly metadata?: Readonly<Partial<Record<'io.genoffice.slides.slide' | 'io.genoffice.slides.elements', string>>>;
}
export interface AppClipboardWriteRequest extends AppClipboardContent {
  readonly expected?: { readonly format: 'io.genoffice.slides.elements'; readonly value: string };
}
/** Shape and byte limits; the native owner additionally validates PNG chunks and pixels. */
export function isAppClipboardWriteRequest(value: unknown): value is AppClipboardWriteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const bytes = (item: string) => new TextEncoder().encode(item).byteLength;
  if (Object.keys(input).some(key => !['text', 'html', 'image', 'metadata', 'expected'].includes(key))
    || !['text', 'html', 'image', 'metadata'].some(key => input[key] !== undefined)
    || input.text !== undefined && (typeof input.text !== 'string' || bytes(input.text) > 2 * 1024 * 1024)
    || input.html !== undefined && (typeof input.html !== 'string' || bytes(input.html) > 32 * 1024 * 1024)) return false;
  if (input.image !== undefined) {
    const image = input.image;
    if (!record(image) || Object.keys(image).some(key => key !== 'data' && key !== 'mimeType') || image.mimeType !== 'image/png'
      || typeof image.data !== 'string' || !image.data.length || image.data.length > 4 * Math.ceil(20 * 1024 * 1024 / 3)
      || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return false;
    const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
    if (image.data.length / 4 * 3 - padding > 20 * 1024 * 1024) return false;
  }
  if (input.metadata !== undefined && (!record(input.metadata) || !Object.keys(input.metadata).length
    || Object.keys(input.metadata).some(key => !['io.genoffice.slides.slide', 'io.genoffice.slides.elements'].includes(key))
    || input.metadata['io.genoffice.slides.slide'] !== undefined && (typeof input.metadata['io.genoffice.slides.slide'] !== 'string'
      || !input.metadata['io.genoffice.slides.slide'].length || bytes(input.metadata['io.genoffice.slides.slide']) > 256)
    || input.metadata['io.genoffice.slides.elements'] !== undefined && (typeof input.metadata['io.genoffice.slides.elements'] !== 'string'
      || !input.metadata['io.genoffice.slides.elements'].length || bytes(input.metadata['io.genoffice.slides.elements']) > 256))) return false;
  if (input.expected !== undefined && (!record(input.expected) || Object.keys(input.expected).some(key => key !== 'format' && key !== 'value')
    || input.expected.format !== 'io.genoffice.slides.elements' || typeof input.expected.value !== 'string' || !input.expected.value.length || bytes(input.expected.value) > 256)) return false;
  return true;
}

export interface AppSpellcheckContextMenu { readonly seq: number; readonly misspelledWord: string; readonly suggestions: string[] }
export interface AppSpellcheckLanguages { readonly active: string[]; readonly available: string[] }
export interface AppSpellcheckWord { readonly misspelled: boolean; readonly suggestions: string[] }
export type AppSpellcheckRequest =
  | { readonly operation: 'armContextMenu' | 'languages' | 'respellKick' }
  | { readonly operation: 'claimContextMenu'; readonly seq: number }
  | { readonly operation: 'addWord' | 'ignoreWord' | 'replace' | 'checkWord'; readonly word: string }
  | { readonly operation: 'setLanguages'; readonly languages: string[] };
export function isAppSpellcheckRequest(value: unknown): value is AppSpellcheckRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (['armContextMenu', 'languages', 'respellKick'].includes(String(input.operation))) return keys.length === 1;
  if (input.operation === 'claimContextMenu') return keys.length === 2 && keys.every(key => key === 'operation' || key === 'seq') && Number.isSafeInteger(input.seq) && Number(input.seq) > 0;
  if (['addWord', 'ignoreWord', 'replace', 'checkWord'].includes(String(input.operation))) return keys.length === 2 && keys.every(key => key === 'operation' || key === 'word') && typeof input.word === 'string' && input.word.length > 0 && input.word.length <= 256 && !input.word.includes('\0');
  return input.operation === 'setLanguages' && keys.length === 2 && keys.every(key => key === 'operation' || key === 'languages') && Array.isArray(input.languages) && input.languages.length <= 128
    && input.languages.every(language => typeof language === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(language));
}
export interface AppSpellcheckApi {
  armContextMenu(): Promise<void>;
  claimContextMenu(seq: number): Promise<void>;
  onContextMenuRequest(listener: (request: AppSpellcheckContextMenu) => void): () => void;
  addWord(word: string): Promise<boolean>;
  ignoreWord(word: string): Promise<boolean>;
  replace(word: string): Promise<void>;
  languages(): Promise<AppSpellcheckLanguages>;
  setLanguages(languages: string[]): Promise<AppSpellcheckLanguages>;
  respellKick(): Promise<void>;
  checkWord(word: string): Promise<AppSpellcheckWord>;
}

export interface AppPresentationDisplay {
  readonly id: number;
  readonly label: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly workArea: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor: number;
  readonly primary: boolean;
  readonly current: boolean;
}
export interface AppPresentationOpenRequest {
  readonly content: { readonly kind: 'application'; readonly applicationId: string } | { readonly kind: 'html'; readonly html: string } | { readonly kind: 'document'; readonly documentResourcesId: string };
  readonly displayId?: number;
  readonly fullscreen?: boolean;
  readonly data?: AppJson;
}
export type AppPresentationEvent = { readonly type: 'message'; readonly topic: string; readonly data: AppJson } | { readonly type: 'closed' };
export interface AppPresentationBootstrap {
  readonly presentationId: string;
  readonly pluginId: string;
  readonly digest: string;
  readonly applicationId: string;
  readonly entry: string;
  readonly title: string;
  readonly manifest: AppPluginManifest;
  readonly context: AppWebviewContext;
  readonly content: { readonly kind: 'application' | 'html'; readonly html: string } | { readonly kind: 'document'; readonly url: string };
}
export interface AppPresentationApi {
  displays(): Promise<readonly AppPresentationDisplay[]>;
  open(request: AppPresentationOpenRequest): Promise<{ readonly presentationId: string; readonly displayId: number }>;
  send(request: { readonly topic: string; readonly data: AppJson }): Promise<void>;
  swap(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: (event: AppPresentationEvent) => void): () => void;
}

export const APP_RENDER_PDF_MAX_BYTES = 8 * 1024 * 1024;

export interface AppRenderPdfRequest {
  readonly html: string;
  readonly options?: {
    /** Custom dimensions and margins are in inches. */
    readonly pageSize?: 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid' | 'Ledger' | { readonly width: number; readonly height: number };
    readonly landscape?: boolean;
    readonly pageRanges?: string;
    readonly margins?: { readonly top?: number; readonly bottom?: number; readonly left?: number; readonly right?: number };
    readonly scale?: number;
    readonly headerTemplate?: string;
    readonly footerTemplate?: string;
    readonly displayHeaderFooter?: boolean;
    readonly preferCSSPageSize?: boolean;
    readonly printBackground?: boolean;
  };
}

export interface AppRenderPdfResult {
  readonly data: string;
  readonly mimeType: 'application/pdf';
}

export type AppRenderPdfErrorCode = 'invalid-request' | 'too-large' | 'busy' | 'unavailable' | 'cancelled' | 'deadline' | 'render-failed';

/** Closed, self-contained input only; serialized into the opaque application's bootstrap. */
export function isAppRenderPdfRequest(value: unknown): value is AppRenderPdfRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'html' && key !== 'options') || typeof input.html !== 'string' || !input.html.trim()) return false;
  if (input.options === undefined) return true;
  if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)) return false;
  const options = input.options as Record<string, unknown>;
  if (Object.keys(options).some((key) => !['pageSize', 'landscape', 'pageRanges', 'margins', 'scale', 'headerTemplate', 'footerTemplate', 'displayHeaderFooter', 'preferCSSPageSize', 'printBackground'].includes(key))) return false;
  for (const key of ['landscape', 'displayHeaderFooter', 'preferCSSPageSize', 'printBackground']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') return false;
  }
  for (const key of ['headerTemplate', 'footerTemplate', 'pageRanges']) {
    if (options[key] !== undefined && typeof options[key] !== 'string') return false;
  }
  if (options.scale !== undefined && (typeof options.scale !== 'number' || !Number.isFinite(options.scale) || options.scale < 0.1 || options.scale > 2)) return false;
  if (options.pageSize !== undefined) {
    if (typeof options.pageSize === 'string') {
      if (!['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid', 'Ledger'].includes(options.pageSize)) return false;
    } else {
      const size = options.pageSize as Record<string, unknown> | null;
      if (!size || typeof size !== 'object' || Array.isArray(size) || Object.keys(size).some((key) => key !== 'width' && key !== 'height')
        || ['width', 'height'].some((key) => typeof size[key] !== 'number' || !Number.isFinite(size[key]) || Number(size[key]) <= 0)) return false;
    }
  }
  if (options.margins !== undefined) {
    const margins = options.margins as Record<string, unknown> | null;
    if (!margins || typeof margins !== 'object' || Array.isArray(margins)
      || Object.entries(margins).some(([key, margin]) => !['top', 'bottom', 'left', 'right'].includes(key) || typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0)) return false;
  }
  return true;
}

export interface AppWebviewApi {
  readonly pluginId: string;
  readonly context: AppWebviewContext;
  readonly documentResources: AppDocumentResourcesApi;
  call(name: string, arguments_?: Readonly<Record<string, unknown>>): Promise<AppToolResult>;
  compose(request: AppComposeRequest): Promise<void>;
  openApplication(request: { readonly applicationId: string; readonly data?: AppJson }): Promise<void>;
  /** Loaded workspace media plus paginated native historical images; coverage is explicit. No drafts. */
  listSessionMedia(request?: AppSessionMediaListRequest): Promise<AppSessionMediaList>;
  readSessionMedia(request: { readonly id: string }): Promise<AppSessionMediaData>;
  writeClipboardImage(request: { readonly data: string; readonly mimeType: 'image/png' }): Promise<void>;
  writeClipboard(request: AppClipboardWriteRequest): Promise<void>;
  readClipboard(): Promise<AppClipboardContent>;
  readonly spellcheck: AppSpellcheckApi;
  readonly presentation: AppPresentationApi;
  captureScreenSources(): Promise<AppScreenSourcesResult>;
  captureScreenSource(request: AppScreenCaptureRequest): Promise<AppScreenCaptureResult | null>;
  requestMicrophoneAccess(): Promise<boolean>;
  getMicrophoneStream(): Promise<MediaStream>;
  getScreenStream(): Promise<MediaStream>;
  /** Self-contained HTML to PDF bytes; no scripts, network, local paths or printing. */
  renderPdf(request: AppRenderPdfRequest): Promise<AppRenderPdfResult>;
  /** Native Agent workspace only; requires a foreground user gesture. */
  saveWorkspaceFile?(request: { readonly relativePath: string; readonly data: string }): Promise<{ readonly name: string; readonly size: number }>;
  /** One UI owner; true only after preparing to close. Aborting the request does not cancel backend work. */
  onCloseRequested?(handler: (signal: AbortSignal) => boolean | Promise<boolean>): () => void;
  subscribe(listener: (event: { topic: string; data: AppJson }) => void): () => void;
}

export function appToolName(pluginId: string, name: string): string {
  return `app__${pluginId.replace(/\./g, '_d').replace(/-/g, '_h')}__${name}`;
}

export function appResourceUri(pluginId: string, applicationId: string): string {
  return `ui://app-plugins/${pluginId}/${applicationId}`;
}

export function appPluginResources(manifest: AppPluginManifest): readonly Record<string, unknown>[] {
  return (manifest.contributes.applications ?? []).map((application) => ({
    uri: appResourceUri(manifest.id, application.id),
    name: application.name,
    mimeType: 'text/html;profile=mcp-app',
  }));
}
