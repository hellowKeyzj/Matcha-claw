import { base64ToBytes, bytesToBase64 } from '../documents/client';

export function imageMime(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}

type ImageReader = (source: string) => Promise<{ base64: string; mime: string }>;

export async function selfContainedHtml(html: string, allowExternalResources = true, readImage?: ImageReader): Promise<string> {
  const output = new DOMParser().parseFromString(html, 'text/html');
  const base = output.querySelector('base')?.getAttribute('href') ?? document.baseURI;
  async function inline(source: string, fallbackMime: string): Promise<string> {
    if (/^(data:|#)/i.test(source)) return source;
    if (!allowExternalResources || /^(file|md-asset):/i.test(source)) throw new Error(`The export contains an unresolved resource: ${source}`);
    const url = new URL(source, base);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (!readImage) throw new Error('The export requires the background image reader.');
      const image = await readImage(url.href);
      return `data:${image.mime};base64,${image.base64}`;
    }
    if (url.protocol !== 'blob:') throw new Error(`The export contains an unresolved resource: ${source}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not embed export resource: ${source}`);
    const mime = response.headers.get('content-type')?.split(';')[0] ?? fallbackMime;
    return `data:${mime};base64,${bytesToBase64(new Uint8Array(await response.arrayBuffer()))}`;
  }
  async function inlineCss(css: string): Promise<string> {
    if (/@import\b/i.test(css)) throw new Error('The export contains an external stylesheet import.');
    for (const match of [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)]) {
      css = css.replace(match[0], `url("${await inline(match[2]!, 'application/octet-stream')}")`);
    }
    return css;
  }
  output.querySelectorAll('script, iframe, object, embed, audio, video, source, meta[http-equiv]').forEach((element) => element.remove());
  for (const element of output.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || /^javascript:/i.test(attribute.value.trim())) element.removeAttribute(attribute.name);
      else if (/^(file|md-asset):/i.test(attribute.value)) throw new Error('The export contains an unresolved local resource.');
    }
  }
  for (const image of output.querySelectorAll('img[src], svg image')) {
    const attribute = image.hasAttribute('src') ? 'src' : image.hasAttribute('href') ? 'href' : 'xlink:href';
    const source = image.getAttribute(attribute);
    if (source) image.setAttribute(attribute, await inline(source, imageMime(source)));
    image.removeAttribute('srcset');
  }
  for (const reference of output.querySelectorAll('svg use')) {
    const source = reference.getAttribute('href') ?? reference.getAttribute('xlink:href');
    if (source && !source.startsWith('#')) throw new Error('The export contains an external SVG reference.');
  }
  for (const style of output.querySelectorAll('style')) style.textContent = await inlineCss(style.textContent ?? '');
  for (const element of output.querySelectorAll('[style]')) element.setAttribute('style', await inlineCss(element.getAttribute('style')!));
  output.querySelectorAll('base, link').forEach((element) => element.remove());
  return `<!DOCTYPE html>\n${output.documentElement.outerHTML}`;
}

export async function renderPdf(html: string, readImage: ImageReader): Promise<Uint8Array> {
  if (!window.matchaApp) throw new Error('The Matcha app frame is unavailable.');
  const result = await window.matchaApp.renderPdf({
    html: await selfContainedHtml(html, true, readImage),
    options: { pageSize: 'A4', printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } }
  });
  const bytes = base64ToBytes(result.data);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('PDF rendering returned invalid bytes.');
  return bytes;
}
