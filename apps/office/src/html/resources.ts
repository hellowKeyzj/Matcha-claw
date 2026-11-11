import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { sniffBinaryAssetMime } from '../../genoffice/apps/html/src/main/asset-mime';
import type { DocumentResource } from '../documents/model';
import type { AppDocumentResourcesRequest } from '@matcha/app-plugins-sdk';

const mimeTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  html: 'text/html', htm: 'text/html', txt: 'text/plain', wasm: 'application/wasm', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav'
};
export function resourceMime(path: string, bytes?: Uint8Array): string {
  const known = mimeTypes[path.split('.').pop()?.toLowerCase() ?? ''];
  if (known) return known;
  if (!bytes) return 'application/octet-stream';
  const binary = sniffBinaryAssetMime(bytes);
  if (binary) return binary;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name && !name.includes('.') ? 'text/javascript' : 'application/octet-stream';
}
export function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function decodeBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
export function documentResourceMimes(html: string, resources: readonly DocumentResource[], name = 'index.html'): ReadonlyMap<string, string> {
  const base = documentResourceBase(html, name);
  const referencedMime = new Map<string, string>();
  function visit(node: DefaultTreeAdapterMap['node']): void {
    if ('tagName' in node) {
      const attribute = (name: string) => node.attrs.find(attr => attr.name === name)?.value;
      const mime = node.tagName === 'script' ? 'text/javascript'
        : node.tagName === 'link' && attribute('rel')?.toLowerCase().split(/\s+/).includes('stylesheet') ? 'text/css' : undefined;
      const source = attribute(node.tagName === 'script' ? 'src' : 'href');
      if (mime && source) {
        try {
          const url = new URL(source, base);
          if (url.origin === DOCUMENT_RESOURCE_ORIGIN) referencedMime.set(decodeURIComponent(url.pathname.slice(1)), mime);
        } catch { /* Invalid authored URLs remain unchanged. */ }
      }
    }
    if ('tagName' in node && node.tagName === 'style') {
      pendingCss.push({ text: node.childNodes.map(child => 'value' in child ? child.value : '').join(''), from: base });
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    if ('content' in node) visit(node.content);
  }
  const pendingCss: { text: string; from: URL }[] = [];
  const visitedCss = new Set<string>();
  const files = new Map(resources.map(resource => [resource.path, resource.bytes]));
  const root = parse(html);
  visit(root);
  function enqueueCss(path: string): void {
    if (visitedCss.has(path)) return;
    visitedCss.add(path);
    const bytes = files.get(path);
    if (bytes) pendingCss.push({ text: new TextDecoder().decode(bytes), from: documentResourceUrl(path) });
  }
  for (const resource of resources) if (resourceMime(resource.path, resource.bytes) === 'text/css' || referencedMime.get(resource.path) === 'text/css') enqueueCss(resource.path);
  for (let index = 0; index < pendingCss.length; index++) {
    const { text, from } = pendingCss[index];
    // Only @import has a stylesheet slot; ordinary url() may name images or fonts.
    const imports = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@import\s+(?:url\(\s*)?(?:"([^"\n]*)"|'([^'\n]*)'|([^\s);]+))/gi;
    for (const match of text.matchAll(imports)) {
      const source = match[1] ?? match[2] ?? match[3];
      if (!source) continue;
      try {
        const url = new URL(source, from);
        if (url.origin !== DOCUMENT_RESOURCE_ORIGIN) continue;
        const path = decodeURIComponent(url.pathname.slice(1));
        referencedMime.set(path, 'text/css');
        enqueueCss(path);
      } catch { /* Invalid authored URLs remain unchanged. */ }
    }
  }
  return new Map(resources.map(({ path, bytes }) => [path, referencedMime.get(path) ?? resourceMime(path, bytes)]));
}

export function documentSnapshot(html: string, resources: readonly DocumentResource[], name = 'index.html'): AppDocumentResourcesRequest {
  const mimes = documentResourceMimes(html, resources, name);
  return {
    entry: { path: name, data: encodeBytes(new TextEncoder().encode(html)), mimeType: 'text/html' },
    resources: resources.map(({ path, bytes }) => ({ path, data: encodeBytes(bytes), mimeType: mimes.get(path)! }))
  };
}

export function relativeResource(source: string, from = 'index.html'): string | null {
  if (!source || /^(?:[a-z][\w+.-]*:|\/|#|\\)/i.test(source)) return null;
  const root = 'https://office.invalid/document/';
  try {
    const url = new URL(source, new URL(from, root));
    if (!url.href.startsWith(root)) return null;
    return decodeURIComponent(url.pathname.slice('/document/'.length));
  } catch { return null; }
}

export const DOCUMENT_RESOURCE_ORIGIN = 'https://office.invalid';
export function documentResourceUrl(path: string): URL {
  return new URL(path.split('/').map(encodeURIComponent).join('/'), `${DOCUMENT_RESOURCE_ORIGIN}/`);
}
export function documentResourceBase(html: string, name: string): URL {
  const documentUrl = new URL(encodeURIComponent(name), `${DOCUMENT_RESOURCE_ORIGIN}/`);
  let href: string | undefined;
  function visit(node: any): void {
    if (href !== undefined) return;
    if (node.tagName === 'base') href = node.attrs?.find((attr: { name: string }) => attr.name === 'href')?.value;
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(html));
  try { return href === undefined ? documentUrl : new URL(href, documentUrl); }
  catch { return documentUrl; }
}

/** Resource projection is a disposable copy; authored source and source offsets stay untouched. */
export function projectHtml(html: string, resources: readonly DocumentResource[]): {
  html: string; reverse: ReadonlyMap<string, string>; missing: readonly string[];
} {
  const files = new Map(resources.map((resource) => [resource.path, resource.bytes]));
  const urls = new Map<string, string>();
  const reverse = new Map<string, string>();
  const missing = new Set<string>();
  const resolving = new Set<string>();
  const documentBase = documentResourceBase(html, 'index.html');
  function resolve(source: string, from = documentBase.href, required = true, mimeHint?: string): string {
    if (!source || source.startsWith('#') || /^(?:data:|blob:)/i.test(source)) return source;
    if (/^(?:file:|[a-z]:[\\/]|\\\\)/i.test(source)) return 'about:blank#blocked-local-path';
    let target: URL;
    try { target = new URL(source, new URL(from, `${DOCUMENT_RESOURCE_ORIGIN}/`)); }
    catch { return 'about:blank#blocked-resource-path'; }
    if (target.origin !== DOCUMENT_RESOURCE_ORIGIN) return target.href;
    let path: string;
    try { path = decodeURIComponent(target.pathname.slice(1)); }
    catch { return 'about:blank#blocked-resource-path'; }
    const bytes = files.get(path);
    if (!bytes) { if (required) missing.add(path); return 'about:blank#missing-document-resource'; }
    let result = urls.get(path);
    if (!result) {
      if (resolving.has(path)) return 'data:text/css,';
      resolving.add(path);
      const sniffed = resourceMime(path, bytes);
      const mime = sniffed === 'application/octet-stream' && mimeHint ? mimeHint : sniffed;
      const content = mime === 'text/css' ? new TextEncoder().encode(css(new TextDecoder().decode(bytes), path)) : bytes;
      result = `data:${mime};office-resource=${encodeURIComponent(path)};base64,${encodeBytes(content)}`;
      urls.set(path, result);
      resolving.delete(path);
    }
    const fragment = source.includes('#') ? source.slice(source.indexOf('#')) : '';
    const projected = result + fragment;
    reverse.set(projected, source);
    return projected;
  }
  function css(value: string, from: string): string {
    return value.replace(/url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^)'"\s]*))\s*\)/gi,
      (match, double, single, bare) => {
        const source = double ?? single ?? bare;
        const projected = resolve(source, from);
        return projected === source ? match : `url("${projected}")`;
      }).replace(/(@import\s+)(["'])([^"']+)\2/gi,
        (match, prefix, quote, source) => `${prefix}${quote}${resolve(source, from, true, 'text/css')}${quote}`);
  }
  const patches: { from: number; to: number; text: string }[] = [];
  // parse5 owns HTML tokenization, including comments, templates and raw text.
  const document = parse(html, { sourceCodeLocationInfo: true });
  function visit(node: any): void {
    const location = node.sourceCodeLocation;
    for (const attr of node.attrs ?? []) {
      const attrLocation = location?.attrs?.[attr.name];
      if (!attrLocation) continue;
      let value = attr.value;
      if (node.tagName === 'base' && attr.name === 'href') value = 'about:blank';
      else if (['src', 'href', 'poster', 'background', 'xlink:href'].includes(attr.name)) {
        const hint = node.tagName === 'script' ? 'text/javascript' : node.tagName === 'link' && node.attrs.some((item: { name: string; value: string }) => item.name === 'rel' && item.value === 'stylesheet') ? 'text/css' : undefined;
        value = resolve(value, documentBase.href, !['a', 'area'].includes(node.tagName), hint);
      }
      else if (attr.name === 'style') value = css(value, documentBase.href);
      else if (attr.name === 'srcset') {
        // A data URL can contain commas; only rewrite local authored candidates.
        value = value.replace(/data:[^\s]+|[^\s,]+/g, (token: string) => {
          if (/^(?:data:|[\d.]+[wx]$)/i.test(token)) return token;
          return resolve(token);
        });
      }
      if (value !== attr.value) patches.push({ from: attrLocation.startOffset, to: attrLocation.endOffset,
        text: `${attr.name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` });
    }
    if (node.tagName === 'style') {
      for (const child of node.childNodes ?? []) {
        const span = child.sourceCodeLocation;
        if (span && typeof child.value === 'string') {
          const value = css(child.value, documentBase.href);
          if (value !== child.value) patches.push({ from: span.startOffset, to: span.endOffset, text: value });
        }
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(document);
  let projected = html;
  for (const patch of patches.sort((a, b) => b.from - a.from)) projected = projected.slice(0, patch.from) + patch.text + projected.slice(patch.to);
  return { html: projected, reverse, missing: [...missing] };
}

export function restoreProjected<T>(value: T, reverse: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    let source: string = value;
    for (const [projected, authored] of reverse) source = source.split(projected).join(authored);
    return source as T;
  }
  if (Array.isArray(value)) return value.map((item) => restoreProjected(item, reverse)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreProjected(item, reverse)])) as T;
  return value;
}
