import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { extractMarkdownImageSources, rewriteMarkdownImageSources } from '../../genoffice/apps/markdown/src/main/asset-lifecycle';
import type { DocumentResource } from '../documents/model';

export function rewriteWikiImages(text: string, rewrites: ReadonlyMap<string, string>): string {
  let fence = '';
  return text.split(/(\r?\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; return line; }
    if (fence || /^(?: {4}|\t)/.test(line)) return line;
    return line.replace(/(`+)([\s\S]*?)\1|(?<!\\)!\[\[([^\]|\n]+)(\|[^\]\n]*)?\]\]/g, (raw, code, _body, target, alias) => {
      if (code) return raw;
      const replacement = rewrites.get(target);
      return replacement === undefined ? raw : `![[${replacement}${alias ?? ''}]]`;
    });
  }).join('');
}

export function resourcePath(source: string, documentPath: string): string {
  try { source = decodeURIComponent(source); } catch { /* Preserve a literal percent. */ }
  return posix.resolve(posix.dirname(documentPath), source.replaceAll('\\', '/'));
}

/** Rebase only parsed image destinations; authored resource bytes remain untouched. */
export function prepareMarkdownResources(text: string, documentPath: string, available: ReadonlyMap<string, DocumentResource>, imageSources: readonly string[] = [], wikiPaths: ReadonlyMap<string, string> = new Map()) {
  const sources = new Set([...extractMarkdownImageSources(text), ...imageSources]);
  const resources = new Map<string, DocumentResource>();
  const rewrites = new Map<string, string>();
  const directory = posix.dirname(documentPath) + '/';
  for (const [absolute, resource] of available) {
    const referenced = [...sources].some(source => resourcePath(source, documentPath) === absolute)
      || [...wikiPaths.values()].includes(absolute);
    const owned = resource.ownedSha256 === createHash('sha256').update(resource.bytes).digest('hex');
    if (!referenced && owned) continue;
    const path = absolute.startsWith(directory) ? absolute.slice(directory.length) : `assets/${createHash('sha256').update(absolute).digest('hex').slice(0, 16)}-${posix.basename(resource.path)}`;
    resources.set(path, owned ? { ...resource, path } : { path, bytes: resource.bytes });
    for (const source of sources) if (resourcePath(source, documentPath) === absolute && source !== path) rewrites.set(source, encodeURI(path));
    for (const [target, resolved] of wikiPaths) if (resolved === absolute) {
      const fragment = target.includes('#') ? target.slice(target.indexOf('#')) : '';
      if (target !== path + fragment) rewrites.set(target, path + fragment);
    }
  }
  return { text: rewriteWikiImages(rewriteMarkdownImageSources(text, rewrites), rewrites), resources: [...resources.values()], imageRewrites: [...rewrites].map(([from, to]) => ({ from, to })) };
}
