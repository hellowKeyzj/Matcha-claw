import { createHash } from 'node:crypto';
import { extractDocumentImageSources, scanCssUrls } from '../../genoffice/apps/html/src/main/asset-lifecycle';
import type { DocumentResource } from '../documents/model';
import { documentResourceBase, documentResourceMimes, documentResourceUrl, DOCUMENT_RESOURCE_ORIGIN } from './resources';

/** Only unchanged app-owned bytes are collectible; author resources are never inferred from paths. */
export function reconcileHtmlResources(html: string, resources: readonly DocumentResource[], name: string): readonly DocumentResource[] {
  const base = documentResourceBase(html, name);
  const referenced = new Set<string>();
  const add = (source: string, from: URL) => {
    try {
      const url = new URL(source, from);
      if (url.origin === DOCUMENT_RESOURCE_ORIGIN) referenced.add(decodeURIComponent(url.pathname.slice(1)));
    } catch { /* An invalid authored reference cannot own a resource. */ }
  };
  for (const source of extractDocumentImageSources(html)) add(source, base);
  for (const { source } of scanCssUrls(html)) add(source, base);
  // Stylesheet images retain ownership just like inline CSS; static author resources stay intact.
  const mimes = documentResourceMimes(html, resources, name);
  for (const resource of resources) if (mimes.get(resource.path) === 'text/css') {
    const from = documentResourceUrl(resource.path);
    for (const { source } of scanCssUrls(new TextDecoder().decode(resource.bytes))) add(source, from);
  }
  return resources.flatMap(resource => {
    if (!resource.ownedSha256) return [resource];
    const hash = createHash('sha256').update(resource.bytes).digest('hex');
    if (hash !== resource.ownedSha256) return [{ path: resource.path, bytes: resource.bytes }];
    return referenced.has(resource.path) ? [resource] : [];
  });
}
