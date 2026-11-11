import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, join, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { orderedExternalLinkParts, retargetExternalLinkRels } from '../../genoffice/packages/xlsx-gateway/src/gateway/xlsx-external-links';
import type { ExternalLinksResult } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import type { LibraryWorkbook } from './save';
import type { DocumentRecord } from '../documents/model';

const librarySource = /^matcha-office:\/\/documents\/(doc_[a-f0-9]{16})$/;
export const workbookIdentity = (documentId: string) => `/office-workbooks/${documentId}`;
export const libraryTarget = (documentId: string) => `matcha-office://documents/${documentId}`;

type LinkSource = { documentId: string } | { path: string } | null;

export function resolveLinkSource(rawTarget: string, nativeSource: string | null, originPath?: string): LinkSource {
  const raw = rawTarget.trim();
  const documentId = librarySource.exec(raw)?.[1];
  if (documentId) return { documentId };
  if (raw.includes('://') || raw.startsWith('\\') || posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    return nativeSource === null ? null : { path: nativeSource };
  }
  if (!originPath) return null;
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(originPath) ? win32 : posix;
  // Native external_links.rs joins relative targets literally; only file:// URIs decode %xx.
  return { path: paths.resolve(paths.dirname(originPath), raw) };
}

export function bindLibrarySource(source: LinkSource, opened: readonly LibraryWorkbook[]): LinkSource {
  if (!source || 'documentId' in source) return source;
  const matches = opened.filter(binding => binding.originPath !== undefined &&
    (process.platform === 'win32' ? binding.originPath.toLowerCase() === source.path.toLowerCase() : binding.originPath === source.path));
  const ids = new Set(matches.map(binding => binding.documentId));
  return ids.size === 1 ? { documentId: matches[0]!.documentId } : source;
}

export function publicExternalLinks(
  listing: ExternalLinksResult,
  sources: ReadonlyMap<number, LinkSource>,
  documentId: string,
  opened: readonly LibraryWorkbook[],
  library: readonly DocumentRecord[]
): ExternalLinksResult['links'] {
  return listing.links.map(link => {
    const source = bindLibrarySource(sources.get(link.index) ?? null, opened);
    const sourceId = source && 'documentId' in source ? source.documentId : undefined;
    const name = library.find(record => record.id === sourceId)?.name ?? sourceDisplayName(link.rawTarget);
    return {
      ...link,
      rawTarget: name,
      source: sourceId ? workbookIdentity(sourceId)
        : link.source !== null || source ? `/office-links/${documentId}/${link.index}/${encodeURIComponent(name)}` : null
    };
  });
}

/** A disposable read view resolves links without changing the library's bytes or formulas. */
export async function writeExternalLinkView(
  bytes: Uint8Array,
  listing: ExternalLinksResult,
  targets: ReadonlyMap<number, string>,
  directory: string
): Promise<string> {
  const archive = await JSZip.loadAsync(bytes);
  const workbook = await archive.file('xl/workbook.xml')!.async('string');
  const relationships = await archive.file('xl/_rels/workbook.xml.rels')!.async('string');
  for (const link of orderedExternalLinkParts(workbook, relationships)) {
    const target = targets.get(link.n);
    if (!target || !link.part) continue;
    const part = `${link.part.replace(/([^/]+)$/, '_rels/$1')}.rels`;
    archive.file(part, retargetExternalLinkRels(await archive.file(part)!.async('string'), pathToFileURL(target).href));
  }
  if (listing.links.some(link => !targets.has(link.index) && link.source !== null)) {
    throw new Error('Choose the external workbook source before updating links.');
  }
  const path = join(directory, `links-${randomUUID()}.xlsx`);
  await writeFile(path, await archive.generateAsync({ type: 'nodebuffer' }));
  return path;
}

export function sourceDisplayName(target: string): string {
  if (target.startsWith('file://')) {
    try { return basename(fileURLToPath(target)); } catch { /* Foreign-platform file URI. */ }
  }
  return target.replaceAll('\\', '/').split('/').pop() || 'Workbook';
}
