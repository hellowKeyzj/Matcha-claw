import type { AppPluginContext } from '@matcha/app-plugins-sdk';
import type { DocumentResource, EditorDocumentHooks } from '../documents/model';
import type { DocumentService } from '../documents/service';
import { OfficeError } from '../errors';
import { convertHtmlDocument } from '../conversion';
import { documentSnapshot } from './resources';
import { fetchWithSsrfGuard } from '../../genoffice/packages/electron-utils/src/safe-remote-url';
import { readBodyCapped, MAX_REMOTE_IMAGE_BYTES } from '../../genoffice/packages/electron-utils/src/remote-image';
import { safeExternalUrl } from '../../genoffice/packages/electron-utils/src/safe-external-url';
import { editableImageMime, sniffBinaryAssetMime } from '../../genoffice/apps/html/src/main/asset-mime';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileHtmlResources } from './assets';
import { inlineImagesForSingleFile } from '../../genoffice/apps/html/src/main/single-file-html';
import { documentResourceBase, DOCUMENT_RESOURCE_ORIGIN } from './resources';
import { validateHtmlAction } from './actions-schema';

type Binding = { documentId: string; name: string; revision: number; resources: Map<string, DocumentResource> };
function resourceInput(resource: { path?: unknown; data?: unknown; ownedSha256?: unknown }): DocumentResource {
  const content = bytes(resource.data);
  const ownedSha256 = resource.ownedSha256;
  if (ownedSha256 !== undefined && (typeof ownedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ownedSha256))) throw new OfficeError('invalid_input', 'Invalid owned resource hash.');
  return { path: resourcePath(resource.path), bytes: content,
    ...(ownedSha256 === createHash('sha256').update(content).digest('hex') ? { ownedSha256 } : {}) };
}
function base64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
function bytes(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new OfficeError('invalid_input', 'Expected base64 file data.');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw new OfficeError('invalid_input', 'Invalid base64 file data.');
  return new Uint8Array(result);
}
function resourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\u0000') || value.split('/').some((part) => !part || part === '.' || part === '..') || /^[a-z][\w+.-]*:/i.test(value)) {
    throw new OfficeError('invalid_resource_path', 'A document-relative resource path is required.');
  }
  return value;
}
export function createHtmlSession(context: AppPluginContext, documents: DocumentService | EditorDocumentHooks) {
  const hooks = 'editorHooks' in documents ? documents.editorHooks('html') : documents;
  const editors = new Map<string, Binding | null>();
  const observations = new Map<string, Binding>();
  const tails = new Map<string, Promise<unknown>>();
  let closed = false;
  const pending = new Map<string, { editorId: string; documentId: string; finish(value?: unknown, error?: Error): void }>();
  function cancelActions(editorId?: string) {
    for (const request of [...pending.values()]) if (!editorId || request.editorId === editorId) request.finish(undefined, new OfficeError('unavailable', 'The HTML document changed or closed.'));
  }
  async function action(documentId: string, action: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
    validateHtmlAction(action, input);
    if (closed || signal?.aborted) throw new OfficeError('unavailable', 'The HTML action is not available.');
    const matches = [...editors].filter(([, binding]) => binding?.documentId === documentId);
    if (matches.length !== 1) throw new OfficeError('unavailable', 'Open this HTML document in exactly one editor before using document actions.');
    const [editorId] = matches[0];
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const abort = () => finish(undefined, new OfficeError('cancelled', 'Stopped observing the HTML action; already applied edits are not undone.'));
      const timer = setTimeout(() => finish(undefined, new OfficeError('unavailable', 'The HTML editor did not answer.')), 30_000);
      const finish = (value?: unknown, error?: Error) => {
        clearTimeout(timer); pending.delete(requestId); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      pending.set(requestId, { editorId, documentId, finish });
      signal?.addEventListener('abort', abort, { once: true });
      try { context.publish('office.html.action', { editorId, documentId, requestId, action, input }); }
      catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
    });
  }
  function wire(binding: Binding, text: Uint8Array) {
    return { documentId: binding.documentId, name: binding.name, revision: binding.revision,
      path: hooks.logicalPath({ id: binding.documentId, name: binding.name }), data: base64(text),
      resources: [...binding.resources.values()].map(({ path, bytes, ownedSha256 }) => ({ path, data: base64(bytes), ...(ownedSha256 ? { ownedSha256 } : {}) })) };
  }
  async function load(id: string, editorId: string) {
    cancelActions(editorId);
    const { record, bytes: content, resources } = await hooks.readDocument(id);
    if (record.type !== 'html') throw new OfficeError('invalid_type', 'The library document is not HTML.');
    const binding: Binding = { documentId: record.id, name: record.name, revision: record.revision,
      resources: new Map(resources.map((resource) => [resource.path, resource])) };
    editors.set(editorId, binding);
    observations.delete(editorId);
    return wire(binding, content);
  }
  async function open(documentId: string, _name?: string, _bytes?: Uint8Array, _revision?: number, editorId = 'default') {
    if (closed) throw new OfficeError('session_closed', 'The HTML session is closed.');
    return load(documentId, editorId);
  }
  async function dispatch(input: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    if (closed) throw new OfficeError('session_closed', 'The HTML session is closed.');
    const editorId = typeof input.editorId === 'string' ? input.editorId : 'default';
    const channel = input.channel;
    const args = Array.isArray(input.arguments) ? input.arguments : [];
    const request = (args[0] ?? {}) as Record<string, unknown>;
    if (channel === 'office:open-editor') { if (!editors.has(editorId)) editors.set(editorId, null); return null; }
    if (channel === 'office:close-editor') { cancelActions(editorId); editors.delete(editorId); observations.delete(editorId); return null; }
    if (channel === 'html:action-result') {
      const waiting = typeof request.requestId === 'string' ? pending.get(request.requestId) : undefined;
      if (waiting && waiting.editorId === editorId && waiting.documentId === request.documentId && editors.get(editorId)?.documentId === request.documentId) {
        waiting.finish(request.result, typeof request.error === 'string' ? new OfficeError('html_action_failed', request.error) : undefined);
      }
      return null;
    }
    if (channel === 'html:list') return (await hooks.listDocuments()).filter((record) => record.type === 'html');
    if (channel === 'html:open') return load(String(request.documentId), editorId);
    if (channel === 'html:new') { cancelActions(editorId); editors.set(editorId, null); observations.delete(editorId); return null; }
    if (!editors.has(editorId)) throw new OfficeError('session_closed', 'The HTML editor is not open.');
    if (channel === 'html:open-external') {
      const url = safeExternalUrl(args[0]);
      if (!url) throw new OfficeError('invalid_input', 'A supported external URL is required.');
      await context.desktop.openExternal({ url });
      return null;
    }
    const binding = editors.get(editorId);
    if (channel === 'html:read') {
      if (!binding) throw new OfficeError('document_not_open', 'No HTML document is open.');
      const result = await hooks.readDocument(binding.documentId);
      const observation: Binding = { documentId: binding.documentId, revision: result.record.revision, name: result.record.name,
        resources: new Map(result.resources.map((resource) => [resource.path, resource])) };
      observations.set(editorId, observation);
      // Reading an external generation must not silently advance this editor's CAS snapshot.
      return wire(observation, result.bytes);
    }
    if (channel === 'html:ack') {
      const observation = observations.get(editorId);
      if (!binding || !observation || observation.documentId !== binding.documentId || observation.revision !== request.revision) {
        throw new OfficeError('invalid_revision', 'Only the document generation read by this editor can be acknowledged.');
      }
      editors.set(editorId, observation);
      observations.delete(editorId);
      return null;
    }
    if (channel === 'html:reconcile' || channel === 'html:single-file') {
      if (typeof request.html !== 'string' || !Array.isArray(request.resources)) throw new OfficeError('invalid_input', 'HTML source and resources are required.');
      const name = binding?.name ?? 'index.html';
      const resources = reconcileHtmlResources(request.html, request.resources.map(resourceInput), name);
      if (channel === 'html:reconcile') return resources.map(({ path, bytes, ownedSha256 }) => ({ path, data: base64(bytes), ...(ownedSha256 ? { ownedSha256 } : {}) }));
      const files = new Map(resources.map(resource => [resource.path, resource.bytes]));
      const base = documentResourceBase(request.html, name);
      return inlineImagesForSingleFile(request.html, name, async (_path, source) => {
        try {
          const url = new URL(source, base);
          if (url.origin !== DOCUMENT_RESOURCE_ORIGIN) return null;
          const path = decodeURIComponent(url.pathname.slice(1));
          const content = files.get(path);
          if (!content) return null;
          const mime = sniffBinaryAssetMime(content) ?? (/\.svg$/i.test(path) ? 'image/svg+xml' : null);
          return mime?.startsWith('image/') ? `data:${mime};base64,${base64(content)}` : null;
        } catch { return null; }
      });
    }
    if (channel === 'html:fetch-image') {
      if (typeof request.url !== 'string' || !/^https?:\/\//i.test(request.url)) throw new OfficeError('invalid_input', 'A public HTTP image URL is required.');
      const response = await fetchWithSsrfGuard(request.url);
      if (!response?.ok) throw new OfficeError('image_fetch_failed', 'The image URL was blocked or could not be downloaded.');
      const content = await readBodyCapped(response, MAX_REMOTE_IMAGE_BYTES);
      const mime = editableImageMime(content);
      return mime ? { base64: base64(content), mime } : null;
    }
    if (channel === 'html:convert') {
      if (typeof request.html !== 'string' || !['docx', 'png', 'pdf'].includes(String(request.format))) throw new OfficeError('invalid_input', 'A supported HTML conversion is required.');
      const resources: readonly DocumentResource[] = Array.isArray(request.resources)
        ? request.resources.map(resourceInput)
        : [...binding?.resources.values() ?? []];
      const name = resourcePath(request.name ?? binding?.name ?? 'index.html');
      const output = await convertHtmlDocument(context, request.html, {
        format: request.format as 'docx' | 'png' | 'pdf', document: documentSnapshot(request.html, resources, name)
      }, signal);
      return { data: base64(output), mimeType: request.format === 'png' ? 'image/png' : request.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }
    if (channel === 'html:save' || channel === 'html:import') {
      const content = bytes(request.data);
      const incoming: readonly DocumentResource[] = Array.isArray(request.resources)
        ? request.resources.map(resourceInput)
        : [...binding?.resources.values() ?? []];
      const resources = channel === 'html:import' ? incoming : reconcileHtmlResources(new TextDecoder('utf-8', { ignoreBOM: true }).decode(content), incoming, String(request.name || binding?.name || 'index.html'));
      if (channel === 'html:import' || request.mode === 'saveAs' || !binding) {
        cancelActions(editorId);
        const result = await hooks.createDocument(String(request.name || 'Untitled.html'), async () => ({ bytes: content, resources }));
        const next: Binding = { ...result, resources: new Map(resources.map((resource) => [resource.path, resource])) };
        editors.set(editorId, next);
        observations.delete(editorId);
        return wire(next, content);
      }
      // The renderer supplies its acknowledged revision, never an implicit overwrite bypass.
      const expectedRevision = Number(request.expectedRevision);
      if (expectedRevision !== binding.revision) throw new OfficeError('revision_conflict', 'The HTML editor has not acknowledged this document generation.', { currentRevision: binding.revision });
      const revision = await hooks.saveDocument(binding.documentId, expectedRevision, async () => ({ bytes: content, resources }));
      binding.revision = revision;
      observations.delete(editorId);
      binding.resources = new Map(resources.map((resource) => [resource.path, resource]));
      return wire(binding, content);
    }
    throw new OfficeError('unsupported_channel', `HTML operation is not available: ${String(channel)}`);
  }
  return {
    open, action,
    call(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
      if (input.channel === 'html:action-result') return dispatch(input, signal);
      const id = typeof input.editorId === 'string' ? input.editorId : 'default';
      const result = (tails.get(id) ?? Promise.resolve()).then(() => dispatch(input, signal));
      const tail = result.then(() => {}, () => {});
      tails.set(id, tail);
      void tail.then(() => { if (tails.get(id) === tail) tails.delete(id); });
      return result;
    },
    async beginClose() { closed = true; cancelActions(); await Promise.all(tails.values()); },
    async dispose() { closed = true; cancelActions(); await Promise.all(tails.values()); editors.clear(); observations.clear(); }
  };
}
