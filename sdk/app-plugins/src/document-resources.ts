import { MAX_APP_PLUGIN_FILES } from './limits.js';

export interface AppDocumentResource {
  readonly path: string;
  readonly data: string;
  readonly mimeType: string;
}

export interface AppDocumentResourcesRequest {
  readonly entry: AppDocumentResource;
  readonly resources: readonly AppDocumentResource[];
}

export function isAppDocumentResourcesRequest(value: unknown): value is AppDocumentResourcesRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'entry') || !Array.isArray(input.resources) || input.resources.length >= MAX_APP_PLUGIN_FILES) return false;
  const paths = new Set<string>();
  let bytes = 0;
  for (const [index, item] of [input.entry, ...input.resources].entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const file = item as Record<string, unknown>;
    if (Object.keys(file).length !== 3 || !Object.keys(file).every(key => ['path', 'data', 'mimeType'].includes(key))
      || typeof file.path !== 'string' || !file.path || file.path.length > 4096 || /[\\:]/.test(file.path)
      || [...file.path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || file.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(file.path)
      || typeof file.mimeType !== 'string' || file.mimeType.length > 200 || index === 0 && file.mimeType !== 'text/html'
      || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/.test(file.mimeType)
      || typeof file.data !== 'string' || file.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) return false;
    const padding = file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0;
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(file.data[file.data.length - padding - 1]!);
    if (padding && (last < 0 || last % (padding === 1 ? 4 : 16))) return false;
    bytes += file.data.length / 4 * 3 - padding;
    if (bytes > 8 * 1024 * 1024) return false;
    paths.add(file.path);
  }
  return true;
}

export interface AppDocumentResourcesApi {
  create(request: AppDocumentResourcesRequest): Promise<AppDocumentResourcesResult>;
  release(request: { readonly id: string }): Promise<void>;
}

export interface AppDocumentResourcesResult {
  readonly id: string;
  readonly url: string;
  readonly rootUrl: string;
}
