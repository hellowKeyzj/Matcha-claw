import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, normalize as nativeNormalize, posix } from 'node:path';
import { writeJsonAtomic } from '../../genoffice/packages/electron-utils/src/atomic-write';
import { normalizeMarkdownTheme } from '../../genoffice/apps/markdown/src/shared/markdown-theme';
import { safeExternalUrl } from '../../genoffice/packages/electron-utils/src/safe-external-url';
import type { DocumentService } from '../documents/service';
import type { DocumentResource } from '../documents/model';
import { readRemoteImage } from './remote-image';

type TextDocumentType = 'md' | 'txt' | 'json';
function documentType(name: string): TextDocumentType {
  if (/\.json$/i.test(name)) return 'json';
  if (/\.txt$/i.test(name)) return 'txt';
  if (/\.(md|markdown)$/i.test(name)) return 'md';
  throw new Error('The editor accepts Markdown, text and JSON documents.');
}
const decodeText = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
import { OfficeError } from '../errors';
import { resolveWikiLinks, splitTarget } from '../../genoffice/apps/markdown/src/main/wiki-resolve';
import { listWikiNotes } from '../../genoffice/apps/markdown/src/main/wiki-notes';
import { parseWikiHeads } from '../../genoffice/apps/markdown/src/main/wiki-heads';
import { wikiBacklinks, wikiGraph, wikiTags, extractWikiTargets, type VaultFs } from '../../genoffice/apps/markdown/src/main/wiki-index';
import { extractMarkdownImageSources } from '../../genoffice/apps/markdown/src/main/asset-lifecycle';
import type { SaveMarkdownRequest } from '../../genoffice/apps/markdown/src/shared/ipc';
import { prepareMarkdownResources, resourcePath } from './resources';
import { validateMarkdownAction } from './actions-schema';

const normalize = (path: string) => path.replaceAll('\\', '/');
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
function decode(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(50 * 1024 * 1024 / 3)) throw new Error('Invalid Markdown file bytes.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid Markdown file encoding.');
  return bytes;
}
const resourceWire = (resources: readonly DocumentResource[]) => resources.map(({ path, bytes, ownedSha256 }) => ({ path, data: encode(bytes), ...(ownedSha256 ? { ownedSha256 } : {}) }));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Editor {
  documentId?: string;
  type?: TextDocumentType;
  path?: string;
  revision?: number;
  readRevision?: number;
  pending: Map<string, Uint8Array>;
  retained: Map<string, DocumentResource>;
}

export function createMarkdownSession(context: AppPluginContext, documents: DocumentService) {
  const settingsPath = join(context.storagePath, 'markdown-settings.json');
  function readSettings(): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Markdown settings.');
      return value as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
  const hooks = documents.editorHooks('md');
  const editors = new Map<string, Editor>();
  const tails = new Map<string, Promise<unknown>>();
  let disposed = false;
  const actions = new Map<string, { editorId: string; documentId: string; resolve(value: unknown): void; reject(error: Error): void }>();
  function rejectActions(editorId: string) {
    for (const [id, request] of actions) if (request.editorId === editorId) { actions.delete(id); request.reject(new Error('The Markdown document editor changed or closed.')); }
  }
  async function action(documentId: string, action: string, input: Record<string, AppJson>, signal?: AbortSignal): Promise<unknown> {
    validateMarkdownAction({ documentId, action, input });
    signal?.throwIfAborted();
    const matches = [...editors].filter(([, editor]) => editor.documentId === documentId && editor.type === 'md');
    if (matches.length !== 1) throw new Error('Exactly one open Markdown editor is required for this document.');
    const editorId = matches[0]![0];
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); actions.delete(requestId); if (error) reject(error); else resolve(value); };
      const abort = () => finish(new Error('Markdown action observation canceled; an applied edit is not rolled back.'));
      const timer = setTimeout(() => finish(new Error('The Markdown editor did not acknowledge the action.')), 30_000);
      actions.set(requestId, { editorId, documentId, resolve: value => finish(undefined, value), reject: error => finish(error) });
      signal?.addEventListener('abort', abort, { once: true });
      try { context.publish('office.markdown.action', { editorId, documentId, requestId, action, input }); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  function editor(id: string): Editor {
    if (disposed) throw new Error('The Markdown session is closed.');
    const value = editors.get(id);
    if (!value) throw new Error('The Markdown editor is not open.');
    return value;
  }

  async function vault(extraResources?: ReadonlyMap<string, DocumentResource>): Promise<VaultFs> {
    const files = new Map<string, { bytes: Uint8Array; revision: number }>();
    for (const record of await hooks.listDocuments()) {
      if (record.type !== 'md' && record.type !== 'txt') continue;
      const loaded = await hooks.readDocument(record.id);
      const identity = `${record.id}:${record.revision}`;
      const revision = Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 13), 16);
      const path = hooks.logicalPath(loaded.record);
      files.set(path, { bytes: loaded.bytes, revision });
      for (const resource of loaded.resources) {
        if (/\.json$/i.test(resource.path)) continue;
        files.set(posix.join(posix.dirname(path), resource.path), { bytes: resource.bytes, revision });
      }
    }
    for (const [path, resource] of extraResources ?? []) files.set(path, { bytes: resource.bytes, revision: 0 });
    return {
      async isFile(path) { return files.has(normalize(path)); },
      async list(directory) {
        const prefix = normalize(directory).replace(/\/$/, '') + '/';
        const names: string[] = [];
        const dirs = new Set<string>();
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          if (rest.includes('/')) dirs.add(rest.split('/')[0]!);
          else names.push(rest);
        }
        return { files: names, dirs: [...dirs] };
      },
      async read(path) {
        const file = files.get(normalize(path));
        if (!file) throw new Error('The library path does not exist.');
        return new TextDecoder().decode(file.bytes);
      },
      async mtimeMs(path) { return files.get(normalize(path))?.revision ?? 0; }
    };
  }

  function exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new Error('The Markdown session is closed.'));
    const run = (tails.get(id) ?? Promise.resolve()).then(operation);
    const tail = run.then(() => {}, () => {});
    tails.set(id, tail);
    void tail.then(() => { if (tails.get(id) === tail) tails.delete(id); });
    return run;
  }

  function open(documentId: string, editorId = 'default') {
    return exclusive(editorId, async () => {
      const { record, bytes, resources } = await hooks.readDocument(documentId);
      if (record.type !== 'md' && record.type !== 'txt' && record.type !== 'json') throw new Error('The library document is not Markdown, text or JSON.');
      const text = decodeText(bytes);
      const path = hooks.logicalPath(record);
      rejectActions(editorId);
      editors.set(editorId, { documentId, type: record.type, path, revision: record.revision, pending: new Map(), retained: new Map() });
      return { documentId, type: record.type, revision: record.revision, path, name: record.name, text, resources: resourceWire(resources) };
    });
  }

  async function prepareContent(state: Editor, text: string, imageSources: readonly string[] = []) {
      const pending = state.pending;
      const previous = state.documentId ? await hooks.readDocument(state.documentId) : null;
      const available = new Map<string, DocumentResource>();
      const documentPath = state.path ?? '/library/Untitled.md';
      if (state.type === 'md' || !state.documentId) {
        for (const resource of previous?.resources ?? []) available.set(resourcePath(resource.path, documentPath), resource);
        for (const [absolute, resource] of state.retained) if (!available.has(absolute)) available.set(absolute, resource);
        for (const [path, bytes] of pending) available.set(resourcePath(path, documentPath), { path, bytes, ownedSha256: sha256(bytes) });
        const fs = await vault(available);
        const wiki = await resolveWikiLinks(extractWikiTargets(text), { fromPath: documentPath, root: '/library' }, fs);
        const wikiPaths = new Map([...wiki].filter(([, answer]) => answer.found).map(([target, answer]) => [target, normalize(answer.path)]));
        const sources = [...extractMarkdownImageSources(text), ...imageSources];
        const referencedPaths = new Set([...sources.map(source => resourcePath(source, documentPath)), ...wikiPaths.values()]);
        const sharedSources: string[] = [];
        const ownedPaths = new Set((previous?.resources ?? []).filter(resource => resource.ownedSha256 === sha256(resource.bytes)).map(resource => resourcePath(resource.path, documentPath)));
        for (const record of await hooks.listDocuments()) {
          if (record.id === state.documentId || record.type !== 'md') continue;
          const path = hooks.logicalPath(record);
          const needsCopy = [...referencedPaths].some(source => source.startsWith(posix.dirname(path) + '/'));
          if (!needsCopy && !ownedPaths.size) continue;
          const loaded = await hooks.readDocument(record.id);
          const body = decodeText(loaded.bytes);
          const links = await resolveWikiLinks(extractWikiTargets(body), { fromPath: path, root: '/library' }, fs);
          const references = [...extractMarkdownImageSources(body).map(source => resourcePath(source, path)),
            ...[...links.values()].filter(answer => answer.found).map(answer => normalize(answer.path))];
          for (const absolute of references) if (ownedPaths.has(absolute)) sharedSources.push(absolute);
          if (!needsCopy) continue;
          for (const resource of loaded.resources) {
            const absolute = resourcePath(resource.path, path);
            if (referencedPaths.has(absolute)) available.set(absolute, resource);
          }
        }
        return prepareMarkdownResources(text, documentPath, available, [...imageSources, ...sharedSources], wikiPaths);
      }
      return prepareMarkdownResources(text, documentPath, available, imageSources);
  }

  async function dispatch(id: string, channel: string, args: unknown[]): Promise<unknown> {
    if (channel === 'office:open-editor') {
      if (!editors.has(id)) editors.set(id, { pending: new Map(), retained: new Map() });
      return null;
    }
    const state = editor(id);
    if (channel === 'office:close-editor') { rejectActions(id); editors.delete(id); return null; }
    if (channel === 'markdown:open-external') {
      const url = safeExternalUrl(args[0], { allowedProtocols: ['http:', 'https:', 'mailto:'] });
      if (!url) throw new Error('Invalid Markdown external link.');
      return context.desktop.openExternal({ url });
    }
    if (channel === 'markdown:get-theme') return normalizeMarkdownTheme(readSettings().markdownTheme);
    if (channel === 'markdown:set-theme') {
      const theme = normalizeMarkdownTheme(args[0]);
      writeJsonAtomic(settingsPath, { ...readSettings(), markdownTheme: theme });
      return theme;
    }
    if (channel === 'markdown:read-remote-image') return readRemoteImage(args[0]);
    if (channel === 'markdown:import') {
      const input = args[0] as { name: string; data: string; resources: { path: string; data: string }[] };
      if (!input || typeof input.name !== 'string' || typeof input.data !== 'string' || !Array.isArray(input.resources)) throw new Error('Invalid Markdown import.');
      const type = documentType(input.name);
      if (input.resources.length > 1000 || (type !== 'md' && input.resources.length)) throw new Error('Invalid text document import files.');
      const bytes = decode(input.data);
      decodeText(bytes);
      let total = bytes.length;
      const resources = input.resources.map((resource) => {
        if (!resource || typeof resource.path !== 'string') throw new Error('Invalid Markdown resource.');
        const bytes = decode(resource.data);
        total += bytes.length;
        if (total > 200 * 1024 * 1024) throw new Error('The Markdown import is too large.');
        return { path: resource.path, bytes };
      });
      const created = await documents.editorHooks(type).createDocument(input.name, async () => type === 'md' ? { bytes, resources } : bytes);
      return created;
    }
    if (channel === 'markdown:ack-file-changed-on-disk') {
      if (state.readRevision !== undefined) state.revision = state.readRevision;
      return null;
    }
    if (channel === 'markdown:save-image') {
      if (!state.documentId || state.type !== 'md') return null;
      const data = args[0] as { base64?: unknown; ext?: unknown };
      if (typeof data?.base64 !== 'string' || !/^(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(String(data.ext))) throw new Error('Invalid image data.');
      const bytes = Buffer.from(data.base64, 'base64');
      if (!bytes.length || bytes.length > 50 * 1024 * 1024 || bytes.toString('base64') !== data.base64) throw new Error('Invalid image bytes.');
      const path = `assets/${crypto.randomUUID()}.${String(data.ext).toLowerCase()}`;
      state.pending.set(path, bytes);
      return { path, data: encode(bytes) };
    }
    if (channel === 'markdown:archive') {
      if (typeof args[0] !== 'string') throw new Error('Markdown source is required.');
      const prepared = await prepareContent(state, args[0]);
      return { text: prepared.text, resources: resourceWire(prepared.resources) };
    }
    if (channel === 'markdown:save') {
      const request = args[0] as SaveMarkdownRequest & { libraryName?: string };
      if (!request || typeof request.text !== 'string' || !['save', 'saveAs'].includes(request.mode)) throw new Error('Invalid Markdown save request.');
      const type = state.documentId && request.mode === 'save' ? state.type! : documentType(request.libraryName ?? '');
      const pending = new Map(state.pending);
      const documentPath = state.path ?? '/library/Untitled.md';
      const previous = state.documentId ? await hooks.readDocument(state.documentId) : null;
      const prepared = type === 'md' ? await prepareContent(state, request.text, request.imageSources) : { text: request.text, resources: [], imageRewrites: [] };
      const content = { bytes: new TextEncoder().encode(prepared.text), resources: prepared.resources };
      try {
        if (state.documentId && request.mode === 'save') {
          // Overwrite is an explicit upstream user decision, never an automatic CAS retry.
          const expected = request.overwrite ? previous!.record.revision : state.revision!;
          state.revision = await hooks.saveDocument(state.documentId, expected, async () => content);
        } else {
          if (!request.libraryName) throw new Error('A document name is required.');
          const created = await documents.editorHooks(type).createDocument(request.libraryName, async () => type === 'md' ? content : content.bytes);
          state.documentId = created.documentId;
          state.type = type;
          state.revision = created.revision;
          state.path = hooks.logicalPath({ id: created.documentId, name: created.name });
          rejectActions(id);
          state.retained = new Map([...state.retained].map(([path, resource]) => [resourcePath(posix.relative(posix.dirname(documentPath), path), state.path!), resource]));
        }
        for (const resource of previous?.resources ?? []) if (resource.ownedSha256 === sha256(resource.bytes)) state.retained.set(resourcePath(resource.path, documentPath), resource);
        for (const [path, bytes] of pending) {
          state.retained.set(resourcePath(path, documentPath), { path, bytes, ownedSha256: sha256(bytes) });
          if (state.pending.get(path) === bytes) state.pending.delete(path);
        }
        return { ok: true, documentId: state.documentId, type, revision: state.revision, path: state.path, writtenText: prepared.text, imageRewrites: prepared.imageRewrites, resources: resourceWire(content.resources) };
      } catch (error) {
        if (error instanceof OfficeError && error.code === 'revision_conflict') return { ok: false, conflict: true, error: error.message };
        throw error;
      }
    }
    if (channel === 'markdown:read-document') {
      const path = normalize(String(args[0]));
      const record = (await hooks.listDocuments()).find((record) => hooks.logicalPath(record) === path);
      if (!record || !['md', 'txt', 'json'].includes(record.type)) throw new Error('The text library document does not exist.');
      const loaded = await hooks.readDocument(record.id);
      if (record.id === state.documentId) {
        state.path = hooks.logicalPath(loaded.record);
        state.readRevision = loaded.record.revision;
      }
      return { text: decodeText(loaded.bytes), resources: resourceWire(loaded.resources) };
    }
    if (channel === 'markdown:resources') {
      const path = normalize(String(args[0] ?? state.path));
      const record = (await hooks.listDocuments()).find((record) => hooks.logicalPath(record) === path);
      if (!record) throw new Error('A library document path is required.');
      return resourceWire((await hooks.readDocument(record.id)).resources);
    }
    if (channel === 'markdown:move') {
      if (!state.documentId || state.revision === undefined) throw new Error('Save the document before moving it.');
      const oldPath = state.path!;
      const record = await hooks.moveDocument(state.documentId, state.revision, String(args[0]));
      state.path = hooks.logicalPath(record);
      state.retained = new Map([...state.retained].map(([path, resource]) => [resourcePath(posix.relative(posix.dirname(oldPath), path), state.path!), resource]));
      state.revision = record.revision;
      return { path: state.path, revision: record.revision };
    }
    if (channel === 'markdown:find-document') {
      const record = (await hooks.listDocuments()).find((record) => hooks.logicalPath(record) === normalize(String(args[0])));
      if (!record) throw new Error('The library document does not exist.');
      return { documentId: record.id };
    }
    const fs = await vault();
    const fromPath = state.path ?? '';
    if (channel === 'markdown:read-file') {
      if (normalize(String(args[0])) === state.path && state.documentId) {
        const loaded = await hooks.readDocument(state.documentId);
        state.readRevision = loaded.record.revision;
        return decodeText(loaded.bytes);
      }
      return fs.read(String(args[0]));
    }
    if (channel === 'markdown:resolve-wiki-links') {
      const request = args[0] as { targets: string[]; fromPath: string };
      if (!Array.isArray(request?.targets) || request.targets.some((target) => typeof target !== 'string')) throw new Error('Invalid wiki targets.');
      const resolved = await resolveWikiLinks(request.targets, { fromPath: request.fromPath, root: '/library' }, fs);
      return Object.fromEntries([...resolved].map(([key, value]) => [key, { ...value, path: normalize(value.path) }]));
    }
    if (channel === 'markdown:list-wiki-notes') return (await listWikiNotes('/library', fs)).map((note) => ({ ...note, path: normalize(note.path), relPath: normalize(note.relPath) }));
    if (channel === 'markdown:wiki-backlinks') return (await wikiBacklinks('/library', nativeNormalize(String(args[0])), fs)).map((link) => ({ ...link, source: normalize(link.source) }));
    if (channel === 'markdown:wiki-tags') return (await wikiTags('/library', fs)).map((tag) => ({ ...tag, files: tag.files.map(normalize) }));
    if (channel === 'markdown:wiki-graph') {
      const graph = await wikiGraph('/library', fs);
      return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, path: normalize(node.path), relPath: normalize(node.relPath) })), edges: graph.edges.map((edge) => ({ from: normalize(edge.from), to: normalize(edge.to) })) };
    }
    if (channel === 'markdown:wiki-heads') {
      const request = args[0] as { target: string; fromPath: string };
      const hit = (await resolveWikiLinks([request.target], { fromPath: request.fromPath, root: '/library' }, fs)).get(request.target);
      return hit?.found ? parseWikiHeads(await fs.read(hit.path)) : [];
    }
    if (channel === 'markdown:create-wiki-note') {
      const { name, fragment } = splitTarget(String((args[0] as { target?: unknown })?.target ?? ''));
      if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split(/[/\\]/).includes('..')) throw new Error('Invalid wiki note target.');
      const segments = name.split(/[/\\]/).filter((part) => part && part !== '.').map((part) => part.replace(/[:*?"<>|]/g, '_').replace(/[. ]+$/, '') || '_');
      const target = segments.join('/');
      const fileName = posix.extname(target) ? posix.basename(target) : `${posix.basename(target)}.md`;
      const type = documentType(fileName);
      const directory = segments.length > 1 ? posix.join('/library', ...segments.slice(0, -1)) : fromPath ? posix.dirname(fromPath) : '/library';
      const libraryPath = posix.relative('/library', posix.join(directory, fileName));
      try {
        const created = await documents.editorHooks(type).createDocument(fileName, async () => new Uint8Array(), undefined, libraryPath);
        return { ok: true, path: hooks.logicalPath({ id: created.documentId, name: created.name, libraryPath }), target, fragment, created: true };
      } catch (error) {
        if (!(error instanceof OfficeError) || error.code !== 'path_conflict') throw error;
        const record = (await hooks.listDocuments()).find((record) => hooks.logicalPath(record).toLowerCase() === `/library/${libraryPath}`.toLowerCase());
        if (!record) throw error;
        return { ok: true, path: hooks.logicalPath(record), target, fragment, created: false };
      }
    }
    throw new Error(`Unsupported Markdown channel: ${channel}`);
  }

  return {
    open,
    action,
    call(input: Readonly<Record<string, unknown>>) {
      if (disposed) return Promise.reject(new Error('The Markdown session is closed.'));
      const id = typeof input.editorId === 'string' ? input.editorId : 'default';
      const channel = input.channel;
      if (typeof channel !== 'string') return Promise.reject(new Error('Markdown IPC requires a channel.'));
      if (channel === 'markdown:action-result') {
        const reply = (Array.isArray(input.arguments) ? input.arguments[0] : null) as { requestId?: string; documentId?: string; result?: unknown; error?: string } | null;
        const request = reply?.requestId ? actions.get(reply.requestId) : undefined;
        if (!request || request.editorId !== id || request.documentId !== reply?.documentId || editors.get(id)?.documentId !== request.documentId) return Promise.reject(new Error('The Markdown action reply does not match the active request.'));
        if (typeof reply.error === 'string') request.reject(new Error(reply.error)); else request.resolve(reply.result);
        return Promise.resolve(null);
      }
      return exclusive(id, () => dispatch(id, channel, Array.isArray(input.arguments) ? input.arguments : []));
    },
    async dispose() { disposed = true; for (const id of editors.keys()) rejectActions(id); await Promise.allSettled(tails.values()); editors.clear(); }
  };
}
