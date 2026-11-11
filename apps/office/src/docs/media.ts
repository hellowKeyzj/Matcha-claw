import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { DOCS_PARSE_BYTES } from './resource';
import { inflateRawSync } from 'node:zlib';
import { bufferSource, materializeDocx, openZipFile, readZipEntries, slimDocx, type ZipFile } from '../../genoffice/packages/docx-engine/src/zip-splice';
import { isLazyMediaPart, MAX_LAZY_PART_CHARS } from '../../genoffice/packages/docx-engine/src/lazy-media';

const MIN_MEDIA_BYTES = 1024 * 1024;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

export async function docsFileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Immutable sources remain editor-owned until close, including after Save As. */
export function createDocsMedia() {
  const sources = new Map<string, string | Buffer>();
  async function sourceZip(source: string | Buffer): Promise<ZipFile> {
    if (typeof source === 'string') return openZipFile(source);
    const input = bufferSource(source);
    return { ...input, entries: new Map((await readZipEntries(input)).map(entry => [entry.name, entry])), close: async () => {} };
  }
  return {
    async slim(source: string | Buffer, hash: string): Promise<Buffer> {
      const size = typeof source === 'string' ? (await stat(source)).size : source.length;
      if (size === 0) return Buffer.alloc(0);
      const zip = await sourceZip(source);
      try {
        const slim = await slimDocx(zip, hash, MIN_MEDIA_BYTES);
        if (!slim) {
          if (size > DOCS_PARSE_BYTES) throw new Error('Docs parsing input exceeds 512 MiB.');
          return typeof source === 'string' ? readFile(source) : source;
        }
        sources.set(hash, source);
        return slim.bytes;
      } finally { await zip.close(); }
    },
    materialize(bytes: Buffer): Promise<Buffer> {
      return materializeDocx(bytes, async hash => {
        const source = sources.get(hash);
        return source ? sourceZip(source) : null;
      });
    },
    async read(hash: string, part: string): Promise<{ bytes: Buffer; mime: string } | null> {
      const source = sources.get(hash);
      if (!source || part.length > MAX_LAZY_PART_CHARS || !isLazyMediaPart(part) || part.split('/').some(value => value === '..')) return null;
      const zip = await sourceZip(source);
      try {
        const entry = zip.entries.get(part);
        if (!entry || ![0, 8].includes(entry.method)) return null;
        const raw = await zip.read(entry.dataOffset, entry.csize);
        return { bytes: entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: entry.usize }), mime: MIME[part.split('.').pop()!.toLowerCase()]! };
      } finally { await zip.close(); }
    },
    clear(): void { sources.clear(); }
  };
}
