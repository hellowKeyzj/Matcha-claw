import { getMimeTypeForPath } from '@/lib/generated-files';
import { hostWikiReadBinaryFile } from '@/lib/host-api';

const WIKI_MEDIA_PREFIX = 'wiki/media/';
const WIKI_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export function wikiMediaPath(filePath: string, imagePath: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|data:|#|\/)/i.test(imagePath)) return null;
  const normalized = imagePath.replace(/\\/g, '/');
  if (normalized.startsWith(WIKI_MEDIA_PREFIX)) return normalized;
  if (normalized.startsWith('media/')) {
    const rootMediaPath = new URL(normalized, 'file:///wiki/').pathname.replace(/^\/+/, '');
    return rootMediaPath.startsWith(WIKI_MEDIA_PREFIX) ? rootMediaPath : null;
  }
  const directory = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const resolved = new URL(normalized, `file:///${directory ? `${directory}/` : ''}`).pathname.replace(/^\/+/, '');
  return resolved.startsWith(WIKI_MEDIA_PREFIX) ? resolved : null;
}

export async function resolveWikiMarkdownImage(src: string, filePath: string): Promise<string | null> {
  const path = wikiMediaPath(filePath, src);
  if (!path) return null;
  const result = await hostWikiReadBinaryFile({ path, maxBytes: WIKI_MEDIA_MAX_BYTES });
  return result.ok && result.data ? `data:${getMimeTypeForPath(path)};base64,${result.data}` : null;
}
